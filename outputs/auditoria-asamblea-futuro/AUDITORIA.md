# Auditoría de producción: asamblea-futuro / Ribera Campestre

**Fecha:** 1 de octubre de 2026  
**Alcance:** revisión estática del repositorio local, del esquema PostgreSQL, permisos runtime y cliente React.  
**No se consultó Render ni se escribió en ribera-db. No se ejecutó carga ni se insertaron votos de prueba.**

## Resumen

El núcleo transaccional de votos conserva el coeficiente como NUMERIC(9,6), lo lee de la unidad autenticada, valida pregunta/opción/asistencia dentro de una transacción y rechaza duplicados por unidad/pregunta. También hay trigger que niega UPDATE y DELETE de votos.

**No recomiendo abrir una votación real hasta compilar y probar en staging los cambios locales.** En el commit auditado, cada conexión residente a una asamblea activa tomaba un lock exclusivo sobre la fila de la asamblea, volvía a consultar el quórum de las 628 unidades y emitía el objeto completo a toda la sala; el voto también recalculaba/difundía el resultado tras cada sufragio. El working tree actual reduce esas rutas (detalle abajo), pero todavía no se ha compilado ni probado.

### Cambios locales aplicados durante esta auditoría

- Asistencia: usa lock compartido de asamblea, actualiza la caché de unidad solo en transición a presente y no por cada reconexión.
- Quórum: agrupa consultas por 250 ms y manda instantáneas solo a la sala Socket.IO de administración.
- Resultados: el voto confirma tras COMMIT. En Socket.IO, el tally se consulta/difunde como máximo una vez por ventana de 250 ms. El POST HTTP conserva su respuesta actual: consulta el tally después del commit (una lectura por solicitud), fuera de la transacción que bloquea el voto.
- Presentación: propietario y administración muestran seis posiciones decimales en la pantalla.

Estos cambios están solo en el checkout local, no desplegados. No resuelven todavía ACK perdido/idempotencia, rehidratación, modo jurídico por pregunta ni diario firmado.

