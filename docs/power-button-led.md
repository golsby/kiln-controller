# Panel power button + status LED

One illuminated momentary switch on the enclosure that (a) boots the Pi when it's
halted, (b) shuts it down cleanly when it's running, and (c) shows what the
controller is doing via the LED in the button.

Nothing on the HAT moves. The button lands on GPIO3, which the HAT already uses
for the Arduino watcher's I2C SCL — that sharing is deliberate and is explained
below. The LED lands on GPIO26, which the HAT doesn't use at all.

## The switch

Same Sky (ex-CUI) **PB4L-M-BKR-P-D-67** — momentary, IP67, 12 mm panel cutout,
black cap with a lit power emblem.

| | |
|---|---|
| Contact | SPST-NO, momentary (off-(on)), 250 Vac / 0.2 A |
| LED | red, Vf 1.8 / **2.0** / 2.4 V at If = 20 mA |
| Terminals | 4 × solder / 2.0 mm quick-connect: two switch, two LED |
| Operating force | 500 gf typ., 2.0 mm travel |

The LED is a **bare LED with no built-in resistor** — it needs an external one
(below), and it's polarised. The datasheet has a polarity table for the terminals;
easiest is to confirm with a multimeter on diode-test before wiring (the LED lights
faintly on the correct polarity).

## Wiring

Everything is 3.3 V logic straight to the Pi header. No parts other than one
resistor.

```
switch contact  ── GPIO3   header pin 5     (shared with the HAT's I2C SCL)
switch contact  ── GND     header pin 6 or 9

LED anode (+)   ──[220 Ω]── GPIO26  header pin 37
LED cathode (−) ──          GND     header pin 34 (or any GND)
```

**Resistor:** (3.3 V − 2.0 V) / 220 Ω ≈ 6 mA, comfortably inside the Pi's 16 mA
per-pin limit and plenty bright for a panel indicator. Drop to 150 Ω (≈ 9 mA) if
you want it brighter; don't go below 100 Ω.

**Getting at the pins with the HAT seated.** Pins 5 and 37 are under the HAT, but
both are reachable without moving anything:

* Pin 37 / GPIO26 is one of the header positions the HAT leaves unconnected, so its
  through-hole on the top of the HAT is a free, electrically-floating pad wired to
  the Pi pin through the socket. Solder to it. Same for the GND at pin 34.
* Pin 5 / GPIO3 is already routed on the HAT to the Arduino's SCL. Tap that net
  anywhere convenient — the header pad, the Arduino's SCL pin, or the trace between
  them. A parallel connection is all this needs.
* If you'd rather not solder to the HAT, a 40-pin stacking header or a pass-through
  breakout gives you the same pins on top.

Keep the run to the panel short-ish and twist each pair; these are unbuffered
logic lines a few inches from a contactor.

## Why GPIO3 for the button

Boot-from-halt is a firmware feature of the Pi 3 and it only listens to **GPIO3**.
When you `poweroff`, the SoC parks in a low-power state with the 3.3 V rail live and
GPIO3 held high by its fixed 1.8 kΩ on-board pull-up; a falling edge there restarts
it. No other pin can do this, so if the button is going to turn the Pi on, it has to
be on GPIO3. That half is pure hardware — it works with the software below removed.

GPIO3 is also I2C1 SCL, going to the Arduino over-temp watcher. Two consequences:

* **Pressing the button while the Pi is running shorts SCL to GND** for as long as
  it's held, so any I2C poll in flight fails. That is already a tolerated condition
  — `ovenWatcher` logs `[Errno 121]` at debug while idle, and if the Arduino wedges
  it pulses the reset line to recover it (`docs/watcher.md`). Current through the
  pull-up while held is 1.8 mA.
* **The stock `dtoverlay=gpio-shutdown` can't be used.** It claims GPIO3 as a
  gpio-keys input, which collides with i2c1's claim on the same pin; one of the two
  drivers loses. `scripts/power_button.py` exists to avoid that collision: it reads
  the pin's *level* out of the GPLEV0 register through `/dev/gpiomem` and never
  claims the pin or changes its function select, so I2C is untouched.

## Boot-status LED

Driven by the kernel's `leds-gpio` driver rather than by application code, so the
LED means something from early boot onwards, even if the controller never starts.

Add to `/boot/firmware/config.txt`:

```
dtoverlay=gpio-led,gpio=26,label=kiln,trigger=heartbeat
```

That creates `/sys/class/leds/kiln`. `scripts/power_button.py` takes over the
pattern once it's running:

| LED | Meaning |
|---|---|
| off | Pi is halted (or the first ~4 s of boot, before the kernel loads overlays). Safe to unplug. |
| double-pulse heartbeat | Kernel is up, `kiln-controller` isn't answering yet |
| solid | Controller up, kiln idle |
| slow blink (1 s) | Firing in progress |
| brief blip every 2 s | Waiting for an aimed start |
| fast blink (~4 Hz) | Firing aborted with an error (over-temp, lost thermocouple, …) |
| goes dark while pressed | Button is registering |
| strobe | Shutting down — wait for it to go out |

The dead window at the very start of boot is unavoidable with a GPIO LED; the
alternative, `dtoverlay=act-led,gpio=26`, lights it from the bootloader as an
SD-activity light but then it can't show controller status. Status won.

## Button behaviour

| Pi state | Press | Result |
|---|---|---|
| Halted | tap | Boots (firmware wake-from-halt, no software involved) |
| Running, idle | hold **3 s** | Clean `systemctl poweroff` |
| Running, firing | hold **10 s** | Clean `systemctl poweroff` |
| Running | tap | Nothing (one dropped I2C poll) |

Hold times are `power_button_hold_seconds` / `power_button_hold_seconds_firing` in
`config.py`. The longer hold during a firing is deliberate: powering off drops the
SSR and contactor, which stops the firing. `resume.json` is rewritten every control
loop, so the firing is resumable after the Pi comes back — but it isn't automatic,
see the resume procedure.

The daemon also waits for the button to be *released* before it arms, so the press
that boots the Pi can be held as long as you like without immediately powering it
back off.

## Install

```bash
sudo cp /home/brian/kiln-controller/lib/init/kiln-power-button.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kiln-power-button
```

The overlay line in `config.txt` needs a reboot. The daemon runs as root: it needs
`/dev/gpiomem`, `/sys/class/leds`, and `systemctl poweroff`.

Check it:

```bash
systemctl status kiln-power-button
journalctl -u kiln-power-button -f
```

## Verifying

1. `ls /sys/class/leds/kiln` exists and `echo 1 | sudo tee /sys/class/leds/kiln/brightness`
   lights the button (after `echo none | sudo tee /sys/class/leds/kiln/trigger`).
2. With the daemon stopped, `journalctl` quiet: tap the button and confirm the
   watcher still reads temperatures — `curl -s localhost/api/state | python3 -m json.tool`
   should keep returning fresh temperatures, and any `[Errno 121]` should be a
   one-off.
3. Start the daemon, hold the button 3 s while idle — the LED should go dark on
   press and the Pi should shut down.
4. Once the LED is out, tap the button — the Pi should boot.

## Known failure mode

The daemon can't electrically tell "button held" from "something else is holding
SCL low", so an Arduino that wedges the clock line low for more than the hold time
would look like a shutdown press. In practice a wedged I2C slave holds SDA, clock
stretching by the `Wire` slave library lasts milliseconds, and `ovenWatcher` resets
the Arduino when polls start failing — and during a firing the threshold is 10 s.
If it ever happens the symptom is unmistakable in the journal: the daemon logs the
hold before it powers off. Raise `power_button_hold_seconds` if you want more margin.
