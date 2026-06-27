#!/usr/bin/env python
'''Backfill historical firing bundles from an old process.log.

The pre-tracking controller logged rich per-sample lines
(temp/target/heat_on/heat_off/run_time/total_time); this reconstructs firing
bundles (record.json + samples.ndjson + events.ndjson) from them so past
firings show up in the history UI.

Real firings are buried in noise (false starts, thermocouple-refused starts,
service restarts) and a single physical firing is often fragmented across many
restart/resume segments. So we: drop empty/refused segments, stitch consecutive
same-profile segments within a time gap into one firing, keep only firings with
enough samples, and re-base each sample's runtime to elapsed wall-seconds from
the firing start (fragments restart run_time at 0, which would otherwise fold
the curve back on itself). Restart seams become power_interruption/resumed
events.

Usage:
  python scripts/import_firings.py --log LOG --profiles DIR --out DIR \
      --controller-id ID [--min-samples 10] [--gap-min 60] [--dry-run]
'''
import os
import re
import sys
import json
import argparse
import datetime

HERE = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))
sys.path.insert(0, ROOT)

import firingStore
from scripts.schedule_converter import rth_to_segments, segments_to_points

TS = r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+"
re_run = re.compile(TS + r".*oven: Running schedule (.*) starting at (\d+) minutes")
re_temp = re.compile(TS + r".*oven: temp=([\d.-]+), target=([\d.-]+),.*"
                     r"heat_on=([\d.-]+), heat_off=([\d.-]+), run_time=(\d+), total_time=(\d+)")
re_svc = re.compile(TS + r".*kiln-controller: Starting kiln controller")
re_ended = re.compile(r"oven: schedule ended")
re_refuse = re.compile(r"Refusing to start profile")


def parse_ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def parse_segments(logpath):
    '''Split the log into run-segments, each with its profile and samples.'''
    segments, cur = [], None

    def close(reason):
        nonlocal cur
        if cur is not None:
            cur["end_reason"] = cur.get("end_reason") or reason
            segments.append(cur)
            cur = None

    for line in open(logpath, encoding="utf-8", errors="replace"):
        m = re_run.search(line)
        if m:
            close("superseded")
            cur = {"profile": m.group(2).rstrip(), "samples": [], "end_reason": None}
            continue
        if re_svc.search(line):
            close("interrupted")
            continue
        if cur is None:
            continue
        m = re_temp.search(line)
        if m:
            ts, temp, target, hon, hoff, rt, tt = m.groups()
            hon, hoff = float(hon), float(hoff)
            heat = hon / (hon + hoff) if (hon + hoff) else 0.0
            cur["samples"].append({"ts": parse_ts(ts), "temperature": float(temp),
                                   "target": float(target), "heat": heat, "totaltime": float(tt)})
            continue
        if re_ended.search(line):
            cur["end_reason"] = "completed"
        elif re_refuse.search(line):
            cur["end_reason"] = "refused"
    close("eof")
    return segments


def stitch(segments, gap_min):
    '''Group consecutive same-profile segments whose start follows the previous
    segment's last sample within gap_min minutes into one firing.'''
    groups, cur = [], None
    for seg in segments:
        if not seg["samples"]:
            continue
        start = seg["samples"][0]["ts"]
        if (cur and seg["profile"] == cur[-1]["profile"]
                and (start - cur[-1]["samples"][-1]["ts"]).total_seconds() <= gap_min * 60):
            cur.append(seg)
        else:
            if cur:
                groups.append(cur)
            cur = [seg]
    if cur:
        groups.append(cur)
    return groups


def load_profile_snapshot(profiles_dir, name):
    '''Embed the planned curve for `name` if a profile file exists, else just
    the name with an empty curve.'''
    path = os.path.join(profiles_dir, name + ".json")
    snap = {"name": name, "type": "profile", "data": []}
    if os.path.isfile(path):
        try:
            with open(path) as f:
                obj = json.load(f)
            if obj.get("rth"):
                segs = rth_to_segments(obj["rth"])
                start = obj["data"][0][1] if obj.get("data") else 100
                snap["data"] = segments_to_points(segs, start)
            elif obj.get("data"):
                snap["data"] = sorted(obj["data"])
        except Exception as e:
            print("  warn: could not load profile %r: %s" % (name, e))
    return snap


