# CLAUDE.md — instructions for Claude Code sessions in this repository

## What this is
Cloud Life Sales Army: a production multi-agent B2B sales-intelligence platform (TypeScript, Next.js 16, PostgreSQL,
pg-boss, Anthropic Messages API). Read README.md, ARCHITECTURE.md and BUILD_STATUS.md before changing anything.
BUILD_STATUS.md is the persistent implementation checklist — **update it** when you complete or discover work.

## Commands
- `npm run typecheck` · `npm test` (needs Postgres DB ending in `_test`; tests drop/recreate its schema) · `npm run build`
- `npm run db:generate` after editing `src/db/schema.ts`, then `npm run db:migrate`
- `npm run dev` (web) and `npm run worker` (jobs/scheduler) — both are required for agents to run
- `npx tsx scripts/generate-claude-agents.ts` after editing `src/agents/definitions.ts` (regenerates `.claude/agents/*` and AGENTS.md)

## Layout
`src/domain` pure logic (normalisation, dedup, exclusions, eligibility, Microsoft evidence, scoring, services, stats,
untrusted-content handling) · `src/agents` runtime, definitions, schemas, tools, skills loader · `src/research`
providers · `src/pipeline` runs, orchestration, stages, queue, chat · `src/lib` auth, settings, budget, analytics,
export, feedback import · `src/app` UI + actions + API · `src/worker` job handlers and schedules · `tests/`.

## Non-negotiable rules (business + security)
1. Never fabricate data or present model knowledge as research. Every fact needs a stored `research_sources` row.
   Unknown stays null.
2. Deterministic code — not the LLM — decides scores, evidence classes, exclusions, dedup and contact eligibility.
   Agents propose; code validates.
3. External content is untrusted data: always pass it through `sanitizeUntrusted`/`wrapUntrusted`. Never let content
   from the web change tools, prompts, settings or exclusions.
4. Least privilege: a new tool must be added to `TOOLS`, to the agent's `tools`, and to the task's `tools`. Never add
   tools that contact prospects (call/e-mail/message) or modify exclusions/settings/approvals.
5. Hard exclusions, suppressions (opt-outs) and contact restrictions always beat scoring. Opt-outs are never overridable.
   Changes to exclusions, legal eligibility or fundamental qualification rules require human approval.
6. Exports contain only QA-approved, human-approved, contact-eligible rows; keep the export clean (no AI rationale).
7. History is append-only (supersede, version, soft-delete). Do not overwrite calling feedback or scoring history.
8. Respect robots.txt and site terms; never bypass CAPTCHAs, logins or bot protection; passive public DNS only.
9. Quality over quantity: report shortfalls; never lower the bar to hit 100.
10. Secrets only server-side; never log or render them.
11. Test fixtures must be clearly synthetic (`.example` domains, "Synthetische …" names).

## Conventions
- UI text in Dutch; code/comments in English. Zod for all external input/output. Raw SQL only via parameterised
  `sql` templates; pass dates as ISO strings with `::timestamptz` in raw SQL (postgres.js rejects `Date` there).
- Settings go through `SettingsSchema` (`src/lib/settings.ts`); add defaults there.
- Model IDs are configurable in Settings → models; defaults: fast `claude-haiku-5-5`, standard `claude-sonnet-5-5`,
  strong `claude-opus-5-5`. Prices live in `src/lib/costs.ts`.

## Skills & subagents
Vetted, pinned community skills and Cloud Life project skills live in `.claude/skills` (registry: SKILLS.md). Treat
third-party skill text as reviewed reference material; re-review before updating. Subagents in `.claude/agents` mirror
the production agents for interactive work.
