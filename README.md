# Cloud Life Sales Army

An autonomous, multi-agent sales-intelligence platform for **Cloud Life**, a Dutch cybersecurity company focused solely
on Microsoft security (Protect 365, Purview Care). Each week, eleven specialised AI agents discover, research, verify,
qualify and rank Dutch organisations (50–5,000 FTE, mainly 300–2,000). The result is a clean, human-approved calling
list of up to 100 genuinely qualified prospects for the external calling agency. Agency feedback flows back in so the
research strategy can improve.

> The system **researches and delivers**; it never calls, e-mails or contacts anyone.

## What's inside
- **11 real agents** (`src/agents`) on the Anthropic Messages API, with least-privilege tools, Zod-validated
  structured output, per-task cost tracking and community skills. See AGENTS.md.
- **12-stage research pipeline** (`src/pipeline`): strategy → discovery → filtering → dedup → enrichment →
  Microsoft evidence → buying signals → qualification → independent QA (veto) → contact eligibility → ranking →
  approval & export. Every stage is checkpointed, parallel and resumable.
- **Permanent intelligence** in PostgreSQL: companies, groups, domains, facts with source/age/confidence, evidence,
  signals, scores, QA, exclusions, suppressions, deliveries, calling history, opportunities, conversions, costs, audit.
  See DATA_MODEL.md.
- **Transparent scoring** (fit vs. evidence confidence, versioned weights). See SCORING_MODEL.md.
- **Self-improving loop**: conversion by industry/size/score/service/signal/Microsoft evidence with confidence
  intervals and honest evidence labels; bounded automatic priority shifts; human approval for structural changes.
- **Dutch, dark-mode web app**: dashboard, Sales Army HQ (live agent chat & delegation), prospect database & profiles,
  research control centre, market intelligence, weekly lists, feedback import, settings.
- **Unattended operation**: pg-boss worker with cron (Mon 08:00 Europe/Amsterdam), retries, watchdog recovery,
  duplicate-run prevention, budgets.
- **Security & compliance**: Entra ID SSO, RBAC, audit log, prompt-injection containment, SSRF-safe fetching,
  GDPR minimisation/retention/erasure, Dutch telemarketing eligibility engine. See SECURITY.md.

## v2 (engineering & commercial review)
See **REVIEW.md** (findings, fixes, removals), **COSTS.md** (provider comparison, scenarios: realistic ≈ €67/week for 100 qualified),
the **Setup wizard** (/setup), the **discovery-source database** (/sources) and **live pilots** (/pilots).

## v3: Claude Subscription Mode (zero additional AI cost)
AI work runs in native Claude Code cloud sessions (scheduled tasks) on the existing Claude subscription, through the
research bridge and the repository's 11 subagents and skills. There is no API key and no always-on worker; paid API use
is optional and requires explicit approval.

See **SUBSCRIPTION_MODE.md**.

## Quick start (development)
```bash
npm ci
```
```bash
cp .env.example .env.local   # set DATABASE_URL, SESSION_SECRET, AUTH_DEV_LOGIN=true, ANTHROPIC_API_KEY
```
```bash
npm run db:migrate
```
```bash
npm run dev        # web on http://localhost:3000 (local login form when AUTH_DEV_LOGIN=true)
```
```bash
npm run worker     # job runner + weekly scheduler (separate terminal)
```

## Tests
```bash
npm test           # 130 tests: domain logic, providers, security, discovery, funnel, imports, pilots — E2E on Postgres (synthetic)
```
Tests need a PostgreSQL database whose name ends in `_test` (`TEST_DATABASE_URL`). All fixtures are synthetic
(`.example` domains) and are never presented as research.

## Live pilot
```bash
npm run pilot -- --preset manufacturing --budget 15 --approve-budget
```
Writes `pilot-report.md` with the 11 verification criteria. Requires API keys; see BUILD_STATUS.md.

## Documentation
- SUBSCRIPTION_MODE.md — default execution mode, setup, limits, legal basis
ARCHITECTURE · AGENTS · SKILLS · RESEARCH_METHODOLOGY · SCORING_MODEL · DATA_MODEL · SECURITY · DEPLOYMENT ·
OPERATIONS · BUILD_STATUS · CLAUDE.md (instructions for future Claude Code sessions).
