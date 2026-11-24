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
  if (!(await modelAvailable())) throw new Error("Stel eerst een geldige Claude API-sleutel in");
  const r = await startPilot(key, z.coerce.number().parse(fd.get("budgetEur")), fd.get("approved") === "on", `user:${u.sub}`);
  redirect(`/research/${r.runId}`);
}

export async function startFirstRunAction(fd: FormData) {
  const u = await admin();
  if (fd.get("approved") !== "on") throw new Error("Expliciete budgetgoedkeuring is vereist");
  if (!(await modelAvailable())) throw new Error("Stel eerst een geldige Claude API-sleutel in");
  const s = await getSettings();
  const budget = z.coerce.number().min(1).max(5000).parse(fd.get("budgetEur"));
  const r = await createRun("weekly", { target: s.schedule.weeklyTarget }, `user:${u.sub}`, budget);
  await audit({ actorType: "user", actorId: u.sub, action: "setup.first_run", entityType: "research_run", entityId: r.runId, details: { budget, created: r.created } });
  redirect(`/research/${r.runId}`);
}
