import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('No se definió DATABASE_URL en esta sesión de PowerShell.');
  process.exit(2);
}

const requireFromProject = createRequire(resolve(process.cwd(), 'package.json'));
const { Client } = requireFromProject('pg');
const schemaPath = fileURLToPath(new URL('./ribera-production-schema.sql', import.meta.url));
const sql = await readFile(schemaPath, 'utf8');
const connectionUrl = new URL(connectionString);
connectionUrl.searchParams.set('sslmode', 'require');
const client = new Client({
  connectionString: connectionUrl.toString(),
  connectionTimeoutMillis: 20_000,
  statement_timeout: 120_000,
});

try {
  await client.connect();
  await client.query(sql);
  console.log('Esquema base instalado; sin datos de demostración.');
} catch (error) {
  console.error('El esquema no se confirmó; PostgreSQL revirtió la transacción.');
  if (error?.code) console.error(`Código: ${error.code}`);
  if (error?.message) console.error(`Detalle: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
