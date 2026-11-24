import { timingSafeEqual, createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db/client";

/**
 * First-administrator bootstrap for a fresh deployment. Requires SETUP_TOKEN
 * (≥24 chars, set outside the app) and closes permanently once an administrator
 * has signed in through Microsoft Entra ID.
 */
export async function bootstrapOpen(): Promise<boolean> {
  const t = process.env.SETUP_TOKEN;
  if (!t || t.length < 24) return false;
  const [entraAdmin] = await getDb().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.role, "admin"), isNotNull(schema.users.entraObjectId), eq(schema.users.active, true))).limit(1);
  return !entraAdmin;
}

export function tokenMatches(given: string): boolean {
  const expected = process.env.SETUP_TOKEN ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return expected.length >= 24 && timingSafeEqual(a, b);
}
