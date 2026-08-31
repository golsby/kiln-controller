#!/usr/bin/env python3
"""Generate the custom Fritzing parts for the kiln mains board.

Footprints are taken from the manufacturer drawings:
  T92S7D22-12  TE/P&B datasheet 1308242 rev 1217, "PCB layout, mounting and
               termination code 1".  Every terminal is TWO holes 5.16 mm apart;
               the drawing is not to scale so the printed dimensions rule.
  IRM-20-12    Mean Well IRM-20 spec, Case No. 219A (bottom view; mirrored here
               to a top-down footprint).
  TSR 2-2450   Traco TSR 2 series outline, SIP3.

SVG conventions Fritzing wants: viewBox units are millimetres, width/height in
inches.  Scene geometry in the .fz is 90 dpi, i.e. mm * 90/25.4.
"""
import os

MM2IN = 1.0 / 25.4
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "parts")
os.makedirs(OUT, exist_ok=True)

# ----------------------------------------------------------------- primitives

def svg_open(w_mm, h_mm):
    return (
        "<?xml version='1.0' encoding='UTF-8' standalone='no'?>\n"
        "<svg xmlns:svg='http://www.w3.org/2000/svg' xmlns='http://www.w3.org/2000/svg' "
        "version='1.2' baseProfile='tiny' x='0in' y='0in' "
        f"width='{w_mm*MM2IN:.6f}in' height='{h_mm*MM2IN:.6f}in' "
        f"viewBox='0 0 {w_mm:.4f} {h_mm:.4f}' >\n"
    )


def pcb_pad(idx, name, cx, cy, drill_mm, pad_od_mm):
    """Through-hole annular ring drawn the way Fritzing expects."""
    rin = drill_mm / 2.0
    rout = pad_od_mm / 2.0
    r = (rin + rout) / 2.0
    sw = rout - rin
    return (f"<circle id='connector{idx}pad' connectorname='{name}' "
            f"cx='{cx:.4f}' cy='{cy:.4f}' r='{r:.4f}' stroke='#F7BD13' "
            f"stroke-width='{sw:.4f}' fill='none' />\n")


def silk_rect(x, y, w, h, sw=0.2032):
    return (f"<rect class='other' x='{x:.4f}' y='{y:.4f}' width='{w:.4f}' "
            f"height='{h:.4f}' stroke='#f0f0f0' stroke-width='{sw}' fill='none' />\n")


def pcb_nonconn(idx, cx, cy, dia):
    """A FILLED copper circle with a `nonconn` id: a non-plated through hole.

    Verified against Fritzing 1.0.7's own exporter (`Fritzing -gerber`):
      * FILLED circle + id `nonconn<N>` -> drill file under the NON-PLATED tool
        (T1..), and the feature is absent from the copper gerbers entirely.
      * RING (fill:none + stroke)       -> drill file under a PLATED tool
        (T100..), with the stroke flashed as an annular ring in copper.
    A mounting hole that must carry no copper and join no net is the filled
    form. Fritzing's own panel-mount parts (Taiway toggle switch mounting hole,
    Dagu servo mounting holes) use exactly this.
    """
    return (f"<circle id='nonconn{idx}' cx='{cx:.4f}' cy='{cy:.4f}' "
            f"r='{dia / 2.0:.4f}' fill='#000000' stroke='none' />\n")


def make_pcb_svg(w, h, pads, silk, copper_extra=""):
    """pads: list of (idx, name, cx, cy, drill, od).  silk: raw svg string.
    copper_extra: raw svg dropped inside the copper group (e.g. nonconn holes).

    Pads are defined ONCE inside nested copper1/copper0 groups, which is the
    convention every core Fritzing THT footprint uses. Emitting them twice
    (once per group) duplicates the element ids, and Fritzing then resolves
    connector<N>pad only on copper1 - the copper0 lookup fails and the pad is
    silently dropped from the bottom-copper gerber.
    """
    body = "".join(pcb_pad(*p) for p in pads) + copper_extra
    s = svg_open(w, h)
    s += "<g id='silkscreen'>\n" + silk + "</g>\n"
    s += "<g id='copper1'><g id='copper0'>\n" + body + "</g></g>\n"
    s += "</svg>\n"
    return s


GRID = 2.54  # 0.1 in schematic grid, in mm
PINLEN = 2.54
PINSW = 0.246944
LINESW = 0.1524
FONT = 0.881944


def schem_pin(idx, name, x_out, y, side, label):
    """A pin stub entering the body.  side 'L' pin runs left->right."""
    if side == "L":
        x1, x2 = x_out, x_out + PINLEN
        tx, anchor = x_out + PINLEN + 0.5, "start"
    else:
        x1, x2 = x_out, x_out - PINLEN
        tx, anchor = x_out - PINLEN - 0.5, "end"
    s = (f"<line class='pin' id='connector{idx}pin' connectorname='{name}' "
         f"x1='{x1:.4f}' y1='{y:.4f}' x2='{x2:.4f}' y2='{y:.4f}' "
         f"stroke='#787878' stroke-width='{PINSW}' stroke-linecap='round'/>\n")
    s += (f"<rect class='terminal' id='connector{idx}terminal' x='{x1:.4f}' "
          f"y='{y:.4f}' width='0.0001' height='0.0001' stroke='none' "
          f"stroke-width='0' fill='none'/>\n")
    s += (f"<text class='text' font-family=\"'Droid Sans'\" stroke='none' "
          f"stroke-width='0' fill='#8c8c8c' font-size='{FONT}' x='{tx:.4f}' "
          f"y='{y+0.3:.4f}' text-anchor='{anchor}'>{label}</text>\n")
    return s


