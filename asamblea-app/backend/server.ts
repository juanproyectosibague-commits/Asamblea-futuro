import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "node:http";
import { Pool } from "pg";
import { Server } from "socket.io";
import { assertJwtConfiguration, HttpError, socketJwtMiddleware } from "./auth";
import { registerSocketHandlers } from "./socket.handler";
import { createVotingRouter } from "./voting.controller";
import path from 'path';
import { fileURLToPath } from 'url';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Falta la variable de entorno " + name + ".");
  return value;
}

const databaseUrl = required("DATABASE_URL");
assertJwtConfiguration();
const requireDatabaseTls = process.env.PG_SSL === "true";
const parsedDatabaseUrl = new URL(databaseUrl);
if (requireDatabaseTls) {
  // Avoid pg-connection-string replacing the explicit, certificate-validating SSL config.
  for (const option of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) parsedDatabaseUrl.searchParams.delete(option);
}
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || "http://localhost:5173").split(",").map(value => value.trim()).filter(Boolean)
);

const app = express();
app.disable("x-powered-by");
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("origin");
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Origen no permitido.", code: "CORS_ORIGIN_DENIED" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "32kb", strict: true }));

const pool = new Pool({
  connectionString: requireDatabaseTls ? parsedDatabaseUrl.toString() : databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "ph-votaciones-api",
  ssl: requireDatabaseTls ? { rejectUnauthorized: true } : undefined
});
pool.on("error", error => console.error("Error en conexión inactiva de PostgreSQL:", error.message));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error("Origen Socket.IO no permitido."));
    },
    credentials: true,
    methods: ["GET", "POST"]
  },
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || allowedOrigins.has(origin));
  },
  maxHttpBufferSize: 32_768,
  // La sesión de transporte puede recuperarse brevemente; la asistencia vive en PostgreSQL.
  connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: false }
});

io.use(socketJwtMiddleware);
registerSocketHandlers(io, pool);
app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));
app.use("/api/asambleas", createVotingRouter(pool, io));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, '../dist');

app.use(express.static(distPath));

app.use((req, res, next) => {
  if (req.method !== 'GET' || /^\/(api|socket\.io)(\/|$)/.test(req.path)) return next();
  res.sendFile('index.html', { root: distPath });
});

app.use((_req: Request, res: Response) => res.status(404).json({ error: "Ruta no encontrada.", code: "NOT_FOUND" }));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: "JSON de solicitud inválido.", code: "INVALID_JSON" });
    return;
  }
  console.error("Error no controlado en la API:", error);
  res.status(500).json({ error: "Error interno del servidor.", code: "INTERNAL_ERROR" });
});

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  const port = Number(process.env.PORT || 3000);
  httpServer.listen(port, "0.0.0.0", () => console.log("API y Socket.IO disponibles en el puerto " + port + "."));
}
void start().catch(error => {
  console.error("No se pudo iniciar el servidor:", error);
  process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
  console.log("Cierre solicitado por " + signal + ".");
  await new Promise<void>(resolve => io.close(() => resolve()));
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
