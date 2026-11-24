# SKILLS — installed Agent Skills registry

Skills live in `.claude/skills/<name>/` (Claude Code project skills). They serve two runtimes:

1. **Interactive** — Claude Code sessions and the generated subagents in `.claude/agents/` load them natively.
2. **Production** — `src/agents/skills.ts` reads the pinned `SKILL.md` of each skill assigned to an agent and injects it
   (truncated to ~4.5k chars) into that agent's system prompt as *methodology reference*, ranked **below** Cloud Life's
   own security rules. Per-agent assignment can be changed in **Settings → Skillbeheer per agent** (`agentSkills`).

**v2 cost control:** skill text is only injected where it adds value — strategy, discovery and chat tasks get all assigned skills;
QA and batch tasks only the short Cloud Life `sales-army-*` skills; high-volume extraction gets none (see AGENTS.md per task).

Every third-party skill is pinned to the commit we inspected, carries its upstream `LICENSE`, and has an `ORIGIN.json`.
No third-party skill was modified. Updating a skill = re-review + bump the pinned commit (see OPERATIONS.md).

## Registry

| Skill | Origin (pinned commit) | Version | License | Purpose here | Assigned agents |
|---|---|---|---|---|---|
| `prospecting` | coreyhaines31/marketingskills `8fd2fca` | 1.8.0 | MIT | ICP → discovery → qualification → scoring framework; compliance guardrails (no LinkedIn scraping, no CAPTCHA bypass, provenance for every contact) | CSO, Market Intelligence, Enterprise/Midmarket/Growth Hunters, Buying Signal Analyst, Company Research |
| `revops` | coreyhaines31/marketingskills `8fd2fca` | 2.2.4 | MIT | Lead scoring models, lifecycle definitions, routing | CSO, Lead Qualification, Sales Operations |
| `sales-enablement` | coreyhaines31/marketingskills `8fd2fca` | 2.4.4 | MIT | Win/loss analysis, call-script and objection framing (internal only — never exported) | Lead Qualification, Sales Operations |
| `competitor-profiling` | coreyhaines31/marketingskills `8fd2fca` | 2.1.9 | MIT | Account/market research structure | Market Intelligence |
| `customer-research` | coreyhaines31/marketingskills `8fd2fca` | 2.0.9 | MIT | Source guides for market/customer research | Market Intelligence |
| `lead-research-assistant` | ComposioHQ/awesome-claude-skills `be2a406` | unversioned | Apache-2.0 (repo) | Lead identification and per-lead fit reasoning | Enterprise/Midmarket/Growth Hunters, Company Research |
| `firecrawl` | firecrawl/skills `1d4b072` | unversioned | ISC | Firecrawl CLI workflow + `rules/security.md` (untrusted web content) — dev sessions | (Claude Code only) |
| `firecrawl-search` | firecrawl/skills `1d4b072` | unversioned | ISC | Search escalation patterns | Market Intelligence, Hunters, Buying Signal Analyst |
| `firecrawl-scrape` | firecrawl/skills `1d4b072` | unversioned | ISC | Single-page extraction patterns | Microsoft Intelligence, Company Research, QA |
| `firecrawl-map` | firecrawl/skills `1d4b072` | unversioned | ISC | Finding the right subpage (contact/legal/vacancies) | (Claude Code only) |
| `sales-army-icp` | this repository | 1.0.0 | Proprietary | Cloud Life ICP, exclusions, scoring summary, service entry points | CSO, Lead Qualification |
| `sales-army-microsoft-evidence` | this repository | 1.0.0 | Proprietary | Evidence classes and what each DNS/web signal may (not) prove | Microsoft Intelligence |
| `sales-army-qa` | this repository | 1.0.0 | Proprietary | QA Director checklist and veto rules | QA Director |
| `sales-army-delivery` | this repository | 1.0.0 | Proprietary | Export columns, approval gates, feedback statuses, learning loop | Sales Operations |

## Evaluation (Phase 1, 2026-11-24)

Adoption data was gathered from skills.sh and public trackers; figures differ by snapshot and are indicative only.
**Parent-repository popularity was explicitly separated from per-skill adoption.**

| Candidate | Parent repo signal | Per-skill adoption | Inspection result | Decision |
|---|---|---|---|---|
| coreyhaines31/marketingskills → `prospecting` | ~50k GitHub stars; maintained daily (last commit 2026-11-23); MIT; versioned skills + evals | **~49k installs** on skills.sh — the most adopted prospecting skill found | Markdown only, no scripts, no `allowed-tools`, no external calls. Strong, current compliance guidance (LinkedIn/Maps ToS, GDPR lineage, no CAPTCHA bypass) | **Installed** |
| same repo → `revops`, `sales-enablement`, `competitor-profiling`, `customer-research` | as above | High (repo total ~2.8M installs over 64 skills) | Markdown only; relevant sections for scoring and win/loss | **Installed** |
| ComposioHQ/awesome-claude-skills → `lead-research-assistant` | ~73–80k stars (it is a curated *list*) | **Low**: skills.sh lists ~125 installs across all 27 Composio skills | Single SKILL.md, no scripts. Generic; its "contact strategy / conversation starters" output is out of scope for us (we do not do outreach) | **Installed** (as requested; used for fit reasoning only) |
| firecrawl/skills (`firecrawl`, `-search`, `-scrape`, `-map`) | Firecrawl main repo is widely adopted (AGPL-3.0); skills repo ISC; active (2026-11-11) | Not verified (no per-skill count found) | `allowed-tools: Bash(firecrawl *)` only; includes a good untrusted-content security rule; requires Firecrawl CLI for interactive use | **Installed**; production uses the Firecrawl **SDK** (`@mendable/firecrawl-js`, MIT) behind our provider interface, not the CLI |
| firecrawl/firecrawl (self-host) | AGPL-3.0 | — | Self-hosting is possible but adds an AGPL service to operate | **Not installed**; optional future provider (hosted API is used) |
| anthropics/knowledge-work-plugins → `enrich-lead` | Anthropic-published | ~2.2k installs; skills.sh audit **MEDIUM** risk | Person-level enrichment via connectors (contact cards, emails) — conflicts with our data-minimisation stance | **Not installed** |
| Misc. `lead-enrichment`, `sales-skills/*`, `agent-gtm-skills` | small repos | 55–250 installs | Thin wrappers around paid enrichment APIs; low adoption | **Not installed** (obscure) |
| Apollo / Clay / ZoomInfo / LeadMagic integrations | commercial | — | Person-contact data; paid; NL coverage of 50–5,000 FTE organisations unproven | **Not installed**; candidates for an optional licensed provider behind `RegistryProvider` |

Commercial company-data providers for the Dutch market were assessed in RESEARCH_METHODOLOGY.md → *Optional providers*.
