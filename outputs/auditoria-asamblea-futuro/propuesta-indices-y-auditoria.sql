-- BORRADOR PARA REVISION EN STAGING. NO EJECUTAR EN PRODUCCION TAL CUAL.
-- La seccion A es de solo lectura. La seccion B propone un modelo nuevo.

-- A. Auditoria de padron y coeficientes exactos (con usuario de migracion autorizado).
-- Reemplazar el NIT con el de staging; nunca imprimir credenciales en psql.
\set nit_staging 'NIT-DE-STAGING'
SELECT c.id AS id_copropiedad, c.nombre, count(u.id) AS unidades,
       coalesce(sum(u.coeficiente),0)::numeric(12,6)::text AS suma_coeficientes
FROM public.copropiedades c
LEFT JOIN public.unidades u ON u.id_copropiedad=c.id
WHERE regexp_replace(c.nit,'[^0-9]','','g')=regexp_replace(:'nit_staging','[^0-9]','','g')
GROUP BY c.id,c.nombre;

-- A.1 Resultados exactos; definir estos valores de staging antes de ejecutar.
\set tenant_id 'UUID-COPROPIEDAD-STAGING'
\set assembly_id 'UUID-ASAMBLEA-STAGING'
\set question_id 1
BEGIN READ ONLY;
SELECT set_config('app.id_copropiedad', :'tenant_id', true);
SELECT count(*) AS unidades, coalesce(sum(coeficiente),0)::numeric(12,6)::text AS total
FROM public.unidades WHERE id_copropiedad=:'tenant_id'::uuid;
SELECT count(*) AS votos,
       coalesce(sum(coeficiente_registrado),0)::numeric(12,6)::text AS coeficiente_votado
FROM public.votos
WHERE id_copropiedad=:'tenant_id'::uuid
  AND id_asamblea=:'assembly_id'::uuid
  AND id_pregunta=:'question_id'::integer;
ROLLBACK;

