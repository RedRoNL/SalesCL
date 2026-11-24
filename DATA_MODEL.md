# DATA MODEL

Source of truth: `src/db/schema.ts` (Drizzle) → SQL migrations in `drizzle/`. PostgreSQL 16. UUID keys, UTC timestamps.
History is preserved: corrections supersede (`superseded_by_id`), configurations are versioned, companies are soft-deleted.

## Companies & identity
| Table | Purpose |
|---|---|
| `companies` | One row per organisation. `prospect_number` (serial) → persistent ID **CLSA-000123**. Normalised name, canonical domain (unique), KvK (unique), industry, HQ/NL office, employees (count or range + source), group, legal form, public phone (+source), purchasing authority, status, relationship (none/customer/active_opportunity/prior_prospect/rejected/opted_out), contact eligibility (+reason, checked_at), latest scores, reactivation flag, soft delete. |
| `company_aliases` | Trading/alternative names for fuzzy matching. |
| `domains` | All known domains → company/group (unique). |
| `company_groups` | Parent companies: name, primary domain, HQ country, where IT is purchased. |
| `legal_entities` | Legal entities (KvK, legal form) per company. |
| `industries` | Sector catalogue: priority tier (0 = excluded), indicative NIS2/DORA, estimated pool size (+ source; null = unknown). |
| `market_segments` | Persistent market map: per industry/size band the queries and sources used, candidates found, exhaustion estimate. |

## Evidence
| Table | Purpose |
|---|---|
| `research_sources` | Every retrieval: URL, type, provider, content hash, bounded excerpt, HTTP status, run. |
| `company_facts` | Atomic facts with source, confidence (0–1), observed/expiry dates, supersession — fact age & reliability. |
| `technology_evidence` | Microsoft technology × classification × evidence type × source. |
| `buying_signals` | Type, title, explanation, relevance, commercial assessment, date, source. |
| `contacts` | Professional role (+ public name only with source), lawful basis, retention date. |

## Qualification & QA
`scoring_configs` (versioned weights/thresholds/rules; one active) · `qualification_scores` (fit, confidence, components,
classification, service, rationale, missing info, hard failures, config version) · `qa_reviews` (verdict, deterministic +
agent checks, issues, documented admin override).

## Controls
`exclusions` (scope: company/domain/parent_company/legal_entity/sector/name; category; permanent flag; active) ·
`suppressions` (opt-out/do-not-contact; normalised identifier only; unique; never overridable).

## Execution
`research_runs` (kind, status, idempotency key, params, strategy, stage, budget & cost, stats, pause reason, heartbeat,
management summary) · `run_candidates` (per-company checkpoint: stage, status, attempts, last error, outcome) ·
`agent_tasks` (agent, task type, parent task, input/output JSON, model, tokens, tool calls, cost, timings) ·
`agent_messages` (HQ threads, delegations) · `agent_performance_snapshots` · pg-boss tables in schema `pgboss`.

## Delivery & feedback
`prospect_lists` (ISO week, status draft→in_review→approved→exported, target, shortfall + explanation, QA report,
management summary, approver) · `prospect_list_items` (rank, priority A/B/C, human decision + reason, contact role) ·
`exports` (format, file name, rows, content hash, user) · `deliveries` (company × list × export — prevents re-delivery) ·
`feedback_imports` (file, mapping, preview, counts, errors) · `calling_results` (13 outcomes, notes, date, row hash unique,
`superseded_by_id`) · `appointments` · `opportunities` (estimated MRR — an estimate) · `conversions` (contracted MRR).

## Learning, cost, settings
`strategies` (versioned CSO plans and learning overrides) · `recommendations` (type, evidence strength, proposed change,
approval status) · `provider_usage` (provider, operation, units, cost, cached, run/task/agent/company) · `research_cache`
(provider responses with expiry) · `system_settings` (validated JSON per key) · `users` · `audit_logs`.

## Deduplication keys
KvK number → canonical registrable domain (subdomains/protocols stripped, multi-part TLDs handled) → parent group
(group id, group domain, group name) → exact normalised name or alias → fuzzy name (Levenshtein + token-set ≥ 0.9, not
when both have different known domains, not for names ≤ 4 characters).

## v2 additions
| Table | Purpose |
|---|---|
| `discovery_sources` | Persistent source database: page (list URL) or query (search template with `{sector}`), type, sectors, status (unverified/active/exhausted/blocked/retired), origin (seed/agent/admin), harvest counters, re-harvest interval. |
| `source_companies` | Which source surfaced which company, whether it was **new** at that time, and the role (member, exhibitor, customer, employer…). Source yield (unique, qualified, delivered, appointments) is computed from here. |
| `company_identifiers` | Normalised domains (incl. historical), phones, KvK numbers and name variants for deduplication. |
| `run_work` | Discovery work units per run (harvest/scout/hunt, round 1 or shortfall round 2). |
| `secrets` | Encrypted integration secrets (AES-256-GCM), last 4 chars, validation status. |
| `companies.research_tier`, `screen_score` | Funnel depth reached and prescreen potential (used for reserve reuse). |
| `run_candidates.discovery_source_id`, `priority` | Source attribution and queue priority. |
| `feedback_imports.kind` | feedback / historical_list / customers / opportunities / rejected / optouts. |
