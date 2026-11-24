"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current";
import { hasRole } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings, updateSetting } from "@/lib/settings";
import { setSecret, deleteSecret, SECRET_NAMES, type SecretName } from "@/lib/secrets";
import { runCheck } from "@/lib/integrations";
import { startPilot, PILOT_PRESETS, type PilotKey } from "@/lib/pilots";
import { createRun } from "@/pipeline/runs";
import { modelAvailable } from "@/agents/model";
import { dispatchRun } from "@/lib/routine";

async function admin() {
  const u = await getCurrentUser();
  if (!u || !hasRole(u, "admin")) throw new Error("Beheerdersrechten vereist");
  return u;
}
const done = () => revalidatePath("/setup");

export async function saveSecretAction(name: SecretName, fd: FormData) {
  const u = await admin();
  z.enum(SECRET_NAMES).parse(name);
  const value = z.string().min(8).max(500).parse(String(fd.get("value") ?? "").trim());
  await setSecret(name, value, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "secret.updated", entityType: "secret", entityId: name }); // value never logged
  await runCheck(name);
  done();
}

export async function deleteSecretAction(name: SecretName) {
  const u = await admin();
  await deleteSecret(z.enum(SECRET_NAMES).parse(name));
  await audit({ actorType: "user", actorId: u.sub, action: "secret.deleted", entityType: "secret", entityId: name });
  done();
}

export async function runCheckAction(key: string) {
  await admin();
  await runCheck(key);
  done();
}

