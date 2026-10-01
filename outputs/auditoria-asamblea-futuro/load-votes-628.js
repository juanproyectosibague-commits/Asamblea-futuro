import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";

const usersFile = __ENV.LOADTEST_USERS_FILE;
const target = __ENV.TARGET_URL;
const assemblyId = __ENV.ASSEMBLY_ID;
const questionId = Number(__ENV.QUESTION_ID);
const optionId = Number(__ENV.OPTION_ID);

if (!usersFile || !target || !assemblyId || !Number.isInteger(questionId) || !Number.isInteger(optionId)) {
  throw new Error("Configura LOADTEST_USERS_FILE, TARGET_URL, ASSEMBLY_ID, QUESTION_ID y OPTION_ID.");
}

const users = new SharedArray("staging-residents", function () {
  const parsed = JSON.parse(open(usersFile));
  return parsed.residents;
});

export const options = {
  scenarios: {
    simultaneous_vote: {
      executor: "per-vu-iterations",
      vus: 628,
      iterations: 1,
      maxDuration: "2m"
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.005"],
    checks: ["rate>0.995"]
  }
};

function micros(value) {
  const pieces = String(value).split(".");
  const whole = pieces[0];
  const fraction = pieces[1] || "";
  if (!/^\d+$/.test(whole) || !/^\d{0,6}$/.test(fraction)) {
    throw new Error("Coeficiente de prueba inválido; se esperan hasta 6 decimales.");
  }
  return Number(whole) * 1000000 + Number((fraction + "000000").slice(0, 6));
}

function assertStaging() {
  if (__ENV.LOADTEST_CONFIRM_STAGING !== "I_CONFIRM_ISOLATED_STAGING") {
    throw new Error("Falta LOADTEST_CONFIRM_STAGING=I_CONFIRM_ISOLATED_STAGING.");
  }
  const url = new URL(target);
  if (["asamblea-futuro.onrender.com", "asamblea-ph.onrender.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("Bloqueado: el script no permite apuntar a producción.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Usa HTTPS para staging; HTTP solo se permite en localhost.");
  }
  if (users.length !== 628) throw new Error("El archivo de prueba debe contener 628 residentes.");
  const ids = new Set();
  let sum = 0;
  for (const user of users) {
    if (!user.token || !user.id_unidad || ids.has(user.id_unidad)) {
      throw new Error("Falta token/unidad o hay unidades repetidas en el archivo de prueba.");
    }
    ids.add(user.id_unidad);
    sum += micros(user.coeficiente);
  }
  if (sum !== 100000000) throw new Error("Los coeficientes de prueba no suman 100.000000.");
}

export function setup() {
  assertStaging();
  const headers = {
    Authorization: "Bearer " + users[0].token,
    "Content-Type": "application/json"
  };
  const activeUrl = target.replace(/\/$/, "") + "/api/asambleas/" + assemblyId + "/votacion/activa";
  const active = http.get(activeUrl, { headers, timeout: "15s" });
  if (active.status !== 200 || Number(active.json("id_pregunta")) !== questionId) {
    throw new Error("La pregunta configurada no es la pregunta activa de staging.");
  }
  const resultsUrl = target.replace(/\/$/, "") + "/api/asambleas/" + assemblyId +
    "/preguntas/" + questionId + "/resultados";
  const results = http.get(resultsUrl, { headers, timeout: "15s" });
  if (results.status !== 200) throw new Error("No se pudieron consultar los resultados iniciales.");
  const rows = results.json("resultados") || [];
  if (rows.some(function (row) { return Number(row.votos) !== 0; })) {
    throw new Error("La pregunta ya tiene votos. Usa una pregunta limpia de staging.");
  }
  return { startedAt: Date.now() };
}

export default function () {
  const user = users[__VU - 1];
  const url = target.replace(/\/$/, "") + "/api/asambleas/" + assemblyId + "/votos";
  const response = http.post(url, JSON.stringify({
    id_pregunta: questionId,
    id_opcion: optionId
  }), {
    headers: {
      Authorization: "Bearer " + user.token,
      "Content-Type": "application/json"
    },
    timeout: "30s",
    tags: { operation: "weighted_vote" }
  });
  check(response, {
    "vote committed (201)": function (res) {
      return res.status === 201 && res.json("ok") === true;
    }
  });
}

export function teardown() {
  const url = target.replace(/\/$/, "") + "/api/asambleas/" + assemblyId +
    "/preguntas/" + questionId + "/resultados";
  const response = http.get(url, {
    headers: { Authorization: "Bearer " + users[0].token },
    timeout: "15s"
  });
  if (response.status !== 200) throw new Error("No se pudo auditar el tally final en staging.");
  const rows = response.json("resultados") || [];
  let count = 0;
  let totalMicros = 0;
  for (const row of rows) {
    count += Number(row.votos || 0);
    totalMicros += micros(row.coeficiente_representado || "0");
  }
  if (count !== 628 || totalMicros !== 100000000) {
    throw new Error("Auditoria fallida: votos=" + count + ", coeficiente_micro=" + totalMicros);
  }
}
