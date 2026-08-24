# Narrow-pad PCB footprints

Fritzing's stock through-hole footprints use ~70-75 mil pads on 100 mil pitch,
leaving only 25-30 mil of gap between adjacent pads. That is not enough room for
a trace plus DRC keepout, which forces every net to route around the outside of
each header and makes the board very hard to lay out.

These are the same footprints with the copper rings thinned to an 8 mil annular
ring. **Drill hole sizes are unchanged**, so parts fit exactly as before.

| Footprint | Source | Hole | Pad OD | Gap between pads |
|---|---|---|---|---|
| `metro_mini_narrowpad_pcb.svg` | user part `bdg_cac67ad6...` | 39.4 mil (1.0 mm) | 70.0 → 55.4 mil | 30.0 → 44.6 mil |
| `raspberry_pi_3_narrowpad_pcb.svg` | core `raspberry_pi_3_rev-1.2.svg` | 40.6 mil (1.03 mm) | 75.4 → 56.6 mil | 24.6 → 43.4 mil |
| `PC817_narrowpad_pcb.svg` | core `PC817_9.svg` | 35.0 mil (0.89 mm) | 75.0 → 51.0 mil | 25.0 → 49.0 mil |

Only `<circle>` elements with `id="connectorNpin"` / `connectorNpad` inside the
`copper0`/`copper1` groups were touched. Silkscreen and board outline are byte
identical.

## The math

Fritzing draws a THT pad as a circle with a thick stroke:

    hole = 2r - stroke-width
    OD   = 2r + stroke-width

To set a given annular ring while holding the hole fixed:

    stroke-width = ring
    r            = (hole + ring) / 2

Watch the units per inch, they differ per file: the Metro Mini and Pi footprints
use 72 units/inch, the PC817 uses 1000 units/inch.

## Using these

In Fritzing (1.0.7): right-click the part in PCB view > `Edit (new parts editor)`
> PCB tab > `File > Load image for view` > pick the SVG here >
`File > Save as New Part`. The new part lands in the MINE bin and in
`~/Documents/Fritzing/parts/svg/user/pcb/`.

Then set the routing rules to match:

- `Routing > Autorouter/DRC settings...` > Keepout `0.008in`
- `Routing > Select All Traces`, then set width to 8 or 12 mil in the Inspector

A 43 mil gap fits one 12 mil trace with 15 mil clearance each side, or two 8 mil
traces at 8 mil keepout.

## Manufacturing note

An 8 mil (0.203 mm) annular ring is above the 0.15 mm minimum quoted by JLCPCB
and PCBWay for 2-layer plated through-holes, but it is not a large margin once
drill tolerance is counted. If a fab rejects it, regenerate with a 10 mil ring:
that costs 4 mil of gap per pad and still leaves ~39 mil.

## Not included

`screw_terminal_2_100mil` (10 in the sketch) references
`pcb/screw_terminal_2_100mil_pcb.svg`, which does not ship with Fritzing 1.0.7 —
the file is absent from the parts library. Check how those render in PCB view
before relying on them.
