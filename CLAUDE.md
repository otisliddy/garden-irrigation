# Garden Irrigation

Solar-powered ESP32-S3 irrigation system. Location: Ireland. Scope: 9 raised beds (8'×4') + 2 polytunnel lines, controlled as 3 zones (Beds A, Beds B, Polytunnel). No master valve — mains flow can't water all 9 beds at once, so the beds are split into two independently-watered groups (Beds A = 5 beds, Beds B = 4 beds). Phase: hardware purchased, firmware not yet written.

## Docs: hardware design

- `docs/purchased.txt` — actual BOM (what's on the shelf)
- `docs/wiring_diagram.txt`

## Things only in conversation, not in wiring_diagram.txt

**No master valve.** The three zones fire independently — no open/close sequencing
between valves. (The former master valve and its L298N #1 channel A / GPIO 10-12
were repurposed as the Beds B valve.)

**Fail-closed design (4 layers, in priority order):**
1. **Boot close pulse** — fire close on all 3 valves every boot, before anything else. Highest-value, always runs.
2. **Battery voltage ADC** — read once per 15-min wake. Alerting/health only, not a safety mechanism (deep sleep prevents polling).
3. **Hold-up cap** — 4700–10000µF on 5V rail keeps ESP32 alive ~150ms after power loss. Pairs with Layer 4.
4. **LM393 comparator** monitoring 12V rail → ESP32 RTC GPIO wake pin. Hardware-level, works during deep sleep. ESP32 wakes in ~10ms on power drop and fires close pulses. **Not yet drawn in wiring_diagram.txt — add when implementing.**

Layer 4 is load-bearing. Layers 2–3 alone are insufficient because deep sleep precludes polling.

## Software architecture (planned, not built)

- **ESP32**: 15-min deep-sleep cycle. On wake: read sensors, check schedule, fire valves, report to AWS via MQTT, sleep.
- **AWS**: schedule logic, rain-skip decision, MQTT broker, persistence with DynamoDB.
- **Weather**: Met Éireann API (free, no key, authoritative for Ireland). Skip if >Xmm forecast.
- **UI**: TBD.

## Power budget (for firmware decisions)

- Peak: ~430mA (WiFi + solenoid fire simultaneously)
- Typical awake: ~230mA
- Deep sleep: ~80mA (dominated by L298N quiescent draw, ~40mA per module)
- Runtime without solar: ~100h at sleep draw
- Future optimisation: MOSFET to cut 12V to L298N VCC between cycles would slash sleep draw

## Sensor notes

- **Soil sensors**: 5× capacitive, analog. Higher reading = drier. On 3 AWG18 5-core cables: polytunnel (1 soil + DHT11), 2 bed cables (2 soil each). AOUT bypasses the perfboard straight to ESP ADC; VCC/GND come from the perfboard. Battery-sense is on GPIO 6.
- **DHT11**: 1× in the polytunnel (GPIO 8). Temperature (±2°C) and humidity (±5%). Elegoo module version has onboard pull-up; no perfboard pull-up needed.

## User context

Personal project, not work. User is comfortable with electronics and Arduino fundamentals. Prefers concise answers and direct corrections over hedging.
