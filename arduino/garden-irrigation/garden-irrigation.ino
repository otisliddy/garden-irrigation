// Garden Irrigation — ESP32-S3 online firmware. AWS IoT (MQTT/TLS) for telemetry,
// remote control and config; degrades to an on-device moisture loop when offline —
// the cloud is additive, never load-bearing. Modes are chosen each wake (see setup()):
// ONLINE (awake, responsive), NIGHT/OFFLINE (sample + cycle + 15-min sleep), POWER-SAVE
// (battery low, no WiFi). Hardware: docs/wiring_diagram.txt. Cloud: docs/cloud_design.md.
// Libs: PubSubClient, ArduinoJson, DHT. Credentials in secrets.h (git-ignored).

// Must precede #includes (Arduino auto-generates forward declarations referencing it).
enum LedMode { LED_OFF, LED_SOLID, LED_WATERING, LED_FAULT, LED_LOWBATT, LED_IDLE };

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include "esp_sleep.h"
#include "secrets.h"

#define FW_VERSION "2.1.4"

// ===================== Pin map (docs/wiring_diagram.txt §2) =====================
// Soil sensors — ADC1 only (reliable with radio on). Higher reading = drier.
#define PIN_SOIL_POLY   1     // cable 1, polytunnel
#define PIN_SOIL_A1     2     // cable 2, Beds A
#define PIN_SOIL_A2     3     // cable 2, Beds A
#define PIN_SOIL_B1     4     // cable 3, Beds B
#define PIN_SOIL_B2     5     // cable 3, Beds B
#define PIN_BATT        6     // 1MΩ/100kΩ divider, ×11
#define PIN_DHT         8     // DHT11 DATA (polytunnel, onboard pull-up)

// Beds B valve — L298N#1 channel A
#define PIN_BB_IN1     10
#define PIN_BB_IN2     11
#define PIN_BB_EN      12
// Beds A valve — L298N#1 channel B  (17/18 are UART1 defaults: never start Serial1)
#define PIN_BA_IN1     16
#define PIN_BA_IN2     17
#define PIN_BA_EN      18
// Polytunnel valve — L298N#2 channel A
#define PIN_PT_IN1     39
#define PIN_PT_IN2     40
#define PIN_PT_EN      41

// Buttons — RTC-capable (EXT1 wake). Active-low, external 10k pull-up to 3V3.
// Pins rotated to match physical wiring: GPIO21→Beds A, GPIO13→Beds B, GPIO14→Polytunnel.
#define PIN_BTN_A      21
#define PIN_BTN_B      13
#define PIN_BTN_POLY   14

#define PIN_LED        42     // status LED via 220Ω
#define PIN_RELAY      47     // sleep-cutoff relay, PN2222 low-side (HIGH = ON)

// ===================== Default tunables (seed the configurable cfg, below) =======
#define DEF_SOIL_START    2800   // avg >= this (drier) -> start watering
#define DEF_SOIL_STOP     2500   // avg <= this (wetter) -> stop  (hysteresis band)
#define DEF_DAILY_CAP_MIN  120   // per-zone daily cap; resets every 24h
#define DEF_OVERRIDE_MIN    30   // manual button/web override auto-reverts after this
#define DEF_RAIN_SKIP_MM     3   // skip Beds A/B if forecast rain >= this (cloud sets flag)
#define DEF_WINDOW_START     7   // local hour: auto-water only inside [start,end)
#define DEF_WINDOW_END      21
#define DEF_FREEZE_C       2.0f  // skip auto watering if temp <= this
#define SLEEP_MIN           15   // deep-sleep interval
#define BATT_DIVIDER      11.0f
#define DEF_BATT_LOW_V    11.5f  // LiFePO4 getting low

#define PULSE_MS            50   // latching-solenoid pulse width
#define RELAY_SETTLE_MS     10   // relay + L298N regulator settle (rule 1)
#define OPEN_GAP_MS        200   // gap between close-pulse and open-pulse
#define LOOP_INTERVAL_MS  1000   // active-loop tick (button responsiveness)
#define WIFI_TIMEOUT_MS  15000   // WiFi association timeout
#define TELEMETRY_MS  (SLEEP_MIN * 60UL * 1000UL)  // online telemetry cadence
#define REPORT_MS        60000UL // online shadow-report / status cadence

