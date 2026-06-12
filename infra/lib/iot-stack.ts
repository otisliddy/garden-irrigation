import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface IotStackProps extends cdk.StackProps {
  sensorsTable: dynamodb.Table;
  valveEventsTable: dynamodb.Table;
  alertEmail?: string;
}

/** Single controller for now; topics carry the thing name so a 2nd unit can be added later. */
const THING_NAME = 'irrigation-controller-01';

/**
 * IoT Core resources: the device thing + a tightly-scoped policy, three topic rules
 * (telemetry -> DynamoDB, valve events -> DynamoDB, health -> SNS), and the alerts topic.
 *
 * The device X.509 cert is NOT created here — it is generated once out-of-band and the
 * private key installed on the device by hand (see infra/README.md). CDK owns everything
 * except the secret material.
 */
export class IotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IotStackProps) {
    super(scope, id, props);

    const { region, account } = this;
    const topicArn = (suffix: string) => `arn:aws:iot:${region}:${account}:topic/${suffix}`;
    const topicFilterArn = (suffix: string) => `arn:aws:iot:${region}:${account}:topicfilter/${suffix}`;

    // ---- Thing + device policy ----------------------------------------------------
    new iot.CfnThing(this, 'Thing', { thingName: THING_NAME });

    new iot.CfnPolicy(this, 'DevicePolicy', {
      policyName: `${THING_NAME}-policy`,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'iot:Connect',
            Resource: `arn:aws:iot:${region}:${account}:client/${THING_NAME}`,
          },
          {
            Effect: 'Allow',
            Action: ['iot:Publish', 'iot:Receive'],
            Resource: [
              topicArn(`garden/${THING_NAME}/*`),
              topicArn(`$aws/things/${THING_NAME}/shadow/*`),
            ],
          },
          {
            Effect: 'Allow',
            Action: 'iot:Subscribe',
            Resource: [
              topicFilterArn(`garden/${THING_NAME}/*`),
              topicFilterArn(`$aws/things/${THING_NAME}/shadow/*`),
            ],
          },
          {
            Effect: 'Allow',
            Action: ['iot:GetThingShadow', 'iot:UpdateThingShadow', 'iot:DeleteThingShadow'],
            Resource: `arn:aws:iot:${region}:${account}:thing/${THING_NAME}`,
          },
        ],
      },
    });

    // ---- Alerts topic ---------------------------------------------------------------
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'irrigation-alerts',
      displayName: 'Garden Irrigation Alerts',
    });
    if (props.alertEmail && props.alertEmail !== 'REPLACE_WITH_YOUR_EMAIL') {
      alertsTopic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    }

    // ---- Shared role for the topic rules -------------------------------------------
    const ruleRole = new iam.Role(this, 'TopicRuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Lets IoT topic rules write telemetry/events to DynamoDB and publish alerts',
    });
    props.sensorsTable.grantWriteData(ruleRole);
    props.valveEventsTable.grantWriteData(ruleRole);
    alertsTopic.grantPublish(ruleRole);

    // ---- Rule 1: telemetry -> sensors table ----------------------------------------
    // timestamp() is epoch ms (integer sort key). ttl is epoch seconds for DynamoDB TTL.
    new iot.CfnTopicRule(this, 'TelemetryRule', {
      ruleName: 'irrigation_telemetry',
      topicRulePayload: {
        awsIotSqlVersion: '2016-03-23',
        sql: `SELECT *, topic(2) AS deviceId, timestamp() AS ts, ` +
          `(trunc(timestamp() / 1000, 0) + 31536000) AS ttl ` +
          `FROM 'garden/+/telemetry'`,
        actions: [{
          dynamoDBv2: {
            putItem: { tableName: props.sensorsTable.tableName },
            roleArn: ruleRole.roleArn,
          },
        }],
      },
    });

    // ---- Rule 2: valve events -> valve-events table --------------------------------
    new iot.CfnTopicRule(this, 'ValveRule', {
      ruleName: 'irrigation_valve_events',
      topicRulePayload: {
        awsIotSqlVersion: '2016-03-23',
        sql: `SELECT *, topic(2) AS deviceId, timestamp() AS ts, ` +
          `(trunc(timestamp() / 1000, 0) + 31536000) AS ttl ` +
          `FROM 'garden/+/valve'`,
        actions: [{
          dynamoDBv2: {
            putItem: { tableName: props.valveEventsTable.tableName },
            roleArn: ruleRole.roleArn,
          },
        }],
      },
    });

    // ---- Rule 3: health -> SNS (fault or low battery) ------------------------------
    new iot.CfnTopicRule(this, 'HealthAlertRule', {
      ruleName: 'irrigation_health_alert',
      topicRulePayload: {
        awsIotSqlVersion: '2016-03-23',
        sql: `SELECT * FROM 'garden/+/status' WHERE fault = true OR battLow = true`,
        actions: [{
          sns: {
            targetArn: alertsTopic.topicArn,
            roleArn: ruleRole.roleArn,
            messageFormat: 'JSON',
          },
        }],
      },
    });

    // ---- Outputs --------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ThingName', { value: THING_NAME });
    new cdk.CfnOutput(this, 'AlertsTopicArn', { value: alertsTopic.topicArn });
    new cdk.CfnOutput(this, 'IotEndpointHint', {
      value: 'aws iot describe-endpoint --endpoint-type iot:Data-ATS --profile personal',
      description: 'Run this to get the MQTT endpoint hostname for the firmware',
    });
  }
}
