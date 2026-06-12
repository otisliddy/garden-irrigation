# Garden Irrigation — Cloud & Web Design

Design for Stage 2: connect the ESP32-S3 to the internet, persist sensor data,
and provide a web UI for control and visualisation. The device must keep working
offline exactly as it does today; the cloud is additive, never load-bearing for
safe operation.

- **AWS account:** 056402289766 (profile `personal`)
- **Region:** eu-west-1
- **Location:** Glenealy, Ireland (≈ 52.99 N, -6.18 E)
- **Status:** design — not yet built.

---

## 1. Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │                  AWS (eu-west-1)             │
                          │                                              │
  ESP32-S3 ──MQTT/TLS──►  │  IoT Core ──Rule──► DynamoDB (Sensors)       │
  (X.509 cert)            │     │     ──Rule──► DynamoDB (ValveEvents)    │
     ▲   │                │     │                                        │
     │   └──Shadow delta◄──┼─────┤  Device Shadow (config + valve desired)│
     │                    │     │                                        │
     │                    │  IoT Rule (battLow/fault/offline) ──► SNS ──► email
     │                    │                                              │
     │                    │  EventBridge (hourly) ──► Lambda (weather)   │
     │                    │        └──► Met Éireann ──► Shadow.rainSkip   │
     │                    │                                              │
  Browser (PWA)           │  API Gateway (HTTP API) ──► Lambda(s) ───────┤
  S3 + CloudFront ──REST──►│    GET /sensors /valve-history /config /weather
                          │    PUT /config   POST /zone/{id}             │
                          │       └─► Shadow update / DynamoDB query     │
                          └─────────────────────────────────────────────┘