// ===================== MQTT topics (compile-time, from secrets.h thing name) =====
#define TOPIC_TELEMETRY      "garden/" AWS_THING_NAME "/telemetry"
#define TOPIC_VALVE          "garden/" AWS_THING_NAME "/valve"
#define TOPIC_STATUS         "garden/" AWS_THING_NAME "/status"
#define SHADOW_BASE          "$aws/things/" AWS_THING_NAME "/shadow"
#define SHADOW_GET           SHADOW_BASE "/get"
#define SHADOW_GET_ACCEPTED  SHADOW_BASE "/get/accepted"
#define SHADOW_UPDATE        SHADOW_BASE "/update"
#define SHADOW_UPDATE_DELTA  SHADOW_BASE "/update/delta"

// ===================== Zones =====================
enum { ZONE_BEDS_A, ZONE_BEDS_B, ZONE_POLY, ZONE_COUNT };

struct Zone {
  const char* name;
  uint8_t in1, in2, en;        // L298N drive pins
  uint8_t soil[2];             // soil sensor ADC pins
  uint8_t soilCount;
  uint8_t btn;                 // override button (RTC pin)
};

const Zone zones[ZONE_COUNT] = {
  { "Beds A",     PIN_BA_IN1, PIN_BA_IN2, PIN_BA_EN, { PIN_SOIL_A1, PIN_SOIL_A2 }, 2, PIN_BTN_A    },
  { "Beds B",     PIN_BB_IN1, PIN_BB_IN2, PIN_BB_EN, { PIN_SOIL_B1, PIN_SOIL_B2 }, 2, PIN_BTN_B    },
  { "Polytunnel", PIN_PT_IN1, PIN_PT_IN2, PIN_PT_EN, { PIN_SOIL_POLY, 0 },         1, PIN_BTN_POLY },
};

// Shadow/JSON keys for each zone (must match docs/cloud_design.md §2.2).
const char* const zoneKey[ZONE_COUNT] = { "bedsA", "bedsB", "polytunnel" };

#define BTN_MASK ((1ULL << PIN_BTN_A) | (1ULL << PIN_BTN_B) | (1ULL << PIN_BTN_POLY))

// ===================== Configurable settings (seeded by defaults, overridden by shadow)
struct Config {
  int   soilStart[ZONE_COUNT];
  int   soilStop[ZONE_COUNT];
  int   rainSkipMm;
  int   overrideMinutes;
  int   windowStartHour, windowEndHour;
  float freezeGuardC;
  int   dailyCapMin;
  float battLowV;
};
RTC_DATA_ATTR Config cfg;     // survives deep sleep; re-seeded only on cold boot

// ===================== State that survives deep sleep =====================
RTC_DATA_ATTR bool     rtcInit = false;            // false => cold boot (RTC mem cleared)
RTC_DATA_ATTR bool     valveOpen[ZONE_COUNT];      // physical latch state
RTC_DATA_ATTR uint64_t waterStartSec[ZONE_COUNT];  // when current watering began
RTC_DATA_ATTR bool     ovrActive[ZONE_COUNT];      // manual override engaged
RTC_DATA_ATTR bool     ovrOpen[ZONE_COUNT];        // override target state
RTC_DATA_ATTR uint8_t  ovrSource[ZONE_COUNT];      // 0 = button, 1 = web
RTC_DATA_ATTR uint64_t ovrExpireSec[ZONE_COUNT];   // override lapse time
RTC_DATA_ATTR uint64_t rtcAccumSec = 0;            // monotonic seconds across sleeps
RTC_DATA_ATTR bool     faultFlag = false;          // a watering hit its cap
RTC_DATA_ATTR uint32_t waterTodaySec[ZONE_COUNT];  // watering seconds used today per zone
RTC_DATA_ATTR uint64_t dayStartSec = 0;            // when the current 24h window began
RTC_DATA_ATTR bool     rainSkip = false;           // cloud-set: skip Beds A/B watering

DHT dht(PIN_DHT, DHT11);
int lastBtn[ZONE_COUNT] = { HIGH, HIGH, HIGH };

WiFiClientSecure net;
PubSubClient mqtt(net);
bool mqttReady = false;                 // true once connected + subscribed this wake
const char* currentMode = "offline";    // reported in status/shadow

// Monotonic clock surviving deep sleep (no RTC chip); granularity = one wake cycle.
uint64_t nowSeconds() { return rtcAccumSec + (uint64_t)(millis() / 1000); }

// ===================== Low-level I/O =====================
void allDriveLow() {
  for (int z = 0; z < ZONE_COUNT; z++) {
    digitalWrite(zones[z].in1, LOW);
    digitalWrite(zones[z].in2, LOW);
    digitalWrite(zones[z].en,  LOW);
  }
}

