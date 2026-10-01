-- Ejecute como usuario de migraciones después de schema.sql.
-- Establezca la contraseña fuera de este archivo (por ejemplo con psql \password ph_runtime).
DO $$
BEGIN
  CREATE ROLE ph_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER ROLE ph_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO ph_runtime;
GRANT SELECT ON public.copropiedades,public.unidades,public.asambleas,public.preguntas,
  public.opciones,public.asistencia_asambleas,public.votos TO ph_runtime;
GRANT INSERT ON public.preguntas,public.opciones,public.asistencia_asambleas,public.votos TO ph_runtime;
GRANT UPDATE (estado) ON public.preguntas TO ph_runtime;
GRANT UPDATE (estado_asistencia,registrada_en,ultima_conexion_socket_en,actualizada_en)
  ON public.asistencia_asambleas TO ph_runtime;
GRANT UPDATE (estado_asistencia) ON public.unidades TO ph_runtime;
GRANT USAGE,SELECT ON SEQUENCE public.preguntas_id_seq,public.opciones_id_seq TO ph_runtime;
-- No otorgue UPDATE, DELETE, TRUNCATE ni propiedad de tablas/sec. a ph_runtime.