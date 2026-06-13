'use strict';
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const dynamo = new DynamoDBClient({});
const TABLE = process.env.SENSORS_TABLE;
const DEVICE_ID = process.env.THING_NAME;
const MAX_POINTS = 500;
const RAW_WINDOW_MS = 48 * 60 * 60 * 1000;
const FIELDS = ['soilA1', 'soilA2', 'soilB1', 'soilB2', 'soilPoly', 'tempC', 'rh', 'battV'];

function num(attr) { return attr ? parseFloat(attr.N) : null; }

function unmarshal(item) {
  return {
    ts: parseInt(item.ts.N),
    soilA1: num(item.soilA1), soilA2: num(item.soilA2),
    soilB1: num(item.soilB1), soilB2: num(item.soilB2),
    soilPoly: num(item.soilPoly), tempC: num(item.tempC),
    rh: num(item.rh), battV: num(item.battV),
  };
}

function downsample(rows, from, to) {
  if (rows.length <= MAX_POINTS) return rows;
  const bucketMs = Math.ceil((to - from) / MAX_POINTS);
  const acc = new Map();
  for (const r of rows) {
    const key = Math.floor((r.ts - from) / bucketMs);
    if (!acc.has(key)) {
      acc.set(key, { ts: 0, count: 0, ...Object.fromEntries(FIELDS.map(f => [f, 0])) });
    }
    const b = acc.get(key);
    b.ts += r.ts;
    b.count++;
    for (const f of FIELDS) b[f] += r[f] ?? 0;
  }
  return Array.from(acc.entries())
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({
      ts: Math.round(b.ts / b.count),
      ...Object.fromEntries(FIELDS.map(f => [f, Math.round(b[f] / b.count * 100) / 100])),
    }));
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const now = Date.now();
  const to = qs.to ? parseInt(qs.to) : now;
  const from = qs.from ? parseInt(qs.from) : to - 24 * 60 * 60 * 1000;

  const rows = [];
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
    rows.push(...(resp.Items ?? []).map(unmarshal));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const result = (to - from) > RAW_WINDOW_MS ? downsample(rows, from, to) : rows;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ items: result, count: result.length }),
  };
};