void relayOn()  { digitalWrite(PIN_RELAY, HIGH); }
void relayOff() { digitalWrite(PIN_RELAY, LOW);  }

// One latching pulse. Relay is energised only for the pulse (valve holds with
// zero power), satisfying §1: never drive an IN while the L298N is unpowered.
void pulse(int z, bool open) {
  allDriveLow();
  relayOn();
  delay(RELAY_SETTLE_MS);
  digitalWrite(zones[z].in1, open ? HIGH : LOW);
  digitalWrite(zones[z].in2, open ? LOW  : HIGH);
  digitalWrite(zones[z].en,  HIGH);
  delay(PULSE_MS);
  digitalWrite(zones[z].en,  LOW);
  digitalWrite(zones[z].in1, LOW);
  digitalWrite(zones[z].in2, LOW);
  relayOff();
}

// Close-before-open: a close pulse is a harmless no-op if already closed, so the
// physical state is known regardless of any missed prior pulse.
void openValve(int z)  { pulse(z, false); delay(OPEN_GAP_MS); pulse(z, true); }
void closeValve(int z) { pulse(z, false); }

int readSoilPin(uint8_t pin) {
  uint32_t s = 0;
  for (int k = 0; k < 5; k++) { s += analogRead(pin); delay(2); }
  return s / 5;
}

int readZoneSoil(int z) {
  uint32_t total = 0;
  for (int i = 0; i < zones[z].soilCount; i++) total += readSoilPin(zones[z].soil[i]);
  return total / zones[z].soilCount;
}

float readBatt() { return analogReadMilliVolts(PIN_BATT) * BATT_DIVIDER / 1000.0f; }

bool anyValveOpen() {
  for (int z = 0; z < ZONE_COUNT; z++) if (valveOpen[z]) return true;
  return false;
}

// ===================== Time / watering window =====================
int getLocalHour() {
  const time_t now = time(nullptr);
  if (now < 1700000000) return -1;          // clock not yet SNTP-synced
  struct tm tm;
  localtime_r(&now, &tm);
  return tm.tm_hour;
}

// Daytime-window gate. Clock unknown (offline/no SNTP) => true, so on-device watering works.
bool withinWindow() {
  const int h = getLocalHour();
  if (h < 0) return true;
  if (cfg.windowStartHour <= cfg.windowEndHour)
    return h >= cfg.windowStartHour && h < cfg.windowEndHour;
  return h >= cfg.windowStartHour || h < cfg.windowEndHour;   // wrap-around (unusual)
}

// ===================== LED (non-blocking) =====================
void ledTick(LedMode m) {
  const uint32_t t = millis();
  bool on = false;
  switch (m) {
    case LED_OFF:      on = false;                         break;
    case LED_SOLID:    on = true;                          break;
    case LED_WATERING: on = (t % 4000) < 2000;             break;            // 2s on / 2s off
    case LED_FAULT:    on = (t % 200)  < 100;              break;            // 5 Hz
    case LED_IDLE:     on = (t % 3000) < 100;              break;            // brief blink / 3s
    case LED_LOWBATT: { const uint32_t p = t % 2600;       on = (p < 1500) && ((p % 500) < 100); } break;  // 3 blips + pause
  }
  digitalWrite(PIN_LED, on ? HIGH : LOW);
}

void ledDoubleBlip() {                    // button-press acknowledgement
  for (int i = 0; i < 2; i++) {
    digitalWrite(PIN_LED, HIGH); delay(80);
    digitalWrite(PIN_LED, LOW);  delay(80);
  }
}

// ===================== Cloud publish =====================
void publishValveEvent(int z, const char* action, const char* source, uint32_t durSec) {
  if (!mqttReady) return;
  JsonDocument doc;
  doc["zone"]   = zoneKey[z];
  doc["action"] = action;
  doc["source"] = source;
  if (durSec > 0) doc["durationSec"] = durSec;
  char buf[192];
  serializeJson(doc, buf, sizeof(buf));        // null-terminates; use 2-arg publish
  mqtt.publish(TOPIC_VALVE, buf);
}

