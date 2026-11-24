/**
 * Tests for the v2 review changes. All fixtures are SYNTHETIC (".example" domains).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "./helpers/db";
import { ScriptedModel } from "./helpers/scriptedModel";
import { FakeDns, FakeFetch, FakeSearch, DIRECTORY_HOME } from "./helpers/world";
import { schema, type DB } from "@/db/client";
import { extractDeterministic, selectSubpages, quoteFound, focusExcerpt } from "@/research/extract";
import { classifyDns, technologyConfidence, mailGateway, summarizeEvidence } from "@/domain/msEvidence";
import { potentialScore, scoreCompany } from "@/domain/scoring";
import { selectSources, type SourceStat } from "@/discovery/sources";
import { linkCandidates } from "@/discovery/work";
import { estimateWeeklyCost, SCENARIOS } from "@/lib/costModel";
import { encrypt, decrypt, setSecret, getSecret, clearSecretCache, secretStatus } from "@/lib/secrets";
import { createHistoricalPreview, commitHistorical } from "@/lib/historicalImport";
import { findExistingCompany } from "@/pipeline/identity";
import { registerCandidate } from "@/pipeline/candidates";
import { tokenMatches } from "@/lib/auth/bootstrap";
import { startPilot, pilotMetrics } from "@/lib/pilots";
import { setModelClient } from "@/agents/model";
import { setProviders } from "@/research/service";
import { InlineQueue, setQueue } from "@/pipeline/queue";
import { handlers } from "@/worker/handlers";
import { createRun, getRun } from "@/pipeline/runs";
import { updateSetting, DEFAULT_SETTINGS } from "@/lib/settings";

let db: DB;
let conn: { end: () => Promise<void> };
beforeAll(async () => {
  const c = await setupTestDb();
  db = c.db;
  conn = c.sql;
});
afterAll(async () => {
  setModelClient(null);
  setProviders(null);
  setQueue(null);
  await conn.end();
});

describe("deterministic page extraction (free screening)", () => {
  const pages = [
    { sourceId: "s-home", url: "https://www.acme.example", kind: "home" as const, text: "Welkom bij Acme Synthetic B.V. — ruim 1.250 medewerkers werken dagelijks aan voedselveiligheid." },
    { sourceId: "s-contact", url: "https://www.acme.example/contact", kind: "contact" as const, text: "Contact: Industrieweg 1, Synthstad. Telefoon +31 (0)10 - 123 45 67. Service 06-12345678. KvK-nummer: 12345678. ISO 27001 gecertificeerd." },
    { sourceId: "s-jobs", url: "https://www.acme.example/vacatures", kind: "careers" as const, text: "Vacature: Security Officer. Je beheert Microsoft Intune en Microsoft Defender for Endpoint. Wij werken met Microsoft 365." },
    { sourceId: "s-news", url: "https://www.acme.example/nieuws", kind: "news" as const, text: "Tijdens het event demonstreerden we Microsoft Teams." },
  ];
  const p = extractDeterministic(pages);
  it("finds the public switchboard number and ignores mobile numbers", () => {
    expect(p.bestPhone?.value).toBe("+31101234567");
    expect(p.phones.some((x) => x.value.startsWith("+316"))).toBe(false);
  });
  it("extracts KvK, legal form and employee counts with quotes", () => {
    expect(p.bestKvk?.value).toBe("12345678");
    expect(p.bestLegalForm?.value).toBe("bv");
    expect(p.bestEmployees?.value).toBe(1250);
    expect(quoteFound(pages[0].text, p.bestEmployees!.quote)).toBe(true);
  });
  it("classifies Microsoft mentions per page type, separately per technology", () => {
    const by = (t: string) => p.msMentions.filter((m) => m.value === t);
    expect(by("intune")[0].classification).toBe("strongly_indicated"); // vacancy page
    expect(by("defender")[0].evidenceType).toBe("vacancy");
    expect(by("microsoft_365")[0].classification).toBe("strongly_indicated"); // adoption phrasing
    expect(by("teams")[0].classification).toBe("weakly_indicated"); // a mere mention on a news page
    expect(by("purview")).toHaveLength(0);
  });
  it("finds security vacancies and certifications as sourced signals/compliance", () => {
    expect(p.securityVacancies.map((v) => v.value.toLowerCase())).toContain("security officer");
    expect(p.certifications.map((c) => c.value)).toContain("ISO27001");
  });
  it("selects one subpage per useful kind on the company's own site", () => {
    const sel = selectSubpages("https://www.acme.example", [
      { href: "https://www.acme.example/contact", text: "Contact" }, { href: "https://www.acme.example/over-ons", text: "Over ons" },
      { href: "https://www.acme.example/contact-2", text: "Contact" }, { href: "https://www.linkedin.com/company/acme", text: "Vacatures" },
      { href: "https://werkenbij.acme.example/vacatures", text: "Werken bij" }, { href: "https://www.acme.example/brochure.pdf", text: "Over ons pdf" },
    ]);
    expect(sel.map((s) => s.kind)).toEqual(["contact", "about", "careers"]);
    expect(sel.find((s) => s.kind === "careers")!.url).toContain("werkenbij.acme.example");
  });
});

describe("Microsoft intelligence v2", () => {
  it("detects mail security gateways in front of Exchange Online", () => {
    expect(mailGateway(["eu-smtp-inbound-1.mimecast.com"])).toBe("Mimecast");
    const ev = classifyDns({ domain: "x", mx: ["mx1.synthx.pphosted.com"], txt: ["v=spf1 include:spf.protection.outlook.com -all"], cname: { "selector1._domainkey": "selector1-x._domainkey.x.onmicrosoft.com" } });
    expect(summarizeEvidence(ev).exchange_online).toBe("strongly_indicated");
  });
  it("uses Teams SRV and optional tenant metadata", () => {
    const ev = classifyDns({ domain: "x", mx: [], txt: [], cname: {}, srv: { "_sipfederationtls._tcp": "sipfed.online.lync.com." }, tenant: { exists: true, tenantId: "11111111-2222-3333-4444-555555555555" } });
    const s = summarizeEvidence(ev);
    expect(s.teams).toBe("strongly_indicated");
    expect(s.entra_id).toBe("strongly_indicated");
    expect(s.intune).toBe("unknown");
  });
  it("keeps separate confidence per technology; mail never lifts the security stack", () => {
    const items = [
      ...classifyDns({ domain: "x", mx: ["x.mail.protection.outlook.com"], txt: ["MS=ms1"], cname: { autodiscover: "autodiscover.outlook.com" } }),
      { technology: "intune" as const, classification: "strongly_indicated" as const, evidenceType: "vacancy", detail: "" },
      { technology: "intune" as const, classification: "weakly_indicated" as const, evidenceType: "vacancy", detail: "" },
    ];
    const c = technologyConfidence(items);
    expect(c.exchange_online.confidence).toBeGreaterThan(0.9);
    expect(c.intune.confidence).toBe(0.75); // same evidence type counted once (strongest)
    expect(c.defender.confidence).toBe(0);
    expect(c.purview.confidence).toBe(0);
  });
});

describe("progressive research economics", () => {
  const base = { msEvidence: {}, employees: null, industryTier: 1, compliance: { nis2: "important" as const }, purchasingAuthority: "unknown", signals: [], fieldConfidence: {}, sourceCount: 1 };
  it("potential score gives bounded upside to unknowns but never forgives known negatives", () => {
    expect(potentialScore(base)).toBeGreaterThan(scoreCompany(base).fitScore);
    expect(potentialScore({ ...base, msEvidence: { microsoft_365: "contradicted" } })).toBeLessThan(potentialScore(base));
    expect(potentialScore({ ...base, purchasingAuthority: "abroad_central" })).toBe(0);
  });
  it("cost model: scenarios are ordered and explicit", () => {
    const c = estimateWeeklyCost(SCENARIOS.conservative);
    const r = estimateWeeklyCost(SCENARIOS.realistic);
    const h = estimateWeeklyCost(SCENARIOS.high_volume);
    expect(r.weeklyEur).toBeLessThan(c.weeklyEur);
    expect(h.weeklyEur).toBeGreaterThan(r.weeklyEur);
    expect(r.lines.find((l) => l.item.startsWith("Screening"))!.eurPerWeek).toBe(0);
    expect(r.perQualifiedEur).toBeGreaterThan(0);
    expect(r.monthlyEur).toBeCloseTo((r.weeklyEur - r.fixedMonthlyEur / 4.33) * 4.33 + r.fixedMonthlyEur, 3);
  });
});

describe("discovery-source prioritisation", () => {
  const mk = (id: string, o: Partial<SourceStat>): SourceStat => ({ id, kind: "page", sourceType: "association", name: id, url: `https://${id}.example`, query: null, industryCodes: ["manufacturing"], status: "active", origin: "seed", harvestCount: 1, lastHarvestedAt: "2020-01-01", reharvestDays: 90, found: 10, uniqueNew: 10, qualified: 0, delivered: 0, appointments: 0, priority: 10, ...o });
  it("exploits high-yield sources and reserves exploration slots for new ones", () => {
    const stats = [mk("great", { priority: 80, qualified: 8 }), mk("poor", { priority: 5 }), mk("new1", { harvestCount: 0, status: "unverified", lastHarvestedAt: null }), mk("other-sector", { industryCodes: ["energy"], priority: 99 })];
    const picks = selectSources(stats, "manufacturing", 2, 0.5);
    expect(picks.map((p) => p.sourceId).sort()).toEqual(["great", "new1"]);
    expect(picks.find((p) => p.sourceId === "new1")!.exploration).toBe(true);
  });
  it("respects re-harvest intervals and excludes blocked/exhausted sources", () => {
    const stats = [mk("recent", { lastHarvestedAt: new Date().toISOString(), priority: 90 }), mk("blocked", { status: "blocked" }), mk("ok", { priority: 20 })];
    expect(selectSources(stats, "manufacturing", 3, 0).map((p) => p.sourceId)).toEqual(["ok"]);
  });
  it("focus excerpt drops navigation and keeps fact lines verbatim", () => {
    const nav = Array.from({ length: 200 }, (_, i) => `Menu ${i} [https://www.acme.example/m${i}]`).join("\n");
    const text = `${nav}\nProducten\nOver ons\n${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(80)}\nBij Acme Synthetic B.V. werken ruim 650 medewerkers in Nederland.`;
    const ex = focusExcerpt(text, 1500);
    expect(ex).toContain("Bij Acme Synthetic B.V. werken ruim 650 medewerkers in Nederland.");
    expect(ex).not.toContain("Menu 1 [");
    expect(quoteFound(text, "werken ruim 650 medewerkers in Nederland")).toBe(true);
  });

  it("never turns navigation/footer anchors into company names (live-harvest regression)", () => {
    const c = linkCandidates({ url: "https://beurs.example/", links: [
      { href: "https://www.organisator.example/", text: "© 2026 Organisator" },
      { href: "https://leden.example/voordelen", text: "Ga naar Members&rsquo; Benefits &raquo;" },
      { href: "https://www.echtbedrijf.example/", text: "Echt Bedrijf B.V." },
    ] });
    expect(c.find((x) => x.website.includes("echtbedrijf"))?.name).toBe("Echt Bedrijf B.V.");
    expect(c.map((x) => x.name)).not.toContain("© 2026 Organisator");
    expect(c.some((x) => /Ga naar|&rsquo;/.test(x.name))).toBe(false);
  });

  it("extracts company candidates from outbound links, skipping platforms and generic anchors", () => {
    const c = linkCandidates({ url: "https://vereniging.example/leden", links: [
      { href: "https://www.lid-een.example/", text: "Lid Een B.V." }, { href: "https://www.linkedin.com/x", text: "LinkedIn" },
      { href: "https://vereniging.example/agenda", text: "Agenda" }, { href: "https://lid-twee.example", text: "Lees meer" },
    ] });
    // "Lees meer" is no name, and a name is never guessed from the domain (live-pilot finding).
    expect(c).toEqual([{ name: "Lid Een B.V.", website: "https://lid-een.example" }]);
  });
});

describe("encrypted secrets store", () => {
  it("round-trips with AES-GCM and detects tampering", () => {
    const e = encrypt("sk-ant-synthetic-123456");
    expect(decrypt(e)).toBe("sk-ant-synthetic-123456");
    expect(() => decrypt({ ...e, ciphertext: Buffer.from("x" + e.ciphertext).toString("base64") })).toThrow();
  });
  it("stores write-only values; env variables take precedence", async () => {
    await setSecret("FIRECRAWL_API_KEY", "fc-synthetic-abcdef", "test");
    clearSecretCache();
    expect(await getSecret("FIRECRAWL_API_KEY")).toBe("fc-synthetic-abcdef");
    const status = await secretStatus();
    expect(status.FIRECRAWL_API_KEY).toMatchObject({ source: "database", last4: "cdef" });
    const [row] = await db.select().from(schema.secrets).where(eq(schema.secrets.key, "FIRECRAWL_API_KEY"));
    expect(row.ciphertext).not.toContain("synthetic");
    process.env.FIRECRAWL_API_KEY = "fc-from-env-999999";
    expect(await getSecret("FIRECRAWL_API_KEY")).toBe("fc-from-env-999999");
    delete process.env.FIRECRAWL_API_KEY;
  });
});

describe("historical imports with messy data", () => {
  it("matches inconsistent names, email domains, phones and remembers every variant", async () => {
    // Existing record (e.g. from an earlier run) with its current website.
    await db.insert(schema.companies).values({ officialName: "Synthetische Metaal Groep B.V.", normalizedName: "synthetische metaal", canonicalDomain: "synthmetaal-new.example", phonePublic: "+31401112233" });
    const csv = [
      "Bedrijf;Website;Email contact;Tel;Datum;Status",
      "SYNTHETISCHE METAAL GROEP;www.synthmetaal-OLD.example;;040-1112233;03-02-2025;Geen interesse", // phone match, outdated website
      "Synth Logistiek Holding BV;;inkoop@synthlogistiek.example;;10-02-2025;Afspraak gepland", // email-derived domain, new
      "Synth Logistiek Holding;;;;;", // same company again in the file
      "Synthetisch Bakkerij;http://bakkerij.example;;;; Niet bellen",
    ].join("\n");
    const p = await createHistoricalPreview("historical_list", "oude-lijst.csv", Buffer.from(csv), "test");
    expect(p.mapping.email).toBe("Email contact");
    expect(p.preview[0].matchMethod).toBe("phone");
    expect(p.preview[1].domain).toBe("synthlogistiek.example");
    const r = await commitHistorical(p.importId, "test");
    expect(r.created).toBe(2);
    expect(r.linked).toBe(2);
    // Later discovery under the OLD website or the email domain is recognised as already delivered.
    const old = await findExistingCompany({ name: "Totaal Andere Naam", domain: "https://synthmetaal-old.example" });
    expect(old?.reason).toBe("domain");
    expect(old?.delivered).toBe(true);
    const run = await createRunRow();
    const reg = await registerCandidate(run, { name: "Synth Logistiek", website: "https://www.synthlogistiek.example", discoveredBy: "test" });
    expect(reg.status).toBe("duplicate");
    // "Niet bellen" in a historical list → permanent suppression.
    const sup = await db.select().from(schema.suppressions);
    expect(sup.some((s) => s.identifierValue === "bakkerij.example")).toBe(true);
  });
  it("imports opt-out lists as permanent suppressions", async () => {
    const p = await createHistoricalPreview("optouts", "optout.csv", Buffer.from("Naam,KvK\nSynth Optout BV,99887766\n"), "test");
    await commitHistorical(p.importId, "test");
    expect((await db.select().from(schema.suppressions)).some((s) => s.identifierValue === "99887766")).toBe(true);
  });
});

async function createRunRow() {
  const [r] = await db.insert(schema.researchRuns).values({ kind: "manual", params: { target: 1 }, triggeredBy: "test", status: "running" }).returning();
  return r.id;
}

describe("bootstrap & pilots", () => {
  it("setup token must match and be long enough", () => {
    process.env.SETUP_TOKEN = "synthetic-setup-token-0123456789";
    expect(tokenMatches("synthetic-setup-token-0123456789")).toBe(true);
    expect(tokenMatches("wrong")).toBe(false);
    process.env.SETUP_TOKEN = "short";
    expect(tokenMatches("short")).toBe(false);
    delete process.env.SETUP_TOKEN;
  });
  it("live pilots require explicit budget approval", async () => {
    await expect(startPilot("manufacturing", 10, false, "test")).rejects.toThrow(/goedkeuring/);
    await expect(startPilot("manufacturing", 500, true, "test")).rejects.toThrow(/budget/);
  });
});

describe("funnel: target reached → reserve, reused by the next run; pilot metrics", () => {
  it("parks remaining candidates as reserve and reuses them later without re-screening", async () => {
    const model = new ScriptedModel();
    setModelClient(model);
    const fetchP = new FakeFetch();
    setProviders({ search: new FakeSearch(), fetch: fetchP, dns: new FakeDns(), registry: null });
    const queue = new InlineQueue();
    for (const [n, h] of Object.entries(handlers)) queue.on(n as never, h as never);
    setQueue(queue);
    await updateSetting("research", { ...DEFAULT_SETTINGS.research, requestDelayMs: 0, targetBufferFactor: 1 }, "test");
    await db.delete(schema.discoverySources);
    await db.insert(schema.discoverySources).values({ kind: "page", sourceType: "association", name: "Synth", url: DIRECTORY_HOME, industryCodes: ["food_production", "healthcare"], origin: "seed" });

    const r = await startPilot("operational", 20, true, "test");
    await db.update(schema.researchRuns).set({ params: { target: 1, industries: ["food_production"], minEmployees: 300, maxEmployees: 5000, pilot: "operational" }, targetProspects: 1 }).where(eq(schema.researchRuns.id, r.runId));
    await queue.drain();
    const run = await getRun(r.runId);
    expect(run?.status).toBe("completed");
    expect((run!.stats as Record<string, number>).reserve).toBeGreaterThan(0);
    const m = (await pilotMetrics(r.runId))!;
    expect(m.qualified).toBe(1);
    expect(m.verifiedPhones).toBeGreaterThanOrEqual(1);
    expect(m.verifiedEmployeeCounts).toBeGreaterThanOrEqual(1);
    expect(m.sourceQuality[0].name).toBe("Synth");
    // Per-run cap (target × multiplier × 1.6 = 4) bounds ACTIVE/qualified slots; rejected ones free their slot; total ≤ 4×.
    const active = (await db.select().from(schema.runCandidates).where(eq(schema.runCandidates.runId, r.runId))).filter((x) => ["pending", "in_progress", "done"].includes(x.status));
    expect(active.length).toBeLessThanOrEqual(4);
    expect(m.candidatesDiscovered).toBeLessThanOrEqual(16);
    expect(m.costPerQualifiedEur).toBeGreaterThan(0);

    // Next run: reserve candidates are fed back first; their pages come from cache (no re-fetch).
    const fetchedBefore = fetchP.fetched.length;
    const r2 = await createRun("sector", { target: 1, industries: ["food_production"] }, "test");
    await queue.drain();
    expect((await getRun(r2.runId))!.stats).toMatchObject({ reserveReused: expect.any(Number) });
    expect(fetchP.fetched.length - fetchedBefore).toBeLessThan(5);
  });
});
