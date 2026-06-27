# Kiln Controller PiHat — Bill of Materials

Generated from `Kiln Controller.fzz` (Fritzing sketch). Of the 488 placements in the
sketch, 459 are wires, vias, ground symbols, and net/power labels (PCB artifacts); the
**29 real component placements** are listed below.

## Active / semiconductor

| Qty | Designators | Part | Value / Marking | Package |
|-----|-------------|------|-----------------|---------|
| 2 | IC1, IC2 | MAX31855K thermocouple-to-digital converter | "MAX31855K" | SOIC-8 (SO08-EIAJ) |
| 4 | U1, U2, U3, U4 | Sharp PC817 optocoupler | — | Sharp-PC817 (confirm DIP-4 vs SMD) |
| 2 | Q1, Q2 | BC847 NPN transistor | — | SOT-23 (SMD) |

## Passives

| Qty | Designators | Value | Rating | Package |
|-----|-------------|-------|--------|---------|
| 3 | C1, C2, C4 | 100 nF (0.1 µF) | 35 V | 0805 |
| 1 | C3 | 10 nF | 35 V | 0805 |
| 1 | R1 | 47 kΩ | ±5%, 0.25 W | 0805 |

## LEDs (0805)

| Qty | Designators | Color |
|-----|-------------|-------|
| 4 | DOOR, EMRG, RUN, SAFE | Green (570 nm) |
| 1 | HEAT | Red (633 nm) |

## Connectors

| Qty | Designators (net) | Part |
|-----|-------------------|------|
| 9 | +5V, +5V, CTX, DOOR, EMRG, GND, HEAT, TC-PRI, TC-Safe | 2-position screw terminal, 0.1″ (100 mil) pitch |

## Boards / modules

| Qty | Ref | Part |
|-----|-----|------|
| 1 | "Arduino Metro Mini" | Adafruit #2590 (Metro Mini 328) — independent safety-watcher MCU |
| 1 | "Raspberry Pi 1" | Raspberry Pi 3 (RPI-3-V1.2) — host SBC the HAT plugs onto (not populated on this PCB) |

**Totals:** 2× MAX31855K, 4× PC817, 2× BC847, 5× capacitors, 1× resistor, 5× LEDs,
9× screw terminals, 1× Metro Mini, plus the host Pi.

## Notes / verify before ordering

1. **Only one resistor (R1, 47 kΩ) is placed.** A board with 5 LEDs, 4 optocouplers, and
   2 transistors would normally need LED current-limiting and transistor base resistors.
   Either the Fritzing sketch is incomplete or those resistors live off-board — confirm
   against the schematic.
2. **No 2×20 (40-pin) GPIO header** appears as a discrete part — the Pi is modeled as a
   whole board. A real HAT needs a 40-pin female header to seat on the Pi; add it to the
   assembly BoM.
3. **PC817 footprint** — the Sharp PC817 is THT DIP-4 by default but has an SMD variant;
   confirm which footprint the PCB actually uses.

## Net / function reference

| Net | Function |
|-----|----------|
| +5V, GND | Power rails |
| HEAT | Heating-element solid-state relay drive (red indicator LED) |
| CTX | Contactor |
| EMRG | Emergency shutoff input |
| DOOR | Door switch input |
| TC-PRI | Primary thermocouple (main control sensor) |
| TC-Safe | Safety thermocouple (independent watcher sensor) |
| RUN, SAFE | Status indicator LEDs |