void publishTelemetry() {
  if (!mqttReady) return;
  JsonDocument doc;
  doc["soilPoly"] = readSoilPin(PIN_SOIL_POLY);
  doc["soilA1"]   = readSoilPin(PIN_SOIL_A1);
  doc["soilA2"]   = readSoilPin(PIN_SOIL_A2);
  doc["soilB1"]   = readSoilPin(PIN_SOIL_B1);
  doc["soilB2"]   = readSoilPin(PIN_SOIL_B2);
  const float tC = dht.readTemperature();
  const float rh = dht.readHumidity();
  if (!isnan(tC)) doc["tempC"] = tC;
  if (!isnan(rh)) doc["rh"]    = rh;
  doc["battV"] = readBatt();
  char buf[320];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(TOPIC_TELEMETRY, buf);
}

void publishStatus(const char* mode) {
  if (!mqttReady) return;
  const float vb = readBatt();
  JsonDocument doc;
  doc["mode"]    = mode;
  doc["battV"]   = vb;
  doc["battLow"] = vb < cfg.battLowV;       // health rule alerts on this
  doc["fault"]   = faultFlag;               // ...and this
  doc["fw"]      = FW_VERSION;
  char buf[192];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(TOPIC_STATUS, buf);
}

// Mirror applied config + valve state into shadow `reported` for the website (P1).
void reportShadow() {
  if (!mqttReady) return;
  JsonDocument doc;
  JsonObject rep = doc["state"].createNestedObject("reported");
  JsonObject c  = rep.createNestedObject("config");
  JsonObject st = c.createNestedObject("soilThreshold");
  JsonObject sp = c.createNestedObject("soilStop");
  for (int z = 0; z < ZONE_COUNT; z++) { st[zoneKey[z]] = cfg.soilStart[z]; sp[zoneKey[z]] = cfg.soilStop[z]; }
  c["rainSkipMm"]      = cfg.rainSkipMm;
  c["overrideMinutes"] = cfg.overrideMinutes;
  c["freezeGuardC"]    = cfg.freezeGuardC;
  c["dailyCapMin"]     = cfg.dailyCapMin;
  JsonObject w = c.createNestedObject("wateringWindow");
  w["startHour"] = cfg.windowStartHour;
  w["endHour"]   = cfg.windowEndHour;
  JsonObject v = rep.createNestedObject("valve");
  for (int z = 0; z < ZONE_COUNT; z++) { JsonObject zo = v.createNestedObject(zoneKey[z]); zo["open"] = valveOpen[z]; }
  rep["mode"]          = currentMode;
  rep["battV"]         = readBatt();
  rep["fault"]         = faultFlag;
  rep["rainSkip"]      = rainSkip;
  rep["fw"]            = FW_VERSION;
  rep["lastSeenEpoch"] = (uint32_t)time(nullptr);

  // GC consumed web commands: DELETE the zone (null), never write {open:false} — a
  // lingering desired.open=false deltas against auto's reported.open=true and is read
  // back as a phantom "close". Absent = no pending command (applyDesired skips it).
  JsonObject des = doc["state"].createNestedObject("desired");
  JsonObject dv  = des.createNestedObject("valve");
  for (int z = 0; z < ZONE_COUNT; z++) {
    if (!ovrActive[z] || ovrSource[z] != 1) {
      dv[zoneKey[z]] = nullptr;   // delete stale command; no open:false to fight auto
    }
  }

  char buf[2560];
  serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(SHADOW_UPDATE, buf);
}

