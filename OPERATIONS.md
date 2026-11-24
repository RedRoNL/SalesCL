# OPERATIONS (runbook)

## Weekly cycle in Claude Subscription Mode (default)
1. Monday 08:00 Europe/Amsterdam, the Claude Code scheduled task starts. The skill `sales-army-weekly` runs
   `army start`, which opens this ISO week's run (idempotent) or resumes an open one.
2. The session loops `pump` → `tasks` → subagents → `submit` until no work is left or limits approach. All progress is
   in PostgreSQL.
3. Continuation starts (11:00, 14:00, 17:00, Monday–Wednesday) resume interrupted work. A start with nothing to do
   ends immediately.
4. The run page shows genuine status: "Wacht op Claude Code" with the number of parked AI tasks, links to the sessions,
   and €0 AI cost.
5. **Start now:** "Start Claude Code-sessie" on a run page uses the official API trigger, if configured in the wizard.
   A 429 means the trigger or subscription limit was reached; the scheduled start will pick the run up.
6. Human steps are unchanged: review the list, approve, export, import feedback.

Troubleshooting:

| Symptom | Fix |
|---|---|
| Bridge returns 401 | Regenerate the bridge token and update the network secret. |
| Session reports `SALES_ARMY_URL` missing | Set the environment variable in the Claude Code environment. |
| Fetches fail in the session | Dashboard host is missing from the allowlist. |
| Tasks stay "awaiting" | No session ran (check the scheduled task, or the subscription limit); claims are released after 45 minutes. |

## Weekly cycle (Paid API Mode with worker)
| When (Europe/Amsterdam) | What |
|---|---|
| Mon 06:00 | `learning-analyze`: agent performance snapshot, commercial performance, recommendations (Sales Operations Manager) |
| Mon 08:00 | `weekly-trigger`: creates run `weekly:<ISO week>` (idempotent — a second trigger in the same week is a no-op) |
| during run | CSO strategy → discovery → per-candidate research jobs (parallel) → finalize: ranked draft list + management summary |
| every 10 min | `run-watchdog`: re-queues runs without heartbeat for 30 min (crash/redeploy recovery) |
| daily 02:30 | `retention-cleanup` |

## First-time setup
Open **Setup** (first login with `SETUP_TOKEN` if Entra is not configured yet) and complete the ten steps; each shows live status.
Then run the three pilots (Setup → step 10) and review **Live pilots** before enabling the weekly schedule at full volume.

## Discovery sources
**Ontdekkingsbronnen** lists every source with its yield. Add sources (URL of a list page, or a search template with `{sector}`),
stop poor ones, re-activate exhausted ones. The system adds sources itself (scouting) and rests exhausted ones automatically.

## Human steps each week
1. **Weeklijsten → <week>**: read the management summary and QA report; approve/reject items; *Lijst goedkeuren*.
2. Export Excel (tab 2 is the feedback template) → send to the calling agency.
3. When feedback arrives: **Belbureau-feedback** → upload → check mapping/preview → *Vastleggen*.
4. **Marktinformatie → Aanbevelingen**: approve or reject proposals that need approval.

## Run control
**Onderzoekscentrum → run**: *Pauzeer* (in-flight candidates stop at the next stage; nothing is lost), *Hervat*,
*Annuleer*, *Mislukte taken opnieuw* (resets failed candidates and re-opens a finished run; its unexported list is
rebuilt, not duplicated). A run that hits its budget pauses itself with the reason shown.

## Costs
Dashboard and run pages show AI cost per agent/task and provider cost per call. Cost per qualified prospect and per
appointment are computed from actual spend. Update `src/lib/costs.ts` when model prices change; provider unit costs are
in Settings → Budget.

## Failure modes
| Symptom | Cause / action |
|---|---|
| Banner "Niet geconfigureerd: Claude API" | `ANTHROPIC_API_KEY` missing → agents cannot run; weekly trigger logs `weekly.skipped` and fails loudly. |
| Run paused "Budget overschreden" | Raise run/week/month budget or wait for the next period, then *Hervat*. |
| Many `Toegang geweigerd (403)` / CAPTCHA in task errors | Site blocks automated access — by design we don't bypass; consider Firecrawl or a licensed data source. |
| Candidates `failed` | See `last_error` on the run page; *Mislukte taken opnieuw*. Model refusals are not retried automatically. |
| QA rejects >50% | CSO escalation rule: review strategy/sources; check top QA issues on the list page. |
| Chat shows "Taak mislukt" | The agent task failed; see the message and `agent_tasks.error`. |

## Updating skills
1. Clone the upstream repo, diff the skill against `.claude/skills/<name>` (instructions, scripts, URLs, `allowed-tools`).
2. Copy the reviewed version, update `ORIGIN.json` (commit, version, review date) and SKILLS.md.
3. `npm test` (prompt-builder test checks skills load).

## Regenerating agent docs / subagents
```bash
npx tsx scripts/generate-claude-agents.ts
```

## Data subject requests
Prospect profile → *AVG: wis gegevens* (admin). Opt-outs: Settings → *Opt-out vastleggen* or a "niet benaderen" feedback row.

## Backups & restore
Rely on managed PITR. To restore a single company's history, all history tables are append-only and keyed by `company_id`.
