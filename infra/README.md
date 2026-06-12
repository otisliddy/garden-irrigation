# Garden Irrigation — Infrastructure (AWS CDK)

CDK app (TypeScript) for the irrigation cloud backend. Region **eu-west-1**, AWS
profile **`personal`**. See `../docs/cloud_design.md` for the full design.

## Stacks

| Stack | Contents | Phase |
|---|---|---|
| `GardenData` | DynamoDB `irrigation-sensors`, `irrigation-valve-events` | 1 ✅ |
| `GardenIot` | IoT Thing + device policy, 3 topic rules, SNS alerts topic | 1 ✅ |
| `GardenApi` | API Gateway HTTP API + Lambdas + weather schedule | 3 (todo) |
| `GardenWeb` | S3 + CloudFront for the React PWA | 4 (todo) |

## First-time setup

```bash
cd infra
npm install

# Set your alert email (used for SNS low-batt/fault notifications)
# Edit cdk.json -> context.alertEmail, OR pass -c alertEmail=you@example.com on deploy.

# One-time CDK bootstrap of the account/region (creates the CDK toolkit stack):
npx cdk bootstrap --profile personal aws://ACCOUNT_ID/eu-west-1
```

## Deploy

```bash
npm run deploy           # cdk deploy --all --profile personal
# or:
npx cdk deploy --all --profile personal -c alertEmail=you@example.com
```

After deploy, confirm the SNS subscription email AWS sends you, then grab the MQTT
endpoint for the firmware:

```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --profile personal
```

## Device certificate (one-time, manual — never committed)

CDK creates the Thing and policy but not the secret key material. Generate a cert,
attach the policy + thing, and save the files locally (the `infra/certs/` dir and
`*.pem`/`*.key` are git-ignored):

```bash
mkdir -p certs && cd certs

# 1. Create cert + keys, mark active
aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile device.cert.pem \
  --public-key-outfile device.public.key \
  --private-key-outfile device.private.key \
  --profile personal > create-cert.json

CERT_ARN=$(jq -r .certificateArn create-cert.json)

# 2. Attach the CDK-created policy and the thing to the cert
aws iot attach-policy --policy-name irrigation-controller-01-policy \
  --target "$CERT_ARN" --profile personal
aws iot attach-thing-principal --thing-name irrigation-controller-01 \
  --principal "$CERT_ARN" --profile personal

# 3. Amazon Root CA for TLS
curl -o AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
```

Install `device.cert.pem`, `device.private.key`, and `AmazonRootCA1.pem` on the
ESP32 (firmware Phase 2).

## Verify the data path (before firmware exists)

Use the AWS IoT MQTT test client (console) or `aws iot-data` to publish a sample
telemetry message and confirm a row lands in `irrigation-sensors`:

```bash
aws iot-data publish --topic 'garden/irrigation-controller-01/telemetry' \
  --cli-binary-format raw-in-base64-out \
  --payload '{"soilPoly":2600,"soilA1":2000,"soilA2":2100,"soilB1":1900,"soilB2":1950,"tempC":21.5,"rh":60,"battV":12.9}' \
  --profile personal

aws dynamodb scan --table-name irrigation-sensors --profile personal --max-items 5
```

## Useful

```bash
npm run diff             # cdk diff --profile personal
npm run synth            # emit CloudFormation to cdk.out/
npm run destroy          # tears down stacks (DynamoDB tables are RETAINed)
```