// ===================== Cloud receive (shadow desired -> local state) =============
// Apply a `desired` (or delta) object; missing fields keep their value via `| default`.
void applyDesired(JsonVariantConst d) {
  if (d.isNull()) return;

  JsonVariantConst c = d["config"];
  if (!c.isNull()) {
    JsonVariantConst st = c["soilThreshold"];
    JsonVariantConst sp = c["soilStop"];
    for (int z = 0; z < ZONE_COUNT; z++) {
      cfg.soilStart[z] = st[zoneKey[z]] | cfg.soilStart[z];
      cfg.soilStop[z]  = sp[zoneKey[z]] | cfg.soilStop[z];
    }
    cfg.rainSkipMm      = c["rainSkipMm"]      | cfg.rainSkipMm;
    cfg.overrideMinutes = c["overrideMinutes"] | cfg.overrideMinutes;
    cfg.freezeGuardC    = c["freezeGuardC"]    | cfg.freezeGuardC;
    cfg.dailyCapMin     = c["dailyCapMin"]     | cfg.dailyCapMin;
    JsonVariantConst w  = c["wateringWindow"];
    cfg.windowStartHour = w["startHour"] | cfg.windowStartHour;
    cfg.windowEndHour   = w["endHour"]   | cfg.windowEndHour;
  }

  JsonVariantConst v = d["valve"];
  if (!v.isNull()) {
    const uint64_t nowUnix = (uint64_t)time(nullptr);
    const bool clockOk = nowUnix > 1700000000ULL;  // SNTP has synced
    for (int z = 0; z < ZONE_COUNT; z++) {
      JsonVariantConst zv = v[zoneKey[z]];
      if (zv.isNull()) continue;
      JsonVariantConst openVar = zv["open"];
      if (openVar.isNull()) {
        ovrActive[z] = false;                 // web released the zone -> back to auto
      } else {
        const bool     open       = openVar.as<bool>();
        const uint64_t untilEpoch = zv["untilEpoch"] | (uint64_t)0;
        // Discard open commands whose expiry has already passed (stale shadow state).
        if (open && untilEpoch > 0 && clockOk && untilEpoch <= nowUnix) {
          Serial.printf("WEB %s: stale command (expired %llus ago), ignoring\n",
                        zones[z].name, nowUnix - untilEpoch);
        } else {
          // Idempotent (P3): only (re)arm the expiry for a new/changed command, so a
          // re-synced shadow with the same pending command can't extend the override.
          const bool isNew = !ovrActive[z] || ovrSource[z] != 1 || ovrOpen[z] != open;
          ovrActive[z] = true;
          ovrOpen[z]   = open;
          ovrSource[z] = 1;                       // website command => source "app"
          if (isNew)
            ovrExpireSec[z] = (untilEpoch > 0 && clockOk)
                              ? nowSeconds() + (untilEpoch - nowUnix)
                              : nowSeconds() + (uint64_t)cfg.overrideMinutes * 60;
          Serial.printf("WEB %s -> %s (%llu s left)\n", zones[z].name,
                        open ? "OPEN" : "CLOSE", ovrExpireSec[z] - nowSeconds());
        }
      }
    }
  }

  rainSkip = d["rainSkip"] | rainSkip;
}

void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;          // ignore malformed
  if (strstr(topic, "/get/accepted"))      applyDesired(doc["state"]["desired"]);
  else if (strstr(topic, "/update/delta")) applyDesired(doc["state"]);
  // Never reportShadow() here — writing back into the shadow re-deltas and storms this
  // callback. Acks happen via the periodic report and applyZone() (P4).
}

// ===================== Connectivity =====================
bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (uint32_t t0 = millis(); WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS; )
    delay(250);
  if (WiFi.status() != WL_CONNECTED) { Serial.println("WiFi: failed"); return false; }
  WiFi.setSleep(true);                       // modem sleep (DTIM) — the cheap always-on path
  Serial.printf("WiFi: %s  %s\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
  return true;
}

void syncTime() {
  // Europe/Dublin: GMT in winter, IST (UTC+1) in summer.
  configTzTime("GMT0IST,M3.5.0/1,M10.5.0", "pool.ntp.org", "time.google.com");
  struct tm tm;
  for (uint32_t t0 = millis(); !getLocalTime(&tm, 0) && millis() - t0 < 5000; ) delay(200);
}

bool subscribeShadow() {
  return mqtt.subscribe(SHADOW_GET_ACCEPTED) && mqtt.subscribe(SHADOW_UPDATE_DELTA);
}

bool connectMQTT() {
  net.setCACert(AWS_ROOT_CA);
  net.setCertificate(AWS_DEVICE_CERT);
  net.setPrivateKey(AWS_PRIVATE_KEY);
  mqtt.setServer(AWS_IOT_ENDPOINT, 8883);
  mqtt.setBufferSize(3072);                  // shadow docs exceed PubSubClient's 256B default
  mqtt.setKeepAlive(60);
  mqtt.setCallback(onMqttMessage);
  for (int i = 0; i < 3; i++) {
    if (mqtt.connect(AWS_THING_NAME)) {
      mqttReady = subscribeShadow();
      Serial.println(mqttReady ? "MQTT: connected" : "MQTT: subscribe failed");
      return mqttReady;
    }
    Serial.printf("MQTT connect rc=%d, retrying\n", mqtt.state());
    delay(1500);
  }
  return false;
}

bool reconnectMQTT() {
  for (int i = 0; i < 2 && WiFi.status() == WL_CONNECTED; i++) {
    if (mqtt.connect(AWS_THING_NAME)) { mqttReady = subscribeShadow(); return mqttReady; }
    delay(1000);
  }
  mqttReady = false;
  return false;
}

