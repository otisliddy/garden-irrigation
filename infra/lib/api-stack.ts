import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  sensorsTable: dynamodb.Table;
  valveEventsTable: dynamodb.Table;
  iotEndpoint: string;
}

const THING_NAME = 'irrigation-controller-01';

export class ApiStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const thingArn = `arn:aws:iot:${this.region}:${this.account}:thing/${THING_NAME}`;

    // Shared IoT shadow permissions granted to Lambdas that need them
    const shadowReadPolicy = new iam.PolicyStatement({
      actions: ['iot:GetThingShadow'],
      resources: [thingArn],
    });
    const shadowWritePolicy = new iam.PolicyStatement({
      actions: ['iot:UpdateThingShadow'],
      resources: [thingArn],
    });

    const commonEnv = {
      THING_NAME,
      IOT_ENDPOINT: props.iotEndpoint,
      SENSORS_TABLE: props.sensorsTable.tableName,
      VALVE_EVENTS_TABLE: props.valveEventsTable.tableName,
    };

    function fn(scope: Construct, id: string, dir: string, env?: Record<string, string>) {
      return new lambda.Function(scope, id, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambda', dir)),
        timeout: cdk.Duration.seconds(15),
        environment: { ...commonEnv, ...env },
      });
    }

    // ---- Lambdas -----------------------------------------------------------------

    const sensorsLambda = fn(this, 'SensorsLambda', 'sensors');
    props.sensorsTable.grantReadData(sensorsLambda);

    const valveHistLambda = fn(this, 'ValveHistLambda', 'valve-history');
    props.valveEventsTable.grantReadData(valveHistLambda);

    const configLambda = fn(this, 'ConfigLambda', 'config');
    configLambda.addToRolePolicy(shadowReadPolicy);
    configLambda.addToRolePolicy(shadowWritePolicy);

    const zoneLambda = fn(this, 'ZoneLambda', 'zone');
    zoneLambda.addToRolePolicy(shadowReadPolicy);
    zoneLambda.addToRolePolicy(shadowWritePolicy);

    const weatherLambda = fn(this, 'WeatherLambda', 'weather');
    weatherLambda.addToRolePolicy(shadowReadPolicy);
    weatherLambda.addToRolePolicy(shadowWritePolicy);

    const statusLambda = fn(this, 'StatusLambda', 'status');
    statusLambda.addToRolePolicy(shadowReadPolicy);

    // ---- HTTP API ----------------------------------------------------------------
    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'garden-irrigation-api',
      corsPreflight: {
        allowOrigins: ['https://d2rg4myx80f9ai.cloudfront.net'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type'],
      },
    });

    const addRoute = (path: string, methods: apigwv2.HttpMethod[], fn: lambda.Function, id: string) =>
      api.addRoutes({ path, methods, integration: new HttpLambdaIntegration(id, fn) });

    addRoute('/sensors',                  [apigwv2.HttpMethod.GET],        sensorsLambda,  'SensorsInt');
    addRoute('/valve-history',            [apigwv2.HttpMethod.GET],        valveHistLambda,'ValveHistInt');
    addRoute('/config',                   [apigwv2.HttpMethod.GET],        configLambda,   'ConfigGetInt');
    addRoute('/config',                   [apigwv2.HttpMethod.PUT],        configLambda,   'ConfigPutInt');
    addRoute('/zone/{zone}',              [apigwv2.HttpMethod.POST],       zoneLambda,     'ZoneInt');
    addRoute('/zone/{zone}/skip-next',    [apigwv2.HttpMethod.POST],       zoneLambda,     'ZoneSkipInt');
    addRoute('/weather',                  [apigwv2.HttpMethod.GET],        weatherLambda,  'WeatherInt');
    addRoute('/status',                   [apigwv2.HttpMethod.GET],        statusLambda,   'StatusInt');

    // ---- EventBridge: hourly weather refresh + shadow rainSkip update -----------
    const weatherSchedule = new events.Rule(this, 'WeatherSchedule', {
      ruleName: 'garden-irrigation-weather-hourly',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Fetch Met Éireann forecast, update shadow rainSkip',
    });
    weatherSchedule.addTarget(new targets.LambdaFunction(weatherLambda));

    // ---- Outputs ----------------------------------------------------------------
    this.apiUrl = api.apiEndpoint;
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'HTTP API base URL — use in the React app as VITE_API_URL',
    });
  }
}
