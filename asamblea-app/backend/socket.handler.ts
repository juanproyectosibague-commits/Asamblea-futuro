import type { Server, Socket } from "socket.io";
import type { Pool } from "pg";
import { assertSocketEventToken, HttpError, socketPrincipal, type AuthClaims } from "./auth";
import {
  assertAssembly, castVote, changeQuestionState, createQuestion, loadActiveQuestion,
  assemblyRoom as roomName, loadQuorum, parseAssemblyId, parseOptionId, parseQuestionId,
  scheduleResultsBroadcast, withTenantTransaction
} from "./voting.controller";

interface EventPayload {
  asamblea_id?: unknown;
  id_pregunta?: unknown;
  id_opcion?: unknown;
  enunciado?: unknown;
  opciones?: unknown;
  token?: unknown;
}
type Ack = (response: Record<string, unknown>) => void;
type AsyncHandler = () => Promise<void>;

const adminRoomName = (tenantId: string, assemblyId: string) =>
  roomName(tenantId, assemblyId) + ":administrators";

const pendingQuorumBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleQuorumBroadcast(io: Server, pool: Pool, tenantId: string, assemblyId: string): void {
  const key = tenantId + ":" + assemblyId;
  if (pendingQuorumBroadcasts.has(key)) return;
  const timer = setTimeout(() => {
    pendingQuorumBroadcasts.delete(key);
    void withTenantTransaction(pool, tenantId, client =>
      loadQuorum(client, assemblyId, tenantId)
    ).then(quorum => {
      io.to(adminRoomName(tenantId, assemblyId)).emit("quorum_actualizado", quorum);
    }).catch(error => {
      console.error("No se pudo difundir el quórum:", error instanceof Error ? error.message : "error desconocido");
    });
  }, 250);
  timer.unref?.();
  pendingQuorumBroadcasts.set(key, timer);
}

function eventAssemblyId(payload: EventPayload, auth: AuthClaims): string {
  const id = parseAssemblyId(payload.asamblea_id);
  if (id !== auth.id_asamblea) throw new HttpError(403, "El token no tiene acceso a esta asamblea.", "ASSEMBLY_FORBIDDEN");
  return id;
}

function emitError(socket: Socket, error: unknown, ack?: Ack): void {
  const message = error instanceof Error ? error.message : "Error procesando el evento.";
  socket.emit("error_votacion", { mensaje: message });
  ack?.({ ok: false, error: message });
}

function run(socket: Socket, handler: AsyncHandler, ack?: Ack): void {
  void handler().catch(error => emitError(socket, error, ack));
}

async function joinTenantAssemblies(io: Server, socket: Socket, pool: Pool, auth: AuthClaims): Promise<void> {
  const result = await withTenantTransaction(pool, auth.id_copropiedad, client =>
    client.query<{ id: string; estado: string }>("SELECT id,estado FROM public.asambleas WHERE id=$1 AND id_copropiedad=$2 AND estado IN ('programada','activa')", [auth.id_asamblea, auth.id_copropiedad])
  );
  const ids = result.rows.map(row => String(row.id));
  if (ids.length) await socket.join(ids.map(id => roomName(auth.id_copropiedad, id)));
  if (ids.length && auth.rol === "administrador") {
    await socket.join(ids.map(id => adminRoomName(auth.id_copropiedad, id)));
  }
  for (const row of result.rows) {
    const id = String(row.id);
    if (row.estado === "activa" && auth.rol === "residente" && auth.id_unidad) {
      const attendance = await registerAttendance(pool, auth, id);
      if (attendance.changed) scheduleQuorumBroadcast(io, pool, auth.id_copropiedad, id);
    }
    const active = await withTenantTransaction(pool, auth.id_copropiedad,
      client => loadActiveQuestion(client, id, auth.id_copropiedad));
    if (active) socket.emit("estado_votacion", active);
  }
}

async function registerAttendance(
  pool: Pool,
  auth: AuthClaims,
  assemblyId: string
): Promise<{ changed: boolean }> {
  if (auth.rol !== "residente" || !auth.id_unidad) throw new HttpError(403, "Solo una unidad residente puede registrar asistencia.");
  return withTenantTransaction(pool, auth.id_copropiedad, async client => {
    const assembly = await assertAssembly(client, assemblyId, auth.id_copropiedad, "share");
    if (assembly.estado !== "activa") throw new HttpError(409, "La asamblea no está habilitada para asistencia.");
    const unit = await client.query("SELECT id FROM public.unidades WHERE id=$1 AND id_copropiedad=$2 FOR UPDATE",
      [auth.id_unidad, auth.id_copropiedad]);
    if (!unit.rowCount) throw new HttpError(403, "La unidad no pertenece a esta copropiedad.");
    const recorded = await client.query(
      "INSERT INTO public.asistencia_asambleas(id_asamblea,id_copropiedad,id_unidad,estado_asistencia,registrada_en,ultima_conexion_socket_en,actualizada_en) " +
      "VALUES($1,$2,$3,TRUE,now(),now(),now()) " +
      "ON CONFLICT(id_asamblea,id_unidad) DO UPDATE SET estado_asistencia=TRUE," +
      "registrada_en=COALESCE(public.asistencia_asambleas.registrada_en,now()),ultima_conexion_socket_en=now(),actualizada_en=now() " +
      "WHERE public.asistencia_asambleas.estado_asistencia IS DISTINCT FROM TRUE RETURNING id_unidad",
      [assemblyId, auth.id_copropiedad, auth.id_unidad]
    );
    if (recorded.rowCount) {
      await client.query(
        "UPDATE public.unidades SET estado_asistencia=TRUE WHERE id=$1 AND id_copropiedad=$2",
        [auth.id_unidad, auth.id_copropiedad]
      );
    } else {
      await client.query(
        "UPDATE public.asistencia_asambleas SET ultima_conexion_socket_en=now(),actualizada_en=now() " +
        "WHERE id_asamblea=$1 AND id_copropiedad=$2 AND id_unidad=$3",
        [assemblyId, auth.id_copropiedad, auth.id_unidad]
      );
    }
    return { changed: Boolean(recorded.rowCount) };
  });
}

