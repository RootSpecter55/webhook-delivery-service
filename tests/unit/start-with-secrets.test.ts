import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { loadSecrets, parseRole, type SecretsClient } from '../../scripts/start-with-secrets';

const completeSecret = {
  DATABASE_URL: 'postgresql://u:p@db:5432/app',
  ADMIN_API_KEY: 'x'.repeat(16),
};

function clientReturning(secretString: string | undefined): jest.Mocked<SecretsClient> {
  return { send: jest.fn().mockResolvedValue({ SecretString: secretString }) } as never;
}

describe('loadSecrets', () => {
  it('copies every key of the AWS secret into the environment', async () => {
    const env: NodeJS.ProcessEnv = { SECRETS_SOURCE: 'aws', SECRET_ID: 'app/prod' };
    const client = clientReturning(JSON.stringify({ ...completeSecret, EXTRA: 'value' }));

    await loadSecrets(env, client);

    expect(env).toMatchObject({ ...completeSecret, EXTRA: 'value' });
    const command = client.send.mock.calls[0]![0] as GetSecretValueCommand;
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect(command.input).toEqual({ SecretId: 'app/prod' });
  });

  it('fails fast when SECRET_ID is not set', async () => {
    await expect(loadSecrets({ SECRETS_SOURCE: 'aws' }, clientReturning('{}'))).rejects.toThrow(
      'SECRET_ID is required when SECRETS_SOURCE=aws',
    );
  });

  it('fails fast when the secret cannot be read', async () => {
    const client = { send: jest.fn().mockRejectedValue(new Error('ResourceNotFoundException')) };
    await expect(
      loadSecrets({ SECRETS_SOURCE: 'aws', SECRET_ID: 'missing' }, client as never),
    ).rejects.toThrow('Could not read secret "missing": ResourceNotFoundException');
  });

  it('names every required key that is absent', async () => {
    const client = clientReturning(JSON.stringify({}));
    await expect(
      loadSecrets({ SECRETS_SOURCE: 'aws', SECRET_ID: 'app/prod' }, client),
    ).rejects.toThrow('missing required keys: DATABASE_URL, ADMIN_API_KEY');
  });

  it('rejects a secret that is not a JSON object', async () => {
    await expect(
      loadSecrets({ SECRETS_SOURCE: 'aws', SECRET_ID: 's' }, clientReturning('not json')),
    ).rejects.toThrow('is not valid JSON');
    await expect(
      loadSecrets({ SECRETS_SOURCE: 'aws', SECRET_ID: 's' }, clientReturning('["a"]')),
    ).rejects.toThrow('must be a JSON object');
  });

  it('does not call AWS when SECRETS_SOURCE=local', async () => {
    const client = clientReturning('{}');
    await loadSecrets({ SECRETS_SOURCE: 'local' }, client);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown SECRETS_SOURCE', async () => {
    await expect(loadSecrets({ SECRETS_SOURCE: 'vault' })).rejects.toThrow(
      'SECRETS_SOURCE must be "local" or "aws", got "vault"',
    );
  });
});

describe('parseRole', () => {
  it('defaults to the API and accepts the worker', () => {
    expect(parseRole(undefined)).toBe('api');
    expect(parseRole('worker')).toBe('worker');
    expect(() => parseRole('cron')).toThrow('Role must be "api" or "worker", got "cron"');
  });
});
