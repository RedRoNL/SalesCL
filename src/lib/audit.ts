import { getDb, schema } from "@/db/client";

export interface AuditEntry {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only audit log. Failures are logged, never swallowed silently. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await getDb().insert(schema.auditLogs).values({ ...entry, actorId: entry.actorId ?? null, entityId: entry.entityId ?? null, ip: entry.ip ?? null });
  } catch (err) {
    console.error("[audit] failed to write audit log", entry.action, err);
  }
}
