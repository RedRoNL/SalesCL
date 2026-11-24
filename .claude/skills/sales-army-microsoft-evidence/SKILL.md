---
name: sales-army-microsoft-evidence
description: Rules for classifying Microsoft technology usage (M365, Exchange Online, Entra ID, Intune, Defender, Purview, Copilot, Azure) from public evidence without overclaiming. Use when researching or validating Microsoft technology evidence for a prospect.
metadata:
  version: 1.0.0
  owner: Cloud Life Sales Army (project skill)
---

# Microsoft evidence classification

Classes: **confirmed** · **strongly_indicated** · **weakly_indicated** · **unknown** · **contradicted**.

| Evidence | Supports | Max class |
|---|---|---|
| MX → `*.mail.protection.outlook.com` | Exchange Online (Microsoft-hosted mail) | strongly_indicated (confirmed with autodiscover/DKIM) |
| TXT `MS=ms…` | Domain verified in a Microsoft tenant | strongly_indicated (M365, with mail indicators) |
| CNAME `enterpriseenrollment` → `manage.microsoft.com` | Intune MDM auto-enrollment | strongly_indicated |
| CNAME `enterpriseregistration` → `windows.net` | Entra device registration | strongly_indicated |
| Company vacancy naming the product | Product in use or planned | strongly_indicated; confirmed only with verbatim quote stating current use |
| Official Microsoft customer story / company site / annual report | Product in use | confirmed with verbatim quote |
| Google Workspace MX, no Microsoft indicators | — | contradicted |

Hard rules:
1. An Exchange Online MX record is **not** evidence of Intune, Defender, Purview, Copilot or any licence tier.
2. Every claim needs a stored `source_id`; claims without one are dropped. Quotes are checked against the retrieved text — unmatched quotes are downgraded.
3. Passive public DNS only. No port scans, no service probing, no login pages, no vulnerability testing.
4. Contradictory evidence: report both; the lower class applies until resolved.
