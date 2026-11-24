import { eq, or } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { env } from "@/lib/env";
import type { Role } from "./session";

/** Create or update a user on sign-in. Entra role claims win; bootstrap admins are always admin. */
export async function upsertUser(input: { email: string; name: string | null; entraObjectId?: string | null; role: Role }) {
  const db = getDb();
  const email = input.email.toLowerCase();
  const bootstrap = env().INITIAL_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const role: Role = bootstrap.includes(email) ? "admin" : input.role;
  const where = input.entraObjectId ? or(eq(schema.users.entraObjectId, input.entraObjectId), eq(schema.users.email, email)) : eq(schema.users.email, email);
  const [existing] = await db.select().from(schema.users).where(where);
  if (existing) {
    const [u] = await db
      .update(schema.users)
      .set({ name: input.name ?? existing.name, entraObjectId: input.entraObjectId ?? existing.entraObjectId, role, lastLoginAt: new Date() })
      .where(eq(schema.users.id, existing.id))
      .returning();
    return u;
  }
  const [u] = await db.insert(schema.users).values({ email, name: input.name, entraObjectId: input.entraObjectId ?? null, role, lastLoginAt: new Date() }).returning();
  return u;
}
