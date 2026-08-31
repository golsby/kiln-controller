#!/usr/bin/env python3
"""Package a generated part in parts/ into a .fzpz you can drag into Fritzing.

parts/ is laid out as an UNZIPPED .fzpz: `part.<id>.fzp` beside
`svg.<view>.<file>.svg`.  That flat, dot-separated naming is what Fritzing
expects inside a zip - both in a .fzpz (one part) and in a .fzz (a whole
sketch), which is why the same files serve both.

Dragging the loose .fzp in does NOT work.  A loose .fzp is resolved against the
`image=` paths in its own view stanzas, so Fritzing rewrites
`breadboard/foo_breadboard.svg` to `breadboard.foo_breadboard.svg` and looks for
that next to the .fzp - no `svg.` prefix.  It is not there, and you get
"Local part ... incomplete, subfile not found".  Zip it and the prefix is
correct again.

    python3 tools/make_fzpz.py T92P7D22_12_kilnmains
    python3 tools/make_fzpz.py --all
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARTS = os.path.join(os.path.dirname(HERE), "parts")
VIEWS = ("breadboard", "schematic", "pcb", "icon")


def module_ids():
    return sorted(f[len("part."):-len(".fzp")] for f in os.listdir(PARTS)
                  if f.startswith("part.") and f.endswith(".fzp"))


def package(module_id, out_dir=PARTS):
    members = [f"part.{module_id}.fzp"]
    members += [f"svg.{v}.{module_id}_{v}.svg" for v in VIEWS]

    missing = [m for m in members if not os.path.exists(os.path.join(PARTS, m))]
    if missing:
        raise SystemExit(f"{module_id}: missing {', '.join(missing)} - "
                         "run tools/gen_parts.py first")

    out = os.path.join(out_dir, f"{module_id}.fzpz")
    # Deterministic: fixed timestamp, sorted members, so re-running does not
    # churn the file for no reason.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for m in members:
            info = zipfile.ZipInfo(m, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(PARTS, m), "rb") as fh:
                z.writestr(info, fh.read())
    return out, members


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(f"usage: {sys.argv[0]} <moduleId> | --all\n"
                         f"available: {', '.join(module_ids())}")
    targets = module_ids() if args[0] == "--all" else args
    for mid in targets:
        out, members = package(mid)
        print(f"wrote {os.path.relpath(out, os.path.dirname(HERE))}"
              f"  ({len(members)} files, {os.path.getsize(out)} bytes)")
