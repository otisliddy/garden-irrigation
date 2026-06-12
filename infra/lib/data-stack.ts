import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * DynamoDB tables for sensor telemetry and valve events.
 *
 * Both use deviceId (PK) + ts (SK, epoch ms) and on-demand billing, which keeps
 * this comfortably inside the free tier at ~700 writes/day. TTL expires rows after
 * 12 months. Tables are RETAINed on stack delete so a teardown never drops history.
 */
export class DataStack extends cdk.Stack {
  public readonly sensorsTable: dynamodb.Table;
  public readonly valveEventsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.sensorsTable = new dynamodb.Table(this, 'SensorsTable', {
      tableName: 'irrigation-sensors',
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.valveEventsTable = new dynamodb.Table(this, 'ValveEventsTable', {
      tableName: 'irrigation-valve-events',
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'SensorsTableName', { value: this.sensorsTable.tableName });
    new cdk.CfnOutput(this, 'ValveEventsTableName', { value: this.valveEventsTable.tableName });
  }
}
