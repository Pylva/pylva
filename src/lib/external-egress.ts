import type { LambdaClient } from '@aws-sdk/client-lambda';
import { externalEgressEnv } from './external-egress-config.js';
import {
  assertWebhookUrlAllowed,
  executePreparedEgressRequest,
  prepareEgressRequest,
  _internal,
  type EgressRequest,
  type EgressResponse,
  type EgressTarget,
} from './external-egress-core.js';

export {
  assertWebhookUrlAllowed,
  _internal,
  type EgressRequest,
  type EgressResponse,
  type EgressTarget,
};

let lambdaClient: LambdaClient | undefined;

function brokerError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function parseBrokerResponse(payload: string): EgressResponse {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (cause) {
    throw brokerError(
      'EGRESS_BROKER_INVALID_RESPONSE',
      'egress broker returned invalid JSON',
      cause,
    );
  }

  const response = value as Partial<EgressResponse> | null;
  if (
    response === null ||
    typeof response !== 'object' ||
    !Number.isInteger(response.status) ||
    response.status! < 100 ||
    response.status! > 599 ||
    typeof response.statusText !== 'string' ||
    !isStringRecord(response.headers) ||
    typeof response.body !== 'string'
  ) {
    throw brokerError(
      'EGRESS_BROKER_INVALID_RESPONSE',
      'egress broker returned an invalid response shape',
    );
  }
  return response as EgressResponse;
}

async function brokerFetch(
  request: EgressRequest,
  brokerFunctionName: string,
): Promise<EgressResponse> {
  const { InvokeCommand, LambdaClient: AwsLambdaClient } = await import('@aws-sdk/client-lambda');
  lambdaClient ??= new AwsLambdaClient({});
  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: brokerFunctionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );
  if (result.FunctionError) {
    throw brokerError('EGRESS_BROKER_FAILED', 'egress broker invocation failed');
  }
  const payload = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
  return parseBrokerResponse(payload);
}

export async function externalFetch(request: EgressRequest): Promise<EgressResponse> {
  const prepared = await prepareEgressRequest(request);
  if (externalEgressEnv.EGRESS_BROKER_FUNCTION_NAME) {
    return brokerFetch(
      { ...request, url: prepared.url.toString() },
      externalEgressEnv.EGRESS_BROKER_FUNCTION_NAME,
    );
  }
  return executePreparedEgressRequest(prepared);
}