// Pull current desired state and let the callback apply it.
void shadowSync() {
  mqtt.publish(SHADOW_GET, "");
  for (uint32_t t0 = millis(); millis() - t0 < 3000; ) { mqtt.loop(); delay(20); }
}

// ===================== Valve application =====================
void applyZone(int z, bool wantOpen, const char* source) {
  if (wantOpen && !valveOpen[z]) {
    Serial.printf("OPEN  %s (%s)\n", zones[z].name, source);
    openValve(z);
    valveOpen[z] = true;
    waterStartSec[z] = nowSeconds();
    publishValveEvent(z, "open", source, 0);
    reportShadow();   // push new valve state to the cloud now, not just in the online loop
  } else if (!wantOpen && valveOpen[z]) {
    const uint32_t dur = (uint32_t)(nowSeconds() - waterStartSec[z]);
    waterTodaySec[z] += dur;
    Serial.printf("CLOSE %s (%s, today: %u min)\n", zones[z].name, source, waterTodaySec[z] / 60);
    closeValve(z);
    valveOpen[z] = false;
    publishValveEvent(z, "close", source, dur);
    reportShadow();
  }
}

void closeAllValves() {                   // cold-boot fail-closed (rule 2)
  for (int z = 0; z < ZONE_COUNT; z++) { closeValve(z); valveOpen[z] = false; }
}

// ===================== Buttons / overrides =====================
void handleButton(int z) {
  const bool current = ovrActive[z] ? ovrOpen[z] : valveOpen[z];
  ovrActive[z]    = true;
  ovrOpen[z]      = !current;             // toggle
  ovrSource[z]    = 0;                    // physical button => source "button"
  ovrExpireSec[z] = nowSeconds() + (uint64_t)cfg.overrideMinutes * 60;
  Serial.printf("BUTTON %s -> override %s (%d min)\n",
                zones[z].name, ovrOpen[z] ? "OPEN" : "CLOSED", cfg.overrideMinutes);
  ledDoubleBlip();
}

void pollButtons() {
  for (int z = 0; z < ZONE_COUNT; z++) {
    const int s = digitalRead(zones[z].btn);
    if (lastBtn[z] == HIGH && s == LOW) handleButton(z);   // falling edge = press
    lastBtn[z] = s;
  }
}

// ===================== Watering control (one tick) =====================
// Pure automatic target for one zone (no override): daily cap (raises faultFlag),
// hysteresis, window, freeze guard, rain-skip (Beds only), one-valve rule (busy).
bool autoDecide(int z, bool busy, bool windowOK, bool freeze) {
  const uint32_t capSec = (uint32_t)cfg.dailyCapMin * 60;
  const int      soil   = readZoneSoil(z);
  if (valveOpen[z]) {
    const uint32_t used = waterTodaySec[z] + (uint32_t)(nowSeconds() - waterStartSec[z]);
    if (used >= capSec) { faultFlag = true; return false; }   // daily cap -> force closed
    return soil > cfg.soilStop[z];                             // stop once wet enough
  }
  const bool isBeds = (z == ZONE_BEDS_A || z == ZONE_BEDS_B);
  return soil >= cfg.soilStart[z] && !busy && windowOK && !freeze
         && !(isBeds && rainSkip) && waterTodaySec[z] < capSec;
}

// Resolve every zone once per tick. Precedence: manual override > auto. A lapsed
// manual OPEN closes now (bounded session); auto may re-open it the same tick if the
// soil still reads dry. Overrides are exempt from the one-valve rule but still occupy
// the bus, so at most one *auto* valve opens (no master valve: mains feeds one zone).
void serviceWatering() {
  for (int z = 0; z < ZONE_COUNT; z++)
    if (ovrActive[z] && nowSeconds() >= ovrExpireSec[z]) {
      ovrActive[z] = false;
      if (valveOpen[z]) applyZone(z, false, ovrSource[z] == 1 ? "app" : "button");
    }
  for (int z = 0; z < ZONE_COUNT; z++)
    if (ovrActive[z]) applyZone(z, ovrOpen[z], ovrSource[z] == 1 ? "app" : "button");

  const float tC       = dht.readTemperature();
  const bool  freeze   = !isnan(tC) && tC <= cfg.freezeGuardC;
  const bool  windowOK = withinWindow();
  bool busy = anyValveOpen();
  for (int z = 0; z < ZONE_COUNT; z++) {
    if (ovrActive[z]) continue;
    const bool open = autoDecide(z, busy, windowOK, freeze);
    if (open) busy = true;
    applyZone(z, open, "auto");
  }
}

