import express, { type Request, type Response, type RequestHandler } from "express";
import type { Pool, PoolClient, QueryResult } from "pg";
import type { Server } from "socket.io";
import { authMiddleware, HttpError, requestPrincipal, requireRoles, type AuthClaims } from "./auth";

export type EstadoPregunta = "inactiva" | "activa" | "cerrada";
export interface OpcionDTO { id_opcion: number; texto: string; }
export interface PreguntaDTO { id_pregunta: number; enunciado: string; opciones: OpcionDTO[]; activa: boolean; estado: EstadoPregunta; }
export interface ResultadoDTO { id_opcion: number; texto: string; coeficiente_representado: string; votos: number; }
export interface QuorumDTO {
  coeficiente_presente: string;
  coeficiente_total: string;
  unidades_presentes: Array<{ id_unidad: string; unidad: string; coeficiente_representado: string; presente: boolean }>;
}
export interface VotoDTO { id_voto: string; id_pregunta: number; id_opcion: number; coeficiente_registrado: string; registrado_en: Date; }

export const assemblyRoom = (tenantId: string, assemblyId: string) => "copropiedad:" + tenantId + ":asamblea:" + assemblyId;

export function parseAssemblyId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "ID de asamblea inválido.", "INVALID_ASSEMBLY_ID");
  }
  return value;
}
function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) throw new HttpError(400, label + " inválido.", "INVALID_ID");
  return parsed;
}
export function parseQuestionId(value: unknown): number { return parsePositiveInteger(value, "ID de pregunta"); }
export function parseOptionId(value: unknown): number { return parsePositiveInteger(value, "ID de opción"); }

export async function withTenantTransaction<T>(pool: Pool, tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.id_copropiedad',$1,true)", [tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* keep the original failure */ }
    throw mapDatabaseError(error);
  } finally { client.release(); }
}

function mapDatabaseError(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  const pgError = error as { code?: string; constraint?: string };
  if (pgError.code === "23505" && pgError.constraint === "votos_una_unidad_por_pregunta") return new HttpError(409, "Esta unidad ya registró un voto para la pregunta.", "DUPLICATE_VOTE");
  if (pgError.code === "23505") return new HttpError(409, "El registro ya existe.", "DUPLICATE_RECORD");
  if (pgError.code === "23503") return new HttpError(409, "La referencia no existe o pertenece a otra copropiedad.", "INVALID_REFERENCE");
  if (pgError.code === "23514") return new HttpError(422, "Los datos no cumplen las reglas de integridad.", "CHECK_CONSTRAINT");
  return error;
}

export interface AssemblyRecord { estado: "programada" | "activa" | "cerrada"; }
export async function assertAssembly(client: PoolClient, assemblyId: string, tenantId: string, lock: boolean | "share" = false): Promise<AssemblyRecord> {
  const result = await client.query<AssemblyRecord>("SELECT estado FROM public.asambleas WHERE id=$1 AND id_copropiedad=$2" + (lock === true ? " FOR UPDATE" : lock === "share" ? " FOR SHARE" : ""), [assemblyId, tenantId]);
  if (!result.rowCount) throw new HttpError(404, "Asamblea no encontrada para esta copropiedad.", "ASSEMBLY_NOT_FOUND");
  return result.rows[0];
}
interface QuestionRow { id_pregunta: number; enunciado: string; estado: EstadoPregunta; opciones: OpcionDTO[] | null; }
async function getQuestion(client: PoolClient, assemblyId: string, tenantId: string, questionId: number): Promise<PreguntaDTO> {
  const result = await client.query<QuestionRow>(
    "SELECT q.id AS id_pregunta,q.enunciado,q.estado,COALESCE(json_agg(json_build_object('id_opcion',o.id,'texto',o.texto) ORDER BY o.orden) FILTER (WHERE o.id IS NOT NULL),'[]'::json) AS opciones " +
    "FROM public.preguntas q LEFT JOIN public.opciones o ON o.id_pregunta=q.id AND o.id_asamblea=q.id_asamblea AND o.id_copropiedad=q.id_copropiedad " +
    "WHERE q.id=$1 AND q.id_asamblea=$2 AND q.id_copropiedad=$3 GROUP BY q.id,q.enunciado,q.estado",
    [questionId, assemblyId, tenantId]
  );
  if (!result.rowCount) throw new HttpError(404, "Pregunta no encontrada en esta asamblea.", "QUESTION_NOT_FOUND");
  const row = result.rows[0];
  return { id_pregunta: Number(row.id_pregunta), enunciado: row.enunciado,
    opciones: (row.opciones ?? []).map(option => ({ id_opcion: Number(option.id_opcion), texto: option.texto })),
    activa: row.estado === "activa", estado: row.estado };
}

