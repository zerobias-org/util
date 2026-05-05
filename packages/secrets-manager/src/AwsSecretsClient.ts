import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export interface AwsSecretsClientOptions {
  region?: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * Thin wrapper over `@aws-sdk/client-secrets-manager` exposing only the
 * surface this package needs. When `credentials` is omitted the SDK falls
 * back to its default credential chain (env, shared profile, instance role).
 */
export class AwsSecretsClient {
  private readonly client: SecretsManagerClient;

  constructor(opts: AwsSecretsClientOptions = {}) {
    this.client = new SecretsManagerClient({
      region: opts.region,
      endpoint: opts.endpoint,
      credentials: opts.credentials,
    });
  }

  /** Reachability check — succeeds when the API responds (an empty list counts). */
  async ping(): Promise<void> {
    await this.client.send(new ListSecretsCommand({ MaxResults: 1 }));
  }

  /** Names of all secrets in the account (paginates internally). */
  async listSecretNames(): Promise<string[]> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await this.client.send(new ListSecretsCommand({
        MaxResults: 100,
        SortOrder: 'asc',
        NextToken: nextToken,
      }));
      for (const entry of resp.SecretList ?? []) {
        if (entry.Name) names.push(entry.Name);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return names;
  }

  /** Fetch a secret's string payload. */
  async getSecretString(name: string): Promise<string> {
    const resp = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
    return resp.SecretString ?? '';
  }

  /** Create an empty secret. */
  async createSecret(name: string): Promise<void> {
    await this.client.send(new CreateSecretCommand({ Name: name }));
  }

  /** Replace the value of an existing secret. */
  async putSecretValue(name: string, secretString: string): Promise<void> {
    await this.client.send(new PutSecretValueCommand({
      SecretId: name,
      SecretString: secretString,
    }));
  }

  destroy(): void {
    this.client.destroy();
  }
}
