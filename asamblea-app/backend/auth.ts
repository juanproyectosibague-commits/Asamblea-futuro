import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Socket } from "socket.io";

export type RolUsuario = "administrador" | "residente";
export interface AuthClaims extends JwtPayload {
  sub: string;
  id_unidad: string | null;
  id_copropiedad: string;
  id_asamblea: string;
  rol: RolUsuario;
  exp: number;
}

declare global {
  namespace Express { interface Request { auth?: AuthClaims } }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "REQUEST_ERROR") {
    super(message);
    this.name = "HttpError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function jwtConfiguration() {
  const secret = process.env.JWT_SECRET;
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !issuer || !audience) {
    throw new Error("Configure JWT_SECRET (32+ bytes), JWT_ISSUER y JWT_AUDIENCE.");
  }
  return { secret, issuer, audience };
}

export function assertJwtConfiguration(): void { jwtConfiguration(); }

export function verifyAccessToken(token: string): AuthClaims {
  const config = jwtConfiguration();
  let decoded: string | JwtPayload;
  try {
    decoded = jwt.verify(token, config.secret, {
      algorithms: ["HS256"],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 5
    });
  } catch {
    throw new HttpError(401, "Token inválido o vencido.", "INVALID_TOKEN");
  }
  if (typeof decoded === "string") throw new HttpError(401, "Token inválido.", "INVALID_TOKEN");

  const claims = decoded as JwtPayload & Record<string, unknown>;
  const hasUnitClaim = Object.prototype.hasOwnProperty.call(claims, "id_unidad");
  const role = claims.rol;
  if (
    typeof claims.sub !== "string" ||
    !hasUnitClaim ||
    (claims.id_unidad !== null && !isUuid(claims.id_unidad)) ||
    !isUuid(claims.id_copropiedad) ||
    !isUuid(claims.id_asamblea) ||
    (role !== "administrador" && role !== "residente") ||
    typeof claims.exp !== "number" ||
    ((role === "residente" && claims.id_unidad === null) || (role === "administrador" && claims.id_unidad !== null))
  ) throw new HttpError(401, "El token no contiene una identidad de asamblea válida.", "INVALID_CLAIMS");

  return claims as unknown as AuthClaims;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  return /^Bearer\s+([^\s]+)$/i.exec(header)?.[1] ?? null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    const token = bearerToken(req.header("authorization"));
    if (!token) throw new HttpError(401, "Se requiere un token Bearer.", "MISSING_TOKEN");
    req.auth = verifyAccessToken(token);
    next();
  } catch (error) {
    const authError = error instanceof HttpError ? error : new HttpError(401, "No autorizado.", "UNAUTHORIZED");
    res.status(authError.status).json({ error: authError.message, code: authError.code });
  }
}

export function requireRoles(...roles: RolUsuario[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "No autorizado.", code: "UNAUTHORIZED" });
      return;
    }
    if (!roles.includes(req.auth.rol)) {
      res.status(403).json({ error: "Rol sin permisos para esta acción.", code: "FORBIDDEN" });
      return;
    }
    next();
  };
}

export function socketJwtMiddleware(socket: Socket, next: (error?: Error) => void): void {
  try {
    const token = typeof socket.handshake.auth?.token === "string"
      ? socket.handshake.auth.token
      : bearerToken(socket.handshake.headers.authorization);
    if (!token) throw new HttpError(401, "Se requiere un JWT para conectarse.", "MISSING_TOKEN");

    socket.data.auth = verifyAccessToken(token);
    socket.data.jwtToken = token;
    // La asistencia queda persistida; paquetes recibidos después del exp sí se rechazan.
    socket.use((_packet, packetNext) => {
      const current = socket.data.auth as AuthClaims | undefined;
      if (!current || current.exp * 1000 <= Date.now()) {
        packetNext(new Error("JWT expirado; vuelve a autenticarte."));
        return;
      }
      packetNext();
    });
    next();
  } catch {
    next(new Error("No autorizado: JWT inválido, vencido o incompleto."));
  }
}

export function socketPrincipal(socket: Socket): AuthClaims {
  const claims = socket.data.auth as AuthClaims | undefined;
  if (!claims || claims.exp * 1000 <= Date.now()) {
    throw new HttpError(401, "JWT expirado; vuelve a autenticarte.", "INVALID_TOKEN");
  }
  return claims;
}

export function assertSocketEventToken(socket: Socket, token: unknown): AuthClaims {
  const claims = socketPrincipal(socket);
  if (typeof token !== "string" || token !== socket.data.jwtToken) {
    throw new HttpError(401, "El token del evento no coincide con la sesión.", "TOKEN_MISMATCH");
  }
  return claims;
}

export function requestPrincipal(req: Request): AuthClaims {
  if (!req.auth) throw new HttpError(401, "No autorizado.", "UNAUTHORIZED");
  return req.auth;
}