```

**Principles**
- **Offline-first.** If WiFi/MQTT is unavailable the device runs its current
  moisture-driven loop with compiled-in defaults. Cloud config refines behaviour
  but is never required for safe watering or fail-closed.
- **Shadow is the source of truth for config + commands.** Survives device reboot
  and RTC-memory loss. Website writes `desired`; device applies and writes `reported`.
- **Fail-safe timers live on the device.** "On for N minutes" is enforced by the
  device's existing override timeout, so a dropped connection still closes the valve.
- **No browser AWS credentials.** The site is unauthenticated; all AWS access is
  behind API Gateway → Lambda.

---

## 2. MQTT topics & Device Shadow

**Thing name:** `irrigation-controller-01`. Single device for now; topics include the
thing name so a second controller can be added later without collision.

### 2.1 Topics

| Topic | Dir | Payload |
|---|---|---|
| `garden/irrigation-controller-01/telemetry` | device→cloud | sensor snapshot (§3.1) |
| `garden/irrigation-controller-01/valve` | device→cloud | valve event (§3.2) |
| `garden/irrigation-controller-01/status` | device→cloud | boot/health, mode (online/power-save), fault, battery |
| `$aws/things/irrigation-controller-01/shadow/...` | both | reserved shadow topics |

### 2.2 Device Shadow document

```jsonc
{
  "state": {
    "desired": {
      "config": {
        "soilThreshold": {            // higher reading = drier; start watering at/above
          "bedsA":      2800,
          "bedsB":      2800,
          "polytunnel": 2800
        },
        "soilStop": {                  // stop when wetter than this (hysteresis)
          "bedsA":      2500,
          "bedsB":      2500,
          "polytunnel": 2500
        },
        "rainSkipMm":        3,        // skip Beds A/B if forecast rain ≥ this
        "overrideMinutes":  30,        // manual/web "on" duration
        "wateringWindow":  { "startHour": 7, "endHour": 21 },  // local time; auto-water only inside
        "freezeGuardC":      2.0,      // skip watering if temp/forecast ≤ this
        "dailyCapMin":     120
      },
      "valve": {                       // web/cloud commanded state; null = no override
        "bedsA":      { "open": null, "untilEpoch": 0 },
        "bedsB":      { "open": null, "untilEpoch": 0 },
        "polytunnel": { "open": null, "untilEpoch": 0 }
      },
      "rainSkip": false                // set by weather Lambda; affects Beds A/B only
    },
    "reported": {
      "config":   { /* echo of applied config */ },
      "valve":    { "bedsA": {"open": false}, "bedsB": {"open": false}, "polytunnel": {"open": false} },
      "mode":     "online",            // online | power-save | offline-fallback
      "battV":    12.9,
      "fault":    false,
      "fw":       "2.0.0",
      "lastSeenEpoch": 1760000000
    }
  }
}
```

Notes:
- Config is **one block** so the website PUT is atomic and the device applies a delta in one place.
- `valve.*.open = null` means "no web override — automatic control owns this zone."
  A non-null `open` plus `untilEpoch` is a timed manual command; the device sets its
  own override timer from `overrideMinutes` (it does **not** trust `untilEpoch` for the
  close — that field is advisory/for UI display).
- The device timestamps nothing itself; see §6 (time).

---

## 3. DynamoDB

Two tables, on-demand billing, PITR off (cost), TTL on.

### 3.1 `irrigation-sensors`

One item per reading tick (every 15 min, plus on manual wake). All sensors in one item.

| Attr | Type | Notes |
|---|---|---|
| `deviceId` (PK) | S | `irrigation-controller-01` |
| `ts` (SK) | N | epoch **milliseconds**, set by IoT Rule `timestamp()` |
| `soilPoly`,`soilA1`,`soilA2`,`soilB1`,`soilB2` | N | raw ADC (higher = drier) |
| `tempC`,`rh` | N | DHT11 (may be null on read error) |
| `battV` | N | volts |
| `ttl` | N | `trunc(timestamp()/1000) + 31536000` (epoch **seconds**, 12 months — DynamoDB TTL requires seconds) |

### 3.2 `irrigation-valve-events`

| Attr | Type | Notes |
|---|---|---|
| `deviceId` (PK) | S | |
| `ts` (SK) | N | epoch **milliseconds** (IoT Rule) |
| `zone` | S | `bedsA` \| `bedsB` \| `polytunnel` |
| `action` | S | `open` \| `close` |
| `source` | S | `auto` \| `manual` (web) \| `override` (button) \| `failclose` |
| `durationSec` | N | on `close` events: length of the just-ended opening |
| `ttl` | N | 12 months |

Query patterns: both tables are `deviceId` + `ts` range queries. The API Lambda
**downsamples** long ranges (raw for ≤ 48 h, bucket-averaged into ≤ ~500 points beyond)
so the browser never pulls a year of 15-min rows.

---

## 4. HTTP API (API Gateway HTTP API → Lambda)

Unauthenticated (per risk tolerance). CORS locked to the CloudFront domain.

| Method & path | Purpose | Backed by |
|---|---|---|
| `GET /sensors?from=&to=&metrics=` | sensor series, downsampled | DynamoDB query |
| `GET /valve-history?from=&to=` | valve open/close events | DynamoDB query |
| `GET /config` | current config | Shadow `reported.config` (fallback `desired`) |
| `PUT /config` | update thresholds/windows/etc. | Shadow `desired.config` merge |
| `POST /zone/{zone}` body `{open:bool}` | manual on/off; "on" auto-closes after `overrideMinutes` | Shadow `desired.valve` |
| `POST /zone/{zone}/skip-next` | skip the next automatic watering | Shadow flag |
| `GET /weather` | current + 24 h forecast for the UI | Met Éireann (cached) |
| `GET /status` | mode, battery, fault, lastSeen | Shadow `reported` |

Live updates: the React app **polls** `GET /sensors` (latest) and `GET /status`
every ~5 s. (MQTT-over-WebSocket with a Cognito guest identity is a later upgrade
if polling latency/cost ever matters — it won't at this scale.)

---

## 5. Weather & rain-skip

- **Source:** Met Éireann location-forecast (free, no key, authoritative for Ireland).
  Backup: Open-Meteo (free, no key) if Met Éireann is unreachable.
- **Scheduler:** EventBridge rule, hourly → `weather` Lambda. Sums forecast rainfall
  over the next **12 h**; if `≥ rainSkipMm` (default **3 mm**) it sets
  `desired.rainSkip = true`. Also caches the current obs + 24 h forecast for `GET /weather`.
- **Scope:** rain-skip suppresses **Beds A and Beds B only** (open raised beds). The
  polytunnel is covered and ignores rain.
- **Offline fallback:** if the device can't reach AWS it never sees `rainSkip` and
  waters on moisture alone — acceptable and safe.
- **Freeze guard:** device skips automatic watering when DHT temp ≤ `freezeGuardC`;
  the weather Lambda can additionally set a freeze flag from the forecast.

---

## 6. Firmware changes (Phase 2)

Builds on the current `garden-irrigation.ino`. The offline state machine stays; we
layer connectivity on top.

- **WiFi + AWS IoT MQTT/TLS** using device X.509 cert (stored in firmware/NVS).
- **No polling.** Persistent subscription to shadow delta; broker pushes commands.
  WiFi power save `WIFI_PS_MIN_MODEM` (DTIM light-sleep) for ~20–40 mA while connected.
- **Telemetry** published every 15 min and on manual wake (one extra reading — simple,
  and irregular spacing is fine for the charts).
- **Shadow reconcile on connect:** pull `desired`, apply config delta, publish `reported`.
- **Time:** device has no RTC. It does **not** set timestamps — the IoT Rule stamps
  ingest time via `timestamp()`. For local-time logic (watering window) the device
  syncs wall-clock via SNTP when online; offline it falls back to "always within window"
  so it still waters.
- **Valve commands** from `desired.valve` map onto the existing override mechanism, so
  the device-side auto-off timer (`overrideMinutes`) enforces the close even if the
  link drops mid-watering.

### 6.1 Power management (no MOSFET — software mitigations)

Always-connected keeps the ~80 mA L298N floor plus the ESP (~20–40 mA in light-sleep)
≈ 100–120 mA average ⇒ ~3 days autonomy with zero solar. Tight in an Irish-winter dark
spell. Mitigations:

1. **Day/night gating.** Responsive (connected, light-sleep) during the watering
   window's daytime band (~07:00–22:00). Outside it, revert to the legacy 15-min
   deep-sleep cycle — no watering or button use happens overnight anyway.
2. **Low-battery auto-degrade.** If `battV < BATT_LOW_V`, drop to the deep-sleep cycle
   regardless of time and report `mode: power-save`; the website surfaces it.
3. **MOSFET upgrade remains open** — gating 12 V into the L298Ns (on only for the
   ~250 ms pulse) would remove the 80 mA floor and make always-on comfortable. Deferred.

> The battery ADC on GPIO 6 reads correctly (~0.76 V seen only when the battery was
> physically disconnected). Battery monitoring/alerts can rely on it.

---

## 7. Security

- IoT: mutual TLS, per-device X.509 cert, IoT policy scoped to this thing's topics +
  shadow only.
- API: open by design (anyone with the URL can toggle water — accepted). CORS limited
  to the site origin; optional throttling on API Gateway to blunt abuse.
- No secrets in the React bundle. Lambda roles least-privilege (one table/shadow each).

---

## 8. Infrastructure as code (AWS CDK, TypeScript)

`cdk deploy --profile personal` (region eu-west-1). One app, a few stacks:

- **`IotStack`** — Thing, cert, policy, IoT Rules (telemetry→DDB, valve→DDB,
  health→SNS), SNS topic + email subscription.
- **`DataStack`** — the two DynamoDB tables.
- **`ApiStack`** — HTTP API + Lambdas (sensors, config, zone, weather, status) +
  EventBridge schedule for the weather Lambda.
- **`WebStack`** — S3 bucket (private) + CloudFront (OAC) + cert/domain, SPA redirects.

Cert provisioning: CDK creates the IoT thing/policy; the device cert+keys are generated
once (CLI or a small custom resource) and the private key is installed on the device by
hand — never committed.

---

## 9. Website (React, Phase 4)

SPA on S3+CloudFront, installable **PWA** (manifest + service worker), touch-friendly.

**Views**
- **Dashboard:** three zone cards with on/off + "water N min" + skip-next; current
  weather + 24 h forecast strip; mode/battery/fault banner.
- **Moisture chart:** multi-series (5 sensors), series toggle show/hide, touch pan/zoom.
- **Climate chart:** polytunnel temp (left axis) + humidity (right axis), dual-axis,
  touch pan/zoom. (DHT11 retained → expect steppy data.)
- **Valve activity:** timeline/gantt of openings, coloured by `source`
  (auto vs manual/override), touch pan/zoom.
- **Battery/solar history** chart.
- **Usage totals:** per-zone watering minutes per day/week.
- **Settings:** per-zone thresholds, rain-skip mm, override minutes, watering window,
  freeze-guard temp.

**Charting:** `uPlot` (tiny, fast, great for time-series) or `Chart.js` +
`chartjs-plugin-zoom` for pan/zoom; final pick at build time.

---

## 10. Feature scope (v1)

In: SNS alerts (low-batt / fault / device-offline via lastSeen), freeze guard,
water-for-X + skip-next, watering windows, PWA, per-zone usage totals, battery/solar
history chart.

Deferred: MOSFET, SHT31/AHT20 sensor swap, MQTT-over-WebSocket live push, OTA via IoT
Jobs, CSV export, multi-device.

---

## 11. Cost estimate (eu-west-1)

Well within the $2/mo ceiling, likely < $0.50/mo after the 12-month free tier:

- IoT Core: ~3k msgs/day + 1 persistent connection — pennies (free tier 12 mo, then
  ~$1/M msgs + $0.08/M connection-min).
- DynamoDB on-demand: ~700 writes/day, tiny storage — effectively free.
- Lambda + API Gateway HTTP API: low thousands of calls/day — free tier covers it.
- CloudFront + S3: static site, perpetual always-free tier (1 TB egress, 10 M req).
- SNS email: free tier covers expected volume.

---

## 12. Build phases

1. **AWS foundation** (IotStack + DataStack) — verify via MQTT test client.
2. **Firmware MQTT layer** — telemetry + shadow + light-sleep + power gating.
3. **API backend** (ApiStack) — endpoints + weather scheduler.
4. **React PWA** (WebStack) — dashboard, charts, settings.
5. **Alerts & polish** — SNS, freeze guard, end-to-end test.

Open interface questions to lock as we build: final thing/topic names, exact
downsample bucketing, CloudFront custom domain vs default `*.cloudfront.net`.
