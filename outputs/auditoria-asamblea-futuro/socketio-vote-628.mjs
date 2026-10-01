import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Falta la variable " + name + ".");
  return value;
}

function micros(value) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) throw new Error("Coeficiente inválido; se esperan hasta 6 decimales.");
  return Number(match[1]) * 1000000 + Number(((match[2] || "") + "000000").slice(0, 6));
}

function claimsOf(token) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Un registro no contiene un JWT válido.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function jsonRequest(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " en la consulta de auditoría de staging.");
  return response.status === 204 ? null : response.json();
}

async function readResults(base, assemblyId, questionId, token) {
  return jsonRequest(
    base + "/api/asambleas/" + assemblyId + "/preguntas/" + questionId + "/resultados",
    token
  );
}

async function main() {
  if (process.env.LOADTEST_CONFIRM_STAGING !== "I_CONFIRM_ISOLATED_STAGING") {
    throw new Error("Falta LOADTEST_CONFIRM_STAGING=I_CONFIRM_ISOLATED_STAGING.");
  }
  const target = new URL(required("TARGET_URL"));
  if (["asamblea-futuro.onrender.com", "asamblea-ph.onrender.com"].includes(target.hostname.toLowerCase())) {
    throw new Error("Bloqueado: este script no permite apuntar a producción.");
  }
  if (target.protocol !== "https:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    throw new Error("Usa HTTPS en staging; HTTP solo se permite en localhost.");
  }
  if (target.pathname !== "/" && target.pathname !== "") {
    throw new Error("Configura TARGET_URL como el origen del servicio, sin subruta.");
  }

  const projectRoot = required("LOADTEST_PROJECT_ROOT");
  const requireFromProject = createRequire(resolve(projectRoot, "package.json"));
  const { io } = requireFromProject("socket.io-client");
  const dataset = JSON.parse(await readFile(required("LOADTEST_USERS_FILE"), "utf8"));
  const residents = dataset.residents;
  const assemblyId = required("ASSEMBLY_ID");
  const questionId = Number(required("QUESTION_ID"));
  const optionId = Number(required("OPTION_ID"));
  const base = target.origin;

  if (!Array.isArray(residents) || residents.length !== 628 || !dataset.adminToken) {
    throw new Error("El archivo de staging debe incluir 628 residentes y adminToken.");
  }
  if (!Number.isSafeInteger(questionId) || questionId < 1 ||
      !Number.isSafeInteger(optionId) || optionId < 1) {
    throw new Error("QUESTION_ID y OPTION_ID deben ser enteros positivos.");
  }

  const seen = new Set();
  let expectedMicros = 0;
  for (const resident of residents) {
    if (!resident.token || !resident.id_unidad || seen.has(resident.id_unidad)) {
      throw new Error("Falta token/unidad o hay unidades repetidas en el dataset de staging.");
    }
    seen.add(resident.id_unidad);
    expectedMicros += micros(resident.coeficiente);
    const claims = claimsOf(resident.token);
    if (claims.rol !== "residente" || claims.id_unidad !== resident.id_unidad ||
        claims.id_asamblea !== assemblyId || !claims.exp || claims.exp * 1000 <= Date.now()) {
      throw new Error("Un JWT no coincide con la unidad/asamblea de staging o está vencido.");
    }
  }
  const adminClaims = claimsOf(dataset.adminToken);
  if (adminClaims.rol !== "administrador" || adminClaims.id_asamblea !== assemblyId ||
      !adminClaims.exp || adminClaims.exp * 1000 <= Date.now()) {
    throw new Error("El JWT de administración de prueba no corresponde a staging o está vencido.");
  }
  if (expectedMicros !== 100000000) {
    throw new Error("Los 628 coeficientes de staging deben sumar exactamente 100.000000.");
  }

  const active = await jsonRequest(
    base + "/api/asambleas/" + assemblyId + "/votacion/activa",
    residents[0].token
  );
  if (!active || Number(active.id_pregunta) !== questionId ||
      !active.opciones?.some(option => Number(option.id_opcion) === optionId)) {
    throw new Error("QUESTION_ID/OPTION_ID no coinciden con la votación activa de staging.");
  }
  const before = await readResults(base, assemblyId, questionId, residents[0].token);
  const beforeRows = before?.resultados || [];
  if (beforeRows.some(row => Number(row.votos) !== 0)) {
    throw new Error("La pregunta ya tiene votos; usa una pregunta limpia en staging.");
  }

  const sockets = [];
  const connectTimes = [];
  const voteTimes = [];
  const ackCoefficients = [];
  let voteFailures = 0;
  let finalCount = 0;
  let finalMicros = 0;

  try {
    const connectPromises = residents.map(resident => {
      const socket = io(base, {
        autoConnect: false,
        reconnection: false,
        timeout: 15000,
        auth: { token: resident.token }
      });
      sockets.push(socket);
      const start = Date.now();
      return new Promise((resolveConnect, rejectConnect) => {
        const timer = setTimeout(() => rejectConnect(new Error("Timeout de conexión Socket.IO.")), 20000);
        socket.once("connect", () => {
          clearTimeout(timer);
          connectTimes.push(Date.now() - start);
          resolveConnect();
        });
        socket.once("connect_error", () => {
          clearTimeout(timer);
          rejectConnect(new Error("Falló una conexión autenticada Socket.IO."));
        });
        socket.connect();
      });
    });
    await Promise.all(connectPromises);

    // joinTenantAssemblies registra asistencia al conectar. Esperar quórum completo
    // evita que el primer voto compita con la escritura de presencia.
    const quorumDeadline = Date.now() + 90000;
    let quorumReady = false;
    while (Date.now() < quorumDeadline) {
      const quorum = await jsonRequest(
        base + "/api/asambleas/" + assemblyId + "/quorum",
        dataset.adminToken
      );
      if (quorum && micros(quorum.coeficiente_presente) === 100000000) {
        quorumReady = true;
        break;
      }
      await sleep(1000);
    }
    if (!quorumReady) throw new Error("Staging no alcanzó quórum completo tras conectar los residentes.");

    const votePromises = residents.map((resident, index) => new Promise(resolveVote => {
      const socket = sockets[index];
      const start = Date.now();
      const payload = {
        asamblea_id: assemblyId,
        id_pregunta: questionId,
        id_opcion: optionId,
        token: resident.token
      };
      socket.timeout(30000).emit("emitir_voto", payload, (timeoutError, ack) => {
        const elapsed = Date.now() - start;
        voteTimes.push(elapsed);
        if (timeoutError || !ack?.ok || !ack?.voto?.coeficiente_registrado) {
          voteFailures += 1;
          resolveVote();
          return;
        }
        ackCoefficients.push(micros(ack.voto.coeficiente_registrado));
        resolveVote();
      });
    }));
    await Promise.all(votePromises);

    const resultsDeadline = Date.now() + 90000;
    while (Date.now() < resultsDeadline) {
      const result = await readResults(base, assemblyId, questionId, residents[0].token);
      const rows = result?.resultados || [];
      finalCount = rows.reduce((sum, row) => sum + Number(row.votos || 0), 0);
      finalMicros = rows.reduce((sum, row) => sum + micros(row.coeficiente_representado || "0"), 0);
      if (finalCount === 628) break;
      await sleep(1000);
    }

    const ackMicros = ackCoefficients.reduce((sum, value) => sum + value, 0);
    const passed = voteFailures === 0 && ackCoefficients.length === 628 &&
      ackMicros === 100000000 && finalCount === 628 && finalMicros === 100000000;
    console.log(JSON.stringify({
      environment: "staging",
      connections: sockets.length,
      connected: connectTimes.length,
      connection_ms_p95: percentile(connectTimes, 0.95),
      vote_acks_ok: ackCoefficients.length,
      vote_ack_failures: voteFailures,
      vote_ack_ms_p95: percentile(voteTimes, 0.95),
      vote_ack_ms_p99: percentile(voteTimes, 0.99),
      ack_coefficient_total: (ackMicros / 1000000).toFixed(6),
      final_vote_count: finalCount,
      final_coefficient_total: (finalMicros / 1000000).toFixed(6),
      generator_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      passed
    }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
