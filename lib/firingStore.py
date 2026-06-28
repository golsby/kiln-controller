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
import threading

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# bundle file names
RECORD = "record.json"
SAMPLES = "samples.ndjson"
EVENTS = "events.ndjson"

# event types written to events.ndjson (the firing's narrative). Imported by
# ovenWatcher and oven so the vocabulary lives in one place.
EV_STARTED = "started"
EV_COMPLETED = "completed"
EV_ABORTED = "aborted"
EV_ERROR = "error"
EV_HOLD = "hold"                       # manual hold engaged
EV_HOLD_RELEASE = "hold_release"       # manual hold released
EV_ADVANCE = "advance"                 # user skipped to the next segment
EV_SEGMENT_TARGET_EDIT = "segment_target_edit"
EV_SEGMENT_HOLD_EDIT = "segment_hold_edit"
EV_SEGMENT_TRANSITION = "segment_transition"   # ramp<->hold / next segment
EV_POWER_INTERRUPTION = "power_interruption"   # run was interrupted (crash/outage)
EV_RESUMED = "resumed"                 # capture continued an interrupted run

# Only the fields needed to graph a firing (and reconstruct an idealized curve
# from it) are persisted per sample. The live /status websocket still carries
# the full get_state(); everything constant or derived - profile name, cost,
# kwh_rate, currency, the upcoming-segments array, pidstats, resume_* - lives
# once in record.json instead of being duplicated on every line.
# (state is omitted: samples are only captured while the oven is RUNNING, so it
# would be a constant "RUNNING" on every line. Run-state changes are recorded as
# discrete events in events.ndjson instead.)
SAMPLE_FIELDS = ("runtime", "temperature", "target", "heat", "totaltime")

# per-field rounding to drop sensor/control precision-noise that bloats lines
# but adds nothing to a graph (thermocouple resolution is ~0.25 deg)
_SAMPLE_ROUND = {"runtime": 1, "temperature": 2, "target": 2, "heat": 3, "totaltime": 1}


def _project_sample(state):
    '''Reduce a full oven state to the slim set persisted per line.'''
    line = {}
    for k in SAMPLE_FIELDS:
        if k not in state:
            continue
        v = state[k]
        nd = _SAMPLE_ROUND.get(k)
        if nd is not None and isinstance(v, (int, float)):
            v = round(v, nd)
        line[k] = v
    return line

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
        self._events = open(os.path.join(dirpath, EVENTS), "a", encoding="utf-8")
        # events are written from both the watcher thread and the control
        # greenlet (via oven methods), so guard the events file + closed flag
        self._event_lock = threading.Lock()
        # serializes record.json writes (watcher thread flushes the summary while
        # the control greenlet may be editing notes/photos on the same bundle)
        self._record_lock = threading.Lock()
        self._closed = False
        # remember segment so we only rewrite record.json on real progress
        self._last_segment = record["summary"].get("segment")
        # firing-clock seconds of the last sample; this is the meaningful
        # duration (it doesn't advance while a run is stopped), unlike wall time
        self._last_runtime = record["summary"].get("duration_s") or 0
        # set by continue_resumable to the status the bundle had before resume
        # (running = crash/outage, aborted = deliberate stop) so the watcher can
        # emit the right power_interruption/resumed events
        self.resumed_from = None

    @property
    def id(self):
        return self.record["id"]

    @property
    def last_runtime(self):
        return self._last_runtime

    def append_event(self, etype, runtime=None, detail=None):
        '''Append one discrete event to the firing's narrative. Thread-safe and
        a no-op once the bundle is finalized.'''
        evt = {"ts": _iso(_utcnow()), "type": etype}
        if isinstance(runtime, (int, float)):
            evt["runtime"] = round(runtime, 1)
        if detail:
            evt["detail"] = detail
        with self._event_lock:
            if self._closed:
                return
            self._events.write(json.dumps(evt, ensure_ascii=False) + "\n")
            self._events.flush()
        log.info("firing %s event: %s %s" % (self.id, etype, detail or ""))

    def append_sample(self, state):
        '''Persist a slim per-sample line, but fold the full state into the
        summary (so cost/segment counts/etc. are kept once in record.json).'''
        self._samples.write(json.dumps(_project_sample(state), ensure_ascii=False) + "\n")
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

    def _write_record(self):
        _atomic_write_json(os.path.join(self.dirpath, RECORD), self.record)

    def _flush_record(self):
        with self._record_lock:
            self._write_record()

    # --- live edits to the active firing (notes/photos) ---------------------
    # These mutate the in-memory record and flush, so the watcher's own flushes
    # can't clobber them. Route handlers delegate here when fid is the active
    # firing; otherwise the disk-based firingStore.* functions are used.

    def update_metadata(self, patch):
        with self._record_lock:
            m = _merge_metadata(self.record.setdefault("metadata", _empty_metadata()), patch)
            self._write_record()
        return m

    def add_photo(self, upload, runtime=None):
        name = _save_upload(os.path.join(self.dirpath, "photos"), upload)
        if name is None:
            return None
        if runtime is None:
            runtime = self._last_runtime
        with self._record_lock:
            self.record.setdefault("metadata", _empty_metadata()).setdefault("photos", []).append(
                _photo_entry(name, runtime))
            self._write_record()
        return name

    def update_photo(self, name, patch):
        with self._record_lock:
            photos = self.record.setdefault("metadata", _empty_metadata()).setdefault("photos", [])
            p = _merge_photo(photos, name, patch)
            if p is not None:
                self._write_record()
        return p

    def delete_photo(self, name):
        if os.path.basename(name) != name:
            return False
        fpath = os.path.join(self.dirpath, "photos", name)
        if os.path.isfile(fpath):
            os.remove(fpath)
        with self._record_lock:
            photos = self.record.get("metadata", {}).get("photos", [])
            self.record["metadata"]["photos"] = [p for p in photos if p.get("file") != name]
            self._write_record()
        return True

    def close(self):
        with self._event_lock:
            self._closed = True
            for f in (self._samples, self._events):
                try:
                    f.close()
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


