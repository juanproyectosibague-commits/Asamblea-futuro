import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import AdminPanel from "./AdminPanel";
import VoterPanel from "./VoterPanel";

export interface OpcionVotacion {
  id_opcion: number;
  texto: string;
}

export interface PreguntaVotacion {
  id_pregunta: number;
  enunciado: string;
  opciones: OpcionVotacion[];
  activa: boolean;
  estado?: "inactiva" | "activa" | "cerrada";
}

export interface UnidadPresente {
  id_unidad: string;
  unidad: string;
  coeficiente_representado: string | number;
  presente: boolean;
}

export interface ResumenQuorum {
  estado_asamblea?: "programada" | "activa" | "cerrada";
  coeficiente_presente: string | number;
  coeficiente_total: string | number;
  unidades_presentes: UnidadPresente[];
}

export interface ResultadoOpcion {
  id_opcion: number;
  coeficiente_representado: string | number;
  votos?: number;
}

type Rol = "administrador" | "residente";
type Sesion = { rol: Rol; token: string; asambleaId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AppProps {
  socketUrl?: string;
  apiBaseUrl?: string;
  asambleaId?: string;
}

function accessLinkFromHash(): { session: Sesion | null; error: string | null; hasToken: boolean } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (!token) return { session: null, error: null, hasToken: false };
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) throw new Error();
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as Record<string, unknown>;
    const rol = claims.rol;
    const asambleaId = claims.id_asamblea;
    if (
      (rol !== "administrador" && rol !== "residente") ||
      typeof asambleaId !== "string" || !UUID_RE.test(asambleaId) ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()
    ) throw new Error();
    return { session: { rol, token, asambleaId } as Sesion, error: null, hasToken: true };
  } catch {
    return { session: null, error: "El enlace está vencido o no tiene un formato válido. Solicita uno nuevo a la administración.", hasToken: true };
  }
}

function preguntaDesdeEvento(payload: unknown): PreguntaVotacion | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { pregunta?: unknown; estado?: string; activa?: boolean };
  const raw = (envelope.pregunta ?? payload) as Partial<PreguntaVotacion> | null;
  if (!raw || typeof raw !== "object") return null;
  const activa = raw.activa === true || envelope.estado === "activa";
  if (!activa || typeof raw.id_pregunta !== "number" || typeof raw.enunciado !== "string" || !Array.isArray(raw.opciones)) return null;
  return {
    id_pregunta: raw.id_pregunta,
    enunciado: raw.enunciado,
    opciones: raw.opciones,
    activa: true,
    estado: "activa"
  };
}

export default function App({
  socketUrl,
  apiBaseUrl,
  asambleaId
}: AppProps) {
  const runtime = window as Window & {
    __PH_CONFIG__?: { socketUrl?: string; apiBaseUrl?: string };
  };
  const resolvedSocketUrl = socketUrl || runtime.__PH_CONFIG__?.socketUrl || window.location.origin;
  const resolvedApiBaseUrl = apiBaseUrl || runtime.__PH_CONFIG__?.apiBaseUrl || window.location.origin;

  const [accessLink] = useState(accessLinkFromHash);
  const [sesion, setSesion] = useState<Sesion | null>(accessLink.session);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [conectado, setConectado] = useState(false);
  const [preguntaActiva, setPreguntaActiva] = useState<PreguntaVotacion | null>(null);
  const activeAssemblyId = asambleaId || sesion?.asambleaId || "00000000-0000-4000-8000-000000000101";

  useEffect(() => {
    if (window.location.hash.includes("token=")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    if (!sesion) {
      setSocket(null);
      setConectado(false);
      return;
    }

    const client = io(resolvedSocketUrl, {
      autoConnect: false,
      auth: { token: sesion.token }
    });

    const handleConnect = () => setConectado(true);
    const handleDisconnect = () => setConectado(false);
    const handleEstado = (payload: unknown) => setPreguntaActiva(preguntaDesdeEvento(payload));

    client.on("connect", handleConnect);
    client.on("disconnect", handleDisconnect);
    client.on("estado_votacion", handleEstado);
    setSocket(client);
    client.connect();

    return () => {
      client.off("connect", handleConnect);
      client.off("disconnect", handleDisconnect);
      client.off("estado_votacion", handleEstado);
      client.disconnect();
    };
  }, [resolvedSocketUrl, sesion?.token]);

  function cerrarSesion() {
    setSesion(null);
    setPreguntaActiva(null);
  }

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="/" aria-label="Ribera Campestre">
          <span className="mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 20V10l8-6 8 6v10h-6v-6h-4v6H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <path d="m3 10 9-7 9 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <span><b>RIBERA CAMPESTRE</b><small>PROPIEDAD HORIZONTAL</small></span>
        </a>
        <div className="top-right">
          <span className="demo">{sesion ? conectado ? "Canal en vivo" : "Conectando" : "Acceso con enlace personal"}</span>
          {sesion && (
            <div className="user">
              <div className="user-copy">
                {sesion.rol === "administrador" ? "Administración" : "Propietario"}
                <small>{sesion.rol === "administrador" ? "Panel de control" : "Unidad privada"}</small>
              </div>
              <div className="avatar">{sesion.rol === "administrador" ? "AD" : "P"}</div>
              <button type="button" className="btn soft" onClick={cerrarSesion}>Cerrar sesión</button>
            </div>
          )}
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">Asamblea general · 2026</div>
          <h1>Decisiones con coeficiente.</h1>
          <p>Infórmate, participa y ayuda a decidir en comunidad.</p>
        </div>
        <div className="place">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 21s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="12" cy="9" r="2.2" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Ribera Campestre · Ibagué
        </div>
      </section>

      <main id="app">
        {!sesion ? (
          <section className="card pad">
            <div className="head">
              <div>
                <div className="kicker">Acceso a la asamblea</div>
                <h2>Accede con tu enlace personal</h2>
                <p>Abre el enlace enviado por la administración para consultar o gestionar esta asamblea.</p>
              </div>
            </div>
            {accessLink.error ? <div className="error show" role="alert">{accessLink.error}</div> :
              <p className="hint" style={{ marginTop: 14 }}>Este sitio requiere un enlace válido y vigente. Si no lo tienes, contacta a la administración.</p>}
          </section>
        ) : !socket ? (
          <section className="card empty"><h2>Preparando conexión de asamblea…</h2></section>
        ) : sesion.rol === "administrador" ? (
          <AdminPanel
            socket={socket}
            token={sesion.token}
            asambleaId={activeAssemblyId}
            apiBaseUrl={resolvedApiBaseUrl}
            preguntaActiva={preguntaActiva}
            onPreguntaActiva={setPreguntaActiva}
          />
        ) : (
          <VoterPanel
            socket={socket}
            token={sesion.token}
            asambleaId={activeAssemblyId}
            apiBaseUrl={resolvedApiBaseUrl}
            coeficiente="—"
            preguntaInicial={preguntaActiva}
            onPreguntaActiva={setPreguntaActiva}
          />
        )}
      </main>

      <footer>
        <span>© 2026 Ribera Campestre P.H. · Asamblea de copropietarios</span>
        <span className="footnote">La participación y el peso de cada voto corresponden al coeficiente de la unidad privada.</span>
      </footer>
    </div>
  );
}
