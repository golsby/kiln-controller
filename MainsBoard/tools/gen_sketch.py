#!/usr/bin/env python3
"""Kiln Mains Board -> Fritzing .fzz  (schematic wired + PCB placed).

Schematic scene units are 90 dpi; 9 units = 0.1 in = one grid square.
The three supply rails (+12V, +5V, GND) are drawn with Fritzing power/ground
net labels rather than long wires, which is what keeps the sheet readable.
Everything else is routed as orthogonal Z runs (H, V, H).
"""
import os, re, zipfile, sqlite3, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
PARTS = os.path.join(PROJ, "parts")
PARTSROOT = "/Applications/Fritzing.app/Contents/Resources/fritzing-parts"
PARTSDB = PARTSROOT + "/parts.db"
BUILD = PROJ
IN = 90.0
G = 9.0
MM = 90.0 / 25.4

# ---------------------------------------------------------------- part I/O --
_dbpath = {}
def db_path(mid):
    if not _dbpath:
        for m, p in sqlite3.connect(PARTSDB).execute("select moduleID,path from parts"):
            _dbpath[m] = p
    return _dbpath.get(mid)


def find_fzp(mid):
    p = os.path.join(PARTS, f"part.{mid}.fzp")
    if os.path.exists(p):
        return p, "local"
    rel = db_path(mid)
    if rel:
        rel = rel.replace(":/resources/parts/", "")
        c = os.path.join(PARTSROOT, rel)
        if os.path.exists(c):
            return c, "core"
    return None, None


def _len_in(v, dpi=90.0):
    m = re.match(r"^([-\d.eE+]+)\s*([a-z%]*)$", v.strip())
    n, u = float(m.group(1)), m.group(2)
    return {"in": n, "mm": n/25.4, "cm": n/2.54, "pt": n/72.0, "pc": n/6.0,
            "px": n/dpi, "": n/dpi}[u]


NS = "{http://www.w3.org/2000/svg}"
def _iter(e):
    yield e
    for c in e:
        yield from _iter(c)


