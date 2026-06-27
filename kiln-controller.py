#!/usr/bin/env python

import os
import sys
import logging
from logging.handlers import RotatingFileHandler
import json

# load .env before importing gevent so settings like PURE_PYTHON take effect
import loadenv

import bottle
import time
#from bottle import post, get
from gevent.pywsgi import WSGIServer
from geventwebsocket.handler import WebSocketHandler
from geventwebsocket import WebSocketError
from scripts.schedule_converter import rth_to_segments, segments_to_points

try:
    sys.dont_write_bytecode = True
    import config
    sys.dont_write_bytecode = False
except:
    print ("Could not import config file.")
    print ("Copy config.py.EXAMPLE to config.py and adapt it for your setup.")
    exit(1)
    
logfile = os.path.join(os.path.dirname(__file__), 'process.log')

# my_handler = RotatingFileHandler(
#     logfile, 
#     mode='a', 
#     maxBytes=20*1024*1024,
#     backupCount=2, 
#     encoding=None, 
#     delay=False
# )
logging.basicConfig(
    filename=logfile,
    filemode='a',
    level=config.log_level, 
    format=config.log_format,
    #handlers = [my_handler]
)
log = logging.getLogger("kiln-controller")
log.info("Starting kiln controller")

script_dir = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, script_dir + '/lib/')
profile_path = config.kiln_profiles_directory

from oven import SimulatedOven, RealOven, Profile
from ovenWatcher import OvenWatcher
import identity
import firingStore

# controller identity (GUID + human name); auto-created on first run
controller = identity.load_or_create(config.controller_state_file)

app = bottle.Bottle()

if config.simulate == True:
    log.info("this is a simulation")
    oven = SimulatedOven()
else:
    log.info("this is a real kiln")
    oven = RealOven()
ovenWatcher = OvenWatcher(oven)
# this ovenwatcher is used in the oven class for restarts
oven.set_ovenwatcher(ovenWatcher)

@app.route('/')
def index():
    return bottle.redirect('/kiln/index.html')

@app.get('/api/stats')
def handle_api():
    log.debug("/api/stats command received")
    if hasattr(oven,'pid'):
        if hasattr(oven.pid,'pidstats'):
            return json.dumps(oven.pid.pidstats)


@app.get('/api/firings')
def handle_list_firings():
    '''Lightweight history listing (summaries only, newest first).'''
    bottle.response.content_type = 'application/json'
    return json.dumps(firingStore.list_firings(config.firings_directory))


@app.get('/api/firings/<fid>')
def handle_get_firing(fid):
    '''Full record + events + samples for one firing. ?resolution=N caps the
    number of sample points returned (for graphing); omit it for full data.'''
    bottle.response.content_type = 'application/json'
    resolution = bottle.request.query.get('resolution')
    try:
        resolution = int(resolution) if resolution else None
    except ValueError:
        resolution = None
    data = firingStore.get_firing(config.firings_directory, fid, resolution)
    if data is None:
        bottle.response.status = 404
        return json.dumps({"error": "firing not found"})
    return json.dumps(data)


