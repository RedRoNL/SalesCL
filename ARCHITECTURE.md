# ARCHITECTURE

## Overview

```
 Browser (Dutch UI, Entra ID SSO)
      │  Server Components / Server Actions / route handlers (auth + RBAC on every call)
 ┌────▼──────────────────────────── Next.js 16 (web) ─────────────────────────────┐
 │ src/app        pages, actions, /api (export, feedback upload, chat polling)    │
 │ src/lib        auth, settings, budget, analytics, exporter, feedback import    │
 └────┬──────────────────────────────────────────────────────────────────────────┘
      │ enqueue jobs (pg-boss)                     reads/writes
 ┌────▼──────────── Worker (Node, `npm run worker`) ─┐      ┌────────────────────┐
 │ pg-boss: run-orchestrate, run-candidate,          │◄────►│ PostgreSQL         │
 │ run-finalize, agent-chat, weekly-trigger (cron    │      │ app schema + pgboss│
 │ Mon 08:00 Europe/Amsterdam), watchdog, learning,  │      └────────────────────┘
 │ retention                                         │
 │  src/pipeline  orchestration & checkpointed stages│
 │  src/agents    runtime, 11 agent definitions,     │──► Anthropic Messages API
 │                tools (least privilege)            │
 │  src/research  providers behind interfaces ───────┼──► Firecrawl / HTTP fetch /
 │  src/domain    pure business logic                │    DNS-over-HTTPS / KvK API
 └───────────────────────────────────────────────────┘
```

Separation: **frontend** (`src/app`, `src/components`) holds no business logic; **API** (route handlers + server actions)
authorises and validates then calls `src/lib` / `src/pipeline`; **agent runtime** (`src/agents`); **research providers**
(`src/research`); **database** (`src/db`, Drizzle + SQL migrations in `drizzle/`); **scheduler & job execution**
(`src/worker`, pg-boss); **scoring engine** (`src/domain/scoring.ts`); **export engine** (`src/lib/exporter.ts`);
**authentication** (`src/lib/auth`); **observability** (`agent_tasks`, `provider_usage`, `audit_logs`, worker logs).

## Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | TypeScript + Next.js 16.4 (App Router) + React 19.3 + Tailwind 4.3 | Requested stack; verified current stable versions on npm (2026-11-24). Next 16 uses `proxy.ts` (formerly middleware). |
| D2 | **Agent runtime = Anthropic Messages API with our own bounded tool loop** (`@anthropic-ai/sdk` 1.13) rather than the Claude Agent SDK in production | The Agent SDK is Claude Code as a library (filesystem/Bash tools, its own permission model). Unattended production research needs: an exact per-task tool allow-list, every tool result wrapped as untrusted data, Zod-validated structured output before persistence, per-call cost accounting and budget enforcement, and resumable checkpoints in our DB. A thin explicit loop gives all of that with fewer moving parts. Claude Code subagents + skills (`.claude/`) are used for development/interactive work, generated from the same definitions. *Alternative considered:* Claude Managed Agents (Anthropic-hosted loop & sandbox, scheduled deployments) — viable later, but it moves research state and tool execution outside Cloud Life's database and is beta. |
| D3 | PostgreSQL (Supabase-compatible) + Drizzle ORM + SQL migrations | Relational integrity for dedup/exclusions/history; works on Supabase, Azure Database for PostgreSQL or self-hosted. |
| D4 | pg-boss 12 for jobs and cron | Durable queue in the same Postgres: retries with backoff, singleton keys (duplicate-run prevention), cron with time zones, no extra infrastructure. |
| D5 | Interchangeable research providers (`SearchProvider`, `FetchProvider`, `DnsProvider`, `RegistryProvider`) | Claude web search (default, no extra subscription), Brave or Firecrawl for search; direct HTTP fetch (free) with optional Firecrawl JS-render fallback; DoH or system DNS; optional KvK API. Only Anthropic is required (COSTS.md). |
| D11 | Discovery-source database with yield-based prioritisation | The system gets better at finding hard-to-find companies by learning which sources produce unique *and* qualified companies. |
| D12 | Deterministic-first funnel | Code does crawling, extraction, dedup, scoring; models only judge text and fill real gaps. |
| D6 | Deterministic code decides scores, evidence classes, exclusions, eligibility, dedup | LLMs propose facts with sources; code validates (source exists, quote present in retrieved text, phone appears on source) and computes. Reproducible and analysable against outcomes. |
| D7 | Model tiers (configurable): fast `claude-haiku-5-5` for high-volume evidence/signal work, standard `claude-sonnet-5-5` for discovery/enrichment, strong `claude-opus-5-5` for CSO, qualification, QA | Per brief: cheaper models for volume, stronger for reasoning and independent QA. Per-agent overrides in Settings. |
| D8 | Own small UI component set instead of shadcn/ui | shadcn's CLI pulls component source from its registry at install time (network); our ~10 primitives in `src/components/ui.tsx` give the same control with no extra dependency. Easy to migrate to shadcn later. |
| D9 | Custom OIDC (openid-client 6 + jose sessions) instead of Auth.js | Auth.js v5 is still beta for this Next major; a small audited OIDC code flow with PKCE, nonce, tenant check and signed 8-hour sessions is easier to reason about. |
| D10 | Synthetic test world + scripted model | Lets 100+ tests exercise the real pipeline, DB and security controls without network or API keys; every fixture is fictitious (`.example`). |

