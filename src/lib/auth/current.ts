import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { SESSION_COOKIE, verifySession, hasRole, type Role, type SessionUser } from "./session";

/** Server-side authoritative check: valid signed session AND active user in DB. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await verifySession(token);
  if (!s) return null;
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, s.sub));
  if (!u || !u.active) return null;
  return { sub: u.id, email: u.email, name: u.name, role: u.role };
}

export async function requirePageUser(role: Role = "viewer"): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!hasRole(u, role)) redirect("/?forbidden=1");
  return u;
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
}