export async function saveProvidersAction(fd: FormData) {
  const u = await admin();
  const s = await getSettings();
  const searchProvider = z.enum(["anthropic_web_search", "brave", "firecrawl", "none"]).parse(fd.get("searchProvider"));
  const registryProvider = z.enum(["none", "kvk"]).parse(fd.get("registryProvider"));
  const approved = fd.getAll("approvedPaidProviders").map(String).filter((p) => ["anthropic_web_search", "brave", "firecrawl", "kvk"].includes(p));
  await updateSetting("research", { ...s.research, searchProvider, registryProvider, fetchProvider: "http", firecrawlRenderFallback: fd.get("firecrawlRenderFallback") === "on" }, `user:${u.sub}`);
  await updateSetting("budget", { ...s.budget, approvedPaidProviders: approved }, `user:${u.sub}`);
  await updateSetting("integrations", { ...s.integrations, tenantDiscovery: fd.get("tenantDiscovery") === "on", connectivityTestUrl: z.string().url().parse(fd.get("connectivityTestUrl") || s.integrations.connectivityTestUrl) }, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.providers", details: { searchProvider, registryProvider, approved } });
  done();
}

export async function saveEntraAction(fd: FormData) {
  const u = await admin();
  const s = await getSettings();
  const guid = z.string().regex(/^[0-9a-f-]{36}$/i).or(z.literal(""));
  await updateSetting("integrations", {
    ...s.integrations, entraTenantId: guid.parse(String(fd.get("tenantId") ?? "").trim()), entraClientId: guid.parse(String(fd.get("clientId") ?? "").trim()),
    entraAdminGroupId: guid.parse(String(fd.get("adminGroupId") ?? "").trim()), entraAnalystGroupId: guid.parse(String(fd.get("analystGroupId") ?? "").trim()),
  }, `user:${u.sub}`);
  const secret = String(fd.get("clientSecret") ?? "").trim();
  if (secret) await setSecret("ENTRA_CLIENT_SECRET", secret, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.entra" });
  await runCheck("ENTRA_CLIENT_SECRET");
  done();
}

export async function saveBudgetAction(fd: FormData) {
  const u = await admin();
  const s = await getSettings();
  const n = (k: string) => z.coerce.number().min(0).max(100000).parse(fd.get(k));
  await updateSetting("budget", { ...s.budget, weeklyEur: n("weeklyEur"), monthlyEur: n("monthlyEur"), perRunDefaultEur: n("perRunDefaultEur") }, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.budget" });
  done();
}

export async function saveScheduleAction(fd: FormData) {
  const u = await admin();
  const s = await getSettings();
  const dow = z.coerce.number().int().min(0).max(6).parse(fd.get("weekday"));
  const [hh, mm] = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("time")).split(":").map(Number);
  await updateSetting("schedule", {
    ...s.schedule, enabled: fd.get("enabled") === "on", cron: `${mm} ${hh} * * ${dow}`, timezone: z.string().min(3).parse(fd.get("timezone") || "Europe/Amsterdam"),
    weeklyTarget: z.coerce.number().int().min(1).max(500).parse(fd.get("weeklyTarget")),
  }, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.schedule" });
  done();
}

export async function startPilotAction(key: PilotKey, fd: FormData) {
  const u = await admin();
  if (!(key in PILOT_PRESETS)) throw new Error("Onbekende pilot");
  if (!(await modelAvailable())) throw new Error("AI-uitvoering niet beschikbaar: kies Claude Subscription Mode of keur Paid API Mode goed (wizard → Uitvoering)");
  const r = await startPilot(key, z.coerce.number().parse(fd.get("budgetEur") ?? 0), fd.get("approved") === "on", `user:${u.sub}`);
  if (r.created) await dispatchRun(r.runId, "pilot", `user:${u.sub}`);
  redirect(`/research/${r.runId}`);
}

export async function startFirstRunAction(fd: FormData) {
  const u = await admin();
  const budget = z.coerce.number().min(0).max(5000).parse(fd.get("budgetEur") ?? 0);
  if (budget > 0 && fd.get("approved") !== "on") throw new Error("Expliciete budgetgoedkeuring is vereist");
  if (!(await modelAvailable())) throw new Error("AI-uitvoering niet beschikbaar: kies Claude Subscription Mode of keur Paid API Mode goed (wizard → Uitvoering)");
  const s = await getSettings();
  const r = await createRun("weekly", { target: s.schedule.weeklyTarget }, `user:${u.sub}`, budget);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.first_run", entityType: "research_run", entityId: r.runId, details: { budget, created: r.created } });
  if (r.created) await dispatchRun(r.runId, "weekly", `user:${u.sub}`);
  redirect(`/research/${r.runId}`);
}

/**
 * AI execution mode. Claude Subscription Mode (default) needs no API key. Paid API Mode is only
 * enabled with an explicit, recorded approval; there is never an automatic switch between modes.
 */
export async function saveExecutionAction(fd: FormData) {
  const u = await admin();
  const s = await getSettings();
  const mode = z.enum(["subscription", "api"]).parse(fd.get("mode"));
  const approvedNow = fd.get("paidApiApproved") === "on";
  if (mode === "api" && !approvedNow) throw new Error("Paid API Mode vereist expliciete goedkeuring van API-kosten");
  const routineId = String(fd.get("routineId") ?? "").trim();
  if (routineId && !/^trig_[A-Za-z0-9]+$/.test(routineId)) throw new Error("Scheduled-task-ID moet beginnen met trig_");
  const publicUrl = String(fd.get("publicUrl") ?? "").trim();
  if (publicUrl && !/^https:\/\/[^/\s]+/.test(publicUrl)) throw new Error("Publieke URL moet met https:// beginnen");
  const subscriptionModels = {
    fast: z.enum(["sonnet", "haiku", "opus"]).parse(fd.get("modelFast") ?? s.execution.subscriptionModels.fast),
    standard: z.enum(["sonnet", "opus"]).parse(fd.get("modelStandard") ?? s.execution.subscriptionModels.standard),
    strong: z.enum(["sonnet", "opus"]).parse(fd.get("modelStrong") ?? s.execution.subscriptionModels.strong),
  };
  await updateSetting("execution", {
    ...s.execution, mode, subscriptionModels,
    paidApiApproved: mode === "api" && approvedNow,
    paidApiApprovedBy: mode === "api" && approvedNow ? `user:${u.sub}@${new Date().toISOString()}` : null,
    routineId: routineId || null, publicUrl: publicUrl ? publicUrl.replace(/\/$/, "") : null,
  }, `user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.execution", details: { mode, paidApiApproved: mode === "api" && approvedNow, routineConfigured: Boolean(routineId) } });
  done();
}

/** Generates a new bridge token (invalidates the previous one). The value is returned once and never stored. */
export async function generateBridgeTokenAction(): Promise<string> {
  const u = await admin();
  const { generateBridgeToken } = await import("@/bridge/auth");
  const token = await generateBridgeToken(`user:${u.sub}`);
  await audit({ actorType: "user", actorId: u.sub, action: "bridge.token_generated" }); // value never logged
  done();
  return token;
}

export async function testRoutineAction() {
  const u = await admin();
  const { fireRoutine } = await import("@/lib/routine");
  const r = await fireRoutine({ kind: "test" }, `user:${u.sub}`);
  const db = (await import("@/db/client")).getDb();
  const { schema } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const [row] = (await db.execute(sql`select value from system_settings where key = 'integration_checks'`)) as unknown as { value: Record<string, unknown> }[];
  const value = { ...(row?.value ?? {}), routine: { ok: r.ok, message: r.ok ? `Sessie gestart${r.sessionUrl ? `: ${r.sessionUrl}` : ""}` : r.message, checkedAt: new Date().toISOString() } };
  await db.insert(schema.systemSettings).values({ key: "integration_checks", value }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
  done();
}
