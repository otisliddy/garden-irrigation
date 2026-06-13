'use strict';
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const dynamo = new DynamoDBClient({});
const TABLE = process.env.VALVE_EVENTS_TABLE;
const DEVICE_ID = process.env.THING_NAME;

function unmarshal(item) {
  return {
    ts: parseInt(item.ts.N),
    zone: item.zone?.S ?? null,
    action: item.action?.S ?? null,
    source: item.source?.S ?? null,
    durationSec: item.durationSec ? parseFloat(item.durationSec.N) : null,
  };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const now = Date.now();
  const to = qs.to ? parseInt(qs.to) : now;
  const from = qs.from ? parseInt(qs.from) : to - 7 * 24 * 60 * 60 * 1000;

  const items = [];
  let lastKey;
  do {
    const resp = await dynamo.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'deviceId = :d AND ts BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':d': { S: DEVICE_ID },
        ':from': { N: String(from) },
        ':to': { N: String(to) },
      },
      ScanIndexForward: true,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    items.push(...(resp.Items ?? []).map(unmarshal));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ items, count: items.length }),
  };
};
