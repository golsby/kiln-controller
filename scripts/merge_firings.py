#!/usr/bin/env python
'''Merge one firing bundle into another (they were physically the same firing).

Use when an older firing was split across two bundles because the operator had
to stop and start a new profile mid-firing (before hold/resume existed). The
`--from` firing's samples/events are shifted onto the `--into` firing's timeline
by the wall-clock gap between their start times, the two planned curves are
concatenated, and the seam is recorded as a power_interruption/resumed pair. The
result overwrites `--into` (keeping its id); `--from` is removed.

Usage:
  python scripts/merge_firings.py --dir storage/firings \
      --into 2026-06-22T21-23-13Z --from 2026-06-23T07-23-09Z [--name "..."] [--dry-run]
'''
import os
import sys
import json
import shutil
import argparse
import datetime

FMT = "%Y-%m-%dT%H:%M:%SZ"


def load(d, fid):
    base = os.path.join(d, fid)
    rec = json.load(open(os.path.join(base, "record.json")))
    samps = [json.loads(l) for l in open(os.path.join(base, "samples.ndjson")) if l.strip()]
    epath = os.path.join(base, "events.ndjson")
    evs = [json.loads(l) for l in open(epath) if l.strip()] if os.path.exists(epath) else []
    return rec, samps, evs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--into", required=True, help="earlier firing id (kept)")
    ap.add_argument("--from", dest="frm", required=True, help="later firing id (merged in, then removed)")
    ap.add_argument("--name", help="override the merged profile name")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    arec, asamps, aevs = load(args.dir, args.into)
    brec, bsamps, bevs = load(args.dir, args.frm)
    ta = datetime.datetime.strptime(arec["summary"]["started_at"], FMT)
    tb = datetime.datetime.strptime(brec["summary"]["started_at"], FMT)
    offset = round((tb - ta).total_seconds(), 1)
    if offset <= 0:
        sys.exit("--from must start after --into (offset=%s)" % offset)

    # samples: A as-is, then B shifted onto A's timeline
    merged_samps = asamps + [dict(s, runtime=round(s["runtime"] + offset, 1)) for s in bsamps]

    # events: keep A's start; turn the stop->new-profile->restart into a
    # power_interruption/resumed seam; append B's events (minus its own start)
    a_started = [e for e in aevs if e["type"] == "started"]
    seam = [
        {"ts": arec["summary"]["ended_at"], "type": "power_interruption",
         "runtime": asamps[-1]["runtime"], "detail": {"reason": "stopped to switch profile"}},
        {"ts": brec["summary"]["started_at"], "type": "resumed",
         "runtime": round(bsamps[0]["runtime"] + offset, 1),
         "detail": {"from_status": "aborted", "new_profile": brec["profile"]["name"]}},
    ]
    b_rest = [dict(e, runtime=round(e.get("runtime", 0) + offset, 1)) for e in bevs if e["type"] != "started"]
    merged_evs = a_started + seam + b_rest

    # planned curve: A's plan up to the switch, then B's plan shifted
    a_data = [p for p in arec["profile"]["data"] if p[0] <= offset]
    b_data = [[round(p[0] + offset, 1), p[1]] for p in brec["profile"]["data"]]
    name = args.name or (arec["profile"]["name"] + " → " + brec["profile"]["name"]
                         if arec["profile"]["name"] != brec["profile"]["name"] else arec["profile"]["name"])

    temps = [s["temperature"] for s in merged_samps]
    targets = [s["target"] for s in merged_samps]
    summary = dict(arec["summary"])
    summary.update({
        "status": brec["summary"]["status"],
        "ended_at": brec["summary"]["ended_at"],
        "duration_s": int(merged_samps[-1]["runtime"]),
        "max_temp": max(temps), "peak_target": max(targets),
    })
    rec = dict(arec)
    rec["summary"] = summary
    rec["profile"] = {"name": name, "type": "profile", "data": a_data + b_data}
    rec["imported"] = True

    print("merge %s <- %s" % (args.into, args.frm))
    print("  offset: %.0fs (%.1fh)  merged samples: %d  events: %d"
          % (offset, offset / 3600, len(merged_samps), len(merged_evs)))
    print("  name: %s" % name)
    print("  duration: %.1fh  max_temp: %.0f  status: %s"
          % (summary["duration_s"] / 3600, summary["max_temp"], summary["status"]))
    if args.dry_run:
        print("  DRY RUN - nothing written")
        return

    base = os.path.join(args.dir, args.into)
    with open(os.path.join(base, "record.json"), "w") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    with open(os.path.join(base, "samples.ndjson"), "w") as f:
        for s in merged_samps:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(os.path.join(base, "events.ndjson"), "w") as f:
        for e in merged_evs:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    try:
        shutil.rmtree(os.path.join(args.dir, args.frm))
        print("  removed %s" % args.frm)
    except Exception as e:
        print("  WARNING: could not remove %s: %s (remove it manually)" % (args.frm, e))


if __name__ == "__main__":
    main()