export async function loadActiveQuestion(client: PoolClient, assemblyId: string, tenantId: string): Promise<PreguntaDTO | null> {
  const result = await client.query<{ id: number }>("SELECT id FROM public.preguntas WHERE id_asamblea=$1 AND id_copropiedad=$2 AND estado='activa' LIMIT 1", [assemblyId, tenantId]);
  return result.rowCount ? getQuestion(client, assemblyId, tenantId, Number(result.rows[0].id)) : null;
}
async function listQuestions(client: PoolClient, assemblyId: string, tenantId: string): Promise<PreguntaDTO[]> {
  await assertAssembly(client, assemblyId, tenantId);
  const result = await client.query<{ id: number }>("SELECT id FROM public.preguntas WHERE id_asamblea=$1 AND id_copropiedad=$2 ORDER BY creada_en,id", [assemblyId, tenantId]);
  const questions: PreguntaDTO[] = [];
  for (const row of result.rows) questions.push(await getQuestion(client, assemblyId, tenantId, Number(row.id)));
  return questions;
}

export async function loadQuorum(client: PoolClient, assemblyId: string, tenantId: string): Promise<QuorumDTO> {
  await assertAssembly(client, assemblyId, tenantId);
  const result = await client.query<QuorumDTO>(
    "SELECT COALESCE(sum(u.coeficiente) FILTER (WHERE COALESCE(aa.estado_asistencia,FALSE)),0)::text AS coeficiente_presente,COALESCE(sum(u.coeficiente),0)::text AS coeficiente_total," +
    "COALESCE(json_agg(json_build_object('id_unidad',u.id,'unidad',u.numero_inmueble,'coeficiente_representado',u.coeficiente::text,'presente',COALESCE(aa.estado_asistencia,FALSE)) ORDER BY u.numero_inmueble),'[]'::json) AS unidades_presentes " +
    "FROM public.unidades u LEFT JOIN public.asistencia_asambleas aa ON aa.id_unidad=u.id AND aa.id_copropiedad=u.id_copropiedad AND aa.id_asamblea=$1 WHERE u.id_copropiedad=$2",
    [assemblyId, tenantId]
  );
  return result.rows[0];
}

async function loadResults(client: PoolClient, assemblyId: string, tenantId: string, questionId: number): Promise<ResultadoDTO[]> {
  const result = await client.query<ResultadoDTO>(
    "SELECT o.id AS id_opcion,o.texto,COALESCE(sum(v.coeficiente_registrado),0)::text AS coeficiente_representado,count(v.id)::int AS votos " +
    "FROM public.opciones o LEFT JOIN public.votos v ON v.id_opcion=o.id AND v.id_pregunta=o.id_pregunta AND v.id_asamblea=o.id_asamblea AND v.id_copropiedad=o.id_copropiedad " +
    "WHERE o.id_pregunta=$1 AND o.id_asamblea=$2 AND o.id_copropiedad=$3 GROUP BY o.id,o.texto,o.orden ORDER BY o.orden",
    [questionId, assemblyId, tenantId]
  );
  return result.rows.map(row => ({ ...row, id_opcion: Number(row.id_opcion), votos: Number(row.votos) }));
}

const pendingResultBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

// Many votes can commit together; compute and broadcast one snapshot per short window.
export function scheduleResultsBroadcast(pool: Pool, io: Server, tenantId: string, assemblyId: string, questionId: number): void {
  const key = tenantId + ":" + assemblyId + ":" + questionId;
  if (pendingResultBroadcasts.has(key)) return;
  const timer = setTimeout(() => {
    pendingResultBroadcasts.delete(key);
    void withTenantTransaction(pool, tenantId, client =>
      loadResults(client, assemblyId, tenantId, questionId)
    ).then(resultados => {
      io.to(assemblyRoom(tenantId, assemblyId)).emit("resultados_votacion", {
        id_pregunta: questionId,
        resultados
      });
    }).catch(error => {
      console.error("No se pudo difundir el tally de la pregunta:", error instanceof Error ? error.message : "error desconocido");
    });
  }, 250);
  timer.unref?.();
  pendingResultBroadcasts.set(key, timer);
}

