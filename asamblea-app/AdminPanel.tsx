import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Socket } from "socket.io-client";
import type {
  PreguntaVotacion,
  ResumenQuorum,
  ResultadoOpcion,
  UnidadPresente
} from "./App";

interface AdminPanelProps {
  socket: Socket;
  token: string;
  asambleaId: string;
  apiBaseUrl: string;
  preguntaActiva: PreguntaVotacion | null;
  onPreguntaActiva: (pregunta: PreguntaVotacion | null) => void;
}

interface AckPregunta {
  ok: boolean;
  pregunta?: PreguntaVotacion;
  error?: string;
}

function asPreguntas(data: unknown): PreguntaVotacion[] {
  if (Array.isArray(data)) return data as PreguntaVotacion[];
  if (data && typeof data === "object" && Array.isArray((data as { preguntas?: unknown }).preguntas)) {
    return (data as { preguntas: PreguntaVotacion[] }).preguntas;
  }
  return [];
}

function asResultados(data: unknown): ResultadoOpcion[] {
  if (Array.isArray(data)) return data as ResultadoOpcion[];
  if (data && typeof data === "object" && Array.isArray((data as { resultados?: unknown }).resultados)) {
    return (data as { resultados: ResultadoOpcion[] }).resultados;
  }
  return [];
}

function asQuorum(data: unknown): ResumenQuorum {
  const value = (data && typeof data === "object" ? data : {}) as Partial<ResumenQuorum>;
  const unidades = Array.isArray(value.unidades_presentes) ? value.unidades_presentes : [];
  const sumatoria = unidades.filter((u: UnidadPresente) => u.presente)
    .reduce((sum: bigint, u: UnidadPresente) => sum + coefficientMicros(u.coeficiente_representado || 0), 0n);
  return {
    estado_asamblea: value.estado_asamblea,
    coeficiente_presente: String(value.coeficiente_presente ?? formatMicros(sumatoria)),
    coeficiente_total: String(value.coeficiente_total ?? "100.000000"),
    unidades_presentes: unidades
  };
}

function coefficientMicros(value: string | number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) return 0n;
  const amount = BigInt(match[2]) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0").slice(0, 6));
  return match[1] === "-" ? -amount : amount;
}

function formatMicros(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return (negative ? "-" : "") + (absolute / 1_000_000n).toString() + "." + (absolute % 1_000_000n).toString().padStart(6, "0");
}

function readQuestionState(payload: unknown): PreguntaVotacion | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { pregunta?: unknown; estado?: string };
  const raw = (envelope.pregunta ?? payload) as Partial<PreguntaVotacion> | null;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id_pregunta !== "number" || typeof raw.enunciado !== "string" || !Array.isArray(raw.opciones)) return null;
  const state = raw.estado ?? envelope.estado ?? (raw.activa ? "activa" : "inactiva");
  if (state !== "inactiva" && state !== "activa" && state !== "cerrada") return null;
  return { id_pregunta: raw.id_pregunta, enunciado: raw.enunciado, opciones: raw.opciones, activa: state === "activa", estado: state };
}

const percent = (value: string | number) => formatMicros(coefficientMicros(value)) + "%";

