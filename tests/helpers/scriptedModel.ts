/**
 * SYNTHETIC scripted model used in tests in place of Claude. It drives the real agent
 * runtime through realistic tool-use sequences so orchestration, validation, persistence
 * and security controls are exercised end to end without network or API keys.
 * It deliberately includes bad behaviour (a fabricated company name, a fabricated quote,
 * a privileged tool call after reading an injected page) to prove the code rejects it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "@/agents/model";
import { ALL, WORLD, DIRECTORY_URL, SCOUT_URL, NEWS_HOST, companyByUrl, contactText, aboutText } from "./world";

type Block = Anthropic.ContentBlock;
let n = 0;

function msg(model: string, content: unknown[], stop: Anthropic.StopReason = "tool_use"): Anthropic.Message {
  return {
    id: `msg_synthetic_${++n}`, type: "message", role: "assistant", model, content: content as Block[], stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, service_tier: null },
  } as unknown as Anthropic.Message;
}
const tool = (name: string, input: unknown) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });

export class ScriptedModel implements ModelClient {
  calls: { task: string; model: string; tools: string[] }[] = [];
  failures = new Map<string, number>();
  toolResultsSeen: string[] = [];
  failNext(taskSubstring: string, count: number) {
    this.failures.set(taskSubstring, count);
  }

  async create(p: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    const sys = Array.isArray(p.system) ? p.system.map((s) => s.text).join("\n") : String(p.system ?? "");
    const task = sys.match(/# Taak: (.+)/)?.[1] ?? "?";
    const tools = (p.tools ?? []).map((t) => (t as { name: string }).name);
    this.calls.push({ task, model: p.model, tools });
    for (const [k, v] of this.failures) if (task.includes(k) && v > 0) {
      this.failures.set(k, v - 1);
      throw new Error(`Synthetic transient failure (${k})`);
    }
    const results: string[] = [];
    for (const m of p.messages) if (Array.isArray(m.content)) for (const b of m.content) if ((b as { type: string }).type === "tool_result") {
      const c = (b as { content?: unknown }).content;
      results.push(typeof c === "string" ? c : JSON.stringify(c));
    }
    this.toolResultsSeen.push(...results.slice(-1));
    const srcIds = [...results.join("\n").matchAll(/source_id[:=]\s*"?([0-9a-f-]{36})/g)].map((m) => m[1]);
    const firstUser = p.messages[0].content as string;
    const input = JSON.parse(firstUser.slice(firstUser.indexOf("{"), firstUser.lastIndexOf("}") + 1));
    const turn = results.length;
    const submit = (out: unknown) => msg(p.model, [tool("submit_result", out)]);

    if (task.startsWith("Wekelijkse onderzoeksstrategie")) {
      return submit({
        strategySummary: "Synthetische strategie: focus op voedselproductie en zorg (test).",
        industries: [{ code: "food_production", quota: 8, rationale: "test", sizeFocus: "midmarket" }, { code: "healthcare", quota: 5, rationale: "test", sizeFocus: "midmarket" }, { code: "it_services", quota: 3, rationale: "must be filtered by code", sizeFocus: "midmarket" }],
        hunterAllocation: { enterprise: 0, midmarket: 13, growth: 0 }, searchThemes: ["ledenlijst"], underexploredIndustries: [], risks: [],
      });
    }
    if (task.startsWith("Organisaties uit een bronpagina")) {
      const names = ALL.filter((c) => input.page.includes(c.name)).map((c) => ({ name: c.name, website: null, city: null, role: "member" }));
      return submit({ isCompanyList: names.length > 0, companies: [...names, { name: "Verzonnen Fantasie Holding", website: null, city: null, role: "member" }] });
    }
    if (task.startsWith("Nieuwe ontdekkingsbronnen")) {
      if (input.industry !== "food_production") return submit({ sources: [], notes: "geen" });
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: SCOUT_URL, source_type: "directory" })]);
      return submit({ sources: [{ name: "Synthbeurs exposanten", sourceType: "trade_fair", url: SCOUT_URL, query: null, rationale: "Exposantenlijst (synthetisch)" }, { name: "Niet opgehaald", sourceType: "ranking", url: "https://unfetched.example/top100", query: null, rationale: "must be rejected: not retrieved" }], notes: "" });
    }
    if (task.startsWith("Gerichte prospectjacht")) {
      if (turn === 0) return msg(p.model, [tool("web_search", { query: `${input.industryName} vacature Intune` })]);
      if (turn === 1) return msg(p.model, [tool("fetch_page", { url: DIRECTORY_URL, source_type: "association" })]);
      if (turn === 2 && input.industry === "healthcare") return msg(p.model, [tool("start_research_run", { kind: "manual", target: 5 })]);
      return submit({
        candidates: WORLD.slice(0, 2).map((c) => ({ name: c.name, website: c.website, city: null, estimatedEmployees: c.employees, sourceId: srcIds[0] ?? null, sourceUrl: DIRECTORY_URL, rationale: "synthetisch" })),
        poolsUsed: [{ name: "Synthetische Branchevereniging", url: DIRECTORY_URL, sourceType: "association", usefulness: "high" }], queriesUsed: ["vacature intune"], exhaustionEstimate: 0.5, notes: "synthetisch",
      });
    }
    if (task.startsWith("Bedrijfsprofiel extraheren")) {
      const pages: { sourceId: string; kind: string; url: string; content: string }[] = input.pages;
      const c = companyByUrl(pages[0].url)!;
      const contact = pages.find((x) => x.url.endsWith("/contact"));
      const about = pages.find((x) => x.url.endsWith("/over-ons"));
      const vac = pages.find((x) => x.url.endsWith("/vacatures"));
      return submit({
        officialName: c.name, tradingName: null, industryCode: c.industry, businessCategory: c.category, subIndustry: null, hqCity: "Synthstad", hqCountry: "NL",
        employees: about ? { count: c.employees, min: null, max: null, sourceId: about.sourceId, quote: aboutText(c).slice(0, 60) } : null,
        group: null, purchasingAuthority: "nl_independent", purchasingAuthorityQuote: about ? `Over ${c.name}` : null,
        legalForm: contact ? { value: c.legalForm, sourceId: contact.sourceId, quote: c.name } : null,
        kvkNumber: contact ? { value: c.kvk, sourceId: contact.sourceId, quote: `KvK ${c.kvk}` } : null,
        compliance: { nis2: c.industry === "healthcare" ? "essential" : "important", dora: false, sensitiveData: true, operationalTechnology: c.industry === "food_production", certificationsOrRegulator: false, rationale: "synthetisch" },
        msClaims: vac && c.vacancy ? [
          { technology: "intune", classification: "confirmed", sourceId: vac.sourceId, quote: "ervaring met Microsoft Intune" },
          { technology: "defender", classification: "confirmed", sourceId: vac.sourceId, quote: "Defender for Endpoint specialist" }, // fabricated quote → must be dropped
        ] : [],
        signals: [], decisionMakerRoles: [], unknowns: [],
        injectionAttemptsObserved: pages.some((x) => x.content.includes("IGNORE ALL")) ? ["Instructie-injectie op homepage genegeerd"] : [],
      });
    }
    if (task.startsWith("Kritieke gaten")) {
      return submit({ employees: null, legalForm: null, kvkNumber: null, phone: null, purchasingAuthority: "unknown", purchasingAuthorityQuote: null, group: null, stillUnknown: input.gaps });
    }
    if (task.startsWith("Microsoft-technologiebewijs")) {
      const c = ALL.find((w) => w.name === input.name || w.domain === input.domain);
      if (!c || turn > 0) return submit({ claims: [], summary: "geen aanvullend bewijs gevonden" });
      return msg(p.model, [tool("fetch_page", { url: `${c.website}/vacatures`, source_type: "vacancy" })]);
    }
    if (task.startsWith("Koopsignalen")) {
      const c = ALL.find((w) => w.name === input.name)!;
      if (c.domain !== "synthfood.example") return submit({ signals: [], notes: "geen signalen" });
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: `${NEWS_HOST}/${c.domain.split(".")[0]}-copilot`, source_type: "news" })]);
      return submit({ signals: [{ signalType: "copilot_adoption", title: "Copilot-uitrol", explanation: "Uitrol M365 Copilot", relevance: "high", commercialAssessment: "Copilot security assessment relevant", signalDate: new Date().toISOString().slice(0, 10), sourceId: srcIds[0] }], notes: "" });
    }
    if (task.startsWith("Commerciële onderbouwing (batch)")) {
      return submit({ items: input.companies.map((c: { companyId: string; ruleBasedService: string }) => ({ companyId: c.companyId, rationale: "Synthetische onderbouwing op basis van het dossier (batch).", recommendedService: c.ruleBasedService, serviceReason: "regel", recurringPotential: "high" })) });
    }
    if (task.startsWith("Onafhankelijke QA-review")) {
      const d = input.dossier;
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: d.company.website, source_type: "official_site" })]);
      const ok = { pass: true, note: "geverifieerd (synthetisch)" };
      return submit({ verdict: "approved", checks: { companyExists: ok, websiteVerified: ok, phoneVerified: ok, employeeEstimateSupported: ok, technologyClaimsSupported: ok, relevantProspect: ok, noDuplicate: ok, exclusionsReviewed: ok, contactEligibility: ok, evidenceSufficient: ok }, hallucinationSuspected: false, issues: [] });
    }
    if (task.startsWith("Weeklijst beoordelen")) {
      return submit({ approveForReview: true, decisionRationale: "ok", concerns: ["Tekort ten opzichte van doel"], managementSummary: "## Managementsamenvatting (synthetisch)\nDe weeklijst bevat gekwalificeerde prospects; het tekort is expliciet gerapporteerd." });
    }
    if (task.startsWith("Commerciële feedbackanalyse")) {
      return submit({ summary: "Synthetische analyse", recommendations: [{ type: "search_strategy", title: "Meer zorg", content: "Speculatief", evidenceStrength: "speculative" }] });
    }
    if (task.startsWith("Direct gesprek")) {
      if (tools.includes("delegate_to_agent") && turn === 0) return msg(p.model, [tool("delegate_to_agent", { agent_id: "market_intelligence_director", instruction: "Welke sectoren zijn onderbenut?" })]);
      return submit({ reply: `Antwoord van agent (synthetisch). ${results.length ? "Gedelegeerd resultaat ontvangen." : ""}`, findings: [], recommendations: [] });
    }
    return msg(p.model, [{ type: "text", text: "?" }], "end_turn");
  }
}

export { contactText };