def make_schem_svg(title, left, right, extra_lines=""):
    """left/right: list of (idx, name, label).  Returns svg + pin y offsets."""
    rows = max(len(left), len(right))
    body_h = (rows + 1) * GRID
    body_w = 10 * GRID
    w = body_w + 2 * PINLEN
    h = body_h
    s = svg_open(w, h)
    s += "<g id='schematic'>\n"
    s += (f"<rect class='other' x='{PINLEN:.4f}' y='{GRID/2:.4f}' "
          f"width='{body_w:.4f}' height='{body_h-GRID:.4f}' stroke='#000000' "
          f"stroke-width='{LINESW}' fill='none'/>\n")
    s += (f"<text class='text' font-family=\"'Droid Sans'\" stroke='none' "
          f"stroke-width='0' fill='#000000' font-size='{FONT*1.15:.4f}' "
          f"x='{w/2:.4f}' y='{GRID*0.5+1.4:.4f}' text-anchor='middle'>{title}</text>\n")
    pos = {}
    for i, (idx, name, label) in enumerate(left):
        y = GRID * (i + 1.5)
        s += schem_pin(idx, name, 0.0, y, "L", label)
        pos[idx] = (0.0, y)
    for i, (idx, name, label) in enumerate(right):
        y = GRID * (i + 1.5)
        s += schem_pin(idx, name, w, y, "R", label)
        pos[idx] = (w, y)
    s += extra_lines + "</g>\n</svg>\n"
    return s, pos, w, h


def make_bb_svg(title, left, right, group="breadboard"):
    """Breadboard/icon art. Must still carry connector<N>pin ids for every
    connector or Fritzing refuses to bind the view."""
    rows = max(len(left), len(right))
    body_h = (rows + 1) * GRID
    body_w = 10 * GRID
    w = body_w + 2 * PINLEN
    h = body_h
    s = svg_open(w, h)
    s += f"<g id='{group}'>\n"
    s += (f"<rect x='{PINLEN:.4f}' y='{GRID/2:.4f}' width='{body_w:.4f}' "
          f"height='{body_h-GRID:.4f}' rx='0.6' fill='#2d3436' stroke='none'/>\n")
    s += (f"<text font-family=\"'Droid Sans'\" fill='#ffffff' font-size='2' "
          f"x='{w/2:.4f}' y='{h/2+0.7:.4f}' text-anchor='middle'>{title}</text>\n")
    for i, (idx, name, _label) in enumerate(left):
        y = GRID * (i + 1.5)
        s += (f"<line id='connector{idx}pin' connectorname='{name}' x1='0' "
              f"y1='{y:.4f}' x2='{PINLEN:.4f}' y2='{y:.4f}' stroke='#8c8c8c' "
              f"stroke-width='0.6' stroke-linecap='round'/>\n")
    for i, (idx, name, _label) in enumerate(right):
        y = GRID * (i + 1.5)
        s += (f"<line id='connector{idx}pin' connectorname='{name}' "
              f"x1='{w:.4f}' y1='{y:.4f}' x2='{w-PINLEN:.4f}' y2='{y:.4f}' "
              f"stroke='#8c8c8c' stroke-width='0.6' stroke-linecap='round'/>\n")
    s += "</g>\n</svg>\n"
    return s


def fzp(module_id, title, label, desc, family, conns, props=None):
    """conns: list of dicts with idx,name,desc,bb,schem(with terminal),pcb."""
    props = props or {}
    p = "".join(f'    <property name="{k}">{v}</property>\n' for k, v in props.items())
    s = ["<?xml version='1.0' encoding='UTF-8' standalone='no'?>",
         f'<module fritzingVersion="1.0.7" moduleId="{module_id}">',
         "  <version>1</version>",
         "  <author>generated for kiln-controller mains board</author>",
         f"  <title>{title}</title>",
         f"  <label>{label}</label>",
         "  <date>2026-08-26</date>",
         "  <tags><tag>kiln</tag></tags>",
         "  <properties>",
         f'    <property name="family">{family}</property>' ,
         p.rstrip("\n"),
         "  </properties>",
         f"  <description>{desc}</description>",
         "  <views>",
         "    <iconView><layers image='icon/%s_icon.svg'><layer layerId='icon'/></layers></iconView>" % module_id,
         "    <breadboardView><layers image='breadboard/%s_breadboard.svg'><layer layerId='breadboard'/></layers></breadboardView>" % module_id,
         "    <schematicView><layers image='schematic/%s_schematic.svg'><layer layerId='schematic'/></layers></schematicView>" % module_id,
         "    <pcbView><layers image='pcb/%s_pcb.svg'><layer layerId='copper0'/><layer layerId='copper1'/><layer layerId='silkscreen'/></layers></pcbView>" % module_id,
         "  </views>",
         "  <connectors>"]
    for c in conns:
        i = c["idx"]
        # hybrid="yes" means "this connector is not really in this
        # view": Fritzing draws no pad, adds nothing to the ratsnest
        # and exports no copper or drill for it.  layer="copper0"/
        # "copper1" is the spelling that loads silently - both
        # layer="unknown" and an empty <pcbView/> log "svgidlayer
        # fail" (checked against Fritzing 1.0.7).
        hyb = ' hybrid="yes"' if c.get("hybrid") else ""
        s += [f'    <connector id="connector{i}" name="{c["name"]}" type="male">',
              f'      <description>{c["desc"]}</description>',
              "      <views>",
              f'        <breadboardView><p layer="breadboard" svgId="connector{i}pin"/></breadboardView>',
              f'        <schematicView><p layer="schematic" svgId="connector{i}pin" terminalId="connector{i}terminal"/></schematicView>',
              f'        <pcbView><p layer="copper0" svgId="connector{i}pad"{hyb}/><p layer="copper1" svgId="connector{i}pad"{hyb}/></pcbView>',
              "      </views>",
              "    </connector>"]
    s += ["  </connectors>", "</module>", ""]
    return "\n".join(s)


