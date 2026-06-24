import threading,logging,json,time,datetime
import config
import notifier
from oven import Oven
from arduinoWatcher import ArduinoWatcher, KilnWatcherError, OverTempAlarmError
log = logging.getLogger(__name__)

WATCHER_DEDUP_KEY = "kiln-watcher"


class ArduinoWatcherSimulated(object):
    '''no-op stand-in for the I2C over-temp watcher used when simulating,
    since there is no /dev/i2c bus on a dev machine'''
    def setMaxTemp(self, degreesC):
        return degreesC

    def getMaxTemp(self):
        return 1340

    def getCurrentTemp(self):
        return 0.0

    def reset(self):
        pass

class OvenWatcher(threading.Thread):
    def __init__(self,oven):
        self.last_profile = None
        self.last_log = []
        self.started = None
        self.recording = False
        self.observers = []
        threading.Thread.__init__(self)
        self.daemon = True
        self.oven = oven
        if getattr(config, 'simulate', False):
            self.arduinoWatcher = ArduinoWatcherSimulated()
        else:
            self.arduinoWatcher = ArduinoWatcher(0x8, 1)
        # watcher fault tracking
        self.watcher_errors = 0
        self.watcher_alarm = False
        self.watcher_error_threshold = getattr(config, 'watcher_error_threshold', 3)
        # last max temp pushed to the watcher (deg C), re-sent on a reset.
        # default to a safe ceiling so the watcher is initialized while idle.
        self.watcher_max_temp = getattr(config, 'watcher_default_max_temp_c', 1340)
        self._watcher_initialized = False
        self.start()

    def set_max_temp(self, degreesC):
        '''Remember and push the watcher's max temp so we can re-send it
        when recovering the watcher after a fault.'''
        self.watcher_max_temp = degreesC
        try:
            self.arduinoWatcher.setMaxTemp(degreesC)
        except Exception as e:
            log.error("could not set watcher max temp: %s" % e)

    def reset_watcher(self):
        '''Attempt to recover a faulted Arduino watcher: reset it and re-send
        the max temp. Restarting/resetting has been enough to recover it.'''
        try:
            if hasattr(self.oven, 'output'):
                self.oven.output.resetArduino()
            self.arduinoWatcher.setMaxTemp(self.watcher_max_temp)
            log.info("attempted kiln watcher reset")
        except Exception as e:
            log.error("kiln watcher reset failed: %s" % e)

    def send_alert(self, message):
        '''Surface a high-priority alert: log it and raise a PagerDuty
        incident (no-op if PagerDuty isn't configured).'''
        log.error("ALERT: %s" % message)
        notifier.pagerduty_event("trigger", WATCHER_DEDUP_KEY, message)

    def _clear_watcher_alarm(self, reason):
        '''Clear watcher fault state and resolve the PagerDuty incident if
        one was open.'''
        if self.watcher_alarm:
            log.info("kiln watcher recovered")
            notifier.pagerduty_event("resolve", WATCHER_DEDUP_KEY, reason)
        self.watcher_errors = 0
        self.watcher_alarm = False

