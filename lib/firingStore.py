'''Persistent per-firing records.

Each firing is captured as a self-contained bundle under
``config.firings_directory/<id>/``:

  record.json    - summary + embedded profile snapshot + user metadata
  samples.ndjson - one oven get_state() dict per line, appended live
  (events.ndjson and photos/ are added by later phases)

Capture is near-real-time and crash-safe: samples are appended as they are
produced and record.json is rewritten on progress, so a power loss mid-firing
leaves a valid partial bundle whose status stays "running" (a truthful marker
that the firing was interrupted). See docs/firing-tracking.md.

This module owns only serialization; the OvenWatcher decides when to start,
append, continue (on resume), and finalize a bundle.
'''

import os
import json
import uuid
import logging
import datetime

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# bundle file names
RECORD = "record.json"
SAMPLES = "samples.ndjson"

# terminal statuses
RUNNING = "running"
COMPLETED = "completed"
ABORTED = "aborted"
ERROR = "error"
INTERRUPTED = "interrupted"


def _utcnow():
    return datetime.datetime.utcnow()


def _iso(dt):
    '''ISO-8601 UTC with a trailing Z, e.g. 2026-06-22T21:23:13Z.'''
    return dt.replace(microsecond=0).isoformat() + "Z"


def _id_from(dt):
    '''Filesystem-safe UTC timestamp id, e.g. 2026-06-22T21-23-13Z.'''
    return dt.replace(microsecond=0).isoformat().replace(":", "-") + "Z"


def _empty_metadata():
    return {
        "title": "",
        "tags": [],
        "fields": {},
        "outcome": {
            "rating": None,
            "summary": "",
            "defects": [],
            "went_well": "",
            "went_wrong": "",
        },
        "photos": [],
    }


def _atomic_write_json(path, obj):
    '''Write JSON atomically so a crash mid-write can't corrupt the file.'''
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class FiringRecorder(object):
    '''An open firing bundle. Appends samples and maintains the record.json
    summary. One instance per active (or resumed) firing.'''

    def __init__(self, dirpath, record):
        self.dirpath = dirpath
        self.record = record
        self._samples = open(os.path.join(dirpath, SAMPLES), "a", encoding="utf-8")
        # remember segment so we only rewrite record.json on real progress
        self._last_segment = record["summary"].get("segment")
        # firing-clock seconds of the last sample; this is the meaningful
        # duration (it doesn't advance while a run is stopped), unlike wall time
        self._last_runtime = record["summary"].get("duration_s") or 0

    @property
    def id(self):
        return self.record["id"]

    def append_sample(self, state):
        '''Append one state dict and fold it into the running summary.'''
        self._samples.write(json.dumps(state, ensure_ascii=False) + "\n")
        self._samples.flush()

        s = self.record["summary"]
        temp = state.get("temperature")
        if isinstance(temp, (int, float)) and (s["max_temp"] is None or temp > s["max_temp"]):
            s["max_temp"] = temp
        target = state.get("target")
        if isinstance(target, (int, float)) and (s["peak_target"] is None or target > s["peak_target"]):
            s["peak_target"] = target
        if isinstance(state.get("cost"), (int, float)):
            s["total_cost"] = state["cost"]
        if state.get("currency_type"):
            s["currency_type"] = state["currency_type"]
        if state.get("segments"):
            s["segment_count"] = len(state["segments"])
        if isinstance(state.get("runtime"), (int, float)):
            self._last_runtime = state["runtime"]

        # rewrite the summary when the run advances to a new segment so a
        # crashed firing's record.json still carries meaningful progress
        # (and records where an interrupted/aborted run stopped)
        seg = state.get("segment")
        if seg != self._last_segment:
            self._last_segment = seg
            s["segment"] = seg
            s["duration_s"] = int(self._last_runtime)
            self._flush_record()

    def finalize(self, status):
        '''Close out the bundle with a terminal status and final summary.'''
        s = self.record["summary"]
        s["status"] = status
        s["ended_at"] = _iso(_utcnow())
        # duration is firing-clock time (excludes any stopped/idle gaps), not
        # wall time between started_at and ended_at
        s["duration_s"] = int(self._last_runtime)
        self._flush_record()
        self.close()
        log.info("finalized firing %s as %s" % (self.id, status))

    def _flush_record(self):
        _atomic_write_json(os.path.join(self.dirpath, RECORD), self.record)

    def close(self):
        try:
            self._samples.close()
        except Exception:
            pass