STATUS_MAP = {"completed": firingStore.COMPLETED, "interrupted": firingStore.INTERRUPTED,
              "superseded": firingStore.ABORTED, "eof": firingStore.ABORTED,
              "refused": firingStore.ERROR}


def build_firing(group):
    '''Turn a stitched group of fragments into (samples, events, status,
    started_dt, ended_dt) with elapsed-wall runtimes and seam events.'''
    start_dt = group[0]["samples"][0]["ts"]
    samples, events = [], []
    events.append({"ts": firingStore._iso(start_dt), "type": firingStore.EV_STARTED,
                   "runtime": 0, "detail": {"profile": group[0]["profile"], "fragments": len(group)}})
    last_dt = start_dt
    for i, seg in enumerate(group):
        if i > 0:
            # restart seam between the previous fragment and this one
            gap_end = seg["samples"][0]["ts"]
            rt_prev = round((last_dt - start_dt).total_seconds(), 1)
            rt_now = round((gap_end - start_dt).total_seconds(), 1)
            events.append({"ts": firingStore._iso(last_dt), "type": firingStore.EV_POWER_INTERRUPTION,
                           "runtime": rt_prev})
            events.append({"ts": firingStore._iso(gap_end), "type": firingStore.EV_RESUMED,
                           "runtime": rt_now, "detail": {"gap_s": int((gap_end - last_dt).total_seconds())}})
        for s in seg["samples"]:
            elapsed = (s["ts"] - start_dt).total_seconds()
            samples.append({"runtime": round(elapsed, 1),
                            "temperature": round(s["temperature"], 2),
                            "target": round(s["target"], 2),
                            "heat": round(s["heat"], 3),
                            "totaltime": round(s["totaltime"], 1)})
            last_dt = s["ts"]
    # status: any fragment completed -> completed, else the last fragment's reason
    if any(seg["end_reason"] == "completed" for seg in group):
        status = firingStore.COMPLETED
    else:
        status = STATUS_MAP.get(group[-1]["end_reason"], firingStore.INTERRUPTED)
    events.append({"ts": firingStore._iso(last_dt), "type": status,
                   "runtime": round((last_dt - start_dt).total_seconds(), 1)})
    return samples, events, status, start_dt, last_dt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--profiles", required=True)
    ap.add_argument("--out", required=True, help="firings directory")
    ap.add_argument("--controller-id", required=True)
    ap.add_argument("--min-samples", type=int, default=10)
    ap.add_argument("--gap-min", type=int, default=60)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    segments = parse_segments(args.log)
    groups = [g for g in stitch(segments, args.gap_min)
              if sum(len(s["samples"]) for s in g) >= args.min_samples]

    print("%-3s %-19s %-26s %4s %5s %6s %6s %-11s" %
          ("#", "started", "profile", "frag", "samp", "dur_h", "maxT", "status"))
    plan = []
    for i, g in enumerate(groups):
        samples, events, status, start_dt, end_dt = build_firing(g)
        maxT = max((s["temperature"] for s in samples), default=0)
        dur_h = (end_dt - start_dt).total_seconds() / 3600
        print("%-3d %-19s %-26.26s %4d %5d %6.1f %6.0f %-11s" %
              (i, start_dt.isoformat(sep=" "), g[0]["profile"], len(g), len(samples), dur_h, maxT, status))
        plan.append((g[0]["profile"], samples, events, status, start_dt, end_dt))

    print("\n%d firings (%s)" % (len(plan), "DRY RUN - nothing written" if args.dry_run else "writing"))
    if args.dry_run:
        return
    for profile_name, samples, events, status, start_dt, end_dt in plan:
        snap = load_profile_snapshot(args.profiles, profile_name)
        fid = firingStore.import_firing(args.out, args.controller_id, snap,
                                        samples, events, status, start_dt, end_dt)
        print("  wrote", fid)


if __name__ == "__main__":
    main()