async function assertQuestionExists(client: PoolClient, assemblyId: string, tenantId: string, questionId: number): Promise<void> {
  const result = await client.query("SELECT 1 FROM public.preguntas WHERE id=$1 AND id_asamblea=$2 AND id_copropiedad=$3", [questionId, assemblyId, tenantId]);
  if (!result.rowCount) throw new HttpError(404, "Pregunta no encontrada en esta asamblea.", "QUESTION_NOT_FOUND");
}
function requireAdministrator(actor: AuthClaims): void {
  if (actor.rol !== "administrador") throw new HttpError(403, "Solo administración puede realizar esta acción.", "FORBIDDEN");
}
function normalizeOptions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) throw new HttpError(400, "La pregunta requiere entre 2 y 10 opciones.", "INVALID_OPTIONS");
  const options = value.map(item => {
    const raw = typeof item === "string" ? item : item && typeof item === "object" && "texto" in item ? (item as { texto: unknown }).texto : null;
    if (typeof raw !== "string") throw new HttpError(400, "Cada opción debe tener un texto válido.", "INVALID_OPTIONS");
    const text = raw.trim();
    if (!text || text.length > 300) throw new HttpError(400, "Cada opción debe tener entre 1 y 300 caracteres.", "INVALID_OPTIONS");
    return text;
  });
  if (new Set(options.map(text => text.toLocaleLowerCase("es-CO"))).size !== options.length) throw new HttpError(400, "No se permiten opciones repetidas.", "DUPLICATE_OPTIONS");
  return options;
}
export async function createQuestion(pool: Pool, actor: AuthClaims, assemblyId: string, rawEnunciado: unknown, rawOptions: unknown): Promise<PreguntaDTO> {
  requireAdministrator(actor);
  const enunciado = typeof rawEnunciado === "string" ? rawEnunciado.trim() : "";
  if (!enunciado || enunciado.length > 1000) throw new HttpError(400, "El enunciado debe tener entre 1 y 1000 caracteres.", "INVALID_QUESTION");
  const options = normalizeOptions(rawOptions);
  return withTenantTransaction(pool, actor.id_copropiedad, async client => {
    const assembly = await assertAssembly(client, assemblyId, actor.id_copropiedad, true);
    if (assembly.estado === "cerrada") throw new HttpError(409, "No se pueden crear preguntas en una asamblea cerrada.", "ASSEMBLY_CLOSED");
    const inserted = await client.query<{ id: number }>("INSERT INTO public.preguntas(id_asamblea,id_copropiedad,enunciado,estado) VALUES($1,$2,$3,'inactiva') RETURNING id", [assemblyId, actor.id_copropiedad, enunciado]);
    const questionId = Number(inserted.rows[0].id);
    for (let index = 0; index < options.length; index += 1) {
      await client.query("INSERT INTO public.opciones(id_pregunta,id_asamblea,id_copropiedad,texto,orden) VALUES($1,$2,$3,$4,$5)", [questionId, assemblyId, actor.id_copropiedad, options[index], index + 1]);
    }
    return getQuestion(client, assemblyId, actor.id_copropiedad, questionId);
  });
}

export async function changeQuestionState(pool: Pool, actor: AuthClaims, assemblyId: string, questionId: number, action: "abrir" | "cerrar"): Promise<PreguntaDTO> {
  requireAdministrator(actor);
  return withTenantTransaction(pool, actor.id_copropiedad, async client => {
    const assembly = await assertAssembly(client, assemblyId, actor.id_copropiedad, true);
    if (action === "abrir") {
      if (assembly.estado !== "activa") throw new HttpError(409, "La asamblea debe estar activa para abrir una votación.", "ASSEMBLY_NOT_ACTIVE");
      const target = await client.query<{ estado: EstadoPregunta }>("SELECT estado FROM public.preguntas WHERE id=$1 AND id_asamblea=$2 AND id_copropiedad=$3 FOR UPDATE", [questionId, assemblyId, actor.id_copropiedad]);
      if (!target.rowCount) throw new HttpError(404, "Pregunta no encontrada en esta asamblea.", "QUESTION_NOT_FOUND");
      if (target.rows[0].estado === "cerrada") throw new HttpError(409, "Una pregunta cerrada no se puede reabrir.", "QUESTION_CLOSED");
      await client.query("UPDATE public.preguntas SET estado='cerrada' WHERE id_asamblea=$1 AND id_copropiedad=$2 AND estado='activa' AND id<>$3", [assemblyId, actor.id_copropiedad, questionId]);
      await client.query("UPDATE public.preguntas SET estado='activa' WHERE id=$1 AND id_asamblea=$2 AND id_copropiedad=$3", [questionId, assemblyId, actor.id_copropiedad]);
    } else {
      const changed = await client.query("UPDATE public.preguntas SET estado='cerrada' WHERE id=$1 AND id_asamblea=$2 AND id_copropiedad=$3 AND estado='activa'", [questionId, assemblyId, actor.id_copropiedad]);
      if (!changed.rowCount) {
        await assertQuestionExists(client, assemblyId, actor.id_copropiedad, questionId);
        throw new HttpError(409, "La pregunta no está activa.", "QUESTION_NOT_ACTIVE");
      }
    }
    return getQuestion(client, assemblyId, actor.id_copropiedad, questionId);
  });
}