def _ensure_dir(firings_dir):
    if not os.path.isdir(firings_dir):
        os.makedirs(firings_dir)


def start_firing(firings_dir, controller_id, profile_snapshot, initial_state):
    '''Create a new bundle and return an open FiringRecorder.'''
    _ensure_dir(firings_dir)
    started = _utcnow()
    fid = _id_from(started)
    dirpath = os.path.join(firings_dir, fid)
    # extremely unlikely same-second collision: disambiguate
    suffix = 1
    while os.path.exists(dirpath):
        dirpath = os.path.join(firings_dir, "%s-%d" % (fid, suffix))
        suffix += 1
    os.makedirs(dirpath)
    os.makedirs(os.path.join(dirpath, "photos"))

    record = {
        "id": os.path.basename(dirpath),
        "controller_id": controller_id,
        "schema_version": SCHEMA_VERSION,
        "summary": {
            "status": RUNNING,
            "started_at": _iso(started),
            "ended_at": None,
            "duration_s": None,
            "max_temp": None,
            "peak_target": None,
            "total_cost": initial_state.get("cost"),
            "currency_type": initial_state.get("currency_type"),
            "segment_count": len(initial_state["segments"]) if initial_state.get("segments") else None,
            "segment": initial_state.get("segment"),
        },
        "profile": profile_snapshot,
        "metadata": _empty_metadata(),
    }
    recorder = FiringRecorder(dirpath, record)
    recorder._flush_record()
    log.info("started firing bundle %s (profile=%s)"
             % (record["id"], profile_snapshot.get("name")))
    return recorder


def _read_record(dirpath):
    try:
        with open(os.path.join(dirpath, RECORD), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# a firing can be resumed while it is still mid-run (crashed -> running) or
# after a deliberate Stop (-> aborted); both continue the same bundle so the
# whole firing stays one record. completed/error/interrupted are final.
CONTINUABLE = (RUNNING, ABORTED)


def _iter_bundles(firings_dir):
    '''(mtime, dirpath, record) for every readable bundle, newest first.'''
    out = []
    try:
        names = os.listdir(firings_dir)
    except OSError:
        return out
    for name in names:
        dirpath = os.path.join(firings_dir, name)
        if not os.path.isdir(dirpath):
            continue
        rec = _read_record(dirpath)
        if rec:
            out.append((os.path.getmtime(dirpath), dirpath, rec))
    out.sort(reverse=True)
    return out


def continue_resumable(firings_dir, profile_name=None):
    '''Re-open the most recent continuable bundle for a resume, reverting it to
    running. Matches on profile name when given so an unrelated old aborted run
    isn't picked up. Returns an open FiringRecorder, or None if there's nothing
    to continue (e.g. records were cleared).'''
    for _, dirpath, rec in _iter_bundles(firings_dir):
        if rec["summary"].get("status") not in CONTINUABLE:
            continue
        if profile_name is not None and rec.get("profile", {}).get("name") != profile_name:
            continue
        rec["summary"]["status"] = RUNNING
        rec["summary"]["ended_at"] = None
        recorder = FiringRecorder(dirpath, rec)
        recorder._flush_record()
        log.info("continuing firing bundle %s on resume" % rec["id"])
        return recorder
    return None


def finalize_orphans(firings_dir, status=INTERRUPTED):
    '''Mark any leftover *running* bundles as interrupted. Called when a fresh
    firing starts so a crashed run doesn't linger as "running". Aborted bundles
    are left alone - they are intentional stops that may still be resumed.'''
    for _, dirpath, rec in _iter_bundles(firings_dir):
        if rec["summary"].get("status") != RUNNING:
            continue
        try:
            rec["summary"]["status"] = status
            rec["summary"]["ended_at"] = _iso(_utcnow())
            _atomic_write_json(os.path.join(dirpath, RECORD), rec)
            log.info("marked orphaned firing %s as %s" % (rec["id"], status))
        except Exception as e:
            log.error("could not finalize orphan %s: %s" % (dirpath, e))