async function noteSocketPresence(pool: Pool, auth: AuthClaims, assemblyId: string): Promise<void> {
  if (auth.rol !== "residente" || !auth.id_unidad) return;
  await withTenantTransaction(pool, auth.id_copropiedad, client => client.query(
    "UPDATE public.asistencia_asambleas SET ultima_conexion_socket_en=now(),actualizada_en=now() " +
    "WHERE id_asamblea=$1 AND id_copropiedad=$2 AND id_unidad=$3 AND estado_asistencia=TRUE",
    [assemblyId, auth.id_copropiedad, auth.id_unidad]
  ).then(() => undefined));
}

export function registerSocketHandlers(io: Server, pool: Pool): void {
  io.on("connection", socket => {
    const auth = socketPrincipal(socket);
    void joinTenantAssemblies(io, socket, pool, auth).catch(error => emitError(socket, error));

    socket.on("crear_pregunta", (payload: EventPayload, ack?: Ack) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      if (actor.rol !== "administrador") throw new HttpError(403, "Solo administración puede crear preguntas.");
      const assemblyId = eventAssemblyId(payload, actor);
      const question = await createQuestion(pool, actor, assemblyId, payload.enunciado, payload.opciones);
      io.to(roomName(actor.id_copropiedad, assemblyId)).emit("pregunta_creada", { pregunta: question });
      ack?.({ ok: true, pregunta: question });
    }, ack));

    socket.on("abrir_votacion", (payload: EventPayload, ack?: Ack) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      const assemblyId = eventAssemblyId(payload, actor);
      const question = await changeQuestionState(pool, actor, assemblyId, parseQuestionId(payload.id_pregunta), "abrir");
      io.to(roomName(actor.id_copropiedad, assemblyId)).emit("estado_votacion", question);
      ack?.({ ok: true, pregunta: question });
    }, ack));

    socket.on("cerrar_votacion", (payload: EventPayload, ack?: Ack) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      const assemblyId = eventAssemblyId(payload, actor);
      const question = await changeQuestionState(pool, actor, assemblyId, parseQuestionId(payload.id_pregunta), "cerrar");
      io.to(roomName(actor.id_copropiedad, assemblyId)).emit("estado_votacion", question);
      ack?.({ ok: true, pregunta: question });
    }, ack));

    socket.on("emitir_voto", (payload: EventPayload, ack?: Ack) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      const assemblyId = eventAssemblyId(payload, actor);
      const outcome = await castVote(pool, actor, assemblyId, parseQuestionId(payload.id_pregunta),
        parseOptionId(payload.id_opcion));
      scheduleResultsBroadcast(pool, io, actor.id_copropiedad, assemblyId, outcome.id_pregunta);
      ack?.({
        ok: true,
        mensaje: "Voto registrado con coeficiente " + outcome.coeficiente_registrado + "%.",
        voto: {
          id_voto: outcome.id_voto, id_pregunta: outcome.id_pregunta, id_opcion: outcome.id_opcion,
          coeficiente_registrado: outcome.coeficiente_registrado, registrado_en: outcome.registrado_en
        }
      });
    }, ack));

    socket.on("registrar_asistencia", (payload: EventPayload, ack?: Ack) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      const assemblyId = eventAssemblyId(payload, actor);
      const attendance = await registerAttendance(pool, actor, assemblyId);
      await socket.join(roomName(actor.id_copropiedad, assemblyId));
      if (attendance.changed) scheduleQuorumBroadcast(io, pool, actor.id_copropiedad, assemblyId);
      ack?.({ ok: true });
    }, ack));

    socket.on("presencia_ping", (payload: EventPayload) => run(socket, async () => {
      const actor = assertSocketEventToken(socket, payload?.token);
      await noteSocketPresence(pool, actor, eventAssemblyId(payload, actor));
    }));

    socket.on("disconnect", () => {
      // No se cambia estado_asistencia al desconectar: una caída temporal no borra la asistencia.
      // La vigencia del JWT se vuelve a comprobar al reconectar y en cada paquete de socket.
    });
  });
}