export async function castVote(pool: Pool, actor: AuthClaims, assemblyId: string, questionId: number, optionId: number): Promise<VotoDTO> {
  if (actor.rol !== "residente" || !actor.id_unidad) throw new HttpError(403, "Solo una unidad residente puede votar.", "FORBIDDEN");
  return withTenantTransaction(pool, actor.id_copropiedad, async client => {
    const assembly = await assertAssembly(client, assemblyId, actor.id_copropiedad, "share");
    if (assembly.estado !== "activa") throw new HttpError(409, "La asamblea no está activa.", "ASSEMBLY_NOT_ACTIVE");
    const question = await client.query<{ estado: EstadoPregunta }>("SELECT estado FROM public.preguntas WHERE id=$1 AND id_asamblea=$2 AND id_copropiedad=$3 FOR SHARE", [questionId, assemblyId, actor.id_copropiedad]);
    if (!question.rowCount) throw new HttpError(404, "Pregunta no encontrada en esta asamblea.", "QUESTION_NOT_FOUND");
    if (question.rows[0].estado !== "activa") throw new HttpError(409, "La votación ya no está activa.", "VOTING_CLOSED");
    const option = await client.query("SELECT 1 FROM public.opciones WHERE id=$1 AND id_pregunta=$2 AND id_asamblea=$3 AND id_copropiedad=$4", [optionId, questionId, assemblyId, actor.id_copropiedad]);
    if (!option.rowCount) throw new HttpError(400, "La opción no pertenece a esta pregunta.", "INVALID_OPTION");
    const unit = await client.query<{ coeficiente: string }>(
      "SELECT u.coeficiente::text AS coeficiente FROM public.unidades u JOIN public.asistencia_asambleas aa ON aa.id_unidad=u.id AND aa.id_copropiedad=u.id_copropiedad " +
      "WHERE u.id=$1 AND u.id_copropiedad=$2 AND aa.id_asamblea=$3 AND aa.estado_asistencia=TRUE FOR SHARE OF u,aa",
      [actor.id_unidad, actor.id_copropiedad, assemblyId]
    );
    if (!unit.rowCount) throw new HttpError(403, "La unidad no está registrada como asistente a esta asamblea.", "UNIT_NOT_PRESENT");

    let inserted: QueryResult<{ id: string; coeficiente_registrado: string; registrado_en: Date }>;
    try {
      inserted = await client.query("INSERT INTO public.votos(id_pregunta,id_asamblea,id_copropiedad,id_unidad,id_opcion,coeficiente_registrado) VALUES($1,$2,$3,$4,$5,$6::numeric) RETURNING id,coeficiente_registrado::text AS coeficiente_registrado,registrado_en", [questionId, assemblyId, actor.id_copropiedad, actor.id_unidad, optionId, unit.rows[0].coeficiente]);
    } catch (error) { throw mapDatabaseError(error); }
    const vote = inserted.rows[0];
    return { id_voto: vote.id, id_pregunta: questionId, id_opcion: optionId, coeficiente_registrado: vote.coeficiente_registrado, registrado_en: vote.registrado_en };
  });
}
function endpoint(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}
function pathAssemblyId(req: Request): string {
  const id = parseAssemblyId(req.params.id);
  if (requestPrincipal(req).id_asamblea !== id) {
    throw new HttpError(403, "El token no tiene acceso a esta asamblea.", "ASSEMBLY_FORBIDDEN");
  }
  return id;
}
function pathQuestionId(req: Request): number { return parseQuestionId(req.params.preguntaId); }

