'use strict';
const { IoTDataPlaneClient, GetThingShadowCommand, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const THING = process.env.THING_NAME;
const LAT = 52.99;
const LON = -6.18;
const CACHE_TTL_MS = 15 * 60 * 1000;

// Module-level cache survives warm invocations
let cache = null;
let cacheTs = 0;

async function fetchOpenMeteo() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LON}` +
    `&hourly=precipitation,temperature_2m,relative_humidity_2m,weather_code` +
    `&forecast_days=2&timezone=Europe%2FDublin`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
  return resp.json();
}

function parseWeather(raw) {
  const { hourly } = raw;
  const now = Date.now();
  const times = hourly.time.map(t => new Date(t).getTime());

  let rainSum12h = 0;
  const forecast = [];
  const next12hMs = 12 * 60 * 60 * 1000;
  const next24hMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < times.length; i++) {
    if (times[i] >= now && times[i] < now + next12hMs) {
      rainSum12h += hourly.precipitation[i] ?? 0;
    }
    if (times[i] >= now && times[i] < now + next24hMs) {
      forecast.push({
        ts: times[i],
        precipMm: hourly.precipitation[i],
        tempC: hourly.temperature_2m[i],
        rh: hourly.relative_humidity_2m[i],
        weatherCode: hourly.weather_code[i],
      });
    }
  }

  // Most recent past hour as "current"
  let currentIdx = -1;
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i] <= now) { currentIdx = i; break; }
  }
  const current = currentIdx >= 0 ? {
    tempC: hourly.temperature_2m[currentIdx],
    rh: hourly.relative_humidity_2m[currentIdx],
    precipMm: hourly.precipitation[currentIdx],
    weatherCode: hourly.weather_code[currentIdx],
  } : null;

  return { current, forecast, rainSum12h: Math.round(rainSum12h * 10) / 10, fetchedAt: now };
}

exports.handler = async (event) => {
  const isScheduled = event?.source === 'aws.events';
  const now = Date.now();

  if (!cache || now - cacheTs > CACHE_TTL_MS) {
    try {
      cache = parseWeather(await fetchOpenMeteo());
      cacheTs = now;
    } catch (err) {
      if (!cache) {
        const msg = `Weather fetch failed: ${err.message}`;
        if (isScheduled) { console.error(msg); return; }
        return {
          statusCode: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'Weather service unavailable' }),
        };
      }
      console.warn(`Serving stale weather cache: ${err.message}`);
    }
  }

  // EventBridge: update shadow rainSkip flag based on forecast
  if (isScheduled) {
    try {
      const shadowResp = await iot.send(new GetThingShadowCommand({ thingName: THING }));
      const doc = JSON.parse(Buffer.from(shadowResp.payload).toString());
      const threshMm = doc.state?.reported?.config?.rainSkipMm
        ?? doc.state?.desired?.config?.rainSkipMm
        ?? 3;
      const rainSkip = cache.rainSum12h >= threshMm;
      await iot.send(new UpdateThingShadowCommand({
        thingName: THING,
        payload: Buffer.from(JSON.stringify({ state: { desired: { rainSkip } } })),
      }));
      console.log(`rainSkip=${rainSkip} (${cache.rainSum12h}mm / ${threshMm}mm threshold)`);
    } catch (err) {
      console.error('Shadow update failed:', err.message);
    }
    return;
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(cache),
  };
};
