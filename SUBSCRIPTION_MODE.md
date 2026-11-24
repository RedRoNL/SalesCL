# Claude Subscription Mode (default execution mode)

Goal: run the Cloud Life Sales Army with **no additional AI cost**. The existing Claude subscription pays for the AI work,
there is no Anthropic API key, and no always-on AI worker.

## 1. Is this officially supported? Yes, with clear boundaries

Verified against Anthropic's documentation (Claude Code on the web, *Automate work with routines* — now called
"scheduled tasks" — and *Legal and compliance*, consulted 2026-11-24):

| Requirement | Supported mechanism | Notes |
|---|---|---|
| AI work billed to the subscription | **Cloud scheduled tasks**: full Claude Code sessions on Anthropic infrastructure. They "draw down subscription usage the same way interactive sessions do". | Pro, Max, Ultra, Team, Enterprise. |
| Weekly schedule without the user's computer | Schedule trigger (cron, minimum hourly, `CRON_TZ=Europe/Amsterdam …`). | The session runs in the cloud. |
| Start from the dashboard | **API trigger**: `POST https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire` with a per-task bearer token generated in the claude.ai web UI. | Experimental. The token can only start that one task. Fires are billed as subscription usage, not Messages-API usage. Limits: 30 fires/hour per task, 100/hour per account. |
| Agents, skills, tools | The session loads the repository's `.claude/agents` (11 subagents), `.claude/skills` and `.claude/settings.json`. | Native WebSearch is included. |
| **Not allowed** | Using subscription OAuth credentials in our own code or the Agent SDK, proxying or intermediating claude.ai credentials. | Our code never touches subscription credentials. The Messages-API runtime stays only for the optional Paid API Mode. |

Two points to note:

- **Commercial use.** Team and Enterprise plans fall under Anthropic's Commercial Terms. Pro, Max and Ultra fall under
  the Consumer Terms, and their "advertised usage limits … assume ordinary, individual usage". Recommendation: run this
  on a **Team or Enterprise seat** for Cloud Life business use.
- **Limits.** At the usage limit, scheduled runs are rejected until the window resets, unless the account owner enabled
  extra usage credits. The platform **never** switches to paid API usage by itself.

## 2. Architecture

```
 Dashboard (Next.js, Dutch UI)                 Claude Code cloud session (scheduled task)
 ┌──────────────────────────────────┐         ┌─────────────────────────────────────────────┐
 │ start run / pilot ──► fire API ──┼──────►  │ skill: sales-army-weekly                    │
 │ (official trigger, per-task token)│ claude │  ├─ npm run army -- start / pump / tasks    │
 │                                  │  .ai   │  ├─ Agent tool → 11 Sales Army subagents   │
 │ /api/bridge/*  ◄─────────────────┼────────┼──┤    (Sonnet routine, Opus strategy/QA)    │
 │  bearer token (network secret,   │ HTTPS  │  │    spec → WebSearch + bridge tools        │
 │  injected by the egress proxy)   │        │  │    → submit (Zod-validated)               │
 │                                  │        │  └─ stops cleanly near limits               │
 │ src/pipeline (unchanged funnel)  │        └─────────────────────────────────────────────┘
 │  runAgent → parks task (awaiting)│
 │  pump: runs queued jobs inline   │──► public web (fetch with robots/SSRF checks), DoH, optional KvK
 │ PostgreSQL (all state)           │
 └──────────────────────────────────┘
```

1. `runAgent` (the single entry point for all 11 agents) does not call a model in subscription mode. It **parks** the
   task (`agent_tasks.status = awaiting`, `executor = claude_code`) with an idempotency key and the job to resume. Job
   runners treat this as "parked", not as a failure. Candidate checkpoints keep their stage.
2. The session runs `army pump`. This executes queued pipeline jobs **inline**, so no worker process is needed:
   harvest, free screening (HTTP + DNS), deterministic extraction, identity matching, scoring, QA checks and
   finalisation.
3. `army tasks` claims parked tasks in funnel order. The claim times out after 45 minutes and the task is then released.
4. For each task, `army spec` returns exactly what Paid API Mode would send the model: the system prompt (role,
   knowledge, skills), input, the allowed tools with JSON schemas, and the output JSON schema.