LedMode currentLed() {
  const bool battLow = readBatt() < cfg.battLowV;
  if (faultFlag)       return LED_FAULT;
  if (battLow)         return LED_LOWBATT;
  if (anyValveOpen())  return LED_WATERING;
  return LED_IDLE;
}

// ===================== Offline / finish-watering loop =====================
// Stays awake while any valve is open (LED, moisture, buttons); exits to sleep once
// everything is closed. Offline path + drains in-progress watering before deep sleep.
void runActiveCycle() {
  uint32_t lastBattLog = 0;

  while (true) {
    if (mqttReady) mqtt.loop();              // keep the connection (and keepalive) alive
    pollButtons();
    serviceWatering();
    ledTick(currentLed());

    const float vb = readBatt();
    if (millis() - lastBattLog > 10000) {
      lastBattLog = millis();
      Serial.printf("batt %.2fV%s\n", vb, vb < cfg.battLowV ? " (LOW)" : "");
    }

    if (!anyValveOpen()) break;                // nothing to do -> sleep

    // Poll buttons every 50 ms between ticks so short presses aren't missed.
    for (uint32_t t0 = millis(); millis() - t0 < LOOP_INTERVAL_MS; delay(50)) {
      if (mqttReady) mqtt.loop();
      pollButtons();
    }
  }
}

// ===================== Online loop (daytime, connected, battery OK) =============
// Awake + responsive: services MQTT/buttons/watering, publishes telemetry every 15 min
// and a report every minute. Returns (to deep-sleep) when battery drops or window ends.
void runOnlineLoop() {
  uint32_t lastTelemetry = millis();
  uint32_t lastReport    = millis();
  currentMode = "online";

  while (true) {
    if (!mqtt.connected() && !reconnectMQTT()) {
      Serial.println("MQTT lost — leaving online mode");
      return;
    }
    mqtt.loop();
    pollButtons();
    serviceWatering();
    ledTick(currentLed());

    if (millis() - lastTelemetry >= TELEMETRY_MS) { publishTelemetry(); lastTelemetry = millis(); }
    if (millis() - lastReport    >= REPORT_MS)     { reportShadow(); publishStatus("online"); lastReport = millis(); }

    if (readBatt() < cfg.battLowV) { currentMode = "power-save"; publishStatus("power-save"); return; }
    if (!withinWindow())           { Serial.println("watering window closed — sleeping"); return; }

    // Responsive idle: keep MQTT + buttons alive between ticks (modem sleep saves power).
    for (uint32_t t0 = millis(); millis() - t0 < LOOP_INTERVAL_MS; delay(50)) {
      mqtt.loop();
      pollButtons();
    }
  }
}

// ===================== Logging =====================
void logSensors() {
  const float tC = dht.readTemperature();
  const float rh = dht.readHumidity();
  if (isnan(tC) || isnan(rh)) Serial.println("DHT11: read error");
  else                        Serial.printf("Polytunnel: %.1fC %.0f%%RH\n", tC, rh);

  Serial.printf("Battery: %.2fV\n", readBatt());
  for (int z = 0; z < ZONE_COUNT; z++)
    Serial.printf("Soil %-10s: %d\n", zones[z].name, readZoneSoil(z));
}

// ===================== Sleep =====================
void prepareSleepAndSleep() {
  if (mqttReady) { reportShadow(); publishStatus("asleep"); mqtt.loop(); mqtt.disconnect(); }
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  allDriveLow();
  relayOff();
  digitalWrite(PIN_LED, LOW);

  // Advance the monotonic clock by this awake span plus the upcoming sleep.
  rtcAccumSec += (uint64_t)(millis() / 1000) + (uint64_t)SLEEP_MIN * 60;

  // Wait for held buttons to release, else EXT1 fires instantly and re-toggles the zone.
  for (int z = 0; z < ZONE_COUNT; z++)
    while (digitalRead(zones[z].btn) == LOW) delay(10);
  delay(50);  // debounce

  esp_sleep_enable_ext1_wakeup(BTN_MASK, ESP_EXT1_WAKEUP_ANY_LOW);   // button wake
  esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_MIN * 60ULL * 1000000ULL);

  Serial.printf("Sleeping %d min\n", SLEEP_MIN);
  Serial.flush();
  esp_deep_sleep_start();
}