def write_part(module_id, fzp_text, bb, schem, pcb, icon=None):
    open(os.path.join(OUT, f"part.{module_id}.fzp"), "w").write(fzp_text)
    open(os.path.join(OUT, f"svg.breadboard.{module_id}_breadboard.svg"), "w").write(bb)
    open(os.path.join(OUT, f"svg.schematic.{module_id}_schematic.svg"), "w").write(schem)
    open(os.path.join(OUT, f"svg.pcb.{module_id}_pcb.svg"), "w").write(pcb)
    open(os.path.join(OUT, f"svg.icon.{module_id}_icon.svg"), "w").write(icon or bb)


# ============================================================ 1. T92 RELAY ===
# Origin = pin "2" (pole 1 common) terminal centre.  y grows downward.
#   pole 1 line  y = 0        pole 2 line  y = +16.00
#   col A (COM)  x = 0        col B (NO)   x = +7.85
#   each terminal = 2 holes +/- 2.58 mm from its line (5.16 pitch)
#   coil terminals: centre x = 41.10, each = 2 holes +/- 2.58 in X
#                   coil 1 at y = -4.70, coil 2 at y = +20.70
#   body: 54.23 x 34.54, left edge x = -4.12, top edge y = -9.27
T92_DRILL, T92_OD = 1.93, 3.60
_t92_holes = [
    ("2a", 0.00, -2.58), ("2b", 0.00, 2.58),
    ("4a", 7.85, -2.58), ("4b", 7.85, 2.58),
    ("6a", 0.00, 13.42), ("6b", 0.00, 18.58),
    ("8a", 7.85, 13.42), ("8b", 7.85, 18.58),
    ("A1a", 41.10 - 2.58, -4.70), ("A1b", 41.10 + 2.58, -4.70),
    ("A2a", 41.10 - 2.58, 20.70), ("A2b", 41.10 + 2.58, 20.70),
]
T92_MARGIN = T92_OD / 2 + 0.3
_xs = [h[1] for h in _t92_holes]; _ys = [h[2] for h in _t92_holes]
_bx0, _by0 = -4.12, -9.27          # body top-left in origin coords
_bx1, _by1 = _bx0 + 54.23, _by0 + 34.54
_ox0 = min(_bx0, min(_xs) - T92_MARGIN); _oy0 = min(_by0, min(_ys) - T92_MARGIN)
_ox1 = max(_bx1, max(_xs) + T92_MARGIN); _oy1 = max(_by1, max(_ys) + T92_MARGIN)
T92_W, T92_H = _ox1 - _ox0, _oy1 - _oy0

t92_pads = [(i, n, x - _ox0, y - _oy0, T92_DRILL, T92_OD)
            for i, (n, x, y) in enumerate(_t92_holes)]
t92_silk = silk_rect(_bx0 - _ox0, _by0 - _oy0, 54.23, 34.54)
t92_silk += (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
             f"font-size='2.6' x='{(_bx0-_ox0)+27:.3f}' y='{(_by0-_oy0)+20:.3f}' "
             f"text-anchor='middle'>T92 30A DPST-NO</text>\n")
T92_PCB = make_pcb_svg(T92_W, T92_H, t92_pads, t92_silk)

# schematic: 6 terminals, each shown as its a/b pin pair tied by a bar
t92_left = [(0, "2a", "2a"), (1, "2b", "2b  P1 COM  L1 IN"),
            (4, "6a", "6a"), (5, "6b", "6b  P2 COM  L2 IN"),
            (8, "A1a", "A1a"), (9, "A1b", "A1b  COIL +12V")]
t92_right = [(2, "4a", "4a"), (3, "4b", "P1 NO  L1 SW  4b"),
             (6, "8a", "8a"), (7, "8b", "P2 NO  L2 OUT  8b"),
             (10, "A2a", "A2a"), (11, "A2b", "COIL DRIVE  A2b")]