@app.post('/api')
def handle_api():
    log.debug("/api is alive")


    # run a kiln schedule
    if bottle.request.json['cmd'] == 'run':
        wanted = bottle.request.json['profile']
        log.debug('api requested run of profile = %s' % wanted)

        # start at a specific minute in the schedule
        # for restarting and skipping over early parts of a schedule
        startat = 0;      
        if 'startat' in bottle.request.json:
            startat = bottle.request.json['startat']

        # get the wanted profile/kiln schedule
        profile = find_profile(wanted)
        if profile is None:
            return { "success" : False, "error" : "profile %s not found" % wanted }

        profile = Profile(profile)
        wait_until = compute_aim_wait_until(profile, bottle.request.json)
        run_and_watch(profile, startat=startat, wait_until=wait_until)

    if bottle.request.json['cmd'] == 'stop':
        log.debug("api stop command received")
        oven.abort_run()

    # resume the last stopped/failed firing from its saved position
    if bottle.request.json['cmd'] == 'resume':
        info = oven.resume_info
        if not info:
            return { "success": False, "error": "nothing to resume" }
        try:
            filename = "%s.json" % info['profile']
            with open(os.path.join(profile_path, filename)) as f:
                profile = Profile(json.load(f))
            run_and_watch(profile, resume_state=info)
            log.info("api resume: %s (segment %s)" % (info['profile'], info.get('segment')))
            return { "success": True, "profile": info['profile'] }
        except Exception as e:
            return { "success": False, "error": str(e) }

    # debug-only: force the simulated kiln's temperature (e.g. to test resume
    # after the kiln has cooled). No effect on a real kiln.
    if bottle.request.json['cmd'] == 'set_temp':
        temp = bottle.request.json.get('temp')
        if not hasattr(oven, 'set_simulated_temp'):
            return { "success": False, "error": "set_temp only works on a simulated kiln" }
        try:
            oven.set_simulated_temp(float(temp))
            log.info("api set_temp: simulated temperature set to %s" % temp)
            return { "success": True, "temp": float(temp) }
        except (TypeError, ValueError):
            return { "success": False, "error": "invalid temp" }

    # rename the controller (human-friendly label shown on the dashboard)
    if bottle.request.json['cmd'] == 'set_controller_name':
        try:
            updated = identity.set_name(config.controller_state_file,
                                        bottle.request.json.get('name'))
            controller["name"] = updated["name"]
            return { "success": True, "name": updated["name"] }
        except ValueError as e:
            return { "success": False, "error": str(e) }

    if bottle.request.json['cmd'] == 'memo':
        log.debug("api memo command received")
        memo = bottle.request.json['memo']
        log.debug("memo=%s" % (memo))

    # get stats during a run
    if bottle.request.json['cmd'] == 'stats':
        log.debug("api stats command received")
        if hasattr(oven,'pid'):
            if hasattr(oven.pid,'pidstats'):
                return json.dumps(oven.pid.pidstats)

    return { "success" : True }

def find_profile(wanted):
    '''
    given a wanted profile name, find it and return the parsed
    json profile object or None.
    '''
    # find the wanted profile
    for profile in get_profiles():
        if profile['name'] == wanted:
            return profile
    return None

@app.route('/kiln/:filename#.*#')
def send_static(filename):
    log.debug("serving %s" % filename)
    return bottle.static_file(filename, root=os.path.join(os.path.dirname(os.path.realpath(sys.argv[0])), "public"))


def get_websocket_from_request():
    env = bottle.request.environ
    wsock = env.get('wsgi.websocket')
    if not wsock:
        abort(400, 'Expected WebSocket request.')
    return wsock


