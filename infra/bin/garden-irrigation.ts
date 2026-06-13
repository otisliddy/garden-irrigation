#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { IotStack } from '../lib/iot-stack';
import { ApiStack } from '../lib/api-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// eu-west-1, personal account. Account is resolved from the `personal` CLI profile
// at synth/deploy time (CDK_DEFAULT_ACCOUNT) so the value isn't hard-coded here.
const env: cdk.Environment = {
  region: 'eu-west-1',
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const alertEmail = app.node.tryGetContext('alertEmail') as string | undefined;
const iotEndpoint = app.node.tryGetContext('iotEndpoint') as string;

const data = new DataStack(app, 'GardenData', { env });

new IotStack(app, 'GardenIot', {
  env,
  sensorsTable: data.sensorsTable,
  valveEventsTable: data.valveEventsTable,
  alertEmail,
});

new ApiStack(app, 'GardenApi', {
  env,
  sensorsTable: data.sensorsTable,
  valveEventsTable: data.valveEventsTable,
  iotEndpoint,
});

new WebStack(app, 'GardenWeb', { env });