_tie = ""
for i in range(3):
    y0 = GRID * (2 * i + 1.5); y1 = GRID * (2 * i + 2.5)
    _tie += (f"<line class='other' x1='{PINLEN:.4f}' y1='{y0:.4f}' "
             f"x2='{PINLEN:.4f}' y2='{y1:.4f}' stroke='#000000' "
             f"stroke-width='{LINESW*3:.4f}' stroke-linecap='round'/>\n")
    _tie += (f"<line class='other' x1='{PINLEN+10*GRID:.4f}' y1='{y0:.4f}' "
             f"x2='{PINLEN+10*GRID:.4f}' y2='{y1:.4f}' stroke='#000000' "
             f"stroke-width='{LINESW*3:.4f}' stroke-linecap='round'/>\n")
T92_SCHEM, T92_PINPOS, T92_SW, T92_SH = make_schem_svg("K  T92 DPST-NO 30A", t92_left, t92_right, _tie)
T92_BB = make_bb_svg("T92 relay", t92_left, t92_right)
T92_IC = make_bb_svg("T92", t92_left, t92_right, "icon")

T92_ID = "T92S7D22_12_kilnmains"
t92_conns = []
_lbl = {0: "pole 1 common (line 1 in), hole a", 1: "pole 1 common, hole b",
        2: "pole 1 N.O. (line 1 switched), hole a", 3: "pole 1 N.O., hole b",
        4: "pole 2 common (line 2 in), hole a", 5: "pole 2 common, hole b",
        6: "pole 2 N.O. (line 2 out), hole a", 7: "pole 2 N.O., hole b",
        8: "coil A1, hole a", 9: "coil A1, hole b",
        10: "coil A2, hole a", 11: "coil A2, hole b"}
for i, (n, _, _) in enumerate(_t92_holes):
    t92_conns.append({"idx": i, "name": n, "desc": _lbl[i]})
T92_FZP = fzp(T92_ID, "TE T92S7D22-12 relay (DPST-NO 30A, 12VDC coil)", "K",
              "TE / Potter &amp; Brumfield T92 two-pole 30 A PCB relay, 2 form A, "
              "12 VDC coil. Each terminal is two 1.93 mm holes on 5.16 mm centres "
              "(a and b) - BOTH must be connected, they are one terminal. "
              "Footprint from TE datasheet 1308242 rev 1217, termination code 1.",
              "kiln mains", t92_conns,
              {"package": "THT", "part number": "T92S7D22-12", "mn": "TE Connectivity",
               "voltage": "277VAC", "current": "30A", "coil": "12VDC"})

# ========================================================= 2. IRM-20-12 PSU ==
# Mean Well case 219A.  Datasheet drawing is a BOTTOM view; mirrored in X here.
#   body 52.4 x 27.2, pin dia 1.0
#   bottom view: AC/N (3.4, 3.2)  AC/L (3.4, 24.0)  -V (48.4, 3.2)  +V (48.4, 11.2)
IRM_W, IRM_H = 52.4, 27.2
_irm_bottom = [("AC/N", 3.4, 3.2), ("AC/L", 3.4, 24.0), ("-V", 48.4, 3.2), ("+V", 48.4, 11.2)]
_irm_top = [(n, IRM_W - x, y) for n, x, y in _irm_bottom]   # mirror to top view
IRM_ORDER = ["AC/L", "AC/N", "+V", "-V"]
_irm_map = {n: (x, y) for n, x, y in _irm_top}
irm_pads = [(i, n, _irm_map[n][0], _irm_map[n][1], 1.30, 2.60)
            for i, n in enumerate(IRM_ORDER)]
irm_silk = silk_rect(0.15, 0.15, IRM_W - 0.3, IRM_H - 0.3)
irm_silk += (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
             f"font-size='2.6' x='{IRM_W/2:.3f}' y='{IRM_H/2+1:.3f}' "
             f"text-anchor='middle'>IRM-20-12</text>\n")
IRM_PCB = make_pcb_svg(IRM_W, IRM_H, irm_pads, irm_silk)
irm_left = [(0, "AC/L", "AC/L"), (1, "AC/N", "AC/N")]
irm_right = [(2, "+V", "+12V"), (3, "-V", "0V (SELV)")]
IRM_SCHEM, IRM_PINPOS, IRM_SW, IRM_SH = make_schem_svg("PS  IRM-20-12", irm_left, irm_right)
IRM_BB = make_bb_svg("IRM-20-12", irm_left, irm_right)
IRM_IC = make_bb_svg("IRM-20", irm_left, irm_right, "icon")
IRM_ID = "IRM_20_12_kilnmains"
IRM_FZP = fzp(IRM_ID, "Mean Well IRM-20-12 (20W 12V PCB AC-DC)", "PS",
              "Mean Well IRM-20-12 encapsulated PCB-mount AC-DC module. 85-264 VAC "
              "universal input (non-polarised, so L1-L2 at 240 V is fine), 12 V 1.8 A "
              "out, convection cooled, Class II. Footprint from Mean Well case 219A "
              "(datasheet bottom view, mirrored here to a top-down footprint).",
              "kiln mains",
              [{"idx": i, "name": n, "desc": d} for i, (n, d) in enumerate(
                  [("AC/L", "mains input, line"), ("AC/N", "mains input, neutral/second line"),
                   ("+V", "+12 V output"), ("-V", "0 V output (SELV)")])],
              {"package": "THT", "part number": "IRM-20-12", "mn": "Mean Well",
               "voltage": "12V", "current": "1.8A"})