def import_firing(firings_dir, controller_id, profile_snapshot, samples, events,
                  status, started_dt, ended_dt):
    '''Write a complete historical firing bundle in one shot (backfill from an
    old log). `samples`/`events` are lists already in the persisted shape;
    summary stats are computed from the samples. Marks the record `imported` so
    the UI can show that its status/metadata were reconstructed, not captured
    live. Returns the bundle id.'''
    _ensure_dir(firings_dir)
    fid = _id_from(started_dt)
    dirpath = os.path.join(firings_dir, fid)
    suffix = 1
    while os.path.exists(dirpath):
        dirpath = os.path.join(firings_dir, "%s-%d" % (fid, suffix))
        suffix += 1
    os.makedirs(dirpath)
    os.makedirs(os.path.join(dirpath, "photos"))

    temps = [s["temperature"] for s in samples if isinstance(s.get("temperature"), (int, float))]
    targets = [s["target"] for s in samples if isinstance(s.get("target"), (int, float))]
    runtimes = [s["runtime"] for s in samples if isinstance(s.get("runtime"), (int, float))]
    record = {
        "id": os.path.basename(dirpath),
        "controller_id": controller_id,
        "schema_version": SCHEMA_VERSION,
        "imported": True,
        "summary": {
            "status": status,
            "started_at": _iso(started_dt),
            "ended_at": _iso(ended_dt) if ended_dt else None,
            "duration_s": int(max(runtimes)) if runtimes else None,
            "max_temp": max(temps) if temps else None,
            "peak_target": max(targets) if targets else None,
            "total_cost": None,
            "currency_type": None,
            "segment_count": None,
            "segment": None,
        },
        "profile": profile_snapshot,
        "metadata": _empty_metadata(),
    }
    _atomic_write_json(os.path.join(dirpath, RECORD), record)
    with open(os.path.join(dirpath, SAMPLES), "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(os.path.join(dirpath, EVENTS), "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    log.info("imported firing %s (%d samples, status %s)" % (record["id"], len(samples), status))
    return record["id"]


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
        prior_status = rec["summary"].get("status")
        rec["summary"]["status"] = RUNNING
        rec["summary"]["ended_at"] = None
        recorder = FiringRecorder(dirpath, rec)
        recorder.resumed_from = prior_status
        recorder._flush_record()
        log.info("continuing firing bundle %s on resume (was %s)" % (rec["id"], prior_status))
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


# ---------------------------------------------------------------------------
# read side (the /api/firings surface; later fronted by the cloud proxy)
# ---------------------------------------------------------------------------

def _read_ndjson(path):
    '''Parse an NDJSON file into a list, skipping any malformed/partial lines
    (the last line of a crashed firing may be truncated).'''
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return rows


def _downsample(rows, maxpts):
    '''Thin rows to about maxpts points, always keeping the last one so the end
    of the firing is shown.'''
    n = len(rows)
    if not maxpts or maxpts < 2 or n <= maxpts:
        return rows
    every = max(1, int(n / (maxpts - 1)))
    out = rows[::every]
    if out[-1] is not rows[-1]:
        out.append(rows[-1])
    return out


def list_firings(firings_dir):
    '''Lightweight summaries for the history list, newest first. Excludes the
    per-firing time-series and the full profile curve (just its name) to keep
    the listing cheap.'''
    items = []
    for _, _dirpath, rec in _iter_bundles(firings_dir):
        meta = rec.get("metadata", {})
        items.append({
            "id": rec.get("id"),
            "controller_id": rec.get("controller_id"),
            "profile_name": (rec.get("profile") or {}).get("name"),
            "summary": rec.get("summary", {}),
            "title": meta.get("title", ""),
            "tags": meta.get("tags", []),
        })
    # newest firing first by when it actually ran, not when its bundle was
    # written (an imported firing's file is newer than its firing date)
    items.sort(key=lambda it: it["summary"].get("started_at") or "", reverse=True)
    return items


def _bundle_dir(firings_dir, fid):
    '''Resolve a firing id to its bundle dir, rejecting anything that isn't a
    plain bundle name (path-traversal safety on the :id URL segment).'''
    if not fid or os.path.basename(fid) != fid:
        return None
    dirpath = os.path.join(firings_dir, fid)
    if os.path.isdir(dirpath) and os.path.isfile(os.path.join(dirpath, RECORD)):
        return dirpath
    return None


def get_firing(firings_dir, fid, resolution=None):
    '''Full record + events + (optionally downsampled) samples for one firing,
    or None if the id is unknown/invalid. `resolution` caps the number of
    sample points returned; None returns them all.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None:
        return None
    rec = _read_record(dirpath)
    if rec is None:
        return None
    samples = _read_ndjson(os.path.join(dirpath, SAMPLES))
    rec["events"] = _read_ndjson(os.path.join(dirpath, EVENTS))
    rec["sample_count"] = len(samples)
    rec["samples"] = _downsample(samples, resolution)
    return rec


# ---------------------------------------------------------------------------
# write side: user metadata, photos, delete (the editable surface)
# ---------------------------------------------------------------------------

PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"}


def _clean_str(v, limit):
    return str(v if v is not None else "")[:limit]


# --- pure helpers shared by the disk functions and the live FiringRecorder ---

def _merge_metadata(m, patch):
    '''Merge a user-metadata patch into metadata dict `m` in place (title, tags,
    outcome only); returns m.'''
    if isinstance(patch, dict):
        if "title" in patch:
            m["title"] = _clean_str(patch["title"], 200)
        if isinstance(patch.get("tags"), list):
            m["tags"] = [_clean_str(t, 40) for t in patch["tags"] if str(t).strip()][:30]
        if isinstance(patch.get("outcome"), dict):
            o = m.setdefault("outcome", {})
            po = patch["outcome"]
            if "rating" in po:
                try:
                    r = int(po["rating"])
                    o["rating"] = r if 1 <= r <= 5 else None
                except (TypeError, ValueError):
                    o["rating"] = None
            if "summary" in po:
                o["summary"] = _clean_str(po["summary"], 5000)
            if isinstance(po.get("defects"), list):
                o["defects"] = [_clean_str(d, 40) for d in po["defects"] if str(d).strip()][:30]
    return m


def _photo_entry(name, runtime=None):
    '''A photo metadata entry. `runtime` (firing-clock seconds) places it on the
    timeline/graph; None for photos added outside a firing.'''
    e = {"file": name, "note": ""}
    if isinstance(runtime, (int, float)):
        e["runtime"] = round(runtime, 1)
    return e


def _merge_photo(photos, name, patch):
    '''Merge note/runtime into the matching photo entry; returns it or None.'''
    for p in photos:
        if p.get("file") == name:
            if "note" in patch:
                p["note"] = _clean_str(patch.get("note"), 500)
            if "runtime" in patch:
                rt = patch["runtime"]
                p["runtime"] = round(rt, 1) if isinstance(rt, (int, float)) else None
            return p
    return None


def _save_upload(photos_dir, upload):
    '''Save a bottle FileUpload under a server-chosen, collision-free name.
    Returns the filename, or None if the type isn't an allowed image.'''
    ext = os.path.splitext(getattr(upload, "raw_filename", "") or getattr(upload, "filename", "") or "")[1].lower()
    if ext not in PHOTO_EXTS:
        return None
    if not os.path.isdir(photos_dir):
        os.makedirs(photos_dir)
    n = 1
    while os.path.exists(os.path.join(photos_dir, "photo-%d%s" % (n, ext))):
        n += 1
    name = "photo-%d%s" % (n, ext)
    upload.save(os.path.join(photos_dir, name))
    return name


def update_metadata(firings_dir, fid, patch):
    '''Merge an edit into a firing's user metadata and persist it (disk path,
    for firings that are NOT currently recording). Returns the new metadata, or
    None if the firing is unknown.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None:
        return None
    rec = _read_record(dirpath)
    if rec is None:
        return None
    m = _merge_metadata(rec.setdefault("metadata", _empty_metadata()), patch)
    _atomic_write_json(os.path.join(dirpath, RECORD), rec)
    log.info("updated metadata for firing %s" % fid)
    return m


def delete_firing(firings_dir, fid):
    '''Delete a firing bundle and everything in it. Returns True on success.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None:
        return False
    import shutil
    shutil.rmtree(dirpath)
    log.info("deleted firing %s" % fid)
    return True


def add_photo(firings_dir, fid, upload, runtime=None):
    '''Save an uploaded photo into the bundle's photos/ dir and register it in
    metadata (disk path). `upload` is a bottle FileUpload; `runtime` places it on
    the timeline/graph. Returns the stored filename, or None on failure.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None:
        return None
    name = _save_upload(os.path.join(dirpath, "photos"), upload)
    if name is None:
        return None
    rec = _read_record(dirpath)
    if rec is not None:
        rec.setdefault("metadata", _empty_metadata()).setdefault("photos", []).append(
            _photo_entry(name, runtime))
        _atomic_write_json(os.path.join(dirpath, RECORD), rec)
    log.info("added photo %s to firing %s" % (name, fid))
    return name


def update_photo(firings_dir, fid, name, patch):
    '''Set a photo's note/runtime (disk path). Returns the photo entry or None.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None or os.path.basename(name) != name:
        return None
    rec = _read_record(dirpath)
    if rec is None:
        return None
    photos = rec.setdefault("metadata", _empty_metadata()).setdefault("photos", [])
    p = _merge_photo(photos, name, patch)
    if p is not None:
        _atomic_write_json(os.path.join(dirpath, RECORD), rec)
    return p


def delete_photo(firings_dir, fid, name):
    '''Remove one photo file and its metadata entry. Returns True on success.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None or os.path.basename(name) != name:
        return False
    fpath = os.path.join(dirpath, "photos", name)
    if os.path.isfile(fpath):
        os.remove(fpath)
    rec = _read_record(dirpath)
    if rec is not None:
        photos = rec.get("metadata", {}).get("photos", [])
        rec["metadata"]["photos"] = [p for p in photos if p.get("file") != name]
        _atomic_write_json(os.path.join(dirpath, RECORD), rec)
    return True


def photo_fullpath(firings_dir, fid, name):
    '''Resolve a photo to an on-disk path for serving, or None if invalid.'''
    dirpath = _bundle_dir(firings_dir, fid)
    if dirpath is None or os.path.basename(name) != name:
        return None
    fpath = os.path.join(dirpath, "photos", name)
    return fpath if os.path.isfile(fpath) else None