@app.route('/control')
def handle_control():
    wsock = get_websocket_from_request()
    log.debug("websocket (control) opened")
    while True:
        try:
            message = wsock.receive()
            if message:
                log.debug("Received (control): %s" % message)
                msgdict = json.loads(message)
                if msgdict.get("cmd") == "RUN":
                    log.info("RUN command received")
                    if msgdict.get("resume"):
                        # resume the last stopped/failed firing from where it left off
                        info = oven.resume_info
                        if not info:
                            log.warning("resume requested but no firing to resume")
                        else:
                            try:
                                filename = "%s.json" % info['profile']
                                with open(os.path.join(profile_path, filename)) as f:
                                    profile = Profile(json.load(f))
                                log.info("resuming %s (segment %s, setpoint %s)"
                                         % (info['profile'], info.get('segment'), info.get('setpoint')))
                                # restore the exact scheduler position (not a time fast-forward)
                                run_and_watch(profile, resume_state=info)
                            except Exception as e:
                                log.error("resume failed: %s" % e)
                    else:
                        profile_obj = msgdict.get('profile')
                        if profile_obj:
                            profile = Profile(profile_obj)

                        wait_until = compute_aim_wait_until(profile, msgdict)
                        run_and_watch(profile, wait_until=wait_until)

                elif msgdict.get("cmd") == "SIMULATE":
                    log.info("SIMULATE command received")
                    #profile_obj = msgdict.get('profile')
                    #if profile_obj:
                    #    profile = Profile(profile_obj)
                    #simulated_oven = Oven(simulate=True, time_step=0.05)
                    #simulation_watcher = OvenWatcher(simulated_oven)
                    #simulation_watcher.add_observer(wsock)
                    #simulated_oven.run_profile(profile)
                    #simulation_watcher.record(profile)
                elif msgdict.get("cmd") == "STOP":
                    log.info("Stop command received")
                    oven.abort_run()
                elif msgdict.get("cmd") == "HOLD":
                    log.info("HOLD command received")
                    oven.set_manual_hold(True)
                elif msgdict.get("cmd") == "RESUME":
                    log.info("RESUME command received")
                    oven.set_manual_hold(False)
                elif msgdict.get("cmd") == "ADVANCE":
                    log.info("ADVANCE command received")
                    oven.advance_segment()
                elif msgdict.get("cmd") == "SET_SEGMENT_TARGET":
                    log.info("SET_SEGMENT_TARGET command received")
                    oven.set_segment_target(msgdict.get("segment"),
                                            msgdict.get("target"))
                elif msgdict.get("cmd") == "SET_SEGMENT_HOLD":
                    log.info("SET_SEGMENT_HOLD command received")
                    oven.set_segment_hold(msgdict.get("segment"),
                                          msgdict.get("hold"))
                elif msgdict.get("cmd") == "CLEAR":
                    log.info("CLEAR command received")
                    if oven.state == "RUNNING":
                        log.warning("ignoring CLEAR while a profile is running")
                    else:
                        ovenWatcher.clear()
                        oven.clear_resume_state()
                elif msgdict.get("cmd") == "RESET_WATCHER":
                    log.info("RESET_WATCHER command received")
                    ovenWatcher.arduinoWatcher.reset()
                    #watcher.reset()
        except WebSocketError as e:
            log.error(e)
            break
    log.debug("websocket (control) closed")


@app.route('/storage')
def handle_storage():
    wsock = get_websocket_from_request()
    log.debug("websocket (storage) opened")
    while True:
        try:
            message = wsock.receive()
            if not message:
                break
            log.debug("websocket (storage) received: %s" % message)

            try:
                msgdict = json.loads(message)
            except:
                msgdict = {}

            if message == "GET":
                log.info("GET command received")
                wsock.send(json.dumps(get_profiles()))
            elif msgdict.get("cmd") == "DELETE":
                log.info("DELETE command received")
                profile_obj = msgdict.get('profile')
                if delete_profile(profile_obj):
                  msgdict["resp"] = "OK"
                wsock.send(json.dumps(msgdict))
                #wsock.send(json.dumps(get_profiles()))
            elif msgdict.get("cmd") == "PUT":
                log.info("PUT command received")
                profile_obj = msgdict.get('profile')
                #force = msgdict.get('force', False)
                force = True
                if profile_obj:
                    #del msgdict["cmd"]
                    if save_profile(profile_obj, force):
                        msgdict["resp"] = "OK"
                    else:
                        msgdict["resp"] = "FAIL"
                    log.debug("websocket (storage) sent: %s" % message)

                    wsock.send(json.dumps(msgdict))
                    wsock.send(json.dumps(get_profiles()))
        except WebSocketError:
            break
    log.debug("websocket (storage) closed")


@app.route('/config')
def handle_config():
    wsock = get_websocket_from_request()
    log.debug("websocket (config) opened")
    while True:
        try:
            message = wsock.receive()
            wsock.send(get_config())
        except WebSocketError:
            break
    log.debug("websocket (config) closed")


@app.route('/status')
def handle_status():
    wsock = get_websocket_from_request()
    ovenWatcher.add_observer(wsock)
    log.debug("websocket (status) opened")
    while True:
        try:
            message = wsock.receive()
            wsock.send("Your message was: %r" % message)
        except WebSocketError:
            break
    log.debug("websocket (status) closed")