5. The subagent searches with **native WebSearch** and reads pages **only through the bridge** (`army tool … fetch_page`).
   The server fetches the page, applies robots.txt, SSRF protection and rate limits, stores a `research_sources` row
   and returns the wrapped untrusted content with its `source_id`.
6. `army submit` validates the result against the same Zod schema. The task is stored as succeeded (cost €0) and the
   parked job is re-enqueued. On re-run, `runAgent` finds the result by idempotency key and the pipeline continues from
   its checkpoint. All deterministic gates (quote verification, exclusions, opt-outs, dedup, scoring, QA veto,
   eligibility) are unchanged.

What stays exactly the same:

- All 11 agents (same definitions, prompts, task schemas, tool allow-lists).
- The skills, UI, funnel, discovery source database, Microsoft verification, history, imports, dedup, exclusions,
  scoring, QA, eligibility, exports, feedback optimisation, the wizard and pilots.
- The test suite. Paid API Mode tests still run the Messages-API loop with a scripted model.

## 3. Setup (one time, about 20 minutes)

1. **Host the dashboard** with HTTPS (see DEPLOYMENT.md, *Low-cost hosting*). No worker is needed.
2. **Wizard → step 2 "AI-uitvoering"**:
   - Mode: *Claude Subscription Mode* (the default).
   - Enter the public dashboard URL.
   - Click **Bridge-token genereren**. The token is shown once and only its SHA-256 hash is stored.
3. **On claude.ai/code → Environments**, create an environment (e.g. "SalesArmy"):
   - Network access **Limited** (package managers on), with **only your dashboard host** on the allowlist. All page
     fetching happens on the dashboard server, so the session needs nothing else. WebSearch is a built-in tool.
   - **Network secret**: host = dashboard host, header `Authorization`, prefix `Bearer`, value = bridge token. The proxy
     injects it, so the token is never visible to the session, its logs or the repository.
   - Environment variable (not a secret): `SALES_ARMY_URL=https://<dashboard host>`.
4. **New scheduled task** with this repository, that environment, and:
   - The prompt shown in the wizard.
   - Schedule `CRON_TZ=Europe/Amsterdam 0 8,11,14,17 * * 1-3`: Monday 08:00, plus continuation starts that resume an
     interrupted run. A start with nothing to do ends within a minute.
5. Optional: add an **API trigger**, generate its token and paste the ID (`trig_…`) and token into the wizard. Runs
   started from the dashboard then start a session immediately ("Start Claude Code-sessie" on the run page). The token
   is stored encrypted (AES-256-GCM) and used server-side only.

## 4. Limits and how they are handled

| Limit | Handling |
|---|---|
| Session usage/time limits | Every result is persisted immediately. The session stops after the current task; the next scheduled start resumes. Parked tasks keep their claim for 45 minutes, then return to the queue. |
| Subscription limit reached | The scheduled task is rejected or stopped by Anthropic and the run waits. **No automatic switch to the paid API.** The dashboard shows "Wacht op Claude Code" with the number of open AI tasks. |
| 100 prospects per week | About 300 candidates per week. Roughly 60–70% are settled by free deterministic screening; the rest need 1–4 AI tasks. That is several hours of agent work spread over the Monday–Wednesday starts. Whether one seat's weekly allowance covers it must be measured: see the pilot in BUILD_STATUS.md. A shortfall is reported, never padded. |
| Fire API | 30/hour per task, 100/hour per account; 429 is shown in the dashboard. |
| Token visibility | Per-run AI token use is not visible to the platform in this mode, so AI cost is recorded as €0 and usage is managed in claude.ai. |

## 5. Paid API Mode (optional, off by default)

Wizard step 2: choose *Paid API Mode* **and** tick the explicit approval. The approving user and time are recorded.
Without both, no Messages-API client can be created (`getModelClient` refuses). Use it only if the subscription cannot
deliver the volume; the cost scenarios are in COSTS.md.

## 6. What is no longer needed

- Anthropic API key and API credits.
- An always-on worker container. It is optional: it can still run pg-boss schedules, the watchdog and retention.
- Paid search APIs (Brave/Firecrawl), replaced by native WebSearch.
- Azure Container Apps × 2 or a Key Vault requirement.

A single small HTTPS host plus PostgreSQL is enough.