Hay una brecha legal que debe resolverse antes de afirmar cumplimiento: la Corte Constitucional condicionó el voto porcentual por coeficiente, para inmuebles de vivienda, a decisiones de contenido económico; para decisiones no económicas aplica voto por unidad. La aplicación debe registrar la modalidad aplicable a cada pregunta, no asumir que toda decisión residencial se pondera por coeficiente. [Sentencia C-522 de 2002](https://www.corteconstitucional.gov.co/relatoria/2002/c-522-02.htm), [Sentencia C-738 de 2002](https://www.corteconstitucional.gov.co/relatoria/2002/c-738-02.htm).

## 1. PostgreSQL: índices, consultas y bloqueos

### Controles favorables

- unidades.coeficiente y votos.coeficiente_registrado son NUMERIC(9,6); el backend retorna decimales como texto.
- UNIQUE(id_pregunta,id_unidad) impide dos votos concurrentes de la misma unidad y pregunta.
- Claves foráneas compuestas vinculan voto, opción, pregunta, asamblea, unidad y copropiedad.
- castVote mantiene locks compartidos en orden asamblea → pregunta → unidad/asistencia. Apertura/cierre también bloquean primero la asamblea, reduciendo deadlocks normales entre voto y cierre.
- El voto y su inserción son transaccionales; un INSERT fallido no produce un voto parcial.

### Hallazgo P1: tormenta de conexión

En el commit auditado de backend/socket.handler.ts, al conectarse un residente a una asamblea activa, joinTenantAssemblies llamaba registerAttendance. Esa rutina tomaba FOR UPDATE sobre la asamblea, luego la unidad, hacía upsert de asistencia, actualizaba la caché unidades.estado_asistencia, consultaba otra vez todo el quórum y transmitía el JSON completo a todos los sockets de la sala.

Con 628 ingresos, el lock exclusivo sobre una sola fila serializa el proceso. El volumen puede aproximarse a 628 conexiones × 314 receptores promedio × 628 registros por payload, alrededor de 124 millones de objetos de unidad, sin contar el overhead de JSON/Socket.IO. El número concreto depende del ritmo de ingreso, pero el crecimiento es inaceptable.

**Cambios recomendados antes de producción:**

1. Validar la asamblea con FOR SHARE en la ruta de asistencia, dejando FOR UPDATE para cambios administrativos de estado.
2. Adquirir locks en orden fijo: asamblea, unidad, asistencia. Evitar la escritura de unidades.estado_asistencia si no es indispensable; asistencia_asambleas ya es la fuente histórica por reunión.
3. Hacer el registro idempotente y obtener si hubo transición ausente→presente.
4. Si cambió la asistencia, transmitir un delta pequeño {id_unidad, coeficiente, presente}; no una lista completa. Administración carga la instantánea por API al abrir y tras reconectar.
5. Alternativa inicial: agrupar las transiciones recibidas durante 250–500 ms y difundir una sola instantánea por lote.

Debe confirmarse si la conexión del enlace personal basta para acreditar asistencia. El modelo actual no distingue titular, delegado o apoderado.

### Hallazgo P1: una agregación por voto

En el commit auditado, castVote ejecutaba loadResults después de cada INSERT dentro de la transacción y el handler publicaba los resultados completos tras cada ACK. El cambio local saca la lectura de la transacción; el flujo Socket.IO agrupa las consultas/difusiones por 250 ms. El POST HTTP conserva compatibilidad y hace una lectura agregada postcommit por solicitud. El Pool sigue limitado a 20 conexiones por proceso por defecto; el resto espera en la cola. Eso limita las sesiones PostgreSQL, pero crea latencia de cola; la UI actual deja de esperar el ACK a los 8 segundos.

**Cambio recomendado:** responder con recibo individual solo después del COMMIT. Agrupar el cálculo/broadcast del tally por pregunta (por ejemplo, ventana de 250–500 ms), con un único cálculo por lote. Registrar pool.totalCount, idleCount, waitingCount, latencia de conexión/commit/ACK y errores SQLSTATE. Dimensionar PG_POOL_MAX considerando todas las instancias y el máximo de conexiones de PostgreSQL. node-postgres documenta su cola FIFO y waitingCount. [Pool de node-postgres](https://node-postgres.com/apis/pool).

### Índices existentes y criterio

| Estructura actual | Evaluación |
|---|---|
| UNIQUE unidades(id_copropiedad,numero_inmueble) | También sirve por su prefijo para filtrar por copropiedad. idx_unidades_tenant probablemente duplica ese prefijo. |
| PK asistencia_asambleas(id_asamblea,id_unidad) | Alineada con el join del quórum y el upsert de asistencia. |
| idx_asistencia_quorum(id_copropiedad,id_asamblea,estado_asistencia) | No incluye id_unidad, que es parte del join; medir su uso antes de retener, sustituir o quitar. |
| idx_votos_resultados(id_copropiedad,id_pregunta,id_opcion) | Coincide con el filtro del agregado por opción. |
| idx_preguntas_asamblea_estado(id_copropiedad,id_asamblea,estado) | Alineado con búsqueda de preguntas por asamblea/estado. |
| índice parcial único de pregunta activa | Protege una sola pregunta activa por asamblea. |

Con 628 unidades, un índice adicional no resuelve el principal cuello de botella (lock y broadcast). No crear índices en producción por intuición. El archivo SQL de acompañamiento incluye consultas de auditoría y EXPLAIN para staging. PostgreSQL advierte que cada índice también añade coste de escritura y almacenamiento. [Índices PostgreSQL](https://www.postgresql.org/docs/current/indexes.html).

**Candidatos si el EXPLAIN medido los justifica, no ejecutar por anticipado:**

- Votos/resultados: si crece mucho el histórico y EXPLAIN muestra heap fetches dominantes, comparar un índice de cobertura sobre (id_copropiedad,id_pregunta,id_opcion) con INCLUDE (id,coeficiente_registrado). Reemplazar el actual solo después de comparar planes y tamaño en staging; conservar ambos duplica coste.
- Asistencia/quórum: la PK (id_asamblea,id_unidad) ya es el índice correcto para el join por asamblea/unidad; no sumar otro índice sin demostrar que el plan lo necesita. Si futuros informes filtran muchas asistencias por tenant y reunión, comparar (id_copropiedad,id_asamblea,id_unidad) INCLUDE (estado_asistencia).
- Coeficientes: la UNIQUE (id_copropiedad,numero_inmueble) ya filtra unidades por copropiedad; idx_unidades_tenant no agrega selectividad para el patrón actual. Validar pg_stat_user_indexes antes de cualquier baja.

No aplicar CREATE/DROP INDEX en el pico de una asamblea. CREATE INDEX CONCURRENTLY debe lanzarse fuera de una transacción y con revisión de impacto/capacidad.

### Deadlocks y reintentos

El camino normal de votos toma locks compartidos compatibles. El cierre toma lock exclusivo en la asamblea, espera votos existentes y bloquea nuevos votos hasta actualizar el estado. Lo observado apunta sobre todo a serialización/cola, no a deadlock inevitable entre 628 votos. Aun así, medir 40P01 y 40001, registrar operación/SQLSTATE y aplicar retry acotado con jitter únicamente a operaciones idempotentes. No reintentar un voto con otra opción. PostgreSQL recomienda orden consistente de locks. [Bloqueos PostgreSQL](https://www.postgresql.org/docs/16/sql-lock.html).

## 2. Socket.IO y continuidad del cliente

### Estado observado

- El cliente usa autoConnect=false y JWT en auth; connect() conserva la reconexión automática predeterminada.
- El servidor habilita connectionStateRecovery durante 120 s y vuelve a ejecutar middleware.
- No hay rehidratación completa al reconectar. Administración no vuelve a cargar quórum/resultados automáticamente; el propietario no consulta su recibo para resolver un ACK perdido.
- El ACK de voto vence en 8 s. Si PostgreSQL hizo COMMIT pero el ACK se perdió, la persona ve error; el segundo intento recibe 409 DUPLICATE_VOTE sin indicar claramente que el primero quedó registrado.
- Abrir/cerrar pregunta no usa ACK.
- El adapter de rooms es en memoria. El README indica que varias instancias necesitan adapter compartido y afinidad/configuración de transporte compatible.

### Cambios recomendados

1. Configurar backoff explícito con jitter; presentar “reconectando”, “confirmado” y “estado incierto”.
2. En cada connect posterior, recargar por API pregunta activa, quórum, resultados y voto de la propia unidad.
3. Crear GET /mi-voto?preguntaId=..., limitado a la unidad del JWT.
4. Añadir request_id/idempotency key por voto. Repetir la misma clave devuelve el recibo anterior; una clave distinta que intenta emitir otro sufragio conserva el 409.
5. Añadir ACK a abrir/cerrar, con confirmación de estado persistido.
6. No escalar instancias hasta probar adapter compartido y distribución/afinidad de sockets.

La recuperación Socket.IO cubre desconexiones temporales bajo ciertas condiciones; no reemplaza consultar el estado persistido. [Funcionamiento de Socket.IO](https://socket.io/docs/v4/how-it-works).

## 3. JWT, integridad y replay

### Controles presentes

- HS256 explícito, issuer, audience y exp.
- REST y handshake Socket.IO verifican el token.
- El coeficiente no se toma del cliente: el servidor usa la fila unidades y copia el valor NUMERIC al voto.
- El generador genera jti; la restricción única evita un segundo voto por unidad/pregunta.

### Hallazgos y acciones

- El verificador no exige ni consulta jti y no hay sesiones/revocación. Un enlace portador puede reutilizarse hasta exp para permisos del rol. UNIQUE solo limita una pregunta concreta.
- El generador revisado establece TTL predeterminado de 14 días. El enlace equivale a una credencial: quien lo reenvía puede actuar como esa unidad.
- El JWT se repite en cada payload Socket.IO aunque el handshake ya autentica la conexión; eliminar esa repetición reduce exposición accidental en diagnósticos.
- La identidad es posesión del enlace, no verificación de titularidad, persona presente o poder de representación.
- El cliente decodifica el payload para mostrar paneles; esto solo puede controlar presentación. Toda autorización debe permanecer en backend.
- **El secreto de firma fue compartido en texto en la conversación anterior.** Rotarlo desde Render antes de emitir nuevos enlaces; invalida los JWT con la clave anterior. No reutilizar el valor publicado, ni pegar secretos en chat/logs/archivos versionados. [Buenas prácticas JWT, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html).

### Diseño recomendado

- Llave criptográficamente aleatoria de 256 bits o más; tokens de 15–60 minutos; validar iat/exp y vida máxima además de iss/aud/rol/tenant/asamblea/unidad.
- jti revocable, guardado en tabla de sesiones y verificado en cada acción sensible.
- Para enlaces WhatsApp de larga vida, usar código de intercambio de un solo uso y vida corta; canjearlo por sesión HttpOnly, Secure, SameSite.
- Considerar firma asimétrica si se firma fuera de Render: clave privada en emisor controlado, clave pública de verificación en Web Service.
- Guardar idempotency key y recibo de voto. jti sin estado de revocación no detiene replay.
- No loguear tokens, nombres, teléfonos ni coeficientes identificables.

## 4. Carga y criterios de aceptación

Se entregan dos scripts **no ejecutados**:

- load-votes-628.js: k6 contra el endpoint HTTP, 628 identidades de staging.
- socketio-vote-628.mjs: 628 sockets con tokens distintos y emisión sincronizada; verifica ACKs y el tally al final.

k6 no implementa Socket.IO completo; por eso el segundo usa socket.io-client, la misma biblioteca cliente de la app. Cada corrida deja votos persistentes e inmutables: usar una pregunta nueva o restaurar un snapshot de staging antes de repetir. Los scripts bloquean el dominio de producción y requieren confirmación explícita de staging.

### Secuencia de prueba

1. Baseline sin carga por 5 minutos.
2. Probar 10, 50, 150 y 300 sesiones; después 628 sesiones.
3. Separar ráfaga de conexiones, voto HTTP y voto Socket.IO.
4. Repetir cada ejecución sobre pregunta limpia; no reutilizar un ballot con votos previos.
5. Soak de 30 minutos y revisar fuga de memoria, pool, locks y errores.
6. Reiniciar/redeploy staging con sockets conectados; confirmar reconexión, rehidratación y resolución de ACK incierto.
7. Probar doble click/replay, token vencido/revocado, cierre durante una ráfaga y aislamiento de tenant.
8. Ejecutar con el plan Render exacto. El plan Free se documenta hoy con 0.1 CPU y 512 MB; verificar el plan real. [Planes Render](https://render.com/docs/compute-plans), [métricas Render](https://render.com/docs/service-metrics).

### Objetivos iniciales

- 628 ACK válidos, cero votos perdidos/duplicados y cero resultados inciertos sin reconciliar.
- 628 registros en el ballot de prueba; suma exacta 100.000000 si votan las 628 unidades. Cada opción debe concordar con el test vector.
- Cero 40P01, cero 500/502/503 inesperados; 409 solo en pruebas duplicadas intencionales.
- SLO inicial: p95 de ACK <2 s, p99 <5 s y conexión completa <30 s. Ingeniería inicial, no requisito legal.
- CPU <80% sostenido, RAM/RSS con 20% de margen, conexiones DB <70% del límite y pool.waitingCount drenado al finalizar.
- Guardar SHA del commit, versión del plan, gráficas/tiempo Render, métricas de DB y resumen k6/socket. La gráfica remota de CPU/RAM no mide por sí sola latencia de cada request.

## 5. Trazabilidad jurídico-probatoria

### Estado actual

Votos es inmutable ante UPDATE/DELETE por trigger y guarda coeficiente exacto, pero no hay diario de asistencia, apertura/cierre, actor, modalidad de representación, regla legal aplicada ni manifiesto firmado. El trigger no cubre TRUNCATE y un dueño/superusuario podría alterar privilegios/triggers: es protección contra el rol runtime, no evidencia independiente de la base. En el commit auditado, la UI convertía a Number y mostraba 2 decimales; el working tree ahora presenta 6 decimales, pero todavía hace cálculos con Number y no es un export probatorio.

### Esquema sugerido

El SQL adjunto define auditoria.eventos con tenant/asamblea/pregunta/unidad, tipo de evento, actor/rol/origen, instante del servidor, request_id, versión de software, payload canónico, coeficiente como NUMERIC/texto, modalidad de voto, referencia de RPH y hash SHA-256 por evento.

Insertar el evento en la misma transacción que el voto/cambio de estado; si falla el registro probatorio, revertir también la operación. Restringir UPDATE/DELETE/TRUNCATE al runtime y separar owner/migrator. Incluir asistencia, acreditación de apoderados, apertura/cierre, cambios de padrón/regla y recibo de voto.

Al cerrar la pregunta, detener nuevas emisiones, esperar transacciones activas, calcular tally decimal y crear export JSONL determinista. Calcular Merkle root y firmar el manifiesto con clave privada fuera de PostgreSQL/Render Web Service; almacenar el manifiesto en storage con versionado/retención inmutable. Un hash guardado únicamente en la misma DB no protege frente a un DBA privilegiado que reescriba evento y hash.

El paquete del acta debe incluir padrón/coefs exactos, versión de RPH, regla y modalidad de voto de cada decisión, asistencia/poderes, tally decimal por opción, recibos, hashes, clave pública de verificación y versión de la aplicación. La identidad de asistentes y admisibilidad del acta requieren validación de administración/asesoría jurídica.

## Orden de remediación

1. Rotar el secreto JWT compartido y revocar/enmendar tokens emitidos.
2. Eliminar el broadcast completo en cada conexión y agrupar los resultados.
3. Añadir idempotencia, endpoint de recibo, ACK administrativo y rehidratación.
4. Registrar modalidad jurídica por pregunta y regla RPH.
5. Ejecutar carga en staging, medir Render/PostgreSQL y corregir hasta cumplir objetivos.
6. Añadir auditoría append-only, exportación firmada y procedimiento del acta.
7. Programar la ventana productiva con respaldo, responsables y monitoreo.

### Fuentes

- [Ley 675 de 2001, texto consolidado](https://normas.cra.gov.co/gestor/docs/ley_0675_2001.htm)
- [Corte Constitucional, C-522 de 2002](https://www.corteconstitucional.gov.co/relatoria/2002/c-522-02.htm)
- [Corte Constitucional, C-738 de 2002](https://www.corteconstitucional.gov.co/relatoria/2002/c-738-02.htm)
- [Índices PostgreSQL](https://www.postgresql.org/docs/current/indexes.html), [EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html), [locks](https://www.postgresql.org/docs/16/sql-lock.html)
- [Pool node-postgres](https://node-postgres.com/apis/pool), [Socket.IO](https://socket.io/docs/v4/how-it-works)
- [k6 escenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/), [Artillery Socket.IO](https://www.artillery.io/docs/reference/engines/socketio)
- [Métricas Render](https://render.com/docs/service-metrics)
