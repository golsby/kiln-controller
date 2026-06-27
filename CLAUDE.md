# CLAUDE.md

Guidance for working in this repo. This is a Raspberry Pi **kiln controller**: a Python
backend driving kiln hardware (heating elements via GPIO, thermocouple temperature sensing,
an independent over-temp safety watcher) plus a browser dashboard for running firing schedules.

## Run it locally (simulator)

Local dev runs in **simulator mode** — no real GPIO/I2C hardware required.

```bash
venv/bin/python kiln-controller.py        # serves http://localhost:8080/ (redirects to /kiln/index.html)
```

Behaviour is controlled by `config.py`, which reads a few overrides from the environment
(loaded from a **gitignored `.env`** by `loadenv.py` — present only on dev machines):

- `KILN_DEBUG=true` — enables debug logging AND `simulate` mode; also moves the port to 8080 (production uses 80).
- `KILN_SIM_SPEEDUP=N` — run a simulated firing N× faster than real time (default 60 in debug). Useful for exercising a whole schedule in seconds.
- `PURE_PYTHON=1` — **required on macOS**: the installed gevent/greenlet C extensions have a binary mismatch, so force pure-Python gevent or imports fail.
- `PAGERDUTY_ROUTING_KEY` — optional, enables the watcher over-temp PagerDuty alert path.

`.env` is gitignored on purpose: the same committed `config.py` behaves as a dev simulator
locally and as the real controller in production, with no per-environment code changes.
Never commit `.env`, and never copy dev `.env` settings onto the production device.

Quick config sanity check:
```bash
KILN_DEBUG=true venv/bin/python -c "import config; print(config.DEBUG, config.simulate, config.listening_port, config.sim_speedup)"
```

## Dependencies

`requirements.txt` (bottle, gevent, gevent-websocket, RPi.GPIO, Adafruit MAX31855, requests, …).
A `venv/` is used locally (`venv/bin/python`, `venv/bin/pip`).

## Checks before shipping

There is no test suite; validate syntax directly:
```bash
python3 -m py_compile kiln-controller.py lib/oven.py lib/ovenWatcher.py config.py
node --check public/assets/js/picoreflow.js
```

## Architecture

- **`kiln-controller.py`** — `bottle` app served by `gevent.pywsgi.WSGIServer` + `geventwebsocket`.
  Defines the HTTP routes, the 4 websockets (`/status`, `/control`, `/config`, `/storage`), and `/api`.
  **No `monkey.patch_all()`** — so the oven and watcher below are *real* `threading.Thread`s
  running alongside the gevent server. Don't assume gevent monkey-patching semantics.
- **`lib/oven.py`** — the control loop. `Oven.run()` drives a `SegmentScheduler`
  (RAMP / HOLD / DONE state machine) with rate-paced setpoints, a `PID`, and
  `SimulatedOven` / `RealOven` backends. Supports rate/temp/hold segments, dynamic ETA,
  Hold/Advance, runtime target/hold edits, and aimed start.
- **`lib/ovenWatcher.py`** — broadcasts state to websocket clients and polls the
  **independent Arduino over-temp safety watcher** (`lib/arduinoWatcher.py`, I2C). The watcher
  is only safety-critical *during a firing*; while idle the Arduino is often unpowered, so its
  I2C faults (`[Errno 121]`) are expected and logged at debug, not error. A genuine over-temp
  trip aborts the run.
- **`lib/max31855*.py`, `lib/max31856.py`** — thermocouple sensor drivers.
- **`config.py`** — single source of tuning/wiring/units (GPIO pins, PID gains, temp scale,
  emergency shutoff, simulator params). Read it before changing behaviour.
- **`public/`** — the web UI. `assets/js/picoreflow.js` holds all client logic; the 4 websockets
  there auto-reconnect and show a "Disconnected" banner (`#conn_banner`) when the link drops.
- Other entry points: `kiln-logger.py`, `kiln-tuner.py` (PID autotune), `watcher.py`,
  `process_log_to_csv.py`, `scripts/schedule_converter.py`.

## Production & deploy

Production runs on a Raspberry Pi as the `kiln-controller.service` systemd unit, serving on port 80.
Deploy is a `git pull` on the device:

- **Static assets** (`public/**`) are served straight from the repo — a pull is enough, **no restart**, safe to ship mid-firing (browser picks it up on reload).
- **Backend Python** takes effect only on `systemctl restart kiln-controller`.
- **A restart drops the contactor and resets the oven to IDLE — it does not auto-resume.** Never restart a live firing without resuming it afterward (the controller snapshots `resume.json` and supports a resume command via `/api`).

The exact SSH connection details, the resume procedure, and the safe restart-during-firing
sequence are operational specifics kept in the working Claude's local memory rather than here.

## Conventions

- Match the surrounding code style (this is an older codebase with mixed conventions).
- Commit/push only when asked. Keep secrets (`.env`, PagerDuty key) and `resume.json`/`state.json` out of git (already gitignored).
