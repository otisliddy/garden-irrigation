'use strict';
const { IoTDataPlaneClient, GetThingShadowCommand, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');

const iot = new IoTDataPlaneClient({ endpoint: `https://${process.env.IOT_ENDPOINT}` });
const THING = process.env.THING_NAME;
const VALID_ZONES = ['bedsA', 'bedsB', 'polytunnel'];

exports.handler = async (event) => {
  const zone = event.pathParameters?.zone;
  if (!VALID_ZONES.includes(zone)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: `Unknown zone: ${zone}` }),
    };
  }

  const path = event.rawPath ?? '';
  const isSkipNext = path.endsWith('/skip-next');

  if (isSkipNext) {
    await iot.send(new UpdateThingShadowCommand({
      thingName: THING,
      payload: Buffer.from(JSON.stringify({ state: { desired: { skipNext: { [zone]: true } } } })),
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, zone, action: 'skip-next' }),
    };
  }

  const body = JSON.parse(event.body ?? '{}');
  const open = body.open === true;

  // Read overrideMinutes from shadow to compute untilEpoch advisory value for the UI
  let overrideMinutes = 30;
  try {
    const shadowResp = await iot.send(new GetThingShadowCommand({ thingName: THING }));
    const doc = JSON.parse(Buffer.from(shadowResp.payload).toString());
    overrideMinutes = doc.state?.reported?.config?.overrideMinutes
      ?? doc.state?.desired?.config?.overrideMinutes
      ?? 30;
  } catch (_) { /* use default */ }

  const untilEpoch = open ? Math.floor(Date.now() / 1000) + overrideMinutes * 60 : 0;
  // untilEpoch is UI-advisory only — returned in the response, never written to the
  // shadow. In `desired` it has no `reported` counterpart, so it produces a perpetual
  // delta {valve:{<zone>:{untilEpoch}}} that the firmware reads as "release to auto",
  // cancelling the override. `null` deletes any value left by a prior write.
  await iot.send(new UpdateThingShadowCommand({
    thingName: THING,
    payload: Buffer.from(JSON.stringify({ state: { desired: { valve: { [zone]: { open, untilEpoch: null } } } } })),
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true, zone, open, untilEpoch }),
  };
};
