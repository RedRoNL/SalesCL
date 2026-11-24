/**
 * SYNTHETIC scripted model used in tests in place of Claude. It drives the
 * real agent runtime through realistic tool-use sequences (search → fetch →
 * submit) so orchestration, validation, persistence and security controls are
 * exercised end to end without network or API keys.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "@/agents/model";
import { WORLD, DIRECTORY_URL, NEWS_HOST, companyByUrl } from "./world";

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
  /** Make the next `count` calls for a task (matched by substring) throw. */
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
        industries: [{ code: "food_production", quota: 8, rationale: "test", sizeFocus: "midmarket" }, { code: "healthcare", quota: 5, rationale: "test", sizeFocus: "midmarket" }, { code: "it_services", quota: 3, rationale: "should be filtered by code", sizeFocus: "midmarket" }],
        hunterAllocation: { enterprise: 0, midmarket: 13, growth: 0 }, searchThemes: ["ledenlijst"], underexploredIndustries: [], risks: [],
      });
    }
    if (task.startsWith("Prospectpools") || task.startsWith("Kandidaten vinden")) {
      if (turn === 0) return msg(p.model, [tool("web_search", { query: `${input.industryName} ledenlijst nederland` })]);
      if (turn === 1) return msg(p.model, [tool("fetch_page", { url: DIRECTORY_URL, source_type: "association" })]);
      if (turn === 2 && tools.includes("start_research_run") === false && input.industry === "healthcare") {
        // Simulate a compromised model attempting a privileged tool → must be denied by the runtime.
        return msg(p.model, [tool("start_research_run", { kind: "manual", target: 5 })]);
      }
      return submit({
        candidates: WORLD.map((c) => ({ name: c.name, website: c.website, city: null, estimatedEmployees: c.employees, sourceId: srcIds[0] ?? null, sourceUrl: DIRECTORY_URL, rationale: "Lid van branchevereniging (synthetisch)" })),
        poolsUsed: [{ name: "Synthetische Branchevereniging", url: DIRECTORY_URL, sourceType: "association", usefulness: "high" }],
        queriesUsed: [`${input.industryName} ledenlijst nederland`], exhaustionEstimate: 0.2, notes: "synthetisch",
      });
    }
    if (task.startsWith("Bedrijfsdossier")) {
      const c = companyByUrl(input.website ?? "") ?? WORLD.find((w) => w.name === input.name)!;
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: c.website, source_type: "official_site" })]);
      const sid = srcIds[srcIds.length - 1];
      const injectionSeen = results.some((r) => r.includes("WAARSCHUWING"));
      return submit({
        officialName: c.name, tradingName: null, website: c.website, industryCode: c.industry, businessCategory: c.category, subIndustry: null,
        hqCity: "Synthstad", hqCountry: "NL", nlOfficeCity: "Synthstad", employeeCount: c.employees, employeeMin: null, employeeMax: null, employeeSourceId: sid,
        groupName: null, groupDomain: null, groupHqCountry: null, purchasingAuthority: "nl_independent", purchasingAuthorityRationale: "Zelfstandige NL-organisatie (synthetisch)",
        legalForm: c.legalForm, legalFormSourceId: sid, kvkNumber: c.kvk, phone: c.phone, phoneSourceId: sid,
        decisionMakerRoles: [{ roleTitle: "IT-manager", roleCategory: "it_manager", fullName: null, sourceId: null }], itSecurityNotes: "",
        compliance: { nis2: c.industry === "healthcare" ? "essential" : "important", dora: false, sensitiveData: true, operationalTechnology: c.industry === "food_production", certificationsOrRegulator: false, rationale: "synthetisch" },
        fieldConfidence: { employees: 0.9, industry: 0.9, headquarters: 0.8, authority: 0.8, phone: 0.9, legalForm: 0.9 },
        facts: [{ field: "employees", value: String(c.employees), sourceId: sid, confidence: 0.9 }, { field: "made_up_fact", value: "x", sourceId: "00000000-0000-4000-8000-000000000000", confidence: 0.9 }],
        unknowns: [], injectionAttemptsObserved: injectionSeen ? ["Instructie-injectie op homepage genegeerd"] : [],
      });
    }
    if (task.startsWith("Microsoft-technologiebewijs")) {
      const c = WORLD.find((w) => w.name === input.name || w.domain === input.domain)!;
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: `${c.website}/vacatures`, source_type: "vacancy" })]);
      return submit({
        claims: [
          { technology: "intune", classification: "confirmed", evidenceType: "vacancy", detail: "Vacature vraagt Intune-ervaring", sourceId: srcIds[0], quote: "ervaring met Microsoft Intune" },
          { technology: "defender", classification: "confirmed", evidenceType: "vacancy", detail: "Overdreven claim", sourceId: srcIds[0], quote: "Defender for Endpoint specialist" },
          { technology: "purview", classification: "confirmed", evidenceType: "website", detail: "Geen bron", sourceId: null, quote: null },
        ],
        summary: "synthetisch",
      });
    }
    if (task.startsWith("Koopsignalen")) {
      const c = WORLD.find((w) => w.name === input.name)!;
      if (c.domain !== "synthfood.example") return submit({ signals: [], notes: "geen signalen" });
      if (turn === 0) return msg(p.model, [tool("fetch_page", { url: `${NEWS_HOST}/${c.domain.split(".")[0]}-copilot`, source_type: "news" })]);
      return submit({ signals: [{ signalType: "copilot_adoption", title: "Copilot-uitrol", explanation: "Uitrol M365 Copilot", relevance: "high", commercialAssessment: "Copilot security assessment relevant", signalDate: new Date().toISOString().slice(0, 10), sourceId: srcIds[0] }], notes: "" });
    }
    if (task.startsWith("Commerciële kwalificatie")) {
      return submit({ recommendedService: input.ruleBasedService, serviceReason: "Regel-gebaseerd", rationale: "Synthetische onderbouwing op basis van het dossier.", recurringPotential: "high", risks: [], researchGaps: [] });
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
