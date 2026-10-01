import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { PreguntaVotacion } from "./App";

interface VoterPanelProps {
  socket: Socket;
  token: string;
  asambleaId: string;
  apiBaseUrl: string;
  coeficiente: string;
  preguntaInicial: PreguntaVotacion | null;
  onPreguntaActiva: (pregunta: PreguntaVotacion | null) => void;
}

interface AckVoto {
  ok: boolean;
  mensaje?: string;
  error?: string;
}

function activeQuestionFrom(payload: unknown): PreguntaVotacion | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { pregunta?: unknown; estado?: string };
  const raw = (envelope.pregunta ?? payload) as Partial<PreguntaVotacion> | null;
  if (!raw || typeof raw !== "object") return null;
  const isActive = raw.activa === true || envelope.estado === "activa";
  if (!isActive || typeof raw.id_pregunta !== "number" || typeof raw.enunciado !== "string" || !Array.isArray(raw.opciones)) return null;
  return { id_pregunta: raw.id_pregunta, enunciado: raw.enunciado, opciones: raw.opciones, activa: true };
}

export default function VoterPanel({
  socket,
  token,
  asambleaId,
  apiBaseUrl,
  coeficiente,
  preguntaInicial,
  onPreguntaActiva
}: VoterPanelProps) {
  const [pregunta, setPregunta] = useState<PreguntaVotacion | null>(preguntaInicial?.activa ? preguntaInicial : null);
  const [opcionSeleccionada, setOpcionSeleccionada] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [votoRegistrado, setVotoRegistrado] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [nombreUnidad, setNombreUnidad] = useState("Consultando unidad…");
  const [coeficienteActual, setCoeficienteActual] = useState(coeficiente || "—");
  const syncVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const endpoint = apiBaseUrl.replace(/\/$/, "") + "/api/asambleas/" + encodeURIComponent(asambleaId) + "/unidad-actual";
    fetch(endpoint, { headers: { Authorization: "Bearer " + token }, signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((unidad: { unidad?: unknown; coeficiente?: unknown } | null) => {
        if (!unidad || controller.signal.aborted) return;
        if (typeof unidad.unidad === "string") setNombreUnidad(unidad.unidad);
        if (typeof unidad.coeficiente === "string" || typeof unidad.coeficiente === "number") {
          setCoeficienteActual(Number(unidad.coeficiente).toFixed(6) + "%");
        }
      })
      .catch(() => { /* conserva el dato de demostración cuando la API no responde */ });
    return () => controller.abort();
  }, [apiBaseUrl, asambleaId, token]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++syncVersion.current;
    const endpoint = apiBaseUrl.replace(/\/$/, "") + "/api/asambleas/" + encodeURIComponent(asambleaId) + "/votacion/activa";
    fetch(endpoint, { headers: { Authorization: "Bearer " + token }, signal: controller.signal })
      .then(response => {
        if (response.status === 204) return null;
        if (!response.ok) throw new Error("No fue posible consultar la votación activa.");
        return response.json();
      })
      .then(payload => {
        if (requestId !== syncVersion.current) return;
        const next = payload ? activeQuestionFrom(payload) : null;
        setPregunta(next);
        onPreguntaActiva(next);
      })
      .catch(() => { /* Socket.IO remains the real-time source if the API is offline. */ });

    const handleState = (payload: unknown) => {
      syncVersion.current += 1;
      const next = activeQuestionFrom(payload);
      setPregunta(next);
      setOpcionSeleccionada(null);
      setVotoRegistrado(false);
      setMensaje("");
      onPreguntaActiva(next);
    };
    const handleVoteError = (payload: unknown) => {
      if (payload && typeof payload === "object" && "mensaje" in payload) {
        setMensaje(String((payload as { mensaje: unknown }).mensaje));
      }
    };
    socket.on("estado_votacion", handleState);
    socket.on("error_votacion", handleVoteError);
    return () => {
      controller.abort();
      socket.off("estado_votacion", handleState);
      socket.off("error_votacion", handleVoteError);
    };
  }, [socket, onPreguntaActiva, apiBaseUrl, asambleaId, token]);

  useEffect(() => {
    setPregunta(preguntaInicial?.activa ? preguntaInicial : null);
    setOpcionSeleccionada(null);
    setVotoRegistrado(false);
  }, [preguntaInicial?.id_pregunta, preguntaInicial?.activa]);

  async function emitirVoto() {
    if (!pregunta || opcionSeleccionada === null || enviando) return;
    if (!socket.connected) {
      setMensaje("No hay conexión con el servidor. Tu voto no se ha enviado.");
      return;
    }

    setEnviando(true);
    setMensaje("");
    const ack = await new Promise<AckVoto | null>(resolve => {
      const timer = window.setTimeout(() => resolve(null), 8000);
      socket.emit("emitir_voto", {
        asamblea_id: asambleaId,
        id_pregunta: pregunta.id_pregunta,
        id_opcion: opcionSeleccionada,
        token
      }, (response: AckVoto) => {
        window.clearTimeout(timer);
        resolve(response ?? null);
      });
    });
    setEnviando(false);

    if (!ack?.ok) {
      setMensaje(ack?.error || "El servidor no confirmó el voto. Revisa la conexión e inténtalo de nuevo.");
      return;
    }
    setVotoRegistrado(true);
    setMensaje(ack.mensaje || "Voto registrado correctamente con el coeficiente de tu unidad.");
    setOpcionSeleccionada(null);
  }

  if (!pregunta) {
    return (
      <div className="grid">
        <section className="card empty">
          <div className="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <h2>Esperando a que el administrador habilite la siguiente votación...</h2>
          <p>Cuando se abra una pregunta, aparecerá aquí con sus opciones. Este panel escucha el evento <code>estado_votacion</code> y se actualiza sin recargar la página.</p>
        </section>
        <aside className="col">
          <section className="card info">
            <div className="info-title">Tu representación</div>
            <div className="unit-summary"><div className="big">{coeficienteActual}</div><div><strong>{nombreUnidad}</strong><span>Coeficiente de copropiedad asociado a tu unidad.</span></div></div>
          </section>
          <div className="notice"><strong>Voto ponderado por coeficiente</strong><br />El resultado suma el coeficiente representado; no cuenta personas como votos individuales.</div>
        </aside>
      </div>
    );
  }

  return (
    <div className="grid">
      <section className="card ballot">
        <div className="ballot-top"><span className="ballot-label">Decisión de la asamblea</span><span className="pill active-pill">Votación abierta</span></div>
        <h2>{pregunta.enunciado}</h2>
        <p className="ballot-intro">Selecciona una opción para emitir el voto de tu unidad residencial.</p>
        <div className="coef"><span>Coeficiente que representa tu voto</span><strong>{coeficienteActual}</strong></div>
        {votoRegistrado ? (
          <div className="submitted" role="status">{mensaje}</div>
        ) : (
          <>
            <div className="choices" role="radiogroup" aria-label="Opciones de votación">
              {pregunta.opciones.map(option => {
                const selected = opcionSeleccionada === option.id_opcion;
                return <button
                  key={option.id_opcion}
                  type="button"
                  className={"choice " + (selected ? "sel" : "")}
                  aria-pressed={selected}
                  onClick={() => { setOpcionSeleccionada(option.id_opcion); setMensaje(""); }}
                >
                  <span className="radio" aria-hidden="true" />
                  <span>{option.texto}</span>
                </button>;
              })}
            </div>
            <div className="ballot-actions">
              <span className="hint">Una respuesta por unidad residencial.</span>
              <button type="button" className="btn primary" disabled={opcionSeleccionada === null || enviando} onClick={emitirVoto}>
                {enviando ? "Enviando…" : "Confirmar voto →"}
              </button>
            </div>
            {mensaje && <div className="error show" role="alert">{mensaje}</div>}
          </>
        )}
      </section>
      <aside className="col">
        <section className="card info">
          <div className="info-title">Tu representación</div>
          <div className="unit-summary"><div className="big">{coeficienteActual}</div><div><strong>{nombreUnidad}</strong><span>Coeficiente usado al emitir este voto.</span></div></div>
        </section>
        <div className="notice"><strong>Votación ponderada</strong><br />Al confirmar, se envía el ID de la opción y tu token de sesión al servidor.</div>
        <section className="card info"><div className="info-title">Canal de asamblea</div><div className="unit-summary"><span>Los cambios de estado llegan por Socket.IO sin recargar la página.</span></div></section>
      </aside>
    </div>
  );
}
