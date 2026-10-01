import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}.`);
  return value;
};

const connectionUrl = new URL(required('DATABASE_URL'));
for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connectionUrl.searchParams.delete(option);
const nit = required('RIBERA_NIT');
if (nit.replace(/[^0-9]/g, '') !== '9020699486') throw new Error('El NIT no coincide con el RUT verificado.');
const secret = required('JWT_SECRET');
if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('JWT_SECRET debe tener al menos 32 bytes.');
const issuer = required('JWT_ISSUER');
const audience = required('JWT_AUDIENCE');
const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://asamblea-futuro.onrender.com').replace(/\/$/, '');
const projectRoot = process.cwd();
const requireFromProject = createRequire(resolve(projectRoot, 'package.json'));
const { Client } = requireFromProject('pg');
const jwt = requireFromProject('jsonwebtoken');
const client = new Client({ connectionString: connectionUrl.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 20_000 });

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

try {
  await client.connect();
  const result = await client.query(`
    SELECT c.id::text AS id_copropiedad, c.nombre, a.id::text AS id_asamblea, a.estado,
           u.id::text AS id_unidad, u.numero_inmueble, u.coeficiente::text AS coeficiente,
           count(u.id) OVER ()::text AS cantidad_unidades,
           sum(u.coeficiente) OVER ()::numeric(12,6)::text AS coeficiente_total
    FROM public.copropiedades c
    JOIN public.unidades u ON u.id_copropiedad = c.id
    JOIN public.asambleas a ON a.id_copropiedad = c.id
    WHERE regexp_replace(c.nit, '[^0-9]', '', 'g') = $1
      AND a.estado = 'activa'
    ORDER BY u.numero_inmueble
  `, [nit.replace(/[^0-9]/g, '')]);

  const activeAssemblies = new Set(result.rows.map(row => row.id_asamblea));
  if (activeAssemblies.size !== 1) {
    throw new Error(`Se requiere exactamente una asamblea activa para Ribera Campestre; encontradas=${activeAssemblies.size}.`);
  }

  if (result.rowCount !== 628 || result.rows[0]?.cantidad_unidades !== '628' || result.rows[0]?.coeficiente_total !== '100.000000') {
    throw new Error(`No se generaron enlaces: unidades=${result.rows[0]?.cantidad_unidades ?? 0}, suma=${result.rows[0]?.coeficiente_total ?? '0'}.`);
  }

  const first = result.rows[0];
  const sign = (claims, subject) => jwt.sign(claims, secret, {
    algorithm: 'HS256', issuer, audience, subject,
    expiresIn: process.env.JWT_LINK_TTL || '14d', jwtid: randomUUID()
  });
  const links = result.rows.map(row => {
    const token = sign({
      id_unidad: row.id_unidad,
      id_copropiedad: row.id_copropiedad,
      id_asamblea: row.id_asamblea,
      rol: 'residente'
    }, row.id_unidad);
    return [row.numero_inmueble, `${baseUrl}/#token=${encodeURIComponent(token)}`];
  });

  const outputDir = fileURLToPath(new URL('.', import.meta.url));
  const csvPath = resolve(outputDir, 'ribera-campestre-access-links.csv');
  const adminPath = resolve(outputDir, 'ribera-campestre-admin-link.txt');
  const csvText = '\uFEFF' + [['Unidad privada', 'Enlace de acceso'], ...links].map(row => row.map(csv).join(';')).join('\r\n') + '\r\n';
  const adminToken = sign({
    id_unidad: null,
    id_copropiedad: first.id_copropiedad,
    id_asamblea: first.id_asamblea,
    rol: 'administrador'
  }, `admin:${first.id_copropiedad}`);
  await writeFile(csvPath, csvText, { encoding: 'utf8', mode: 0o600 });
  await writeFile(adminPath, `${baseUrl}/#token=${encodeURIComponent(adminToken)}\r\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`Enlaces generados: ${links.length} residentes y 1 administración; vigencia ${process.env.JWT_LINK_TTL || '14d'}.`);
} finally {
  await client.end().catch(() => {});
}
