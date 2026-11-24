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
| D5 | Interchangeable research providers (`SearchProvider`, `FetchProvider`, `DnsProvider`, `RegistryProvider`) | Firecrawl (hosted, paid) or Claude web search for discovery; direct HTTP fetch (free, robots.txt-respecting) or Firecrawl for pages; DoH or system DNS; optional KvK API. No paid provider is mandatory. |
| D6 | Deterministic code decides scores, evidence classes, exclusions, eligibility, dedup | LLMs propose facts with sources; code validates (source exists, quote present in retrieved text, phone appears on source) and computes. Reproducible and analysable against outcomes. |
| D7 | Model tiers (configurable): fast `claude-haiku-5-5` for high-volume evidence/signal work, standard `claude-sonnet-5-5` for discovery/enrichment, strong `claude-opus-5-5` for CSO, qualification, QA | Per brief: cheaper models for volume, stronger for reasoning and independent QA. Per-agent overrides in Settings. |
| D8 | Own small UI component set instead of shadcn/ui | shadcn's CLI pulls component source from its registry at install time (network); our ~10 primitives in `src/components/ui.tsx` give the same control with no extra dependency. Easy to migrate to shadcn later. |
| D9 | Custom OIDC (openid-client 6 + jose sessions) instead of Auth.js | Auth.js v5 is still beta for this Next major; a small audited OIDC code flow with PKCE, nonce, tenant check and signed 8-hour sessions is easier to reason about. |
| D10 | Synthetic test world + scripted model | Lets 100+ tests exercise the real pipeline, DB and security controls without network or API keys; every fixture is fictitious (`.example`). |

## Pipeline (12 stages)

| Stage | Where | Notes |
|---|---|---|
| 1 Industry selection | `orchestrateRun` → CSO `plan_week` | Gets performance (with CIs), market map, previous runs. Code strips excluded sectors and enforces user constraints. Strategy versioned in `strategies`. |
| 2 Prospect pool discovery | Market Intelligence (`discover_pools`, new segments) / Hunters (`hunt`) — parallel (3) | Adaptive: previous queries per segment are passed in and must not be repeated; a 2nd pass runs if the candidate pool is short. |
| 3 Preliminary filtering | `registerCandidate` | Name/domain exclusions & suppressions before any paid research. |
| 4 Deduplication | `findDuplicate` | KvK → canonical domain → parent group → exact/alias → fuzzy (≥0.9, token-set aware). Reuses eligible existing records. |
| 5 Enrichment | Company Research Specialist | Re-checks exclusions with business category, sector and group; early size/authority gates; fact reuse within `factReuseDays`. |
| 6 Microsoft research | DNS classifier (code) + Microsoft Intelligence Specialist | Agent claims validated against stored sources. |
| 7 Buying signals | Buying Signal Analyst | Every signal must reference a stored source. |
| 8 Qualification | Scoring engine (code) + Lead Qualification Specialist | Agent supplies rationale and may override service with a reason. Reject / needs-research stop early to save cost. |
| 9 QA | deterministic checks + QA Director (strong model, independent dossier) | Worst verdict wins; veto. |
| 10 Contact eligibility | `evaluateEligibility` | Legal person + exportable public number required. |
| 11 Ranking | `finalizeRun` | Fit, then confidence; 50–300 band capped unless shortfall. |
| 12 Approval & export | CSO `approve_list` (summary) → **human** approval → `exportList` | Export re-checks QA, suppressions, eligibility; records deliveries. |

Each candidate is one `run-candidate` job; `run_candidates.stage` is the checkpoint, so retries and resumes continue
from the last completed stage. Pause/cancel are checked before every stage. Budget exhaustion pauses the run.
A watchdog re-queues runs without a heartbeat for 30 minutes (interrupted-run recovery).
