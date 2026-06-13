'use strict';
const { IoTDataPlaneClient, GetThingShadowCommand, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const THING = process.env.THING_NAME;

async function getShadow() {
  const resp = await iot.send(new GetThingShadowCommand({ thingName: THING }));
  return JSON.parse(Buffer.from(resp.payload).toString());
}

// The settings UI should reflect the latest *intended* config, so desired wins
// over reported. Reported is what the device has acked; until its next wake the
// two differ, and showing reported would make a just-saved change appear to revert.
// Deep-merge the known nested objects so a partial desired never drops keys.
function mergeConfig(reported, desired) {
  const r = reported ?? {};
  const d = desired ?? {};
  const out = { ...r, ...d };
  for (const k of ['soilThreshold', 'soilStop', 'wateringWindow']) {
    if (r[k] || d[k]) out[k] = { ...(r[k] ?? {}), ...(d[k] ?? {}) };
  }
  return out;
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method ?? 'GET';

  if (method === 'GET') {
    const shadow = await getShadow();
    const config = mergeConfig(shadow.state?.reported?.config, shadow.state?.desired?.config);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(config),
    };
  }

  if (method === 'PUT') {
    const body = JSON.parse(event.body ?? '{}');
    await iot.send(new UpdateThingShadowCommand({
      thingName: THING,
      payload: Buffer.from(JSON.stringify({ state: { desired: { config: body } } })),
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
