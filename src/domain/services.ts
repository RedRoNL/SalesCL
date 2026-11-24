import { CLASS_RANK, type EvidenceClass, type MsTech } from "./msEvidence";
import type { ComplianceFactors } from "./scoring";

export const SERVICES = [
  "protect_365",
  "purview_care",
  "protect_365_purview_care",
  "ms_security_assessment",
  "purview_assessment",
  "copilot_security_assessment",
  "agentic_ai_security_assessment",
] as const;
export type Service = (typeof SERVICES)[number];

export const SERVICE_LABELS: Record<Service, string> = {
  protect_365: "Protect 365",
  purview_care: "Purview Care",
  protect_365_purview_care: "Protect 365 + Purview Care",
  ms_security_assessment: "Microsoft Security Assessment",
  purview_assessment: "Microsoft Purview Assessment",
  copilot_security_assessment: "Microsoft Copilot Security Assessment",
  agentic_ai_security_assessment: "Agentic AI Security Assessment",
};

export interface ServiceInput {
  msEvidence: Partial<Record<MsTech, EvidenceClass>>;
  compliance: ComplianceFactors;
  signalTypes: string[];
  employees: number | null;
}

/**
 * Deterministic service recommendation. The qualification agent supplies the
 * narrative rationale; this function decides the entry point so the
 * recommendation is reproducible and analysable against outcomes.
 */
export function recommendService(i: ServiceInput): { service: Service; reasons: string[] } {
  const r = (t: MsTech) => CLASS_RANK[i.msEvidence[t] ?? "unknown"];
  const reasons: string[] = [];
  const m365 = Math.max(r("microsoft_365"), r("exchange_online"));
  const dataHeavy = Boolean(i.compliance.sensitiveData || i.compliance.dora);
  const sig = new Set(i.signalTypes);

  if (sig.has("agentic_ai") || sig.has("ai_agents")) {
    reasons.push("Publiek signaal over AI-agents/agentic AI");
    return { service: "agentic_ai_security_assessment", reasons };
  }
  if (sig.has("copilot_adoption") || r("copilot") >= 2) {
    reasons.push("Copilot-adoptie: data-oversharing en labeling zijn het instappunt");
    return { service: "copilot_security_assessment", reasons };
  }
  if (m365 < 2) {
    reasons.push("Microsoft-omgeving nog niet sterk aangetoond — assessment als laagdrempelig instappunt");
    return { service: "ms_security_assessment", reasons };
  }
  if (r("purview") >= 2 || sig.has("data_governance")) {
    reasons.push("Purview/data-governance-indicatie");
    return { service: dataHeavy ? "protect_365_purview_care" : "purview_care", reasons };
  }
  if (dataHeavy && (i.employees ?? 0) >= 300) {
    reasons.push("M365 aanwezig, gevoelige/gereguleerde data en voldoende omvang voor gecombineerde dienst");
    return { service: "protect_365_purview_care", reasons };
  }
  if (dataHeavy) {
    reasons.push("Gereguleerde data: Purview-assessment als instap");
    return { service: "purview_assessment", reasons };
  }
  reasons.push("M365 aanwezig; continue configuratie- en identiteitsbeveiliging is het primaire waardevoorstel");
  return { service: "protect_365", reasons };
}