# ======================================================== 3. TSR 2-2450 5V ===
# Traco TSR 2 SIP3: body 14.0 x 7.50, 3 pins 2.54 pitch, 0.46 sq, row 3.89 from
# the top edge, pin 3 is 4.5 from the right edge.
TSR_W, TSR_H = 14.0, 7.50
_tsr_x3 = TSR_W - 4.5
_tsr_pins = [("+Vin", _tsr_x3 - 2 * 2.54, 3.89),
             ("GND",  _tsr_x3 - 1 * 2.54, 3.89),
             ("+Vout", _tsr_x3,           3.89)]
tsr_pads = [(i, n, x, y, 1.00, 2.20) for i, (n, x, y) in enumerate(_tsr_pins)]
tsr_silk = silk_rect(0.15, 0.15, TSR_W - 0.3, TSR_H - 0.3)
tsr_silk += (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
             f"font-size='1.8' x='{TSR_W/2:.3f}' y='2.2' text-anchor='middle'>TSR2</text>\n")
TSR_PCB = make_pcb_svg(TSR_W, TSR_H, tsr_pads, tsr_silk)
tsr_left = [(0, "+Vin", "+Vin"), (1, "GND", "GND")]
tsr_right = [(2, "+Vout", "+5V")]
TSR_SCHEM, TSR_PINPOS, TSR_SW, TSR_SH = make_schem_svg("VR  TSR 2-2450", tsr_left, tsr_right)
TSR_BB = make_bb_svg("TSR 2-2450", tsr_left, tsr_right)
TSR_IC = make_bb_svg("TSR2", tsr_left, tsr_right, "icon")
TSR_ID = "TSR_2_2450_kilnmains"
TSR_FZP = fzp(TSR_ID, "Traco TSR 2-2450 (5V 2A switching regulator, SIP3)", "VR",
              "Traco TSR 2-2450 non-isolated buck regulator, 7805 pinout, 5 V 2 A, "
              "no heatsink needed. Footprint from the TSR 2 series outline drawing.",
              "kiln mains",
              [{"idx": i, "name": n, "desc": d} for i, (n, d) in enumerate(
                  [("+Vin", "input, +6.5 to +42 V"), ("GND", "ground"),
                   ("+Vout", "+5 V output, 2 A")])],
              {"package": "THT", "part number": "TSR 2-2450", "mn": "Traco Power",
               "voltage": "5V", "current": "2A"})

if __name__ == "__main__":
    write_part(T92_ID, T92_FZP, T92_BB, T92_SCHEM, T92_PCB, T92_IC)
    write_part(IRM_ID, IRM_FZP, IRM_BB, IRM_SCHEM, IRM_PCB, IRM_IC)
    write_part(TSR_ID, TSR_FZP, TSR_BB, TSR_SCHEM, TSR_PCB, TSR_IC)
    print("wrote parts to", OUT)
    for n, w, h in (("T92", T92_W, T92_H), ("IRM", IRM_W, IRM_H), ("TSR", TSR_W, TSR_H)):
        print(f"  {n} pcb outline {w:.2f} x {h:.2f} mm")
    print("  T92 schematic", f"{T92_SW:.2f} x {T92_SH:.2f} mm")


# =================================================== 4/5. TERMINAL BLOCKS ====
# Fritzing's own screw_terminal_* parts ship without schematic/pcb SVGs on
# disk, and the generic ones are too small for 21 A anyway, so build our own.
def terminal_block(module_id, title, pitch, drill, pad_od, body_h, labels, desc,
                   side="L", symtext=""):
    n = len(labels)
    w = n * pitch
    pins = [(labels[i], pitch / 2 + i * pitch, 3.4) for i in range(n)]
    pads = [(i, labels[i], x, y, drill, pad_od) for i, (_, x, y) in enumerate(pins)]
    silk = silk_rect(0.15, 0.15, w - 0.3, body_h - 0.3)
    silk += (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
             f"font-size='1.6' x='{w/2:.3f}' y='{body_h-1.4:.3f}' "
             f"text-anchor='middle'>{pitch:.2f}mm</text>\n")
    pcb = make_pcb_svg(w, body_h, pads, silk)
    rows = [(i, labels[i], labels[i]) for i in range(n)]
    L, R = (rows, []) if side == "L" else ([], rows)
    schem, _pos, _w, _h = make_schem_svg(symtext, L, R)
    bb = make_bb_svg(symtext or "TB", L, R)
    ic = make_bb_svg(symtext or "TB", L, R, "icon")
    conns = [{"idx": i, "name": labels[i], "desc": f"terminal {i+1} ({labels[i]})"}
             for i in range(n)]
    text = fzp(module_id, title, "J", desc, "kiln mains", conns,
               {"package": "THT", "pin spacing": f"{pitch}mm", "pins": str(n)})
    write_part(module_id, text, bb, schem, pcb, ic)
    return module_id


