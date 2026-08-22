#!/usr/bin/env python3
'''Panel power button + status LED daemon.

Hardware (full write-up in docs/power-button-led.md):

  * Momentary switch (SPST-NO) between GPIO3 (header pin 5) and GND.
    GPIO3 is the only pin the Pi 3 firmware wakes on, so a press while the Pi
    is halted boots it - that half needs no software at all. GPIO3 is also the
    Arduino watcher's I2C SCL, which is why this daemon does NOT claim the pin:
    it reads the pin *level* straight out of the GPLEV0 register via
    /dev/gpiomem, leaving the i2c1 pinmux alone.

  * The switch's LED on GPIO26 (header pin 37) through a resistor, driven by
    the kernel leds-gpio driver (config.txt: dtoverlay=gpio-led,...), so it
    lights during boot long before this daemon or the controller are up.

A brief press only pulls SCL low for a few ms - the watcher already tolerates
those [Errno 121] blips and resets the Arduino if it wedges. A press has to be
held (config.power_button_hold_seconds, longer during a firing) before we power
off, which also means an I2C transfer or a bit of clock stretching can never be
mistaken for a button press.
'''

import ctypes
import json
import logging
import mmap
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config

logging.basicConfig(level=config.log_level, format=config.log_format)
log = logging.getLogger("power_button")

GPIOMEM = "/dev/gpiomem"
GPLEV0 = 0x34            # BCM283x pin level register, bit N = level of GPIOn
LEDS = "/sys/class/leds"

POLL = 0.05              # button sampling interval, seconds
STATE_POLL = 2.0         # how often to ask the controller what it's doing


class PinLevel(object):
    '''Reads the level of a GPIO without claiming it or touching its function
    select, so it works on a pin that i2c1 (or anything else) already owns.

    The register has to be read as a single aligned 32-bit load, which is what
    the ctypes pointer buys us. Slicing the mmap (mem[0x34:0x38]) goes through
    memcpy, and memcpy on a Device-mapped page returns garbage on ARM - on this
    Pi it reported every 32-bit word in a 16-byte block as the same value, so
    GPLEV0 came back as a copy of a neighbouring register. The mapping has to
    be PROT_WRITE for ctypes.from_buffer to accept it; nothing here writes.'''

    def __init__(self, pin):
        self.pin = pin
        fd = os.open(GPIOMEM, os.O_RDWR | os.O_SYNC)
        try:
            self.mem = mmap.mmap(fd, 4096, mmap.MAP_SHARED,
                                 mmap.PROT_READ | mmap.PROT_WRITE)
        finally:
            os.close(fd)
        self.regs = ctypes.cast(
            ctypes.addressof(ctypes.c_char.from_buffer(self.mem)),
            ctypes.POINTER(ctypes.c_uint32))
        self.index = GPLEV0 // 4

    def read(self):
        return (self.regs[self.index] >> self.pin) & 1


class StatusLed(object):
    '''The switch LED, via the kernel LED class. Writing sysfs instead of
    driving the GPIO ourselves means the kernel can blink it for us and the
    LED already means something before this process starts.'''

    def __init__(self, name):
        self.path = os.path.join(LEDS, name)
        self.available = os.path.isdir(self.path)
        if not self.available:
            log.warning("no LED at %s - is dtoverlay=gpio-led in config.txt?",
                        self.path)
            self.max = 1
        else:
            self.max = int(self._read("max_brightness") or 1)
        self.pattern = None

    def _read(self, attr):
        try:
            with open(os.path.join(self.path, attr)) as f:
                return f.read().strip()
        except IOError:
            return None

    def _write(self, attr, value):
        if not self.available:
            return
        try:
            with open(os.path.join(self.path, attr), "w") as f:
                f.write("%s\n" % value)
        except IOError as e:
            log.debug("led write %s=%s failed: %s", attr, value, e)

    def set(self, pattern):
        '''Idempotent - only touches sysfs when the pattern actually changes.'''
        if pattern == self.pattern:
            return
        self.pattern = pattern
        if pattern == "boot":                       # kernel up, controller isn't
            self._write("trigger", "heartbeat")
        elif pattern == "idle":                     # controller up, kiln idle
            self._write("trigger", "none")
            self._write("brightness", self.max)
        elif pattern == "firing":                   # slow blink
            self._blink(1000, 1000)
        elif pattern == "waiting":                  # short blip: aimed start
            self._blink(150, 1850)
        elif pattern == "error":                    # fast blink
            self._blink(120, 120)
        elif pattern == "shutdown":                 # strobe until the power dies
            self._blink(60, 60)
        elif pattern == "off":
            self._write("trigger", "none")
            self._write("brightness", 0)

    def _blink(self, on_ms, off_ms):
        self._write("trigger", "timer")
        self._write("delay_on", on_ms)
        self._write("delay_off", off_ms)


def controller_state():
    '''Oven state string, or None if the controller isn't answering yet.'''
    url = "http://127.0.0.1:%d/api/state" % config.listening_port
    try:
        with urllib.request.urlopen(url, timeout=1.0) as r:
            return json.loads(r.read().decode("utf-8")).get("state")
    except Exception as e:
        log.debug("controller not answering: %s", e)
        return None


def led_pattern_for(state):
    if state is None:
        return "boot"
    if state == "IDLE":
        return "idle"
    if state == "RUNNING":
        return "firing"
    if state == "WAITING":
        return "waiting"
    return "error"          # abort_run_with_error() parks the error in .state


def power_off(led):
    log.info("power button: powering off")
    led.set("shutdown")
    subprocess.call(["/bin/systemctl", "poweroff"])


def main():
    if not os.path.exists(GPIOMEM):
        log.error("%s missing - this daemon only runs on the Pi", GPIOMEM)
        return 1

    pin = PinLevel(config.gpio_power_button)
    led = StatusLed(config.status_led_name)

    state = None
    next_state_poll = 0.0
    pressed_since = None
    # If the button is still held from the press that booted us, wait for it to
    # be released before arming - otherwise we'd power straight back off.
    armed = False

    log.info("watching power button on GPIO%d, status LED '%s'",
             config.gpio_power_button, config.status_led_name)

    while True:
        now = time.time()

        if now >= next_state_poll:
            state = controller_state()
            next_state_poll = now + STATE_POLL

        down = pin.read() == 0

        if not armed:
            if not down:
                armed = True
            time.sleep(POLL)
            continue

        if not down:
            if pressed_since is not None:
                log.debug("power button released after %.1fs",
                          now - pressed_since)
                pressed_since = None
            led.set(led_pattern_for(state))
            time.sleep(POLL)
            continue

        # Held. Any single high sample above resets the timer, so an I2C
        # transfer (microseconds of SCL low) can't accumulate toward this.
        if pressed_since is None:
            pressed_since = now
            log.debug("power button down")
        held = now - pressed_since

        # Dark while held: press-and-see-it-go-out is the feedback that the
        # button is doing something.
        led.set("off")

        hold_needed = (config.power_button_hold_seconds_firing
                       if state == "RUNNING"
                       else config.power_button_hold_seconds)
        if held >= hold_needed:
            if state == "RUNNING":
                log.warning("power button held %.0fs during a firing - "
                            "powering off (resume.json is current)", held)
            power_off(led)
            return 0

        time.sleep(POLL)


if __name__ == "__main__":
    sys.exit(main())
