# DEPLOYMENT

**Default (Claude Subscription Mode, see SUBSCRIPTION_MODE.md):** one web process plus PostgreSQL. The AI work runs in
Claude Code cloud sessions (scheduled tasks) on the existing Claude subscription, and those sessions also advance the
pipeline ("pump"). **No always-on worker and no Anthropic API key are needed.**

| Process | Command | Needed? |
|---|---|---|
| **web** (Next.js) | `npm run build && npm run start` | Always: 1 instance behind HTTPS, reachable from the Claude Code environment for `/api/bridge/*` |
| **worker** (pg-boss scheduler/jobs) | `npm run worker` | Optional in Subscription Mode (watchdog, own cron); **required** in Paid API Mode |

The weekly run is started by the Claude Code scheduled task (cron in claude.ai), or by the worker's pg-boss cron in Paid
API Mode. No browser tab or interactive session is involved either way.

## 0. Hosting options (lowest reliable cost first)
| Option | What | Indicative cost | Notes |
|---|---|---|---|
| **A. Existing Cloud Life server / VM** | Docker Compose (`web` + `db`), reverse proxy with TLS (Caddy/nginx) | €0 extra | Recommended if a managed server with backups exists. Only port 443 is exposed. |
| **B. One small EU VPS** | Same compose file on a 2 vCPU / 4 GB VPS (e.g. Hetzner, Scaleway, OVH EU) | ≈ €5–10 / month | Enable automatic backups plus a nightly `pg_dump` off the host. |
| **C. Managed PaaS** | One web container (scale to 1, *not* 0, so the bridge answers) + small managed PostgreSQL (EU) | ≈ €15–40 / month | Azure Container Apps + PostgreSQL Flexible B1ms, Fly, Render, etc. No second container needed. |

Not recommended: exposing a laptop through a tunnel. It depends on the computer being online, which the requirement
rules out.

Security baseline in every option:
- HTTPS only.
- Entra ID sign-in for people. `/api/bridge/*` accepts only the bridge bearer token, which stores no cookies and has no
  access to users, settings, secrets or exports.
- `SESSION_SECRET` and `SECRETS_ENCRYPTION_KEY` set, and PostgreSQL not publicly reachable.

Egress from the web host:
- The public web (research targets) and the DoH resolver.
- `api.anthropic.com`, only for the optional "start now" trigger or Paid API Mode.
- Optional KvK, Brave and Firecrawl.

Behind an HTTPS egress proxy, set `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so `fetch` uses `HTTPS_PROXY`.

## 1. Prerequisites
- Node.js ≥ 22, PostgreSQL 16 (Supabase, Azure Database for PostgreSQL Flexible Server, or self-hosted).
- Outbound HTTPS from the web host (and the worker, if used) to: `api.anthropic.com` (only for the trigger or Paid API Mode), `api.firecrawl.dev` (if used), `api.kvk.nl` (if used),
  the DoH resolver (`cloudflare-dns.com` by default), and the public websites being researched.
- A secret manager (Azure Key Vault, Supabase/Vercel/Fly secrets…). Never commit `.env`.

## 2. Microsoft Entra ID
1. Entra admin center → App registrations → New: *Cloud Life Sales Army*, single tenant.
2. Redirect URI (Web): `https://<your-host>/api/auth/callback`.
3. Certificates & secrets → new client secret → `ENTRA_CLIENT_SECRET`. Note tenant ID and client ID.
4. App roles: `SalesArmy.Admin`, `SalesArmy.Analyst` (members: users/groups) — or set `ENTRA_ADMIN_GROUP_ID` / `ENTRA_ANALYST_GROUP_ID`
   and add the *groups* claim to the ID token. Users without a role become read-only viewers.
5. Set `INITIAL_ADMIN_EMAILS` for the first administrator(s).
6. Recommended: Conditional Access (MFA, compliant device) on the enterprise application.

## 3. Configure environment
Platform values only: `DATABASE_URL`, `APP_URL`, `SESSION_SECRET` and `SECRETS_ENCRYPTION_KEY` (each `openssl rand -hex 32`), and a temporary `SETUP_TOKEN` (≥24 chars). Everything else (Claude key, providers, KvK, Entra, budgets, schedule, imports) is configured in the **Setup wizard**; environment variables for those keys still work and take precedence.

## 4. Database
```bash
npm ci
```
```bash
npm run db:migrate
```
Applies SQL migrations and idempotently seeds industries, the permanent seed exclusions (Visma/ProActive, RedFoxBlue,
ZIGT Mediabureau, The Sales Unit), excluded sectors, scoring model v1 and the baseline strategy. pg-boss creates its own
`pgboss` schema on first worker start. Enable automated backups/PITR on the database.

## 5. Run
### Docker Compose (self-hosted)
```bash
docker compose up -d --build
```
### Separate services (e.g. Azure Container Apps / App Service, Fly, Render)
Build the image from `Dockerfile` once; run it twice — default command for **web**, `npm run worker` for **worker**;
run `npm run db:migrate` as a release/one-off job before each deploy.

## 6. First-time setup in the UI (administrator) — now the Setup wizard
Sign in at /login with `SETUP_TOKEN`, open **Setup** and follow steps 1–10:
1 platform & worker status · 2 Claude API key (validated free) · 3 search/fetch providers + explicit approval of paid providers +
connectivity test · 4 optional KvK key · 5 Entra ID (tenant, client, secret, groups; validated) · 6 import customers, opportunities,
previous calling lists, rejected companies, opt-outs · 7 competitor domains · 8 budgets (with cost estimate) · 9 weekly schedule ·
10 the three live pilots and the first full run (each requires ticking an explicit budget approval).
After an administrator has signed in through Entra ID, remove `SETUP_TOKEN` from the environment.

## 7. Production hardening checklist
- HTTPS only; set `APP_URL` to the public HTTPS origin (cookies become `Secure`).
- Put a WAF / edge rate limiter in front when running more than one web instance.
- Restrict database network access to web + worker; least-privilege DB user (DDL only for the migrate job).
- Ship worker and web logs to your log platform; alert on `run.failed`, `weekly.skipped`, worker restarts.
- Supabase: the app connects server-side with a service DB user; do not expose tables through PostgREST, or enable RLS
  denying the `anon`/`authenticated` roles (the app does not use Supabase Auth).

## 8. Claude Code scheduled task (Claude Subscription Mode)
Follow SUBSCRIPTION_MODE.md §3. In summary:
- Environment: network **Limited**, allowlist = dashboard host only.
- Network secret `Authorization: Bearer <bridge token>` for that host.
- Variable `SALES_ARMY_URL`.
- Scheduled task with the wizard prompt and cron `CRON_TZ=Europe/Amsterdam 0 8,11,14,17 * * 1-3`.
- Optional API trigger whose ID and token go into the wizard.