TB762_ID  = "TB2_762_kilnmains"      # pins on the left  (output side)
TB762R_ID = "TB2_762R_kilnmains"     # pins on the right (input side)
TB508_ID  = "TB2_508_kilnmains"
TB508R_ID = "TB2_508R_kilnmains"

if __name__ == "__main__":
    # 7.62 mm / 41 A class (Phoenix PC 5 or equivalent) - the mains terminals.
    terminal_block(TB762_ID, "Terminal block 2p 7.62mm (41A)", 7.62, 1.60, 3.40, 12.5,
                   ["1", "2"],
                   "Two-position PCB terminal block on 7.62 mm pitch rated 41 A / "
                   "10 mm2 (Phoenix Contact PC 5 series or equivalent). Use for every "
                   "mains connection on this board - the 5 mm blocks in the Fritzing "
                   "core top out around 16 A.")
    terminal_block(TB762R_ID, "Terminal block 2p 7.62mm (41A) in", 7.62, 1.60, 3.40, 12.5,
                   ["1", "2"],
                   "As TB2_762_kilnmains but drawn with its schematic pins on the "
                   "right, for terminals that feed the sheet from the left edge.",
                   side="R")
    # 5.08 mm - SELV signal and low-current terminals.
    terminal_block(TB508_ID, "Terminal block 2p 5.08mm", 5.08, 1.30, 2.60, 9.0,
                   ["1", "2"],
                   "Two-position PCB terminal block on 5.08 mm pitch, for the SELV "
                   "side (Pi interface, SSR drive, thermal switch, fan).")
    terminal_block(TB508R_ID, "Terminal block 2p 5.08mm in", 5.08, 1.30, 2.60, 9.0,
                   ["1", "2"],
                   "As TB2_508_kilnmains but with its schematic pins on the right, "
                   "for terminals that feed the sheet from the left edge.",
                   side="R")
    print("wrote terminal blocks")


# ============================================================== 6. MOV =======
# Fritzing's core varistor is an 0603 chip part - useless for a mains disc MOV.
# S14K275 / V275LA20AP class: 14 mm disc, 7.5 mm lead pitch, 0.8 mm leads.
def radial_2lead(module_id, title, label, pitch, drill, pad_od, body_w, body_h,
                 names, desc, props):
    pads = [(0, names[0], (body_w - pitch) / 2, body_h / 2, drill, pad_od),
            (1, names[1], (body_w + pitch) / 2, body_h / 2, drill, pad_od)]
    silk = silk_rect(0.15, 0.15, body_w - 0.3, body_h - 0.3)
    silk += (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
             f"font-size='2.2' x='{body_w/2:.3f}' y='2.6' text-anchor='middle'>{label}</text>\n")
    pcb = make_pcb_svg(body_w, body_h, pads, silk)
    L = [(0, names[0], names[0])]
    R = [(1, names[1], names[1])]
    schem, _p, _w, _h = make_schem_svg(label, L, R)
    bb = make_bb_svg(label, L, R)
    ic = make_bb_svg(label, L, R, "icon")
    conns = [{"idx": i, "name": names[i], "desc": f"lead {i+1}"} for i in (0, 1)]
    write_part(module_id, fzp(module_id, title, "MOV", desc, "kiln mains", conns, props),
               bb, schem, pcb, ic)


MOV_ID = "MOV_S14K275_kilnmains"

if __name__ == "__main__":
    radial_2lead(MOV_ID, "Metal oxide varistor 275VAC (14mm disc)", "MOV",
                 7.5, 1.10, 2.60, 16.0, 6.0, ["1", "2"],
                 "275 VAC-rated metal oxide varistor across the PSU input, 14 mm "
                 "disc on 7.5 mm lead pitch (TDK S14K275, Littelfuse V275LA20AP or "
                 "equivalent). Fit it downstream of F1 so a failed MOV blows the "
                 "fuse rather than the branch circuit breaker.",
                 {"package": "THT radial", "part number": "S14K275",
                  "voltage": "275VAC"})
    print("wrote MOV")


