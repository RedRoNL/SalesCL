import type { z } from "zod";

export const AGENT_IDS = [
  "chief_sales_officer",
  "market_intelligence_director",
  "enterprise_hunter",
  "midmarket_hunter",
  "growth_market_hunter",
  "microsoft_intelligence_specialist",
  "buying_signal_analyst",
  "company_research_specialist",
  "lead_qualification_specialist",
  "quality_assurance_director",
  "sales_operations_manager",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type ToolName =
  | "web_search"
  | "fetch_page"
  | "dns_lookup"
  | "registry_lookup"
  | "lookup_company_db"
  | "get_company_dossier"
  | "get_commercial_performance"
  | "get_market_map"
  | "get_run_status"
  | "delegate_to_agent"
  | "start_research_run"
  | "propose_recommendation";

export type ModelTier = "fast" | "standard" | "strong";

export interface AgentTask<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** Task type key, e.g. "enrich_company" */
  type: string;
  description: string;
  input: I;
  output: O;
  /** Task-specific instructions appended to the agent system prompt. */
  instructions: string;
  tools: ToolName[];
  modelTier?: ModelTier;
  maxTurns?: number;
}

export interface AgentDefinition {
  id: AgentId;
  number: number;
  name: string;
  nameNl: string;
  mission: string;
  responsibilities: string[];
  skills: string[];
  /** Union of tools this agent may ever use (least privilege). */
  tools: ToolName[];
  modelTier: ModelTier;
  qualityStandards: string[];
  escalationRules: string[];
  kpis: { key: string; label: string }[];
  tasks: Record<string, AgentTask>;
}
