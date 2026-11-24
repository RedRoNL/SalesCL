/**
 * Infrastructure tests: research providers, caching/reuse, authorisation,
 * scheduler. Network calls use injected fetch implementations (SYNTHETIC).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, TEST_DB_URL } from "./helpers/db";
import { schema, type DB } from "@/db/client";
import { HttpFetchProvider, robotsAllows, assertPublicHttpUrl, htmlToText } from "@/research/http";
import { DohDnsProvider } from "@/research/dns";
import { KvkProvider } from "@/research/kvk";
import { FetchBlockedError } from "@/research/types";
import { ResearchService, setProviders } from "@/research/service";
import { FakeDns, FakeFetch, FakeSearch } from "./helpers/world";
import { signSession, verifySession, hasRole } from "@/lib/auth/session";
import { updateSetting, DEFAULT_SETTINGS, getSettings } from "@/lib/settings";
import { assertWithinBudget, assertPaidProviderApproved, BudgetExceededError } from "@/lib/budget";
import { modelCostEur } from "@/lib/costs";
import { toolJsonSchema, TOOLS } from "@/agents/tools";
import { AGENTS } from "@/agents/definitions";
import { buildSystemPrompt } from "@/agents/runtime";
import { loadSkill } from "@/agents/skills";

let db: DB;
let conn: { end: () => Promise<void> };
beforeAll(async () => {
  const c = await setupTestDb();
  db = c.db;
  conn = c.sql;
});
afterAll(async () => {
  setProviders(null);
  await conn.end();
});

const resp = (body: string, init: { status?: number; type?: string; url?: string } = {}) => {
  const r = new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8" } });
  Object.defineProperty(r, "url", { value: init.url ?? "" });
  return r;
};

describe("HTTP research provider (respectful, non-intrusive)", () => {
  it("parses robots.txt with specific and wildcard agents", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: CloudLifeSalesArmyResearchBot\nDisallow: /no-bots\n";
    expect(robotsAllows(robots, "/over-ons")).toBe(true);
    expect(robotsAllows(robots, "/no-bots/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private\nAllow: /private/public", "/private/public/a")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/anything")).toBe(false);
  });

  it("blocks SSRF targets and non-http schemes", () => {
    for (const u of ["http://localhost/x", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/"]) {
      expect(() => assertPublicHttpUrl(u)).toThrow(FetchBlockedError);
    }
    expect(assertPublicHttpUrl("https://www.example.com/over").hostname).toBe("www.example.com");
  });

  it("respects robots.txt disallow", async () => {
    const f = (async (url: string) => (String(url).endsWith("/robots.txt") ? resp("User-agent: *\nDisallow: /secret", { type: "text/plain" }) : resp("<html>ok</html>"))) as typeof fetch;
    const p = new HttpFetchProvider("TestBot", f);
    await expect(p.fetch("https://site.example/secret/page")).rejects.toThrow(/robots/);
    await expect(p.fetch("https://site.example/open")).resolves.toBeTruthy();
  });

  it("never bypasses access controls or CAPTCHAs", async () => {
    const f403 = (async (url: string) => (String(url).endsWith("/robots.txt") ? resp("", { status: 404 }) : resp("Forbidden", { status: 403 }))) as typeof fetch;
    await expect(new HttpFetchProvider("TestBot", f403).fetch("https://site.example/")).rejects.toThrow(/niet omzeild/);
    const fCaptcha = (async (url: string) => (String(url).endsWith("/robots.txt") ? resp("", { status: 404 }) : resp("<html><div class='g-recaptcha'>captcha</div></html>"))) as typeof fetch;
    await expect(new HttpFetchProvider("TestBot", fCaptcha).fetch("https://site.example/")).rejects.toThrow(/CAPTCHA/);
  });

  it("extracts readable text from HTML and drops scripts", () => {
    const { title, text } = htmlToText("<html><head><title>Synth &amp; Co</title><script>alert(1)</script></head><body><h1>Welkom</h1><p>Bel 010-1234567</p></body></html>");
    expect(title).toBe("Synth & Co");
    expect(text).toContain("Bel 010-1234567");
    expect(text).not.toContain("alert");
  });
});

describe("DNS-over-HTTPS provider (passive)", () => {
  it("collects MX/TXT/CNAME records only", async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      const u = new URL(String(url));
      const type = u.searchParams.get("type");
      const name = u.searchParams.get("name")!;
      const ans = type === "MX" ? [{ type: 15, data: "0 synth-example.mail.protection.outlook.com." }] : type === "TXT" ? [{ type: 16, data: '"MS=ms123"' }] : name.startsWith("autodiscover") ? [{ type: 5, data: "autodiscover.outlook.com." }] : [];
      return new Response(JSON.stringify({ Answer: ans }), { headers: { "content-type": "application/dns-json" } });
    }) as typeof fetch;
    const snap = await new DohDnsProvider("https://doh.example/dns-query", f).snapshot("synth.example");
    expect(snap.mx).toEqual(["synth-example.mail.protection.outlook.com."]);
    expect(snap.txt).toEqual(["MS=ms123"]);
    expect(snap.cname.autodiscover).toBe("autodiscover.outlook.com.");
    expect(calls.every((c) => /type=(MX|TXT|CNAME)/.test(c))).toBe(true);
  });
});

describe("KvK provider", () => {
  it("is unavailable without an API key and maps the documented response shape", async () => {
    expect(() => new KvkProvider(undefined)).toThrow(/KVK_API_KEY/);
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/v2/zoeken")) return new Response(JSON.stringify({ resultaten: [{ kvkNummer: "90000001", type: "hoofdvestiging" }] }));
      return new Response(JSON.stringify({ naam: "Synth BV", totaalWerkzamePersonen: 812, _embedded: { eigenaar: { rechtsvorm: "BesloteVennootschap" }, hoofdvestiging: { adressen: [{ plaats: "Synthstad" }] } }, sbiActiviteiten: [{ sbiCode: "1089" }] }));
    }) as typeof fetch;
    const r = await new KvkProvider("synthetic-key", f).search({ name: "Synth" });
    expect(r.records[0]).toMatchObject({ kvkNumber: "90000001", employees: 812, city: "Synthstad", sbi: ["1089"] });
    expect(r.units).toBe(2);
  });
});

describe("research service: provenance, caching and reuse", () => {
  it("stores sources, wraps untrusted content and reuses cached fetches", async () => {
    const fetchP = new FakeFetch();
    setProviders({ search: new FakeSearch(), fetch: fetchP, dns: new FakeDns(), registry: null });
    await updateSetting("research", { ...DEFAULT_SETTINGS.research, requestDelayMs: 0 }, "test");
    const rs = await ResearchService.create({});
    const a = await rs.fetchPage("https://www.synthzorg.example", "official_site");
    expect(a.wrapped).toContain("<untrusted_content");
    expect(a.injectionFlags.length).toBeGreaterThan(0);
    const b = await rs.fetchPage("https://www.synthzorg.example", "official_site");
    expect(fetchP.fetched.filter((u) => u === "https://www.synthzorg.example")).toHaveLength(1); // second hit served from cache
    expect(b.sourceId).not.toBe(a.sourceId);
    const usage = await db.select().from(schema.providerUsage).where(eq(schema.providerUsage.provider, "fake-fetch"));
    expect(usage.some((u) => u.cached)).toBe(true);
  });

  it("requires explicit approval for paid providers and enforces budgets", async () => {
    await expect(assertPaidProviderApproved("firecrawl")).rejects.toThrow(/niet goedgekeurd/);
    await updateSetting("budget", { ...DEFAULT_SETTINGS.budget, approvedPaidProviders: ["firecrawl"] }, "test");
    await expect(assertPaidProviderApproved("firecrawl")).resolves.toBeUndefined();
    await db.insert(schema.providerUsage).values({ provider: "x", operation: "y", units: 1, costEur: "5" });
    await updateSetting("budget", { ...DEFAULT_SETTINGS.budget, weeklyEur: 1 }, "test");
    await expect(assertWithinBudget()).rejects.toBeInstanceOf(BudgetExceededError);
    await updateSetting("budget", DEFAULT_SETTINGS.budget, "test");
  });

  it("computes model cost from usage", () => {
    const eur = modelCostEur("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 }, 1);
    expect(eur).toBeCloseTo(4 + 2, 5);
  });
});

describe("authorisation", () => {
  it("signs and verifies sessions; rejects tampering", async () => {
    const t = await signSession({ sub: "00000000-0000-4000-8000-000000000001", email: "a@test.example", role: "analyst" });
    expect((await verifySession(t))?.role).toBe("analyst");
    const [h, p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), role: "admin" })).toString("base64url");
    expect(await verifySession(`${h}.${forged}.${s}`)).toBeNull();
    expect(await verifySession("garbage")).toBeNull();
  });
  it("enforces role hierarchy", () => {
    const viewer = { sub: "x", email: "v@test.example", role: "viewer" as const };
    expect(hasRole(viewer, "viewer")).toBe(true);
    expect(hasRole(viewer, "analyst")).toBe(false);
    expect(hasRole({ ...viewer, role: "admin" }, "analyst")).toBe(true);
    expect(hasRole(null, "viewer")).toBe(false);
  });
  it("settings are validated before persisting", async () => {
    await expect(updateSetting("schedule", { ...DEFAULT_SETTINGS.schedule, weeklyTarget: -5 }, "test")).rejects.toThrow();
    expect((await getSettings()).schedule.weeklyTarget).toBe(100);
  });
});

describe("agents: least privilege and contracts", () => {
  it("every task's tools are within the agent's allow-list; only CSO can delegate or start runs", () => {
    for (const a of Object.values(AGENTS)) {
      for (const t of Object.values(a.tasks)) for (const tool of t.tools) expect(TOOLS[tool]).toBeTruthy();
      if (a.id !== "chief_sales_officer") {
        expect(a.tools).not.toContain("delegate_to_agent");
        expect(a.tools).not.toContain("start_research_run");
      }
      expect(a.skills.length).toBeGreaterThan(0);
      expect(a.kpis.length).toBeGreaterThan(0);
    }
  });
  it("no tool exists that can contact prospects (call, e-mail, message)", () => {
    expect(Object.keys(TOOLS).filter((t) => /mail|call|sms|message|contact|phone/i.test(t))).toEqual([]);
  });
  it("QA Director cannot see generation tools that change records", () => {
    expect(AGENTS.quality_assurance_director.tools).not.toContain("start_research_run");
    expect(AGENTS.quality_assurance_director.tools).not.toContain("propose_recommendation");
  });
  it("all output schemas convert to JSON schema for the API", () => {
    for (const a of Object.values(AGENTS)) for (const t of Object.values(a.tasks)) expect(toolJsonSchema(t.output).type).toBe("object");
  });
  it("system prompts include security rules, company knowledge and installed skills", () => {
    const p = buildSystemPrompt("company_research_specialist", AGENTS.company_research_specialist.tasks.enrich_company, DEFAULT_SETTINGS);
    expect(p).toContain("untrusted_content");
    expect(p).toContain("Protect 365");
    expect(p).toContain('skill "lead-research-assistant"');
    expect(loadSkill("../../etc/passwd")).toBeNull();
  });
});

describe("scheduler (pg-boss, Europe/Amsterdam)", () => {
  it("registers the weekly Monday 08:00 schedule and maintenance jobs", async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    const { getBoss } = await import("@/pipeline/queue");
    const { syncSchedules } = await import("@/worker/schedule");
    const boss = await getBoss();
    const label = await syncSchedules(boss);
    expect(label).toBe("0 8 * * 1 (Europe/Amsterdam)");
    const schedules = await boss.getSchedules();
    const weekly = schedules.find((s) => s.name === "weekly-trigger");
    expect(weekly?.cron).toBe("0 8 * * 1");
    expect(weekly?.options?.tz ?? (weekly as { timezone?: string })?.timezone).toBe("Europe/Amsterdam");
    expect(schedules.map((s) => s.name)).toEqual(expect.arrayContaining(["run-watchdog", "retention-cleanup", "learning-analyze"]));
    // Disabling the schedule removes it.
    await updateSetting("schedule", { ...DEFAULT_SETTINGS.schedule, enabled: false }, "test");
    await syncSchedules(boss);
    expect((await boss.getSchedules()).find((s) => s.name === "weekly-trigger")).toBeUndefined();
    await updateSetting("schedule", DEFAULT_SETTINGS.schedule, "test");
    await boss.stop({ graceful: false });
  });
});