def run_and_watch(profile, startat=0, wait_until=None, resume_state=None):
    # Set max kiln temp; kiln shuts down automatically if safety
    # thermocouple reaches this temperature
    max_temp = profile.get_max_temp()
    if (config.temp_scale == "f"):
        max_temp = (max_temp - 32.0) * 5.0 / 9.0
    max_temp += 40  # add 40C to max temp for safety
    if hasattr(ovenWatcher.oven, 'output'):
        ovenWatcher.oven.output.resetArduino()
        time.sleep(1)
    log.info("Kiln Watcher MAX set to {0}C".format(max_temp))
    ovenWatcher.set_max_temp(max_temp)

    oven.run_profile(profile, startat=startat, wait_until=wait_until, resume_state=resume_state)
    ovenWatcher.record(profile, resuming=resume_state is not None)


def compute_aim_wait_until(profile, msgdict):
    '''For an aimed start, back-compute the epoch start time so that the
    chosen segment's target temperature is reached at the requested clock
    time. Returns None for a normal (start-now) run.'''
    aim_segment = msgdict.get('aim_segment')
    aim_time = msgdict.get('aim_time')   # epoch seconds
    if aim_segment is None or aim_time is None:
        return None
    try:
        idx = int(aim_segment)
        aim_time = float(aim_time)
    except (TypeError, ValueError):
        return None
    # start from the kiln's current temperature so the first ramp is realistic
    try:
        current_temp = oven.board.temp_sensor.temperature + config.thermocouple_offset
    except Exception:
        current_temp = profile.start_temp
    offset = profile.nominal_time_to_segment(idx, current_temp)
    wait_until = aim_time - offset
    log.info("aimed start: segment %d target in ~%ds, start at epoch %d"
             % (idx, int(offset), int(wait_until)))
    return wait_until
    

def get_profiles():
    try:
        profile_files = os.listdir(profile_path)
    except:
        profile_files = []
    profiles = []
    for filename in sorted(profile_files):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(profile_path, filename), 'r') as f:
                profile = json.load(f)
        except Exception as e:
            log.error("could not load profile %s: %s" % (filename, e))
            continue
        if profile.get("rth"):
            # rebuild the displayed curve from the rate/temp/hold segments
            # so the graph matches what the controller will run
            try:
                segs = rth_to_segments(profile["rth"])
                start_temp = profile["data"][0][1] if profile.get("data") else 100
                profile["data"] = segments_to_points(segs, start_temp)
            except Exception as e:
                log.error("could not build curve for rth profile %s: %s" % (filename, e))
        profiles.append(profile)
    return profiles


def save_profile(profile, force=False):
    profile_json = json.dumps(profile)
    filename = profile['name']+".json"
    filepath = os.path.join(profile_path, filename)
    if not force and os.path.exists(filepath):
        log.error("Could not write, %s already exists" % filepath)
        return False
    with open(filepath, 'w+') as f:
        f.write(profile_json)
        f.close()
    log.info("Wrote %s" % filepath)
    return True

def delete_profile(profile):
    profile_json = json.dumps(profile)
    filename = profile['name']+".json"
    filepath = os.path.join(profile_path, filename)
    os.remove(filepath)
    log.info("Deleted %s" % filepath)
    return True


def get_config():
    return json.dumps({"temp_scale": config.temp_scale,
        "time_scale_slope": config.time_scale_slope,
        "time_scale_profile": config.time_scale_profile,
        "kwh_rate": config.kwh_rate,
        "currency_type": config.currency_type,
        "controller_id": controller["id"],
        "controller_name": controller["name"]})


def main():
    ip = "0.0.0.0"
    port = config.listening_port
    log.debug("listening on %s:%d" % (ip, port))

    server = WSGIServer((ip, port), app,
                        handler_class=WebSocketHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
