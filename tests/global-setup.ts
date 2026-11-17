import { execSync } from 'node:child_process';
import { Client } from 'pg';
import './setup-env';

/** Runs a CLI command quietly, printing its output only if it fails. */
function run(command: string) {
  try {
    execSync(command, { stdio: 'pipe', env: process.env });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    process.stderr.write(`${stdout ?? ''}${stderr ?? ''}`);
    throw err;
  }
}

/** Creates the test database if it does not exist, then applies migrations. */
export default async function globalSetup() {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  run('npx prisma migrate deploy');
}
