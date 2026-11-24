/**
 * End-to-end integration tests of the real pipeline against PostgreSQL, using
 * a SYNTHETIC scripted model and SYNTHETIC providers (".example" companies).
 * These prove orchestration, persistence, dedup, exclusions, QA, eligibility,
 * export, feedback and learning — not live research quality (see pilot).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { setupTestDb } from "./helpers/db";
import { ScriptedModel } from "./helpers/scriptedModel";
import { FakeDns, FakeFetch, FakeSearch, DIRECTORY_HOME, SCOUT_URL } from "./helpers/world";
import { schema, type DB } from "@/db/client";
import { setModelClient } from "@/agents/model";
import { setProviders } from "@/research/service";
import { InlineQueue, setQueue, JOBS } from "@/pipeline/queue";
import { handlers } from "@/worker/handlers";
import { createRun, getRun, pauseRun, resumeRun, requeuePending } from "@/pipeline/runs";
import { approveList, decideItem, overrideQa } from "@/lib/lists";
import { exportList, ExportBlockedError } from "@/lib/exporter";
import { createImportPreview, commitImport, normalizeOutcome } from "@/lib/feedbackImport";
import { commercialPerformance } from "@/lib/analytics";
import { updateSetting, DEFAULT_SETTINGS } from "@/lib/settings";
import { runAgent } from "@/agents/runtime";
import { AGENT_LIST } from "@/agents/definitions";
import { postChatMessage } from "@/pipeline/chat";
import { normalizeCompanyName } from "@/domain/normalize";

let db: DB;
let sqlConn: { end: () => Promise<void> };
const model = new ScriptedModel();
const fetchP = new FakeFetch();
const queue = new InlineQueue();

beforeAll(async () => {
  const conn = await setupTestDb();
  db = conn.db;
  sqlConn = conn.sql;
  setModelClient(model);
  setProviders({ search: new FakeSearch(), fetch: fetchP, dns: new FakeDns(), registry: null });
  for (const [name, h] of Object.entries(handlers)) queue.on(name as never, h as never);
  setQueue(queue);
  await updateSetting("research", { ...DEFAULT_SETTINGS.research, requestDelayMs: 0 }, "test");
  // Pre-existing Cloud Life customer (synthetic) to test duplicate/customer exclusion.
  await db.insert(schema.companies).values({ officialName: "Synthetische Bouw Groep N.V.", normalizedName: normalizeCompanyName("Synthetische Bouw Groep N.V."), canonicalDomain: "synthbouw.example", website: "https://www.synthbouw.example", relationship: "customer", status: "excluded" });
  // Existing market segment for healthcare → hunters (not the MI director) get that industry.
  // Discovery-source database: replace real seed sources with one synthetic association.
  await db.delete(schema.discoverySources);
  await db.insert(schema.discoverySources).values({ kind: "page", sourceType: "association", name: "Synthetische Branchevereniging", url: DIRECTORY_HOME, industryCodes: ["food_production", "healthcare"], origin: "seed" });
});
afterAll(async () => {
  setModelClient(null);
  setProviders(null);
  setQueue(null);
  await sqlConn.end();
});

describe("weekly research run (end to end)", () => {
  let runId: string;
  let listId: string;

  it("runs strategy → discovery → research → QA → eligibility → ranking → list", async () => {
    const r = await createRun("weekly", { target: 3 }, "system:test");
    expect(r.created).toBe(true);
    runId = r.runId;
    await queue.drain();
    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.managementSummary).toContain("Managementsamenvatting");
    const [list] = await db.select().from(schema.prospectLists).where(eq(schema.prospectLists.runId, runId));
    listId = list.id;
    const items = await db.select({ i: schema.prospectListItems, c: schema.companies }).from(schema.prospectListItems).innerJoin(schema.companies, eq(schema.companies.id, schema.prospectListItems.companyId)).where(eq(schema.prospectListItems.listId, list.id));
    const names = items.map((x) => x.c.officialName).sort();
    expect(names).toEqual(["Stichting Synthetische Zorg", "Synthetische Voeding B.V."]);
    expect(list.shortfall).toBe(1); // target 3, only 2 genuinely qualified → shortfall reported, not padded
    expect(list.shortfallExplanation).toMatch(/niet verlaagd/);
  });

  it("CSO strategy cannot include excluded sectors (enforced in code)", async () => {
    const run = await getRun(runId);
    const plan = run!.strategy as { industries: { code: string }[] };
    expect(plan.industries.map((i) => i.code)).not.toContain("it_services");
  });

  it("enforces seed exclusions, competitor categories and existing customers", async () => {
    const all = await db.select().from(schema.companies);
    const visma = all.find((c) => c.officialName === "Visma ProActive");
    expect(visma?.status).toBe("excluded");
    expect(all.find((c) => c.officialName === "Synth IT Beheer B.V.")?.status).toBe("excluded");
    // Duplicate of the existing customer must not be re-created.
    expect(all.filter((c) => c.canonicalDomain === "synthbouw.example")).toHaveLength(1);
  });

  it("rejects companies contradicting the Microsoft fit for free, before any model call", async () => {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthlog.example"));
    expect(c.status).toBe("rejected");
    const [rc] = await db.select().from(schema.runCandidates).where(eq(schema.runCandidates.companyId, c.id));
    expect(rc.outcome).toMatch(/Google Workspace/);
    const tasks = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.companyId, c.id));
    expect(tasks).toHaveLength(0); // screening is deterministic and free
  });

  it("keeps natural-person legal forms (VOF) out of calling lists", async () => {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthtech.example"));
    expect(c.contactEligibility).toBe("restricted");
    expect(c.status).toBe("needs_research");
  });

  it("stores sources, classifies Microsoft evidence and validates agent claims", async () => {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthfood.example"));
    const ev = await db.select().from(schema.technologyEvidence).where(eq(schema.technologyEvidence.companyId, c.id));
    const get = (t: string) => ev.filter((e) => e.technology === t).map((e) => e.classification);
    expect(get("exchange_online")).toContain("confirmed"); // MX + autodiscover
    expect(get("intune")).toContain("strongly_indicated"); // vacancy mention, deterministic website scan
    expect(get("intune")).toContain("confirmed"); // extraction claim whose quote exists in the vacancy page
    expect(get("defender")).toEqual([]); // fabricated quote → dropped by code
    expect(get("purview")).toEqual([]);
    const sources = await db.select().from(schema.researchSources).where(eq(schema.researchSources.companyId, c.id));
    expect(sources.some((s) => s.sourceType === "official_site")).toBe(true);
    expect(sources.some((s) => s.sourceType === "vacancy")).toBe(true);
    expect(sources.some((s) => s.sourceType === "dns")).toBe(true);
    expect(c.phonePublic).toBe("+31101234567"); // found deterministically on the contact page
    expect(c.kvkNumber).toBe("90000001");
    expect(c.employeeCount).toBe(800);
    expect(c.legalForm).toBe("bv");
    // No source row is duplicated even though several stages touched the same pages.
    const urls = sources.map((s) => `${s.url}|${s.contentHash}`);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("drops names that do not occur on the harvested page (anti-hallucination)", async () => {
    const all = await db.select().from(schema.companies);
    expect(all.some((c) => /Verzonnen/.test(c.officialName))).toBe(false);
  });

  it("builds a persistent discovery-source database with per-source yield", async () => {
    const { sourceStats } = await import("@/discovery/sources");
    const stats = await sourceStats();
    const dir = stats.find((s) => s.url === DIRECTORY_HOME)!;
    expect(dir.status).toBe("active");
    expect(dir.uniqueNew).toBeGreaterThanOrEqual(5);
    expect(dir.qualified).toBe(2);
    const scouted = stats.find((s) => s.url === SCOUT_URL)!;
    expect(scouted.origin).toBe("agent"); // found by the Market Intelligence Director during the run
    expect(scouted.uniqueNew).toBe(1); // Synthetische Zuivel: not in the association list
    expect(stats.some((s) => s.url === "https://unfetched.example/top100")).toBe(false); // agent must have retrieved it
  });

  it("only activates expensive specialists when needed", async () => {
    const [food] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthfood.example"));
    const [zuivel] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthzuivel.example"));
    const byCompany = async (id: string) => (await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.companyId, id))).map((t) => t.taskType).sort();
    // Strong DNS evidence → no Microsoft specialist; high fit → signal analyst; complete profile → no gap-filling.
    expect(await byCompany(food.id)).toEqual(["extract_profile", "find_signals", "review"]);
    // Weak Microsoft evidence and missing phone → gap-filling and Microsoft specialist; low fit → no signals, no QA.
    expect(await byCompany(zuivel.id)).toEqual(["assess_microsoft", "deep_research", "extract_profile"]);
    // Extraction runs on the cheap tier with no tools.
    const ext = model.calls.filter((c) => c.task.startsWith("Bedrijfsprofiel extraheren"));
    expect(ext.every((c) => c.model === "claude-haiku-5-5" && c.tools.length === 1)).toBe(true);
    // The CSO never works on individual companies.
    const cso = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.agentId, "chief_sales_officer"));
    expect(cso.every((t) => t.companyId === null)).toBe(true);
  });

  it("runs an adaptive shortfall round when the target is not met", async () => {
    const run = await getRun(runId);
    expect((run!.stats as Record<string, number>).shortfallRound).toBe(1);
    const work = await db.select().from(schema.runWork).where(eq(schema.runWork.runId, runId));
    expect(work.some((w) => w.round === 2 && (w.params as { agent?: string }).agent === "growth_market_hunter")).toBe(true);
    expect(work.every((w) => w.status !== "pending")).toBe(true);
  });

  it("separates commercial fit from evidence confidence and explains the score", async () => {
    const [c] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthfood.example"));
    expect(c.fitScore).toBeGreaterThanOrEqual(85);
    expect(c.confidenceScore).toBeGreaterThan(0);
    expect(c.recommendedService).toBe("copilot_security_assessment"); // Copilot adoption signal
    const [s] = await db.select().from(schema.qualificationScores).where(eq(schema.qualificationScores.companyId, c.id));
    expect((s.components as unknown[]).length).toBe(6);
    expect(s.rationale).toMatch(/batch/); // Lead Qualification Specialist wrote it in one batch call
    expect(s.rationale).toMatch(/Fit \d+\/100/); // deterministic component explanation kept
    const batches = await db.select().from(schema.agentTasks).where(eq(schema.agentTasks.taskType, "rationale_batch"));
    expect(batches).toHaveLength(1);
  });

  it("QA operates independently and records reviews", async () => {
    const reviews = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.runId, runId));
    expect(reviews.length).toBeGreaterThanOrEqual(3);
    const qaCalls = model.calls.filter((c) => c.task.startsWith("Onafhankelijke QA-review"));
    expect(qaCalls.every((c) => c.model === "claude-opus-5-5")).toBe(true); // strong tier
    expect(qaCalls[0].tools).not.toContain("propose_recommendation");
    // QA dossier omits other agents' sales rationale.
    const tasks = await db.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.runId, runId), eq(schema.agentTasks.agentId, "quality_assurance_director")));
    expect(JSON.stringify(tasks[0].input)).not.toContain("commercialAssessment");
  });

  it("denies tools outside the agent's allow-list (prompt-injection containment)", async () => {
    const denied = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "agent.tool_denied"));
    expect(denied.length).toBeGreaterThan(0);
    const runs = await db.select().from(schema.researchRuns);
    expect(runs).toHaveLength(1); // no run was started by the injected instruction
    expect(model.toolResultsSeen.some((r) => r.includes("WAARSCHUWING") && r.includes("untrusted_content"))).toBe(true);
    const [zorg] = await db.select().from(schema.companies).where(eq(schema.companies.canonicalDomain, "synthzorg.example"));
    const inj = await db.select().from(schema.companyFacts).where(and(eq(schema.companyFacts.companyId, zorg.id), eq(schema.companyFacts.field, "injection_attempts")));
    expect(inj.length).toBe(1);
  });

  it("coordinates multiple genuine specialist agents and tracks cost per task", async () => {
    const rows = await db.execute(sql`select distinct agent_id from agent_tasks where run_id = ${runId}`);
    const agents = (rows as unknown as { agent_id: string }[]).map((r) => r.agent_id);
    for (const a of ["chief_sales_officer", "market_intelligence_director", "midmarket_hunter", "growth_market_hunter", "company_research_specialist", "microsoft_intelligence_specialist", "buying_signal_analyst", "lead_qualification_specialist", "quality_assurance_director"]) expect(agents).toContain(a);
    const [cost] = (await db.execute(sql`select sum(cost_eur)::float as c, sum(input_tokens)::int as t from agent_tasks where run_id = ${runId}`)) as unknown as { c: number; t: number }[];
    expect(cost.c).toBeGreaterThan(0);
    expect(cost.t).toBeGreaterThan(0);
    const run = await getRun(runId);
    expect(Number(run!.costEur)).toBeCloseTo(cost.c, 2);
  });

  it("prevents duplicate weekly runs", async () => {
    const again = await createRun("weekly", { target: 3 }, "system:test");
    expect(again.created).toBe(false);
    expect(again.runId).toBe(runId);
  });

  it("blocks export until a human approves; exports only approved, eligible items", async () => {
    await expect(exportList(listId, "xlsx", "user:test")).rejects.toBeInstanceOf(ExportBlockedError);
    const items = await db.select().from(schema.prospectListItems).where(eq(schema.prospectListItems.listId, listId));
    await decideItem(items[0].id, "approved", "user:test");
    await decideItem(items[1].id, "approved", "user:test");
    await approveList(listId, "user:test");
    const exp = await exportList(listId, "xlsx", "user:test");
    expect(exp.rows).toBe(2);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Belijst")!;
    const header = (ws.getRow(1).values as string[]).filter(Boolean);
    expect(header).toEqual(["Prospect-ID", "Bedrijfsnaam", "Website", "Sector", "Medewerkers", "Hoofdkantoor", "Telefoonnummer", "IT-beslisser (rol)", "Contactpersoon", "Prioriteit"]);
    const row2 = ws.getRow(2).values as string[];
    expect(String(row2[1])).toMatch(/^CLSA-\d{6}$/);
    expect(JSON.stringify(ws.getSheetValues())).not.toMatch(/rationale|onderbouwing|Copilot/i); // clean export
    const deliveries = await db.select().from(schema.deliveries);
    expect(deliveries).toHaveLength(2);
    const csv = await exportList(listId, "csv", "user:test");
    expect(csv.buffer.toString("utf8")).toContain("Prospect-ID;Bedrijfsnaam");
  });

  it("imports agency feedback with preview, mapping, duplicate detection and append-only history", async () => {
    const companies = await db.select().from(schema.companies).where(eq(schema.companies.status, "exported"));
    const food = companies.find((c) => c.canonicalDomain === "synthfood.example")!;
    const zorg = companies.find((c) => c.canonicalDomain === "synthzorg.example")!;
    const id = (n: number) => `CLSA-${String(n).padStart(6, "0")}`;
    const csv = `Prospect-ID;Bedrijfsnaam;Status;Datum gebeld;Notities\n${id(food.prospectNumber)};x;Geen gehoor;01-12-2026;\n${id(zorg.prospectNumber)};x;Niet meer bellen a.u.b.;01-12-2026;opt-out\nCLSA-999999;Onbekend;Afspraak;01-12-2026;\n`;
    const p1 = await createImportPreview("feedback.csv", Buffer.from(csv), "user:test");
    expect(p1.mapping.prospectId).toBe("Prospect-ID");
    expect(p1.preview.filter((r) => r.errors.length)).toHaveLength(1);
    await commitImport(p1.importId, "user:test");
    // Second import: food now gets an appointment; history must be preserved.
    const csv2 = `Prospect-ID;Status;Datum gebeld\n${id(food.prospectNumber)};Afspraak gepland;03-12-2026\n`;
    const p2 = await createImportPreview("feedback2.csv", Buffer.from(csv2), "user:test");
    await commitImport(p2.importId, "user:test");
    const hist = await db.select().from(schema.callingResults).where(eq(schema.callingResults.companyId, food.id));
    expect(hist).toHaveLength(2);
    expect(hist.filter((h) => h.supersededById === null)).toHaveLength(1);
    expect((await db.select().from(schema.appointments)).length).toBe(1);
    // Re-uploading the same file → duplicates detected, nothing committed twice.
    const p3 = await createImportPreview("feedback2.csv", Buffer.from(csv2), "user:test");
    expect(p3.preview[0].duplicate).toBe(true);
    // Do-not-contact → permanent suppression, cannot be overridden.
    const sup = await db.select().from(schema.suppressions);
    expect(sup.some((s) => s.identifierValue === "synthzorg.example")).toBe(true);
    const [z] = await db.select().from(schema.companies).where(eq(schema.companies.id, zorg.id));
    expect(z.contactEligibility).toBe("suppressed");
    const [qa] = await db.select().from(schema.qaReviews).where(eq(schema.qaReviews.companyId, zorg.id));
    await expect(overrideQa(qa.id, "user:admin", "Proberen te overschrijven na opt-out")).rejects.toThrow(/Opt-out/);
  });

  it("uses feedback to improve subsequent research recommendations", async () => {
    const perf = await commercialPerformance();
    expect(perf.totals.called).toBe(2);
    expect(perf.totals.successes).toBe(1);
    expect(perf.byIndustry.every((g) => g.strength === "speculative")).toBe(true); // n too small → honest labelling
    await queue.send(JOBS.learning, {});
    await queue.drain();
    const recs = await db.select().from(schema.recommendations);
    expect(recs.some((r) => r.createdBy === "agent:sales_operations_manager")).toBe(true);
    // The next CSO plan receives this performance data.
    model.calls.length = 0;
    const r = await createRun("manual", { target: 1, industries: ["food_production"] }, "user:test");
    await queue.drain();
    const plan = await db.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.runId, r.runId), eq(schema.agentTasks.taskType, "plan_week")));
    expect(JSON.stringify(plan[0].input)).toContain('"successes":1');
  });

  it("never re-delivers previously delivered companies", async () => {
    const latest = await db.select().from(schema.prospectLists).orderBy(sql`created_at desc`).limit(1);
    const items = await db.select().from(schema.prospectListItems).where(eq(schema.prospectListItems.listId, latest[0].id));
    const delivered = new Set((await db.select().from(schema.deliveries)).map((d) => d.companyId));
    expect(items.filter((i) => delivered.has(i.companyId))).toHaveLength(0);
  });
});

describe("run control: pause, resume, budget, failure recovery", () => {
  it("pause stops work; resume continues to completion", async () => {
    const r = await createRun("company", { target: 1, companyName: "Synthetische Techniek V.O.F.", companyWebsite: "https://www.synthtech.example" }, "user:test");
    await pauseRun(r.runId, "user:test");
    await queue.drain();
    expect((await getRun(r.runId))?.status).toBe("paused");
    await resumeRun(r.runId, "user:test");
    await queue.drain();
    expect((await getRun(r.runId))?.status).toBe("completed");
  });

  it("retries transient failures and recovers failed tasks", async () => {
    await db.delete(schema.companies).where(eq(schema.companies.canonicalDomain, "synthzuivel.example"));
    model.failNext("Bedrijfsprofiel extraheren", 3);
    const r = await createRun("company", { target: 1, companyName: "Synthetische Zuivel B.V.", companyWebsite: "https://www.synthzuivel.example" }, "user:test");
    await queue.drain(); // attempt 1 fails → candidate pending with error (pg-boss would retry with backoff)
    let [rc] = await db.select().from(schema.runCandidates).where(eq(schema.runCandidates.runId, r.runId));
    expect(rc.lastError).toMatch(/transient/);
    await requeuePending(r.runId);
    await queue.drain(); // attempt 2 fails
    await requeuePending(r.runId);
    await queue.drain(); // attempt 3 fails → marked failed
    [rc] = await db.select().from(schema.runCandidates).where(eq(schema.runCandidates.runId, r.runId));
    expect(rc.status).toBe("failed");
    await requeuePending(r.runId, true); // "retry failed tasks"
    await queue.drain();
    [rc] = await db.select().from(schema.runCandidates).where(eq(schema.runCandidates.runId, r.runId));
    expect(["rejected", "done", "skipped"]).toContain(rc.status);
    expect((await getRun(r.runId))?.status).toBe("completed");
  });

  it("pauses a run when the budget is exhausted", async () => {
    await updateSetting("budget", { ...DEFAULT_SETTINGS.budget, weeklyEur: 0.0001 }, "test");
    const r = await createRun("manual", { target: 2, industries: ["healthcare"] }, "user:test");
    await queue.drain();
    const run = await getRun(r.runId);
    expect(run?.status).toBe("paused");
    expect(run?.pauseReason).toMatch(/Budget/);
    await updateSetting("budget", DEFAULT_SETTINGS.budget, "test");
  });
});

describe("Sales Army HQ (direct agent interaction)", () => {
  it("CSO delegates to a specialist and replies in the thread", async () => {
    const [u] = await db.insert(schema.users).values({ email: "analyst@test.example", role: "analyst" }).returning();
    const threadId = crypto.randomUUID();
    await postChatMessage({ threadId, agentId: "chief_sales_officer", userId: u.id, userRole: "analyst", message: "Welke sectoren moeten we hierna targeten?" });
    await queue.drain();
    const msgs = await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.threadId, threadId));
    expect(msgs.map((m) => m.role)).toEqual(expect.arrayContaining(["user", "delegation", "agent"]));
    expect(msgs.some((m) => m.fromAgent === "market_intelligence_director")).toBe(true);
    expect(msgs.some((m) => m.fromAgent === "chief_sales_officer" && m.role === "agent")).toBe(true);
  });

  it("every one of the eleven agents can execute a real task through the runtime", async () => {
    expect(AGENT_LIST).toHaveLength(11);
    for (const a of AGENT_LIST) {
      const r = await runAgent(a.id, "chat", { message: "Status?", history: [], userRole: "viewer" }, {});
      expect((r.output as { reply: string }).reply.length).toBeGreaterThan(0);
    }
  });

  it("validates structured outputs and rejects unknown tasks/inputs", async () => {
    await expect(runAgent("chief_sales_officer", "does_not_exist", {})).rejects.toThrow();
    await expect(runAgent("chief_sales_officer", "chat", { message: "" })).rejects.toThrow();
  });
});

describe("feedback outcome normalisation", () => {
  it.each([
    ["Afspraak gepland", "appointment_scheduled"],
    ["geen gehoor", "no_answer"],
    ["Niet meer bellen", "do_not_contact"],
    ["Bestaande leverancier", "existing_supplier"],
    ["Terugbellen in januari", "contact_again_later"],
    ["qualified_opportunity", "qualified_opportunity"],
    ["Hoofdkantoor beslist in Duitsland", "no_purchasing_authority"],
    ["???", null],
  ])("%s → %s", (raw, out) => {
    expect(normalizeOutcome(raw)).toBe(out);
  });
});