-- A.2 Plan del quórum; SELECT solamente. Ejecutar en staging fuera de una asamblea real.
BEGIN READ ONLY;
SELECT set_config('app.id_copropiedad', :'tenant_id', true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT coalesce(sum(u.coeficiente) FILTER (WHERE coalesce(aa.estado_asistencia,false)),0)::text,
       coalesce(sum(u.coeficiente),0)::text
FROM public.unidades u
LEFT JOIN public.asistencia_asambleas aa
  ON aa.id_unidad=u.id AND aa.id_copropiedad=u.id_copropiedad
 AND aa.id_asamblea=:'assembly_id'::uuid
WHERE u.id_copropiedad=:'tenant_id'::uuid;
ROLLBACK;

-- A.3 Plan del resultado por opcion; el filtro debe concordar con el indice actual.
BEGIN READ ONLY;
SELECT set_config('app.id_copropiedad', :'tenant_id', true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id,o.texto,coalesce(sum(v.coeficiente_registrado),0)::text,count(v.id)
FROM public.opciones o
LEFT JOIN public.votos v
  ON v.id_opcion=o.id AND v.id_pregunta=o.id_pregunta
 AND v.id_asamblea=o.id_asamblea AND v.id_copropiedad=o.id_copropiedad
WHERE o.id_pregunta=:'question_id'::integer
  AND o.id_asamblea=:'assembly_id'::uuid
  AND o.id_copropiedad=:'tenant_id'::uuid
GROUP BY o.id,o.texto,o.orden ORDER BY o.orden;
ROLLBACK;

-- A.4 Uso de indices (tomar snapshot antes/despues de una prueba controlada).
SELECT relname AS tabla,indexrelname AS indice,idx_scan,idx_tup_read,idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS tamano
FROM pg_stat_user_indexes
WHERE schemaname='public'
  AND relname IN ('unidades','asistencia_asambleas','votos','preguntas')
ORDER BY relname,indexrelname;

-- Candidatos de indice: no ejecutar hasta comparar EXPLAIN/BUFFERS en staging.
-- El indice unico actual votos_resultados tiene las mismas columnas clave; no conservar
-- ambos sin justificar el coste. INCLUDE puede ayudar solo cuando el historico sea grande
-- y los heap fetches dominen el plan:
-- CREATE INDEX CONCURRENTLY idx_votos_resultados_cover
--   ON public.votos(id_copropiedad,id_pregunta,id_opcion)
--   INCLUDE(id,coeficiente_registrado);
--
-- unidades ya tiene UNIQUE(id_copropiedad,numero_inmueble), que cubre el prefijo
-- id_copropiedad. asistencia ya tiene PK(id_asamblea,id_unidad), alineada con el join.
-- Solo si un futuro informe muestra escaneo alto por tenant+asamblea comparar:
-- CREATE INDEX CONCURRENTLY idx_asistencia_tenant_assembly_unit
--   ON public.asistencia_asambleas(id_copropiedad,id_asamblea,id_unidad)
--   INCLUDE(estado_asistencia);

-- A.5 Locks y esperas sin imprimir texto SQL ni datos de usuarios.
SELECT pid,application_name,state,wait_event_type,wait_event,
       clock_timestamp()-query_start AS antiguedad
FROM pg_stat_activity
WHERE datname=current_database()
  AND (wait_event_type='Lock' OR state='active')
ORDER BY query_start;

-- B. Modelo ilustrativo de diario append-only. Requiere migracion revisada, pruebas RLS,
-- ownership separado y control de retencion antes de aplicarlo.
CREATE SCHEMA IF NOT EXISTS auditoria;

CREATE TABLE auditoria.eventos (
  id_evento uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secuencia bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id_copropiedad uuid NOT NULL,
  id_asamblea uuid NOT NULL,
  tipo_evento text NOT NULL,
  actor_sub text NOT NULL,
  actor_rol text NOT NULL CHECK (actor_rol IN ('administrador','residente','sistema')),
  origen text NOT NULL CHECK (origen IN ('http','socket','sistema','administracion')),
  id_unidad uuid,
  id_pregunta integer,
  id_opcion integer,
  request_id uuid,
  coeficiente NUMERIC(9,6),
  modalidad_voto text CHECK (modalidad_voto IS NULL OR modalidad_voto IN ('coeficiente','unidad')),
  referencia_rph text,
  version_app text NOT NULL,
  ocurrio_en timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  hash_sha256 bytea NOT NULL,
  CONSTRAINT auditoria_assembly_tenant_fk
    FOREIGN KEY (id_asamblea,id_copropiedad)
    REFERENCES public.asambleas(id,id_copropiedad) ON DELETE RESTRICT,
  CONSTRAINT auditoria_unit_tenant_fk
    FOREIGN KEY (id_unidad,id_copropiedad)
    REFERENCES public.unidades(id,id_copropiedad) ON DELETE RESTRICT,
  CONSTRAINT auditoria_question_tenant_fk
    FOREIGN KEY (id_pregunta,id_asamblea,id_copropiedad)
    REFERENCES public.preguntas(id,id_asamblea,id_copropiedad) ON DELETE RESTRICT
);

CREATE INDEX auditoria_eventos_asamblea_secuencia
  ON auditoria.eventos(id_copropiedad,id_asamblea,secuencia);
CREATE INDEX auditoria_eventos_question
  ON auditoria.eventos(id_copropiedad,id_asamblea,id_pregunta,secuencia);

CREATE OR REPLACE FUNCTION auditoria.calcular_hash_evento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.hash_sha256 := public.digest(
    convert_to(jsonb_build_object(
      'id_evento',NEW.id_evento,
      'secuencia',NEW.secuencia,
      'tenant',NEW.id_copropiedad,
      'asamblea',NEW.id_asamblea,
      'tipo',NEW.tipo_evento,
      'actor',NEW.actor_sub,
      'rol',NEW.actor_rol,
      'origen',NEW.origen,
      'unidad',NEW.id_unidad,
      'pregunta',NEW.id_pregunta,
      'opcion',NEW.id_opcion,
      'request_id',NEW.request_id,
      'coeficiente',NEW.coeficiente::text,
      'modalidad_voto',NEW.modalidad_voto,
      'referencia_rph',NEW.referencia_rph,
      'version_app',NEW.version_app,
      'ocurrio_en',NEW.ocurrio_en,
      'payload',NEW.payload
    )::text,'UTF8'),
    'sha256'
  );
  RETURN NEW;
END $$;

CREATE TRIGGER eventos_hash_before_insert
BEFORE INSERT ON auditoria.eventos
FOR EACH ROW EXECUTE FUNCTION auditoria.calcular_hash_evento();

CREATE OR REPLACE FUNCTION auditoria.rechazar_mutacion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El diario de auditoria es append-only';
END $$;

CREATE TRIGGER eventos_no_update_delete
BEFORE UPDATE OR DELETE ON auditoria.eventos
FOR EACH ROW EXECUTE FUNCTION auditoria.rechazar_mutacion();
CREATE TRIGGER eventos_no_truncate
BEFORE TRUNCATE ON auditoria.eventos
FOR EACH STATEMENT EXECUTE FUNCTION auditoria.rechazar_mutacion();

ALTER TABLE auditoria.eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria.eventos FORCE ROW LEVEL SECURITY;
CREATE POLICY auditoria_por_tenant ON auditoria.eventos
  USING (id_copropiedad=NULLIF(current_setting('app.id_copropiedad',true),'')::uuid)
  WITH CHECK (id_copropiedad=NULLIF(current_setting('app.id_copropiedad',true),'')::uuid);

-- Dar permisos solo despues de revisar ownership y definir un rol de lectura probatoria aparte.
-- El rol runtime no debe ser dueño, superuser ni BYPASSRLS.
REVOKE UPDATE,DELETE,TRUNCATE ON auditoria.eventos FROM PUBLIC;
-- GRANT USAGE ON SCHEMA auditoria TO ph_runtime;
-- GRANT INSERT ON auditoria.eventos TO ph_runtime;
-- GRANT USAGE,SELECT ON SEQUENCE auditoria.eventos_secuencia_seq TO ph_runtime;

-- El hash de una fila prueba integridad de ese payload solo frente a cambios no coordinados.
-- Para evidencia independiente, al cierre crear un manifiesto determinista/Merkle root,
-- firmarlo fuera de la base y guardarlo en almacenamiento versionado con retencion inmutable.