## Pipeline (v2 — progressive funnel; see REVIEW.md for why)

| Stage | Where | Cost |
|---|---|---|
| 1 Strategy | CSO `plan_week` (1 call/run): sectors, quotas, themes — informed by commercial results **and source yield** | strong model, 1× |
| 2 Discovery planning | `orchestrateRun`: reserve candidates from earlier runs first; then deterministic selection of sources per sector from `discovery_sources` (exploit high-yield, explore new) → `run_work` units | free |
| 3 Discovery work (parallel) | `harvest` (fetch list pages, follow member/exhibitor links + pagination, link extraction; cheap-model list extraction only if needed) · `scout` (Market Intelligence finds new sources — only for under-covered sectors) · `hunt` (enterprise: groups/annual reports; midmarket/growth: shortfall round) | mostly free / cheap |
| 4 Registration & dedup | `registerCandidate` + `findExistingCompany` (KvK, domains incl. historical, phones, identifiers, pg_trgm names, groups); exclusions & suppressions | free |
| 5 Screen | own-site crawl (home/contact/about/legal/careers), passive DNS, regex extraction (phone, KvK, legal form, employees, Microsoft mentions, security vacancies, certifications), phone/KvK dedup, early gates | free |
| 6 Extract | Company Research `extract_profile`: one fast-tier call, no tools; every field quote-verified by code; exclusion/size/authority gates | ≈€0.003 |
| 7 Deep (dynamic) | KvK lookup → potential score gate → gap-filling agent only for critical gaps → Microsoft specialist only if M365 evidence < strong; reserve if target reached | only when needed |
| 8 Signals (dynamic) + score | Buying Signal Analyst only if preliminary fit ≥ threshold; deterministic final score, service and rationale | cheap |
| 9 QA | deterministic checks + QA Director (strong) only for exceptional/strong | ≈€0.31 |
| 10 Eligibility | deterministic contact eligibility | free |
| 11 Shortfall round | if short of target and <70% of budget used: unused/explore sources, scouting, midmarket + growth hunters | bounded |
| 12 Finalise | ranking, batch rationale (20/call), CSO review & summary, human approval, export | small |

Candidates are checkpointed per stage (`run_candidates.stage`); discovery units in `run_work`. Pause/cancel are checked
before every stage; budget exhaustion pauses the run; the watchdog re-queues runs without heartbeat for 30 minutes.

## Secrets & configuration
Integration keys are entered in **Setup** and stored AES-256-GCM-encrypted (`secrets` table, key `SECRETS_ENCRYPTION_KEY`
or HKDF-derived from `SESSION_SECRET`); environment variables take precedence. Only platform values (DB, URLs, session/encryption
keys, setup token) live outside the app.
