import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('No se definió DATABASE_URL en esta sesión de PowerShell.');
  process.exit(2);
}
const nit = (process.env.RIBERA_NIT || '').trim();
if (nit.replace(/[^0-9]/g, '') !== '9020699486') {
  console.error('El NIT no coincide con el RUT verificado de Ribera Campestre P.H. (base y DV).');
  process.exit(2);
}

let requireFromProject;
try {
  requireFromProject = createRequire(resolve(process.cwd(), 'package.json'));
} catch {
  console.error('Ejecuta este auxiliar desde la raíz del proyecto, donde está package.json.');
  process.exit(2);
}

let Client;
try {
  ({ Client } = requireFromProject('pg'));
} catch {
  console.error('No se encontró el paquete pg. Ejecuta desde la raíz del proyecto con sus dependencias instaladas.');
  process.exit(2);
}

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'ribera-campestre-unidades.sql');
const sql = await readFile(scriptPath, 'utf8');
const connectionUrl = new URL(connectionString);
for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connectionUrl.searchParams.delete(option);
const client = new Client({
  connectionString: connectionUrl.toString(),
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 20_000,
  statement_timeout: 120_000,
});
let migrationCommitted = false;

try {
  await client.connect();
  const tls = await client.query("SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
  if (tls.rows[0]?.ssl !== true) throw new Error('La conexión de PostgreSQL no está cifrada con TLS.');
  console.log(`Conexión PostgreSQL validada con TLS ${tls.rows[0].version}.`);
  await client.query("SELECT set_config('app.ribera_nit', $1, false)", [nit]);
  await client.query(sql);
  migrationCommitted = true;
  const audit = await client.query(`
    SELECT c.id::text AS id_copropiedad, c.nombre,
           count(u.id)::text AS unidades,
           COALESCE(sum(u.coeficiente), 0)::numeric(12,6)::text AS coeficiente_total,
           bool_or(a.id = '00000000-0000-4000-8000-000000000101'::uuid AND a.estado = 'activa') AS asamblea_activa
    FROM public.copropiedades c
    LEFT JOIN public.unidades u ON u.id_copropiedad = c.id
    LEFT JOIN public.asambleas a ON a.id_copropiedad = c.id
    WHERE regexp_replace(c.nit, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
    GROUP BY c.id, c.nombre
  `, [nit]);
  const row = audit.rows[0];
  if (audit.rowCount !== 1 || row.unidades !== '628' || row.coeficiente_total !== '100.000000' || row.asamblea_activa !== true) {
    console.error('La migración se confirmó, pero la auditoría posterior no coincide con el resultado esperado.');
    console.error(JSON.stringify({ unidades: row?.unidades, coeficiente_total: row?.coeficiente_total, asamblea_activa: row?.asamblea_activa }));
    process.exitCode = 1;
  } else {
    console.log(`Migración confirmada y auditada: ${row.unidades} unidades; suma ${row.coeficiente_total}%; asamblea lista.`);
  }
} catch (error) {
  if (migrationCommitted) {
    console.error('La transacción se confirmó, pero falló la consulta de auditoría posterior.');
  } else {
    await client.query('ROLLBACK').catch(() => {});
    console.error('La migración no se confirmó; PostgreSQL revirtió la transacción.');
  }
  if (error?.code) console.error(`Código: ${error.code}`);
  if (error?.message) console.error(`Detalle: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
