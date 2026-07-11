// Shared AWS Secrets Manager reader.
//
// Single source of truth for fetching a secret's raw string so the runtime DB
// credential refresher (src/lib/db/credentials.ts) stays isolated. The
// SecretsManagerClient is created lazily on first use, so local/dev/test paths
// that never call it pay no price.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let client: SecretsManagerClient | undefined;

function getClient(): SecretsManagerClient {
  client ??= new SecretsManagerClient({});
  return client;
}

export async function getSecretString(arn: string): Promise<string> {
  const result = await getClient().send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error(`secret ${arn} has no SecretString`);
  return result.SecretString;
}