export function createVotingRouter(pool: Pool, io: Server): express.Router {
  const router = express.Router();
  router.use(authMiddleware);

  router.get("/:id/preguntas", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const preguntas = await withTenantTransaction(pool, actor.id_copropiedad, client => listQuestions(client, assemblyId, actor.id_copropiedad));
    res.json({ preguntas });
  }));
  router.get("/:id/unidad-actual", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    if (actor.rol !== "residente" || !actor.id_unidad) throw new HttpError(403, "Solo un residente puede consultar su unidad.", "FORBIDDEN");
    const unidad = await withTenantTransaction(pool, actor.id_copropiedad, async client => {
      await assertAssembly(client, assemblyId, actor.id_copropiedad);
      const result = await client.query<{ id_unidad: string; unidad: string; coeficiente: string; presente: boolean }>(
        "SELECT u.id AS id_unidad,u.numero_inmueble AS unidad,u.coeficiente::text AS coeficiente,COALESCE(aa.estado_asistencia,FALSE) AS presente " +
        "FROM public.unidades u LEFT JOIN public.asistencia_asambleas aa ON aa.id_unidad=u.id AND aa.id_copropiedad=u.id_copropiedad AND aa.id_asamblea=$3 " +
        "WHERE u.id=$1 AND u.id_copropiedad=$2",
        [actor.id_unidad, actor.id_copropiedad, assemblyId]
      );
      if (!result.rowCount) throw new HttpError(403, "La unidad del token no pertenece a esta copropiedad.", "UNIT_NOT_FOUND");
      return result.rows[0];
    });
    res.json(unidad);
  }));
  router.get("/:id/quorum", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const quorum = await withTenantTransaction(pool, actor.id_copropiedad, client => loadQuorum(client, assemblyId, actor.id_copropiedad));
    res.json(quorum);
  }));
  router.get("/:id/votacion/activa", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const active = await withTenantTransaction(pool, actor.id_copropiedad, async client => {
      await assertAssembly(client, assemblyId, actor.id_copropiedad);
      return loadActiveQuestion(client, assemblyId, actor.id_copropiedad);
    });
    if (!active) { res.status(204).end(); return; }
    res.json(active);
  }));
  router.get("/:id/preguntas/:preguntaId/resultados", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req), questionId = pathQuestionId(req);
    const resultados = await withTenantTransaction(pool, actor.id_copropiedad, async client => {
      await assertAssembly(client, assemblyId, actor.id_copropiedad);
      await assertQuestionExists(client, assemblyId, actor.id_copropiedad, questionId);
      return loadResults(client, assemblyId, actor.id_copropiedad, questionId);
    });
    res.json({ id_pregunta: questionId, resultados });
  }));
  router.post("/:id/votos", endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const questionId = parseQuestionId(req.body?.id_pregunta), optionId = parseOptionId(req.body?.id_opcion);
    const voto = await castVote(pool, actor, assemblyId, questionId, optionId);
    // Preserve the REST response contract; this read occurs after the vote transaction commits.
    const resultados = await withTenantTransaction(pool, actor.id_copropiedad, client =>
      loadResults(client, assemblyId, actor.id_copropiedad, voto.id_pregunta)
    );
    scheduleResultsBroadcast(pool, io, actor.id_copropiedad, assemblyId, voto.id_pregunta);
    res.status(201).json({ ok: true, voto: {
      id_voto: voto.id_voto, id_pregunta: voto.id_pregunta, id_opcion: voto.id_opcion,
      coeficiente_registrado: voto.coeficiente_registrado, registrado_en: voto.registrado_en
    }, resultados });
  }));
  router.post("/:id/preguntas", requireRoles("administrador"), endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const pregunta = await createQuestion(pool, actor, assemblyId, req.body?.enunciado, req.body?.opciones);
    io.to(assemblyRoom(actor.id_copropiedad, assemblyId)).emit("pregunta_creada", { pregunta });
    res.status(201).json({ pregunta });
  }));
  router.patch("/:id/preguntas/:preguntaId/abrir", requireRoles("administrador"), endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const pregunta = await changeQuestionState(pool, actor, assemblyId, pathQuestionId(req), "abrir");
    io.to(assemblyRoom(actor.id_copropiedad, assemblyId)).emit("estado_votacion", pregunta);
    res.json({ pregunta });
  }));
  router.patch("/:id/preguntas/:preguntaId/cerrar", requireRoles("administrador"), endpoint(async (req, res) => {
    const actor = requestPrincipal(req), assemblyId = pathAssemblyId(req);
    const pregunta = await changeQuestionState(pool, actor, assemblyId, pathQuestionId(req), "cerrar");
    io.to(assemblyRoom(actor.id_copropiedad, assemblyId)).emit("estado_votacion", pregunta);
    res.json({ pregunta });
  }));
  return router;
}
