# DEPLOYMENT

Two processes share one PostgreSQL database:

| Process | Command | Scale |
|---|---|---|
| **web** (Next.js) | `npm run build && npm run start` | 1+ instances behind HTTPS |
| **worker** (jobs + scheduler) | `npm run worker` | 1 instance (more is safe: pg-boss locks jobs; raise `WORKER_CONCURRENCY` first) |

The weekly run is fired by the worker's pg-boss cron — **no browser tab or interactive Claude Code session is involved.**

## 0. Recommended hosting architecture
| Component | Recommendation | Why |
|---|---|---|
| Web (Next.js) | Container on **Azure Container Apps** (West Europe) — or any EU container platform | Microsoft-aligned for a Microsoft-security company; Entra ID native; scales to zero is NOT needed |
| Worker | Second Container App from the same image, `npm run worker`, **min replicas 1** | Must run continuously for the weekly schedule; one replica is enough (raise `WORKER_CONCURRENCY` first) |
| Database | **Azure Database for PostgreSQL – Flexible Server** (Burstable B1ms/B2s, EU), PITR backups; or Supabase EU (use the *session*/direct connection, not the transaction pooler, for the worker) | pg-boss, pg_trgm, relational integrity |
| Secrets | Azure Key Vault → environment variables for platform values; integration keys via the Setup wizard | Least exposure |
| Egress | Outbound HTTPS to api.anthropic.com, the DoH resolver, research targets (public web), optionally api.kvk.nl / api.search.brave.com / api.firecrawl.dev | Research needs the public web |
| Observability | Container logs → Log Analytics; alert on `run.failed`, worker heartbeat older than 3 min | Unattended operation |
Indicative cost: €40–120/month depending on sizes (verify in the Azure calculator).

## 1. Prerequisites
- Node.js ≥ 22, PostgreSQL 16 (Supabase, Azure Database for PostgreSQL Flexible Server, or self-hosted).
- Outbound HTTPS from the worker to: `api.anthropic.com`, `api.firecrawl.dev` (if used), `api.kvk.nl` (if used),
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
