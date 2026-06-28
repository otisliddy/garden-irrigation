'use strict';
const { IoTDataPlaneClient, GetThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const THING = process.env.THING_NAME;
const OFFLINE_THRESHOLD_SEC = 20 * 60; // two missed 15-min cycles = device offline

exports.handler = async () => {
  let reported;
  try {
    const resp = await iot.send(new GetThingShadowCommand({ thingName: THING }));
    const doc = JSON.parse(Buffer.from(resp.payload).toString());
    reported = doc.state?.reported ?? {};
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ online: false, error: err.message }),
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const lastSeen = reported.lastSeenEpoch ?? 0;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      mode: reported.mode ?? 'unknown',
      battV: reported.battV ?? null,
      fault: reported.fault ?? false,
      faultReason: reported.faultReason ?? null,
      faultZone: reported.faultZone || null,
      fw: reported.fw ?? null,
      lastSeenEpoch: lastSeen,
      online: lastSeen > 0 && (now - lastSeen) < OFFLINE_THRESHOLD_SEC,
      valve: reported.valve ?? null,
    }),
  };
};