def _bbox(el):
    t = el.tag.replace(NS, ""); g = el.get
    try:
        if t in ("circle", "ellipse"):
            cx, cy = float(g("cx", 0)), float(g("cy", 0))
            rx = float(g("r", 0) or g("rx", 0)); ry = float(g("r", 0) or g("ry", 0))
            return cx-rx, cy-ry, cx+rx, cy+ry
        if t == "rect":
            x, y = float(g("x", 0)), float(g("y", 0))
            return x, y, x+float(g("width", 0)), y+float(g("height", 0))
        if t == "line":
            x1, y1 = float(g("x1")), float(g("y1"))     # terminal end
            return x1, y1, x1, y1
        if t in ("polygon", "polyline", "path"):
            src = g("points", "") if t != "path" else g("d", "")
            n = [float(v) for v in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", src)]
            xs, ys = n[0::2], n[1::2]
            return min(xs), min(ys), max(xs), max(ys)
        if t == "g":
            bs = [b for b in (_bbox(c) for c in el) if b]
            if not bs:
                return None
            return (min(b[0] for b in bs), min(b[1] for b in bs),
                    max(b[2] for b in bs), max(b[3] for b in bs))
    except (TypeError, ValueError, IndexError):
        return None
    return None


_cache = {}
def pins(mid, view):
    """{connectorId: (dx,dy)} in scene units from the part origin."""
    if (mid, view) in _cache:
        return _cache[(mid, view)]
    if mid in HARDPINS:                      # Qt-resource parts we can't read
        _cache[(mid, view)] = HARDPINS[mid]
        return HARDPINS[mid]
    f, kind = find_fzp(mid)
    root = ET.parse(f).getroot()
    vt = {"schematic": "schematicView", "pcb": "pcbView"}[view]
    img = root.find(f"./views/{vt}/layers").get("image")
    if kind == "local":
        sp = os.path.join(PARTS, f"svg.{view}.{os.path.basename(img)}")
    else:
        sub = os.path.basename(os.path.dirname(os.path.relpath(f, PARTSROOT)))
        sp = os.path.join(PARTSROOT, "svg", sub, img)
    sr = ET.parse(sp).getroot()
    vbs = sr.get("viewBox")
    if vbs:
        vb = [float(v) for v in re.split(r"[\s,]+", vbs.strip())]
        sc = _len_in(sr.get("width")) * IN / (vb[2]-vb[0])
    else:
        vb, sc = [0, 0, 0, 0], 1.0
    byid = {}
    for el in _iter(sr):
        if el.get("id"):
            byid.setdefault(el.get("id"), el)
    out = {}
    for c in root.findall("./connectors/connector"):
        p = c.find(f"./views/{vt}/p")
        if p is None:
            continue
        el = byid.get(p.get("terminalId")) or byid.get(p.get("svgId"))
        b = _bbox(el) if el is not None else None
        if b:
            out[c.get("id")] = (((b[0]+b[2])/2 - vb[0]) * sc, ((b[1]+b[3])/2 - vb[1]) * sc)
    _cache[(mid, view)] = out
    return out


# Power/ground labels live in Qt resources, so their pin offsets were measured
# from the existing PiHat sketch (consistent across every instance in it).
PWR = "PowerLabelModuleID"
GNDL = "GroundModuleID"
HARDPINS = {PWR: {"connector0": (8.977, 17.466)},
            GNDL: {"connector0": (9.001, 0.596)}}
HARDPATH = {PWR: "power_label.fzp", GNDL: "ground.fzp"}

# ----------------------------------------------------------------- design ---
T92, IRM, TSR = "T92S7D22_12_kilnmains", "IRM_20_12_kilnmains", "TSR_2_2450_kilnmains"
TBL, TBR = "TB2_762_kilnmains", "TB2_762R_kilnmains"      # mains, 7.62 mm
SBL, SBR = "TB2_508_kilnmains", "TB2_508R_kilnmains"      # SELV, 5.08 mm
FET, RES, LED = "1001ABDC04", "ResistorModuleID", "5mmColorLEDModuleID"
DIO, CER, ELE = "3254CBFC44diode", "100milCeramicCapacitorModuleID", "SmallElectrolyticCapacitorModuleID"
FUSE, RLY = "SparkFun-Passives-FUSE-X20MM", "SparkFun-Electromechanical-RELAY-PTH"
MOV = "MOV_S14K275_kilnmains"

# refdes: (module, label, value, schematic xy, pcb xy_mm)
P = {
 "J1":  (TBR,  "J1 240VAC IN",  "41A block",   (100,  95),  (4,   6)),
 "K1":  (T92,  "K1",            "T92S7D22-12", (340,  95),  (8,  30)),
 "J3":  (TBL,  "J3 SSR LOAD",   "41A block",   (640,  95),  (72,  6)),
 "J2":  (TBL,  "J2 KILN OUT",   "41A block",   (640, 205),  (98,  6)),
 "F1":  (FUSE, "F1",            "500mA T",     (150, 250),  (6,  70)),
 "MOV1":(MOV,  "MOV1",          "S14K275",     (280, 350),  (22, 70)),
 "PS1": (IRM,  "PS1",           "IRM-20-12",   (500, 300),  (6,  56)),

 "VR1": (TSR,  "VR1",           "TSR 2-2450",  (790, 300),  (78, 56)),
 "C1":  (ELE,  "C1",            "10uF 25V",    (640, 400),  (66, 58)),
 "C3":  (CER,  "C3",            "100nF",       (700, 400),  (72, 58)),
 "C2":  (ELE,  "C2",            "10uF 16V",    (930, 400),  (96, 58)),
 "C4":  (CER,  "C4",            "100nF",       (990, 400),  (102,58)),

 "J5":  (SBR,  "J5 THERMAL NC", "",            (100, 480),  (4,  76)),
 "RLY1":(RLY,  "RLY1",          "12V SPST",    (300, 470),  (22, 78)),
 "D1":  (DIO,  "D1",            "1N4007",      (580, 470),  (52, 76)),
 "Q1":  (FET,  "Q1",            "IRLZ44N",     (700, 470),  (60, 76)),
 "R8":  (RES,  "R8",            "1k",          (850, 470),  (68, 76)),
 "LED2":(LED,  "LED2 CTX",      "green",       (990, 470),  (76, 76)),

 "J6C": (SBR,  "J6C PI EN/AUX", "",            (100, 620),  (4,  60)),
 "D2":  (DIO,  "D2",            "1N4148",      (420, 560),  (36, 60)),
 "R3":  (RES,  "R3",            "100R",        (300, 620),  (22, 62)),
 "R4":  (RES,  "R4",            "10k",         (410, 680),  (30, 66)),
 "Q2":  (FET,  "Q2",            "2N7000",      (540, 620),  (40, 62)),

 "J6B": (SBR,  "J6B PI CTX/HEAT","",           (100, 760),  (4,  46)),
 "R1":  (RES,  "R1",            "100R",        (300, 740),  (22, 46)),
 "R2":  (RES,  "R2",            "10k",         (410, 800),  (30, 50)),
 "R5":  (RES,  "R5",            "100R",        (300, 890),  (22, 34)),
 "R6":  (RES,  "R6",            "10k",         (410, 950),  (30, 38)),
 "Q3":  (FET,  "Q3",            "2N7000",      (540, 890),  (40, 34)),
 "R7":  (RES,  "R7",            "1k",          (700, 890),  (52, 34)),
 "LED1":(LED,  "LED1 HEAT",     "red",         (850, 890),  (60, 34)),
 "J4":  (SBL,  "J4 SSR DRIVE",  "",            (1000, 890), (104,34)),

 "J6A": (SBR,  "J6A PI 5V/GND", "",            (100, 1060), (4,  20)),
 "R9":  (RES,  "R9",            "1k",          (330, 1060), (22, 20)),
 "LED3":(LED,  "LED3 PWR",      "green",       (480, 1060), (34, 20)),
 "J7":  (SBR,  "J7 FAN 12V",    "",            (100, 1200), (4,  86)),
}

# rails drawn as net labels, one per pin
RAILS = {
 "+12V": [("PS1","connector2"),("VR1","connector0"),("C1","connector1"),
          ("C3","connector0"),("J5","connector0"),("J7","connector0"),
          ("D2","connector0"),("RLY1","connector4")],
 "+5V":  [("VR1","connector2"),("C2","connector1"),("C4","connector0"),
          ("J4","connector0"),("J6A","connector0"),("R7","connector0"),
          ("R9","connector0")],
 "GND":  [("PS1","connector3"),("VR1","connector1"),("C1","connector0"),
          ("C2","connector0"),("C3","connector1"),("C4","connector1"),
          ("Q1","connector2"),("Q2","connector2"),("Q3","connector2"),
          ("J6A","connector1"),("J7","connector1"),("R2","connector1"),
          ("R4","connector1"),("R6","connector1"),("LED3","connector0")],
}

NETS = {
 "L1_IN":    [("J1","connector0"),("K1","connector0"),("K1","connector1"),("F1","connector0")],
 "L2_IN":    [("J1","connector1"),("K1","connector4"),("K1","connector5"),
              ("PS1","connector1"),("MOV1","connector1")],
 "L1_FUSED": [("F1","connector2"),("PS1","connector0"),("MOV1","connector0")],
 "L1_SW":    [("K1","connector2"),("K1","connector3"),("J3","connector0")],
 "L1_OUT":   [("J3","connector1"),("J2","connector0")],
 "L2_OUT":   [("K1","connector6"),("K1","connector7"),("J2","connector1")],
 "TS_RET":   [("J5","connector1"),("RLY1","connector1")],
 "COIL_H":   [("RLY1","connector2"),("K1","connector8"),("K1","connector9"),
              ("D1","connector0"),("R8","connector0")],
 "COIL_L":   [("K1","connector10"),("K1","connector11"),("D1","connector1"),
              ("Q1","connector1"),("LED2","connector0")],
 "LED2_A":   [("R8","connector1"),("LED2","connector1")],
 "RLY_COIL": [("RLY1","connector0"),("Q2","connector1"),("D2","connector1")],
 "SSR_DRV":  [("J4","connector1"),("Q3","connector1"),("LED1","connector0")],
 "LED1_A":   [("R7","connector1"),("LED1","connector1")],
 "LED3_A":   [("R9","connector1"),("LED3","connector1")],
 "CTX":      [("J6B","connector0"),("R1","connector0")],
 "G_Q1":     [("R1","connector1"),("Q1","connector0"),("R2","connector0")],
 "HEAT":     [("J6B","connector1"),("R5","connector0")],
 "G_Q3":     [("R5","connector1"),("Q3","connector0"),("R6","connector0")],
 "ENABLE":   [("J6C","connector0"),("R3","connector0")],
 "G_Q2":     [("R3","connector1"),("Q2","connector0"),("R4","connector0")],
}

def part_size(mid):
    """PCB footprint (w,h) in mm."""
    f, kind = find_fzp(mid)
    root = ET.parse(f).getroot()
    img = root.find("./views/pcbView/layers").get("image")
    if kind == "local":
        sp = os.path.join(PARTS, f"svg.pcb.{os.path.basename(img)}")
    else:
        sub = os.path.basename(os.path.dirname(os.path.relpath(f, PARTSROOT)))
        sp = os.path.join(PARTSROOT, "svg", sub, img)
    sr = ET.parse(sp).getroot()
    return _len_in(sr.get("width")) * 25.4, _len_in(sr.get("height")) * 25.4


def pack(refs, x0, y0, xmax, gap=5.0):
    """Row-pack refs left to right inside a band; returns {ref: (x,y)} in mm."""
    out, x, y, rowh = {}, x0, y0, 0.0
    for r in refs:
        w, h = part_size(P[r][0])
        if x > x0 and x + w > xmax:
            x, y, rowh = x0, y + rowh + gap, 0.0
        out[r] = (x, y)
        x += w + gap
        rowh = max(rowh, h)
    return out


BOARD_W, BOARD_H = 150.0, 124.0

# The board is split into two bands with a 10 mm dead zone between them.
# MAINS  : y 4 .. 54.5      SELV : y 66 .. 118
# Nothing may sit in y 54.5..66 - that gap is where the isolation slot goes.
MAINS_BOTTOM, SELV_TOP = 54.5, 66.0

PCBPLACE = {
    # mains band, placed explicitly so nothing creeps into the gap
    "J1":   (5.0,   4.0),      # 240 VAC in
    "J3":   (24.0,  4.0),      # SSR loop
    "J2":   (43.0,  4.0),      # to kiln
    "PS1":  (64.0,  4.0),      # IRM-20-12, 52.4 x 27.2
    "F1":   (120.0, 4.0),      # 5x20 fuse
    "K1":   (5.0,  20.0),      # T92, 54.23 x 34.54  -> bottom 54.54
    "MOV1": (64.0, 36.0),
}
# SELV band: small parts, row packed
PCBPLACE.update(pack(["VR1", "C1", "C3", "C2", "C4", "RLY1", "D1", "D2"], 5, 68, 145))
PCBPLACE.update(pack(["Q1", "Q2", "Q3", "R1", "R2", "R3", "R4"], 5, 82, 145))
PCBPLACE.update(pack(["R5", "R6", "R7", "R8", "R9"], 5, 93, 145))
PCBPLACE.update(pack(["LED1", "LED2", "LED3"], 5, 99, 145))
PCBPLACE.update(pack(["J5", "J4", "J6A", "J6B", "J6C", "J7"], 5, 110, 145))


def check_bands():
    bad = []
    for r, (x, y) in PCBPLACE.items():
        w, h = part_size(P[r][0])
        mains = r in ("J1", "J2", "J3", "PS1", "F1", "K1", "MOV1")
        if mains and y + h > MAINS_BOTTOM + 0.1:
            bad.append(f"{r} mains part reaches y={y+h:.1f} (limit {MAINS_BOTTOM})")
        if not mains and y < SELV_TOP - 0.1:
            bad.append(f"{r} SELV part starts at y={y:.1f} (limit {SELV_TOP})")
        if x + w > BOARD_W - 4:
            bad.append(f"{r} runs off the right edge at x={x+w:.1f}")
        if y + h > BOARD_H - 2:
            bad.append(f"{r} runs off the bottom at y={y+h:.1f}")
    # pairwise overlap
    items = [(r, PCBPLACE[r], part_size(P[r][0])) for r in PCBPLACE]
    for i, (ra, (xa, ya), (wa, ha)) in enumerate(items):
        for rb, (xb, yb), (wb, hb) in items[i+1:]:
            if xa < xb + wb and xb < xa + wa and ya < yb + hb and yb < ya + ha:
                bad.append(f"{ra} overlaps {rb}")
    return bad

# ---------------------------------------------------------------- emitter ---
_n = [90000000]
def nid():
    _n[0] += 13
    return _n[0]


SHIFT_X = 90.0   # keep left-edge refdes labels inside the export bounds


def spin(ref, conn):
    """absolute schematic coords of a part pin"""
    mod = P[ref][0]
    ox, oy = P[ref][3][0] + SHIFT_X, P[ref][3][1]
    dx, dy = pins(mod, "schematic")[conn]
    return ox + dx, oy + dy


def zroute(a, b):
    """orthogonal H,V,H points from a to b"""
    (x0, y0), (x1, y1) = a, b
    if abs(y0 - y1) < 0.5:
        return [(x0, y0), (x1, y0)]
    if abs(x0 - x1) < 0.5:
        return [(x0, y0), (x0, y1)]
    xm = round((x0 + x1) / 2 / G) * G
    return [(x0, y0), (xm, y0), (xm, y1), (x1, y1)]


def conns_xml(layer, entries):
    s = "                    <connectors>\n"
    for cid, links in entries:
        s += f'                        <connector connectorId="{cid}" layer="{layer}">\n'
        s += '                            <geometry x="0" y="0"/>\n'
        s += "                            <connects>\n"
        for mi, oc, ol in links:
            s += (f'                                <connect connectorId="{oc}" '
                  f'modelIndex="{mi}" layer="{ol}"/>\n')
        s += "                            </connects>\n"
        s += "                        </connector>\n"
    return s + "                    </connectors>\n"


def build():
    mi = {r: nid() for r in P}
    links = {}                       # (ref,conn) -> [(modelIndex, conn, layer)]
    wires = []                       # (name, p0, p1, [(endconn, target)])
    labels = []                      # (module, netname, xy, pinconn-target)

    def add_run(name, a, b):
        """orthogonal multi-segment wire; a and b are (ref,conn) or ('@',(x,y))"""
        pa = spin(*a) if a[0] != "@" else a[1]
        pb = spin(*b) if b[0] != "@" else b[1]
        pts = zroute(pa, pb)
        segs = []
        for i in range(len(pts) - 1):
            segs.append((nid(), pts[i], pts[i + 1]))
        for i, (w, p0, p1) in enumerate(segs):
            e0 = ("part", a) if i == 0 else ("wire", segs[i-1][0])
            e1 = ("part", b) if i == len(segs)-1 else ("wire", segs[i+1][0])
            wires.append((f"{name}_{i}", w, p0, p1, e0, e1))
        if a[0] != "@":
            links.setdefault(a, []).append((segs[0][0], "connector0", "schematicTrace"))
        if b[0] != "@":
            links.setdefault(b, []).append((segs[-1][0], "connector1", "schematicTrace"))

    # --- signal nets: chain pins left-to-right ------------------------------
    for name, pl in NETS.items():
        order = sorted(pl, key=lambda pc: spin(*pc))
        for a, b in zip(order, order[1:]):
            add_run(name, a, b)

    # --- supply rails: one net label per pin --------------------------------
    for rail, pl in RAILS.items():
        for pc in pl:
            px, py = spin(*pc)
            mod = GNDL if rail == "GND" else PWR
            dy = 27.0                                   # 0.3 in stub
            if rail == "GND":
                lx, ly = px, py + dy                    # ground hangs below
            else:
                lx, ly = px, py - dy                    # power sits above
            ox = lx - HARDPINS[mod]["connector0"][0]
            oy = ly - HARDPINS[mod]["connector0"][1]
            lm = nid()
            labels.append((mod, rail, (ox, oy), lm))
            add_run(rail, pc, ("@", (lx, ly)))
            # attach the last segment's far end to the label
            wires[-1] = wires[-1][:5] + (("label", lm),)
            links.setdefault(("#label", lm), []).append(
                (wires[-1][1], "connector1", "schematicTrace"))

    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<module fritzingVersion="1.0.7" icon="">',
           "    <boards>",
           f'        <board moduleId="TwoLayerRectanglePCBModuleID" title="Board" '
           f'instance="PCB1" width="{BOARD_W/10:.5f}cm" height="{BOARD_H/10:.5f}cm"/>',
           "    </boards>",
           "    <views>",
           '        <view name="breadboardView" backgroundColor="#ffffff" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>',
           '        <view name="schematicView" backgroundColor="#ffffff" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>',
           '        <view name="pcbView" backgroundColor="#333333" gridSize="0.05in" showGrid="1" alignToGrid="1" viewFromBelow="0" '
           'autorouteViaHoleSize="0.02in" autorouteViaRingThickness="0.4mm" autorouteTraceWidth="24"/>',
           "    </views>",
           "    <instances>"]

    b = nid()
    out += [f'        <instance moduleIdRef="TwoLayerRectanglePCBModuleID" modelIndex="{b}" path="rectangle_pcb_two_layers.fzp">',
            '            <property name="layers" value="2"/>',
            f'            <property name="width" value="{BOARD_W}"/>',
            f'            <property name="height" value="{BOARD_H}"/>',
            "            <title>PCB1</title>",
            '            <views><pcbView layer="board"><geometry z="1.5" x="0" y="0"/></pcbView></views>',
            "        </instance>"]

    for ref, (mod, label, value, sxy, pxy) in P.items():
        m = mi[ref]
        cl = sorted(pins(mod, "schematic"), key=lambda c: int(c[9:]))
        f, kind = find_fzp(mod)
        out += [f'        <instance moduleIdRef="{mod}" modelIndex="{m}" path="{os.path.basename(f)}">']
        if value:
            out.append(f'            <property name="value" value="{value}"/>')
        out += [f"            <title>{label}</title>", "            <views>"]
        for vname, vlayer, xy, olayer in (
                ("breadboardView", "breadboard", (sxy[0] + SHIFT_X, sxy[1] + 1400), "schematic"),
                ("schematicView", "schematic", (sxy[0] + SHIFT_X, sxy[1]), "schematic"),
                ("pcbView", "copper0", (PCBPLACE[ref][0]*MM, PCBPLACE[ref][1]*MM), "copper0trace")):
            out += [f'                <{vname} layer="{vlayer}">',
                    f'                    <geometry z="3.5" x="{xy[0]:.4f}" y="{xy[1]:.4f}"/>']
            if vname in ("schematicView", "pcbView"):
                ty = -14 if vname == "schematicView" else -10
                out += [f'                    <titleGeometry visible="true" x="{xy[0]:.4f}" '
                        f'y="{xy[1]+ty:.4f}" z="12.5" xOffset="0" yOffset="{ty}" '
                        f'textColor="#000000" fontSize="6"><displayKey key=""/></titleGeometry>']
            out += [conns_xml(vlayer, [(c, [(w, oc, olayer) for (w, oc, _l) in
                                            links.get((ref, c), [])]) for c in cl]).rstrip("\n"),
                    f"                </{vname}>"]
        out += ["            </views>", "        </instance>"]

    # net labels (schematic only)
    for mod, rail, (ox, oy), lm in labels:
        out += [f'        <instance moduleIdRef="{mod}" modelIndex="{lm}" path="{HARDPATH[mod]}">']
        if mod == PWR:
            out.append(f'            <property name="voltage" value="{rail.lstrip("+").rstrip("V")}"/>')
        out += [f"            <title>{rail}</title>", "            <views>",
                '                <schematicView layer="schematic">',
                f'                    <geometry z="9.5" x="{ox:.4f}" y="{oy:.4f}"/>',
                conns_xml("schematic", [("connector0", links.get(("#label", lm), []))]).rstrip("\n"),
                "                </schematicView>", "            </views>", "        </instance>"]

    # wires
    def endlink(e):
        kind, v = e
        if kind == "part":
            return (mi[v[0]], v[1], "schematic")
        if kind == "label":
            return (v, "connector0", "schematic")
        return (v, None, "schematicTrace")     # wire-to-wire, conn filled below

    for name, w, p0, p1, e0, e1 in wires:
        l0 = endlink(e0); l1 = endlink(e1)
        if e0[0] == "wire":
            l0 = (e0[1], "connector1", "schematicTrace")
        if e1[0] == "wire":
            l1 = (e1[1], "connector0", "schematicTrace")
        out += [f'        <instance moduleIdRef="WireModuleID" modelIndex="{w}" path="wire.fzp">',
                f"            <title>{name}</title>", "            <views>"]
        for vname, vlayer, col, mils in (
                ("breadboardView", "breadboardWire", "#404040", "22.2222"),
                ("schematicView", "schematicTrace", "#404040", "9.7222"),
                ("pcbView", "copper0trace", "#f28a00", "24")):
            out += [f'                <{vname} layer="{vlayer}">',
                    f'                    <geometry z="5.5" x="{p0[0]:.4f}" y="{p0[1]:.4f}" '
                    f'x1="0" y1="0" x2="{p1[0]-p0[0]:.4f}" y2="{p1[1]-p0[1]:.4f}" wireFlags="128"/>',
                    f'                    <wireExtras mils="{mils}" color="{col}" opacity="1" banded="0"/>',
                    conns_xml(vlayer, [("connector0", [l0]), ("connector1", [l1])]).rstrip("\n"),
                    f"                </{vname}>"]
        out += ["            </views>", "        </instance>"]

    out += ["    </instances>", "</module>"]
    return "\n".join(out) + "\n"


def package(name="Kiln Mains Board"):
    os.makedirs(BUILD, exist_ok=True)
    fz = build()
    fzz = os.path.join(BUILD, name + ".fzz")
    used = sorted({v[0] for v in P.values()})
    with zipfile.ZipFile(fzz, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name + ".fz", fz)
        for m in used:
            p = os.path.join(PARTS, f"part.{m}.fzp")
            if not os.path.exists(p):
                continue
            z.write(p, os.path.basename(p))
            for view, suf in (("breadboard", "breadboard"), ("schematic", "schematic"),
                              ("pcb", "pcb"), ("icon", "icon")):
                f = os.path.join(PARTS, f"svg.{view}.{m}_{suf}.svg")
                if os.path.exists(f):
                    z.write(f, os.path.basename(f))
    return fzz


if __name__ == "__main__":
    for msg in check_bands():
        print("PLACEMENT:", msg)
    print("wrote", package())