# ================== 6. T92 PANEL-MOUNT RELAY (QC tabs, hybrid PCB model) ====
# T92P7D22-12 decodes as: P dust-protected case / 7 two form A / D DC coil /
# 2 panel mount via flanged cover with .250in (6.35 x 0.81) QC terminals /
# 2 AgCdO contacts / -12 twelve volt coil.  Datasheet 1308242 rev 1217,
# "Dimensions - T92 Mounting and termination code 2, 3 and 4" (page 2).
#
# HYBRID PART.  The six relay terminals are real connectors in breadboard and
# schematic, so the coil driver and the mains nets have something to land on and
# the sheet documents the actual circuit.  In pcbView every one of them is
# hybrid="yes": no pad, no ratsnest, no copper, nothing to route.  The board
# gets only the two mounting holes, and those are not connectors at all - they
# are `nonconn` filled circles, which Fritzing exports as NON-PLATED holes.
# Net effect: the relay appears in the schematic and the netlist, and on the PCB
# it is an outline, a keepout and two screw holes.
#
# Datasheet numbers used, mm:
#   flange envelope    68.58 x 34.54   (2.700 MAX x 1.36 MAX)
#   case body          52.07 wide      (2.05 MAX), same 34.54 depth
#   mounting centres   59.56 +/- 0.13  (2.345 +/- .005), .090 RAD for a #8 screw
#   case above flange  26.42           (1.04 MAX)
#   overall with tabs  37.97           (1.495 MAX)
# The flange plane is flush with the TOP of the case, so the relay stands on its
# flange: body and tabs rise 37.97 mm clear of the board.  No cutout and no
# standoffs are needed, and the tabs are wired from above.
#
# The tab pattern is the code-1 hole pattern, so it is derived from the same
# origin as T92S above (contact column A, pole 1) and then MIRRORED in x: the
# datasheet plan view is a bottom view, a PCB footprint is a top view.
T92P_ENV_W, T92P_ENV_H = 68.58, 34.54
T92P_BODY_W = 52.07
T92P_MTG_SPAN = 59.56
T92P_MTG_DRILL = 4.50              # clears a #8 (4.17 mm major) or an M4
T92P_MARGIN = 0.5                  # so silkscreen strokes are not clipped

T92P_W = T92P_ENV_W + 2 * T92P_MARGIN
T92P_H = T92P_ENV_H + 2 * T92P_MARGIN
_pex0 = _pey0 = T92P_MARGIN
_pecx, _pecy = _pex0 + T92P_ENV_W / 2, _pey0 + T92P_ENV_H / 2
_pbx0 = _pecx - T92P_BODY_W / 2
_pbx1 = _pecx + T92P_BODY_W / 2


def _t92p_xy(x_ds, y_ds):
    """Datasheet bottom-view coords (origin = pole 1 column A) -> top view."""
    x_cv = _pbx0 + (x_ds + 4.12)       # body left edge is x_ds = -4.12
    y_cv = _pey0 + (y_ds + 9.27)       # body top edge is y_ds = -9.27
    return 2 * _pecx - x_cv, y_cv      # mirror: bottom view -> top view


def _silk_line(x1, y1, x2, y2, sw=0.2032):
    return (f"<line class='other' x1='{x1:.4f}' y1='{y1:.4f}' x2='{x2:.4f}' "
            f"y2='{y2:.4f}' stroke='#f0f0f0' stroke-width='{sw}' "
            f"stroke-linecap='round'/>\n")


def _silk_text(x, y, size, txt, anchor="middle"):
    return (f"<text class='other' font-family=\"'Droid Sans'\" fill='#f0f0f0' "
            f"font-size='{size}' x='{x:.3f}' y='{y:.3f}' "
            f"text-anchor='{anchor}'>{txt}</text>\n")


# The two mounting holes: NOT connectors, so they never reach the netlist.
_t92p_mtg = [(_pecx - T92P_MTG_SPAN / 2, _pecy),
             (_pecx + T92P_MTG_SPAN / 2, _pecy)]
t92p_copper = "".join(pcb_nonconn(i, x, y, T92P_MTG_DRILL)
                      for i, (x, y) in enumerate(_t92p_mtg))

# Outer flange envelope.  Drawn as a plain rectangle: the real corners are
# chamfered, but the datasheet does not dimension the chamfer and the full
# rectangle is the conservative keepout.
t92p_silk = silk_rect(_pex0, _pey0, T92P_ENV_W, T92P_ENV_H)
for _x in (_pbx0, _pbx1):                       # case body edges
    t92p_silk += _silk_line(_x, _pey0, _x, _pey0 + T92P_ENV_H)
# Ring the mounting holes so they read as holes, not as dots.
for _x, _y in _t92p_mtg:
    t92p_silk += (f"<circle class='other' cx='{_x:.4f}' cy='{_y:.4f}' "
                  f"r='{T92P_MTG_DRILL / 2 + 0.9:.4f}' fill='none' "
                  f"stroke='#f0f0f0' stroke-width='0.15'/>\n")

# QC tab outlines.  Informational: these sit 26.4 to 38.0 mm above the board.
_t92p_contacts = [("2", 0.00, 0.00), ("4", 7.85, 0.00),
                  ("6", 0.00, 16.00), ("8", 7.85, 16.00)]
_t92p_coil = [("A1", 41.10, -4.70), ("A2", 41.10, 20.70)]
for _n, _xd, _yd in _t92p_contacts:
    _cx, _cy = _t92p_xy(_xd, _yd)
    t92p_silk += silk_rect(_cx - 0.405, _cy - 3.175, 0.81, 6.35, sw=0.1)
    t92p_silk += _silk_text(_cx, _cy + 5.0, 1.4, _n)
for _n, _xd, _yd in _t92p_coil:
    _cx, _cy = _t92p_xy(_xd, _yd)
    t92p_silk += silk_rect(_cx - 3.175, _cy - 0.405, 6.35, 0.81, sw=0.1)
    t92p_silk += _silk_text(_cx, _cy + 2.6, 1.4, _n)