# FIXME - need to save runs of schedules in near-real-time
# FIXME - this will enable re-start in case of power outage
# FIXME - re-start also requires safety start (pausing at the beginning
# until a temp is reached)
# FIXME - re-start requires a time setting in minutes.  if power has been
# out more than N minutes, don't restart
# FIXME - this should not be done in the Watcher, but in the Oven class

    def run(self):
        # initialize the watcher at startup so it reports valid readings
        # (and doesn't error) while idle
        if not self._watcher_initialized:
            self.reset_watcher()
            self._watcher_initialized = True

        while True:
            oven_state = self.oven.get_state()
            firing = oven_state.get("state") == "RUNNING"

            # record state for any new clients that join
            if firing:
                self.last_log.append(oven_state)
            else:
                self.recording = False

            self._poll_watcher(firing)

            # surface the watcher alarm to clients without changing oven state
            oven_state['watcher_alarm'] = self.watcher_alarm
            self.notify_all(oven_state)
            # Sample/notify at the oven's playback pace so a fast simulation
            # still produces a smooth graph (not ~12 points for a whole run),
            # but never faster than 10x/sec to avoid flooding the websocket.
            interval = self.oven.time_step / getattr(self.oven, 'runtime_multiplier', 1)
            time.sleep(max(interval, 0.1))
   
    def _poll_watcher(self, firing):
        '''Read the watcher once and handle faults. Sensor/comm faults never
        abort the firing: below threshold they're tolerated; at threshold we
        try a reset; if that doesn't recover it we raise an alarm and keep
        retrying. A genuine over-temp alarm still aborts. Faults are ignored
        while idle.'''
        try:
            watcher_temp = self.arduinoWatcher.getCurrentTemp()
            log.debug("Watcher temp: {0}".format(watcher_temp))
            # a good read clears any fault state (and resolves the incident)
            self._clear_watcher_alarm("Kiln watcher recovered")
        except OverTempAlarmError:
            # a genuine over-temp trip is a real safety event - abort
            log.error("Kiln Watcher OVER TEMP ALARM")
            if firing:
                self.oven.abort_run_with_error("ERROR: Safe Temp Exceeded")
        except KilnWatcherError:
            if not firing:
                # ignore watcher faults while idle (resolve any open incident)
                self._clear_watcher_alarm("Kiln watcher alarm cleared (idle)")
                return
            self.watcher_errors += 1
            log.error("Kiln Watcher Error (%d)" % self.watcher_errors)
            if self.watcher_errors == self.watcher_error_threshold:
                log.warning("kiln watcher faulted - attempting reset")
                self.reset_watcher()
            elif self.watcher_errors > self.watcher_error_threshold:
                if not self.watcher_alarm:
                    self.watcher_alarm = True
                    self.send_alert("Kiln watcher fault - firing continues on the "
                                    "main thermocouple; retrying reset")
                # keep trying to reset periodically (~every 5 polls)
                if self.watcher_errors % 5 == 0:
                    self.reset_watcher()
        except Exception:
            pass

    def lastlog_subset(self,maxpts=3000):
        '''send about maxpts from lastlog by skipping unwanted data'''
        totalpts = len(self.last_log)
        if (totalpts <= maxpts):
            return self.last_log
        every_nth = int(totalpts / (maxpts - 1))
        return self.last_log[::every_nth]

    def clear(self):
        '''drop the recorded run trace so reconnecting clients don't reload
        a stale run, while keeping the last profile so its curve still shows.
        Only safe to call when idle.'''
        self.last_log = []
        self.recording = False
        log.info("cleared recorded run log")

    def record(self, profile):
        self.last_profile = profile
        self.last_log = []
        self.started = datetime.datetime.now()
        self.recording = True
        #we just turned on, add first state for nice graph
        self.last_log.append(self.oven.get_state())

    def add_observer(self,observer):
        if self.last_profile:
            p = {
                "name": self.last_profile.name,
                "data": self.last_profile.data, 
                "type" : "profile"
            }
        else:
            p = None
        
        backlog = {
            'type': "backlog",
            'profile': p,
            'log': self.lastlog_subset(),
            #'started': self.started
        }
        print(backlog)
        backlog_json = json.dumps(backlog)
        try:
            print(backlog_json)
            observer.send(backlog_json)
        except:
            log.error("Could not send backlog to new observer")
        
        self.observers.append(observer)

    def notify_all(self,message):
        message_json = json.dumps(message)
        log.debug("sending to %d clients: %s"%(len(self.observers),message_json))
        for wsock in self.observers:
            if wsock:
                try:
                    wsock.send(message_json)
                except:
                    log.error("could not write to socket %s"%wsock)
                    self.observers.remove(wsock)
            else:
                self.observers.remove(wsock)
