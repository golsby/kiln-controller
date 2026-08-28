# Kiln Mains Board

Fritzing project for the mains side of the kiln controller: the 240 VAC 2-pole
contactor, its two-agent coil drive, the 12 V/5 V supplies, and the drive and
sense terminals for an off-board SSR. Companion to [`../PiHat`](../PiHat), which
keeps the thermocouples, the Pi and the Arduino safety watcher.

Open `Kiln Mains Board.fzz` in Fritzing 1.0.7 or later. The custom parts travel
inside the `.fzz`, so it opens standalone; `parts/` holds the same sources if you
want them in your own bin.

**Status: schematic complete and wired, PCB placed but not routed.** The coloured
lines in PCB view are ratsnest, not copper. See [Before you fab](#before-you-fab).

![schematic](render/schematic.png)

## The kiln this is built for

Seattle Pottery Supply 184, **240 V, 21 A, 5.04 kW**, on a **3-wire** receptacle
(L1, L2, GND, no neutral). Every sizing decision below follows from those three
numbers, so re-check the whole thing if you move it to another kiln.

Two consequences worth stating up front:

- **No neutral means no 120 V.** There is no legal or safe way to derive 120 V
  from L1-to-ground; ground is not a current-carrying conductor. If you want a
  mains-powered kiln fan, run a 240 VAC fan across L1-L2. J7 is a 12 V DC fan
  header for a small enclosure fan, which is a different job.
- **The SSR is off-board.** The only PCB-mount SSRs with integral heatsinks
  (Sensata/Crydom PF series) are rated 10 A convection / 25 A forced air. With no
  enclosure fan in the design, 21 A is out of spec. Use a puck SSR on a finned
  heatsink or the enclosure wall, wired to J3 (load) and J4 (drive).

## How it works

**Power path.** L1 and L2 come in on J1 and land on the two poles of K1. Pole 1
switched output leaves on J3.1 to the external SSR and returns on J3.2; pole 2
goes straight through to J2.2. J2 feeds the elements. The SSR modulates one leg
every 2 s (`sensor_time_wait`); K1 is a safety disconnect that breaks *both* legs
and sees about two operations per firing, which is why 30 A contacts are
comfortable on a 21 A load.

**Two-agent coil interlock.** The K1 coil circuit is a hardware AND of three
independent things in series, all of which must agree before the contactor can
pull in:

```
+12V ── J5 (external NC thermal switch on the SSR heatsink) ── RLY1 contacts
     ── K1 coil ── Q1 (drain→source) ── GND
```

- **Q1** is the low-side element, gated by the Pi's `gpio_contactor` (`CTX`).
- **Q2** is the high-side elemnt, gated from the Arduino watcher's `ENABLE_PIN`, so the two agents are galvanically separate and neither can energize the contactor alone.

**R2**/**R4**/**R6** are gate pulldowns: a booting, crashed or unpowered Pi leaves every
driver open. **D1** is coil flybacks.

#### Supplies 

**PS1** takes **L1-L2** (universal input, non-polarised, so no neutral is
fine) through **F1** and gives 12V; 

**VR1** bucks that to 5V for the Pi. **MOV1** sits downstream of **F1** so a failed **MOV** blows the fuse, not the branch breaker.

#### Indicators 

**LED1** is the 5V rail.
**LED2** sits directly across the **K1** coil, so it means *contactor actually energized*, not *someone asked for it*. 

## Netlist

`+12V`, `+5V` and `GND` are drawn with Fritzing net labels rather than wires.
They are real nets — click any pin in Fritzing and it highlights the whole net —
but verify that once when you open the file, since it is the one thing here that
depends on Fritzing's label bussing rather than on drawn copper.

| Net | Pins | Members |
|---|---|---|
| `+12V` | 8 | PS1.+V, VR1.+Vin, C1.+, C3.0, J5.1, J7.1, D2.cathode, RLY1.COIL1 |
| `+5V` | 7 | VR1.+Vout, C2.+, C4.0, J4.1, J6A.1, R7.0, R9.0 |
| `GND` | 15 | PS1.-V, VR1.GND, C1.-, C2.-, C3.1, C4.1, Q1.source, Q2.source, Q3.source, J6A.2, J7.2, R2.1, R4.1, R6.1, LED3.cathode |
| `L1_IN` | 4 | J1.1, K1.2a, K1.2b, F1.1 |
| `L2_IN` | 5 | J1.2, K1.6a, K1.6b, PS1.AC/N, MOV1.2 |
| `L1_FUSED` | 3 | F1.2, PS1.AC/L, MOV1.1 |
| `L1_SW` | 3 | K1.4a, K1.4b, J3.1 |
| `L1_OUT` | 2 | J3.2, J2.1 |
| `L2_OUT` | 3 | K1.8a, K1.8b, J2.2 |
| `TS_RET` | 2 | J5.2, RLY1.MAIN |
| `COIL_H` | 5 | RLY1.NO, K1.A1a, K1.A1b, D1.cathode, R8.0 |
| `COIL_L` | 5 | K1.A2a, K1.A2b, D1.anode, Q1.drain, LED2.cathode |
| `LED2_A` | 2 | R8.1, LED2.anode |
| `RLY_COIL` | 3 | RLY1.COIL2, Q2.drain, D2.anode |
| `SSR_DRV` | 3 | J4.2, Q3.drain, LED1.cathode |
| `LED1_A` | 2 | R7.1, LED1.anode |
| `LED3_A` | 2 | R9.1, LED3.anode |
| `CTX` | 2 | J6B.1, R1.0 |
| `G_Q1` | 3 | R1.1, Q1.gate, R2.0 |
| `HEAT` | 2 | J6B.2, R5.0 |
| `G_Q3` | 3 | R5.1, Q3.gate, R6.0 |
| `ENABLE` | 2 | J6C.1, R3.0 |
| `G_Q2` | 3 | R3.1, Q2.gate, R4.0 |

`K1` terminals are named `2a/2b`, `4a/4b`, `6a/6b`, `8a/8b`, `A1a/A1b`, `A2a/A2b`.
**The `a` and `b` holes of each pair are one terminal**, two 1.93 mm holes on
5.16 mm centres. Both carry load current and both must be connected.

## Connectors

| Ref | Pitch | Function |
|---|---|---|
| J1 | 7.62 mm | 240 VAC in: 1 = L1, 2 = L2 |
| J2 | 7.62 mm | To kiln elements: 1 = L1 switched, 2 = L2 |
| J3 | 7.62 mm | External SSR load loop: 1 = from K1 pole 1, 2 = return to J2.1 |
| J4 | 5.08 mm | SSR drive: 1 = +5 V, 2 = SSR input − |
| J5 | 5.08 mm | Thermal switch, NC, in the contactor coil path |
| J6A | 5.08 mm | To PiHat: 1 = +5 V, 2 = GND |
| J6B | 5.08 mm | To PiHat: 1 = CTX (`gpio_contactor`), 2 = HEAT (`gpio_heat`) |
| J6C | 5.08 mm | 1 = ENABLE (Arduino `ENABLE_PIN`), 2 = spare |
| J7 | 5.08 mm | 12 V enclosure fan: 1 = +12 V, 2 = GND |

## Parts list

Link key: **[DS]** = datasheet PDF, downloaded and opened while writing this.
**[page]** = manufacturer or distributor product page — real, but not
fetch-checked, because those sites block scripted requests.

### On-board

| Ref | Qty | Part | Spec | Datasheet |
|---|---|---|:-:|---|
| K1 | 1 | TE / P&B **T92S7D22-12**<br />*T92P7D22-12* | DPST-NO, 30 A @ 277 VAC, 12 VDC coil, PCB terminals<br />*Panel mount + quick connect* | [DS](https://www.farnell.com/datasheets/2606696.pdf) · [page](https://www.newark.com/te-connectivity-potter-brumfield/t92p7d22-12/relay-dpst-no-277vac-28vdc-30a/dp/17M3087) |
| PS1 | 1 | Mean Well **IRM-20-12** | 85-264 VAC in, 12 V 1.8 A out, encapsulated, convection cooled | [DS](https://www.meanwell.com/Upload/PDF/IRM-20/IRM-20-SPEC.PDF) |
| VR1 | 1 | Traco **TSR 2-2450** | 5 V 2 A buck, SIP3, 7805 pinout, no heatsink | [DS](https://www.tracopower.com/sites/default/files/products/datasheets/tsr2_datasheet.pdf) |
| RLY1 | 1 | Omron **G6K-2F-Y DC12** or similar | 12 V coil signal relay; high-side element of the coil interlock | [DS](https://omronfs.omron.com/en_US/ecb/products/pdf/en-g6k.pdf) |
| Q1-Q3 | 3 | **IRLZ44N** | Logic-level N-MOSFET, TO-220, Vgs(th) 1.0-2.0 V | [DS](https://datasheet.octopart.com/IRLZ44N-International-Rectifier-datasheet-72962.pdf) · [page](https://www.infineon.com/part/IRLZ44N) |
| — | — | *SMD alternative* **AO3400A** | SOT-23, fully on at 2.5 V gate | [DS](https://www.aosmd.com/pdfs/datasheet/AO3400A.pdf) |
| D1 | 1 | **1N4007** | K1 coil flyback, DO-41 | [DS](https://www.vishay.com/docs/88503/1n4001.pdf) |
| D2 | 1 | **1N4148** | RLY1 coil flyback | [DS](https://www.vishay.com/docs/81857/1n4148.pdf) |
| F1 | 1 | 500 mA slow-blow, 5×20 mm + PCB clips | Protects the PSU branch only, not the kiln | [page](https://www.littelfuse.com/products/fuses/cartridge-fuses/5x20mm-fuses/217) |
| MOV1 | 1 | **S14K275** (TDK/EPCOS) or V275LA20AP | 275 VAC, 14 mm disc, 7.5 mm leads | [DS](https://www.tdk-electronics.tdk.com/inf/70/db/var/SIOV_Leaded_StandarD.pdf) |
| C1 | 1 | 10 µF 25 V electrolytic | 12 V rail bulk | — |
| C2 | 1 | 10 µF 16 V electrolytic | 5 V rail bulk | — |
| C3, C4 | 2 | 100 nF ceramic, 50 V | rail decoupling | — |
| R1, R3, R5 | 3 | 100 Ω 1/4 W | gate series | — |
| R2, R4, R6 | 3 | 10 kΩ 1/4 W | gate pulldown — fail-safe off | — |
| R7, R8, R9 | 3 | 1 kΩ 1/4 W | LED series | — |
| LED1 | 1 | Red 5 mm | Power | — |
| LED2 | 2 | Green 5 mm | CTX (coil energized) | — |
| J1, J2, J3 | 3 | **Phoenix Contact PC 5** 2-pos, 7.62 mm | 41 A / 10 mm². Do not substitute a 5 mm block — those stop around 16 A | [page](https://www.phoenixcontact.com/en-us/products/pcb-terminal-blocks-and-pcb-connectors/pcb-terminal-blocks) |
| J4-J7 | 6 | 2-pos, 5.08 mm terminal block | SELV side, any make | — |

R2/R4/R6 are what guarantee the contactor stays open while the Pi is booting,
crashed, or unpowered. Don't drop them.

### Off-board, but part of the design

| Part | Spec | Datasheet |
|---|---|---|
| **SSR** | Sensata/Crydom **CWD2450** — 50 A, 24-280 VAC, zero-cross, 3-32 VDC input, screw terminals. 50 A on a 21 A load is deliberate margin; the Fotek clones are not honestly rated. | [page](https://www.sensata.com/products/relays/cw-series-240-vac-panel-mount-solid-state-relay-cwd2450) |
| **SSR heatsink** | Finned, or bolt the SSR to the enclosure wall. At 21 A you are dissipating roughly 25 W. | — |
| **Thermal switch** | Honeywell **2455R-100-74** — SPST-NC, opens at 70 °C, resets at 55 °C. Bolt to the SSR heatsink, wire to J5. | [DS](https://prod-edam.honeywell.com/content/dam/honeywell-edam/sps/siot/en-ca/products/sensors/temperature-sensors/thermostats/documents/sps-siot-commercial-thermostats-ps-009053-2-en-ciid-49660.pdf) · [page](https://www.newark.com/honeywell/2455r-100-74/thermal-switch/dp/98K8367) |

### Two things to confirm before ordering

**Gate drive voltage.** Q1-Q3 gates come in on J6B/J6C from the PiHat. The
existing PiHat buffers the Pi's 3.3 V GPIO up through a transistor, so these
should arrive at 5 V — check that on your board. If any of them is actually
3.3 V, the IRLZ44N still turns on (Vgs(th) max 2.0 V) and the loads here are tiny
(75 mA coil, ~30 mA relay coil, ~15 mA SSR input), but its Rds(on) is only
characterised at Vgs = 5 V. AO3400A is the safer choice at 3.3 V.

**RLY1 footprint.** The board uses Fritzing's generic PTH relay footprint, which
is not the G6K. Either check it against the relay you buy or swap the part.

## Custom Fritzing parts

Eight `.fzp` files in [`parts/`](parts), modelling six physical parts. The `…R`
variants are the same footprint with the schematic symbol mirrored, so input
terminals can sit on the left of the sheet and still have their pins face right.

| Fritzing part | Models | Footprint source |
|---|---|---|
| `T92S7D22_12_kilnmains` | TE T92S7D22-12 relay | TE datasheet 1308242 rev 1217, termination code 1 |
| `IRM_20_12_kilnmains` | Mean Well IRM-20-12 | Mean Well case 219A (bottom view, mirrored to top-down) |
| `TSR_2_2450_kilnmains` | Traco TSR 2-2450 | Traco TSR 2 outline drawing, SIP3 |
| `MOV_S14K275_kilnmains` | 14 mm disc MOV | generic radial, 7.5 mm lead pitch |
| `TB2_762_kilnmains`, `…762R` | 7.62 mm terminal block | generic, sized to Phoenix PC 5 |
| `TB2_508_kilnmains`, `…508R` | 5.08 mm terminal block | generic |

These exist because Fritzing 1.0.7 ships its screw-terminal parts without
schematic or PCB SVGs on disk, and its only varistor is an 0603 chip part.

## Before you fab

Nothing here is fab-ready yet. In order:

1. **Route it.** Placement is done, copper is not. At 21 A with a 30 °C rise,
   IPC-2221 wants **5.1 mm of 2 oz** external trace or 3.4 mm of 3 oz. Pour the
   mains nets wide; 6 mm on 2 oz gives margin with no solder-bead tricks.
2. **Verify the custom footprints** against a 1:1 printout with the real parts in
   hand. Standard practice for any custom footprint, and these were derived from
   datasheet drawings, not vendor CAD:
   - `T92S7D22_12_kilnmains` — the TE drawing is **not to scale**, so the printed
     dimensions were used and the pixel geometry ignored.
   - `IRM_20_12_kilnmains` — Mean Well case 219A is a **bottom view**; it is
     mirrored here into a top-down footprint. Worth a second look.
   - `MOV_S14K275_kilnmains`, `TB2_*` — generic, sized from the part class.
3. **Cut the isolation slot.** The band `y = 54.5 … 66 mm` is deliberately empty.
   Add a routed slot down the middle of it in the board outline. A kiln room is
   pollution degree 3 (silica dust), so budget 8 mm creepage mains-to-SELV.
4. **Treat both legs as live.** 3-wire means neither leg is "cold" — both sit at
   120 V to ground and 240 V to each other. Keep clearances symmetric across the
   whole mains section.
5. **Conformal coat** the finished board.
6. Check the `RLY1` footprint against the relay you actually buy.

## Regenerating

The `.fzz` is generated, not hand-edited. If you edit it in Fritzing, your changes
live in the `.fzz` and re-running the tools will overwrite them.

```bash
python3 tools/gen_parts.py && python3 tools/gen_sketch.py
```

`gen_parts.py` writes `parts/`; `gen_sketch.py` reads them plus the Fritzing core
library and writes the `.fzz`. `gen_sketch.py` also runs a placement check for
band violations, off-board parts and overlaps, and prints anything it finds.

To re-render:

```bash
/Applications/Fritzing.app/Contents/MacOS/Fritzing -svg <folder-containing-the-fzz>
```

## Also worth fixing

`config.py:35` has `kw_elements = 9.460`, inherited from upstream's Skutt. This
kiln is 5.04 kW, so every cost figure the UI reports is about 1.9× high.
