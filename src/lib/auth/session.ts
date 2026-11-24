import { SignJWT, jwtVerify } from "jose";

export type Role = "admin" | "analyst" | "viewer";
export interface SessionUser {
  sub: string; // users.id
  email: string;
  name?: string | null;
  role: Role;
}

export const SESSION_COOKIE = "cl_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8h working day

function key(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET (>=32 chars) is required in production");
    return new TextEncoder().encode("dev-only-insecure-session-secret-change-me-0000");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name ?? null, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuedAt()
    .setIssuer("cloud-life-sales-army")
    .setAudience("cloud-life-sales-army")
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifySession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: "cloud-life-sales-army", audience: "cloud-life-sales-army", algorithms: ["HS256"] });
    const role = payload.role as Role;
    if (!payload.sub || !["admin", "analyst", "viewer"].includes(role)) return null;
    return { sub: payload.sub, email: String(payload.email), name: (payload.name as string) ?? null, role };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };
export function hasRole(user: SessionUser | null, required: Role): boolean {
  return Boolean(user && RANK[user.role] >= RANK[required]);
}
