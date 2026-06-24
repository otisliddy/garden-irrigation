# Garden Irrigation

Solar-powered ESP32-S3 irrigation for a garden in Glenealy, Ireland. 9 raised beds
(8'×4') + 2 polytunnel lines, controlled as **3 zones**: Beds A (5 beds), Beds B
(4 beds), Polytunnel. Personal project. User knows electronics/Arduino — prefers
concise answers and direct corrections over hedging.

## Components

- `arduino/garden-irrigation/` — ESP32-S3 firmware (`*.ino`, single file). Online via
  AWS IoT (MQTT/TLS), degrades to on-device moisture loop when offline. `secrets.h`
  (git-ignored) holds WiFi + X.509 certs; copy from `secrets.h.example`.
- `infra/` — AWS CDK (TypeScript). Region `eu-west-1`, profile `personal`. Stacks:
  `GardenData` + `GardenIot` (built), `GardenApi` + `GardenWeb` (todo). See `README.md`.
- `web/` — React + Vite PWA, recharts. Dashboard, charts, settings. Not yet deployed.

## Authoritative docs (read before changing the matching area)

- `docs/cloud_design.md` — full cloud/web design: MQTT topics, shadow schema, DynamoDB,
  HTTP API, weather/rain-skip, phases.
- `docs/wiring_diagram.txt` — pin map & wiring (also mirrored in the .ino pin defines).
- `docs/notes.txt` — firmware sequencing rules, soil ADC mapping, plumbing notes.
- `docs/purchased.txt` — actual BOM.

## Key hardware constraints (drive firmware logic)

- **No master valve.** Mains flow can't feed two zones at once → at most ONE auto
  valve open at a time (overrides are exempt). Zones latch independently.
- **Latching solenoids** driven by 2× L298N. A close pulse is a harmless no-op, so
  close-before-open keeps physical state known. `PULSE_MS` ~50ms.
- **Sleep-cutoff relay (GPIO 47)** energises only during a pulse; valves hold with
  zero power. Rule: never drive an L298N IN pin while its module is unpowered —
  relay ON → settle → pulse → relay OFF (see notes.txt §10 rule 1).
- **Soil sensors**: 5× capacitive analog on ADC1 (GPIO 1–5). **Higher reading = drier**
  (dry ~3350, wet ~1300). DHT11 in polytunnel (GPIO 8). Battery sense GPIO 6 (×11 divider).
- **Buttons** GPIO 21/13/14 (Beds A / Beds B / Poly), active-low, RTC EXT1 wake.

## Fail-closed reality (NOT the original 4-layer plan)

Only the **cold-boot close pulse** is implemented: on a real power-on reset, fire close
on all 3 valves before anything else. A timer/EXT1 wake must NOT slam valves closed
(would interrupt watering). The planned hold-up cap + LM393 comparator layers (3 & 4)
were **dropped**: on total power loss the ESP dies and latching valves hold last state
until power returns and the boot close-pulse fires (notes.txt §10 rule 5). Battery ADC
is alerting/health only — no safety action depends on it.

## Operation

15-min deep-sleep cycle. On wake: read sensors, sync time (SNTP), connect AWS, apply
shadow config/commands, run watering, report telemetry, sleep. Daytime + battery-OK +
connected → stay awake (modem light-sleep) and responsive to web/buttons. Night or
offline → one sample + moisture cycle + sleep. Low battery → power-save (no WiFi).
Always-on draw ~100–120mA (no MOSFET gating of the L298N floor; deferred).