// ===================== Config defaults (cold boot only) =====================
void seedConfigDefaults() {
  for (int z = 0; z < ZONE_COUNT; z++) { cfg.soilStart[z] = DEF_SOIL_START; cfg.soilStop[z] = DEF_SOIL_STOP; }
  cfg.rainSkipMm      = DEF_RAIN_SKIP_MM;
  cfg.overrideMinutes = DEF_OVERRIDE_MIN;
  cfg.windowStartHour = DEF_WINDOW_START;
  cfg.windowEndHour   = DEF_WINDOW_END;
  cfg.freezeGuardC    = DEF_FREEZE_C;
  cfg.dailyCapMin     = DEF_DAILY_CAP_MIN;
  cfg.battLowV        = DEF_BATT_LOW_V;
}

// ===================== Setup (runs every wake; loop() is unused) =====================
void setup() {
  Serial.begin(115200);
  for (uint32_t t0 = millis(); !Serial && millis() - t0 < 1000; ) delay(10);

  // Pin init.
  for (int z = 0; z < ZONE_COUNT; z++) {
    pinMode(zones[z].in1, OUTPUT); pinMode(zones[z].in2, OUTPUT); pinMode(zones[z].en, OUTPUT);
    pinMode(zones[z].btn, INPUT);                 // external 10k pull-up
  }
  pinMode(PIN_RELAY, OUTPUT); pinMode(PIN_LED, OUTPUT);
  allDriveLow(); relayOff(); digitalWrite(PIN_LED, LOW);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);                 // full 0–3.3V range
  dht.begin();

  const esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  const bool coldBoot = !rtcInit;

  if (coldBoot) {
    Serial.println("\n=== COLD BOOT ===");
    rtcInit = true; rtcAccumSec = 0; faultFlag = false; rainSkip = false;
    for (int z = 0; z < ZONE_COUNT; z++) { ovrActive[z] = false; waterStartSec[z] = 0; waterTodaySec[z] = 0; }
    dayStartSec = 0;
    seedConfigDefaults();
    digitalWrite(PIN_LED, HIGH); delay(1000); digitalWrite(PIN_LED, LOW);   // self-test
    closeAllValves();                             // fail-closed — cold boot ONLY (rule 2)
  } else {
    Serial.println(cause == ESP_SLEEP_WAKEUP_EXT1 ? "\n=== WAKE: button ===" : "\n=== WAKE: timer ===");
  }

  // A button wake: act on whichever button(s) fired before entering the loop.
  if (cause == ESP_SLEEP_WAKEUP_EXT1) {
    const uint64_t mask = esp_sleep_get_ext1_wakeup_status();
    for (int z = 0; z < ZONE_COUNT; z++)
      if (mask & (1ULL << zones[z].btn)) { lastBtn[z] = LOW; handleButton(z); }
  }

  // Reset daily watering counters once 24 h has elapsed. The cap fault is tied to
  // these counters, so it clears here too (re-trips next day if the cause persists).
  if (nowSeconds() - dayStartSec >= 86400ULL) {
    dayStartSec = nowSeconds();
    for (int z = 0; z < ZONE_COUNT; z++) waterTodaySec[z] = 0;
    faultFlag = false;
    Serial.println("daily water counters reset");
  }

  const float vb = readBatt();
  const bool battLow = vb < cfg.battLowV;

  // --- Power-save: battery low -> no WiFi, run the on-device loop, deep sleep. ---
  if (battLow) {
    currentMode = "power-save";
    Serial.printf("battery LOW (%.2fV) — power-save, skipping WiFi\n", vb);
    logSensors();
    runActiveCycle();
    prepareSleepAndSleep();
    return;
  }

  // --- Try to go online. ---------------------------------------------------------
  bool online = false;
  if (connectWiFi()) {
    syncTime();
    if (connectMQTT()) {
      online = true;
      currentMode = "online";       // connected; reportShadow/shadowSync must not log stale "offline"
      shadowSync();                 // pull desired config/commands, apply, report
      publishTelemetry();
      reportShadow();
    }
  }

  logSensors();

  if (online && withinWindow()) {
    publishStatus("online");
    runOnlineLoop();                // stays awake through the daytime window
  } else if (online) {
    currentMode = "online";         // connected but it's night: 15-min cycle
    publishStatus("online");
  } else {
    currentMode = "offline";
  }

  // Drain in-progress watering (closes when wet), then deep sleep (15-min cadence).
  runActiveCycle();
  prepareSleepAndSleep();
}

void loop() { /* unused — setup() ends in deep sleep */ }