t92p_silk += _silk_text(_pecx, 15.2, 2.2, "T92P7D22-12")
t92p_silk += _silk_text(_pecx, 18.0, 1.5, "30 A DPST-NO, panel mount")
t92p_silk += _silk_text(_pecx, 20.6, 1.5, "QC tabs - nothing routes here")
T92P_PCB = make_pcb_svg(T92P_W, T92P_H, [], t92p_silk, copper_extra=t92p_copper)

# Six real terminals in schematic and breadboard; all hybrid on the PCB.
t92p_left = [(0, "2", "2  P1 COM  L1 IN"),
             (2, "6", "6  P2 COM  L2 IN"),
             (4, "A1", "A1  COIL +12V")]
t92p_right = [(1, "4", "P1 NO  L1 SW  4"),
              (3, "8", "P2 NO  L2 OUT  8"),
              (5, "A2", "COIL DRIVE  A2")]
_t92p_tie = ""
for _i in range(2):                              # bar linking each pole's pair
    _y0 = GRID * (2 * _i + 1.5)
    _t92p_tie += (f"<line class='other' x1='{PINLEN:.4f}' y1='{_y0:.4f}' "
                  f"x2='{PINLEN:.4f}' y2='{_y0:.4f}' stroke='#000000' "
                  f"stroke-width='{LINESW * 3:.4f}' stroke-linecap='round'/>\n")
T92P_SCHEM, T92P_PINPOS, T92P_SW, T92P_SH = make_schem_svg(
    "K  T92P7D22-12  DPST-NO 30A  (off-board, QC tabs)", t92p_left, t92p_right)
T92P_BB = make_bb_svg("T92 panel mount", t92p_left, t92p_right)
T92P_IC = make_bb_svg("T92P", t92p_left, t92p_right, "icon")

T92P_ID = "T92P7D22_12_kilnmains"
_t92p_desc = {
    0: "pole 1 common, line 1 in - .250 in QC tab, wired off-board",
    1: "pole 1 N.O., line 1 switched - .250 in QC tab, wired off-board",
    2: "pole 2 common, line 2 in - .250 in QC tab, wired off-board",
    3: "pole 2 N.O., line 2 out - .250 in QC tab, wired off-board",
    4: "coil A1, +12 V - .250 in QC tab, take it to a 2-pin SELV block",
    5: "coil A2, low side to the MOSFET drain - .250 in QC tab",
}
t92p_conns = [{"idx": i, "name": n, "desc": _t92p_desc[i], "hybrid": True}
              for i, n in ((0, "2"), (1, "4"), (2, "6"), (3, "8"),
                           (4, "A1"), (5, "A2"))]
T92P_FZP = fzp(
    T92P_ID, "TE T92P7D22-12 relay, panel mount (hybrid: no PCB connections)", "K",
    "TE / Potter &amp; Brumfield T92 two-pole 30 A relay, 2 form A, 12 VDC coil, "
    "panel mount via flanged cover with .250 in (6.35 x 0.81 mm) quick-connect "
    "tabs. "
    "HYBRID PART: all six terminals are real in schematic and breadboard, so the "
    "coil driver and the mains nets connect normally and the sheet documents the "
    "real circuit - but every one is hybrid in pcbView, so there is no pad, no "
    "ratsnest and nothing to route on the board. The PCB gets the outline plus "
    "two mounting holes only, and those are non-plated: no copper, no net. "
    "Wire the contacts to the load with .250 in QC receptacles and bring the "
    "coil back to a 2-pin SELV terminal block. "
    "The flange plane is flush with the top of the case, so the relay stands on "
    "its flange and the body plus tabs rise 37.97 mm clear of the board - no "
    "board cutout and no standoffs are needed. "
    "Envelope 68.58 x 34.54 mm over the flanges, case 52.07 mm wide, mounting "
    "centres 59.56 +/- 0.13 mm, holes 4.5 mm for a #8 or M4 screw. Silkscreen "
    "tab marks are informational and mirrored to a top view; the real tabs sit "
    "26.4 to 38.0 mm above the board. Footprint from TE datasheet 1308242 rev "
    "1217, mounting and termination code 2.",
    "kiln mains", t92p_conns,
    {"package": "panel mount", "part number": "T92P7D22-12",
     "mn": "TE Connectivity", "voltage": "277VAC", "current": "30A",
     "coil": "12VDC"})

if __name__ == "__main__":
    write_part(T92P_ID, T92P_FZP, T92P_BB, T92P_SCHEM, T92P_PCB, T92P_IC)
    print("wrote T92P panel-mount footprint (hybrid)")
    print(f"  envelope {T92P_ENV_W:.2f} x {T92P_ENV_H:.2f} mm, "
          f"svg {T92P_W:.2f} x {T92P_H:.2f} mm")
    print(f"  {len(t92p_conns)} connectors, all hybrid on the PCB; "
          f"{len(_t92p_mtg)} non-plated mounting holes")
    for _i, (_x, _y) in enumerate(_t92p_mtg):
        print(f"    nonconn{_i} at ({_x:.3f}, {_y:.3f}) "
              f"dia {T92P_MTG_DRILL} mm, non-plated")