export default function AdminPanel({
  socket,
  token,
  asambleaId,
  apiBaseUrl,
  preguntaActiva,
  onPreguntaActiva
}: AdminPanelProps) {
  const [preguntas, setPreguntas] = useState<PreguntaVotacion[]>([]);
  const [preguntaSeleccionada, setPreguntaSeleccionada] = useState<number | null>(null);
  const [quorum, setQuorum] = useState<ResumenQuorum | null>(null);
  const [resultados, setResultados] = useState<ResultadoOpcion[]>([]);
  const [enunciado, setEnunciado] = useState("");
  const [opciones, setOpciones] = useState([
    { key: 1, texto: "A favor" },
    { key: 2, texto: "En contra" },
    { key: 3, texto: "Voto en blanco" }
  ]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [avisoApi, setAvisoApi] = useState("");
  const [descargandoActa, setDescargandoActa] = useState(false);
  const [estadoExportacion, setEstadoExportacion] = useState("");
  const base = apiBaseUrl.replace(/\/$/, "");
  const selected = preguntas.find(q => q.id_pregunta === preguntaSeleccionada) ?? null;
  const activa = preguntaActiva ?? preguntas.find(q => q.activa) ?? null;
  const quorumTotal = Math.max(0, Number(quorum?.coeficiente_total ?? "100"));
  const quorumPresente = Math.max(0, Number(quorum?.coeficiente_presente ?? "0"));
  const quorumWidth = quorumTotal > 0 ? Math.min(100, quorumPresente / quorumTotal * 100) : 0;
  const coeficienteVotadoMicros = useMemo(
    () => resultados.reduce((sum, item) => sum + coefficientMicros(item.coeficiente_representado || 0), 0n),
    [resultados]
  );
  const coeficienteVotado = Number(formatMicros(coeficienteVotadoMicros));

  useEffect(() => {
    const controller = new AbortController();
    const headers = { Authorization: "Bearer " + token };
    const root = base + "/api/asambleas/" + encodeURIComponent(asambleaId);

    async function cargarPreguntas() {
      try {
        const response = await fetch(root + "/preguntas", { headers, signal: controller.signal });
        if (!response.ok) throw new Error("No fue posible cargar las preguntas.");
        const list = asPreguntas(await response.json());
        setPreguntas(list);
        const current = list.find(q => q.activa) ?? list[0] ?? null;
        setPreguntaSeleccionada(current?.id_pregunta ?? null);
        if (current?.activa) onPreguntaActiva(current);
        setAvisoApi("");
      } catch {
        if (!controller.signal.aborted) setAvisoApi("No se pudo consultar la API de preguntas. Verifica la conexión con el servidor.");
      }
    }

    async function cargarQuorum() {
      try {
        const response = await fetch(root + "/quorum", { headers, signal: controller.signal });
        if (!response.ok) throw new Error("No fue posible cargar el quórum.");
        setQuorum(asQuorum(await response.json()));
      } catch {
        if (!controller.signal.aborted) setAvisoApi("No se pudo consultar la API de asamblea. El quórum aparecerá al restablecer la conexión.");
      }
    }

    const handleState = (payload: unknown) => {
      setAvisoApi("");
      const next = readQuestionState(payload);
      if (!next) return;
      onPreguntaActiva(next.activa ? next : null);
      setPreguntas(previous => [next, ...previous.filter(q => q.id_pregunta !== next.id_pregunta).map(q =>
        q.activa ? { ...q, activa: false, estado: "cerrada" as const } : q)]);
      setPreguntaSeleccionada(next.id_pregunta);
    };
    const handleQuorum = (payload: unknown) => setQuorum(asQuorum(payload));
    const handleSocketError = (payload: unknown) => {
      if (payload && typeof payload === "object" && "mensaje" in payload) {
        setAvisoApi(String((payload as { mensaje: unknown }).mensaje));
      }
    };

    void cargarPreguntas();
    void cargarQuorum();
    socket.on("estado_votacion", handleState);
    socket.on("quorum_actualizado", handleQuorum);
    socket.on("pregunta_creada", cargarPreguntas);
    socket.on("preguntas_actualizadas", cargarPreguntas);
    socket.on("error_votacion", handleSocketError);

    return () => {
      controller.abort();
      socket.off("estado_votacion", handleState);
      socket.off("quorum_actualizado", handleQuorum);
      socket.off("pregunta_creada", cargarPreguntas);
      socket.off("preguntas_actualizadas", cargarPreguntas);
      socket.off("error_votacion", handleSocketError);
    };
  }, [socket, token, asambleaId, base, onPreguntaActiva]);

  useEffect(() => {
    if (!preguntaActiva) return;
    setPreguntas(previous => {
      const others = previous.filter(q => q.id_pregunta !== preguntaActiva.id_pregunta)
        .map(q => ({ ...q, activa: false }));
      return [{ ...preguntaActiva }, ...others];
    });
    setPreguntaSeleccionada(preguntaActiva.id_pregunta);
  }, [preguntaActiva?.id_pregunta, preguntaActiva?.activa]);

  useEffect(() => {
    if (!preguntaSeleccionada) {
      setResultados([]);
      return;
    }
    const controller = new AbortController();
    const url = base + "/api/asambleas/" + encodeURIComponent(asambleaId) +
      "/preguntas/" + preguntaSeleccionada + "/resultados";
    fetch(url, { headers: { Authorization: "Bearer " + token }, signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("No fue posible cargar los resultados.");
        return response.json();
      })
      .then(data => setResultados(asResultados(data)))
      .catch(() => { if (!controller.signal.aborted) setResultados([]); });

    const handleResults = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const data = payload as { id_pregunta?: number; resultados?: unknown };
      if (data.id_pregunta === preguntaSeleccionada) setResultados(asResultados(data.resultados));
    };
    socket.on("resultados_votacion", handleResults);
    return () => {
      controller.abort();
      socket.off("resultados_votacion", handleResults);
    };
  }, [socket, token, asambleaId, base, preguntaSeleccionada]);

  function cambiarOpcion(key: number, texto: string) {    setOpciones(previous => previous.map(option => option.key === key ? { ...option, texto } : option));
  }

  function agregarOpcion() {
    if (opciones.length >= 10) return;
    setOpciones(previous => [...previous, { key: Date.now(), texto: "" }]);
  }

  function quitarOpcion(key: number) {
    setOpciones(previous => previous.length <= 2 ? previous : previous.filter(option => option.key !== key));
  }

  async function crearPregunta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const cleanText = enunciado.trim();
    const texts = opciones.map(option => option.texto.trim()).filter(Boolean);
    if (!cleanText) return setError("Escribe el enunciado de la decisión.");
    if (texts.length < 2) return setError("Incluye al menos dos opciones de respuesta.");
    if (new Set(texts.map(text => text.toLocaleLowerCase())).size !== texts.length) {
      return setError("Cada opción debe tener un texto distinto.");
    }
    if (!socket.connected) return setError("Conecta con el servidor para crear la pregunta.");

    setGuardando(true);
    const payload = {
      asamblea_id: asambleaId,
      enunciado: cleanText,
      opciones: texts.map(texto => ({ texto })),
      token
    };
    const ack = await new Promise<AckPregunta | null>(resolve => {
      const timer = window.setTimeout(() => resolve(null), 8000);
      socket.emit("crear_pregunta", payload, (response: AckPregunta) => {
        window.clearTimeout(timer);
        resolve(response ?? null);
      });
    });
    setGuardando(false);

    if (!ack?.ok || !ack.pregunta) {
      setError(ack?.error || "El servidor no confirmó la creación. Revisa la conexión e inténtalo de nuevo.");
      return;
    }

    setPreguntas(previous => [ack.pregunta!, ...previous.filter(q => q.id_pregunta !== ack.pregunta!.id_pregunta)]);
    setPreguntaSeleccionada(ack.pregunta.id_pregunta);
    setEnunciado("");
    setOpciones([{ key: Date.now(), texto: "A favor" }, { key: Date.now() + 1, texto: "En contra" }, { key: Date.now() + 2, texto: "Voto en blanco" }]);
    setError("");
  }

  function abrirVotacion() {
    if (!selected || !socket.connected) return;
    socket.emit("abrir_votacion", { asamblea_id: asambleaId, id_pregunta: selected.id_pregunta, token });
  }

  function cerrarVotacion() {
    if (!activa || !socket.connected) return;
    socket.emit("cerrar_votacion", { asamblea_id: asambleaId, id_pregunta: activa.id_pregunta, token });
  }

  async function descargarActa() {
    if (!selected || selected.estado !== "cerrada" || descargandoActa) return;
    setDescargandoActa(true);
    setEstadoExportacion("");
    try {
      const url = base + "/api/asambleas/" + encodeURIComponent(asambleaId) + "/preguntas/" + selected.id_pregunta + "/acta.csv";
      const response = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "No fue posible exportar el acta.");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "acta-votacion-" + selected.id_pregunta + ".csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      const digest = response.headers.get("X-Acta-SHA256");
      const missingIdentity = Number(response.headers.get("X-Acta-Identity-Missing-Votes") || 0);
      setEstadoExportacion((digest ? "CSV descargado. Huella SHA-256: " + digest : "CSV descargado.") +
        (missingIdentity ? " Atención: faltan nombre y/o documento verificado en " + missingIdentity + " voto(s); no uses el archivo como acta identificada hasta completar el padrón." : ""));
    } catch (downloadError) {
      setEstadoExportacion(downloadError instanceof Error ? downloadError.message : "No fue posible exportar el acta.");
    } finally {
      setDescargandoActa(false);
    }
  }

  const totalVotos = resultados.reduce((sum, item) => sum + Number(item.votos || 0), 0);
  const attendance = quorum?.unidades_presentes ?? [];

  return (
    <div className="grid">
      <div className="col">
        <section className="card admin-hero">
          <div className="kicker">Consola de administración</div>
          <h2>Control de votaciones</h2>
          <p>Elige una decisión de la agenda, revisa el quórum por coeficientes y administra su estado.</p>
          <span className={"pill " + (activa ? "active-pill" : "off-pill")}>
            {activa ? "Votación activa" : "Sin votación activa"}
          </span>
          <div className="controls">
            <button type="button" className="btn primary" disabled={!selected || selected.activa || selected.estado === "cerrada" || !socket.connected} onClick={abrirVotacion}>
              Abrir votación
            </button>
            <button type="button" className="btn danger" disabled={!activa || !socket.connected} onClick={cerrarVotacion}>
              Cerrar votación
            </button>
          </div>
        </section>

        <section className="card pad">
          <div className="head"><div><div className="kicker">Agenda</div><h2>Preguntas y decisiones</h2><p>Selecciona una para administrarla. Solo puede haber una activa a la vez.</p></div></div>
          <div className="queue">
            {preguntas.length === 0 ? <div className="blank">No hay preguntas en la agenda. Crea una decisión para comenzar.</div> :
              preguntas.map(question => (
                <div className={"qrow " + (question.id_pregunta === preguntaSeleccionada ? "selected" : "")} key={question.id_pregunta}>
                  <button type="button" className="qselect" onClick={() => setPreguntaSeleccionada(question.id_pregunta)}>
                    {question.enunciado}<small>Pregunta #{question.id_pregunta} · {question.opciones.length} opciones</small>
                  </button>
                  <div className="qtools"><span className="qstatus">{question.estado === "cerrada" ? "Cerrada" : question.activa ? "Abierta" : "Inactiva"}</span>
                    <button type="button" className="qaction" onClick={() => setPreguntaSeleccionada(question.id_pregunta)}>Gestionar</button>
                  </div>
                </div>
              ))
            }
          </div>
          {avisoApi && <div className="notice" style={{ marginTop: 12 }} role="status">{avisoApi}</div>}
        </section>

        <section className="card pad">
          <div className="head">
            <div><div className="kicker">Resultados parciales</div><h2>{selected?.enunciado ?? "Resultados por opción"}</h2><p>La barra y el porcentaje suman los coeficientes representados en cada opción.</p></div>
            {selected && <span className={"pill " + (selected.activa ? "active-pill" : "off-pill")}>{selected.activa ? "En curso" : "Inactiva"}</span>}
          </div>
          <div className="results">
            {!selected ? <div className="blank">Selecciona una pregunta para ver sus resultados.</div> :
              selected.opciones.map(option => {
                const result = resultados.find(item => item.id_opcion === option.id_opcion);
                const coefficientExact = result?.coeficiente_representado || "0.000000";
                const coefficient = Number(coefficientExact);
                return <div className="result" key={option.id_opcion}>
                  <span className="result-label">{option.texto}</span>
                  <div className="track"><div className="result-fill" style={{ width: Math.min(100, Math.max(0, coefficient)) + "%" }} /></div>
                  <span className="result-value">{percent(coefficientExact)}</span>
                </div>;
              })
            }
          </div>
          <div className="meterrow" style={{ marginTop: 15 }}><strong>Coeficiente que ya votó</strong><span>{percent(coeficienteVotado)} del total</span></div>
          <div className="meter"><div className="fill" style={{ width: Math.min(100, Math.max(0, coeficienteVotado)) + "%" }} /></div>
          <div className="caption">{totalVotos} votos registrados · ponderación por coeficiente</div>
          {selected?.estado === "cerrada" && <div className="form-actions">
            <button type="button" className="btn primary" disabled={descargandoActa} onClick={() => void descargarActa()}>
              {descargandoActa ? "Preparando acta…" : "Descargar acta CSV"}
            </button>
          </div>}
          {estadoExportacion && <div className="notice" role="status" style={{ overflowWrap: "anywhere" }}>{estadoExportacion}</div>}
        </section>
      </div>

      <aside className="col">
        <section className="card info">
          <div className="kicker">Quórum presente</div>
          <div className="meterrow"><strong>{percent(quorumPresente)}</strong><span>de {percent(quorumTotal)} de coeficientes</span></div>
          <div className="meter"><div className="fill" style={{ width: quorumWidth + "%" }} /></div>
          <div className="caption">{attendance.filter(unit => unit.presente).length} unidades presentes · {quorum ? "datos de API" : "esperando datos de API"}</div>
        </section>

        <section className="card pad">
          <div className="head"><div><div className="kicker">Asistencia</div><h2>Unidades presentes</h2><p>Unidades y coeficientes cargados desde la API de asamblea.</p></div></div>
          {attendance.length === 0 ? <div className="blank">La lista de asistentes aparecerá cuando PostgreSQL entregue los datos.</div> :
            attendance.map(unit => <div className="attendee" key={unit.id_unidad}>
              <label><input type="checkbox" checked={unit.presente} readOnly /><span>{unit.unidad}</span></label>              <b>{percent(unit.coeficiente_representado)}</b>
            </div>)
          }
          <div className="notice" style={{ marginTop: 10 }}>El total mostrado es la suma de los coeficientes presentes, no el conteo de personas.</div>
        </section>

        <section className="card pad">
          <div className="head"><div><div className="kicker">Nueva decisión</div><h2>Crear pregunta</h2><p>Define el enunciado y añade las opciones que requiera la asamblea.</p></div></div>
          <form onSubmit={crearPregunta}>
            <div className="form-group">
              <label htmlFor="questionText">Enunciado de la decisión</label>
              <textarea id="questionText" className="field" placeholder="Ej. Elección de revisor fiscal" value={enunciado} onChange={event => setEnunciado(event.target.value)} />
            </div>
            <div className="form-group">
              <span className="form-label">Opciones de respuesta</span>
              <div className="option-list">
                {opciones.map((option, index) => <div className="option-edit" key={option.key}>
                  <span className="option-letter">{String.fromCharCode(65 + index)}</span>
                  <input className="field" aria-label={"Opción " + String.fromCharCode(65 + index)} placeholder="Escribe una opción" value={option.texto} onChange={event => cambiarOpcion(option.key, event.target.value)} />
                  <button type="button" className="remove" aria-label="Eliminar opción" disabled={opciones.length <= 2} onClick={() => quitarOpcion(option.key)}>×</button>
                </div>)}
              </div>
              <button type="button" className="add" disabled={opciones.length >= 10} onClick={agregarOpcion}>＋ Añadir opción</button>
              {error && <div className="error show" role="alert">{error}</div>}
            </div>
            <div className="form-actions"><span className="hint">La pregunta se guarda inactiva.</span><button type="submit" className="btn primary" disabled={guardando || !socket.connected}>{guardando ? "Guardando…" : "Guardar en agenda →"}</button></div>
          </form>
        </section>
        <div className="notice"><strong>Referencia: Ley 675 de 2001</strong><br />Valida quórum y mayoría exigibles según la decisión y el reglamento de propiedad horizontal.</div>
      </aside>
    </div>
  );
}
