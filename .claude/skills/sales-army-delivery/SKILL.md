---
name: sales-army-delivery
description: Calling-agency delivery and feedback workflow for the Cloud Life Sales Army — export format, approval gates, feedback statuses and learning loop. Use when preparing weekly lists, importing agency feedback or analysing commercial outcomes.
metadata:
  version: 1.0.0
  owner: Cloud Life Sales Army (project skill)
---

# Delivery & feedback

**Export (clean):** Prospect-ID, Bedrijfsnaam, Website, Sector, Medewerkers, Hoofdkantoor, Telefoonnummer,
IT-beslisser (rol), Contactpersoon (only if lawfully public), Prioriteit. No AI arguments or research notes.

**Gates:** QA approved → contact-eligible → human approval of item and list → export re-checks suppressions.

**Feedback statuses:** nog niet gebeld · geen gehoor · gatekeeper · verkeerde contactpersoon · geen interesse ·
bestaande leverancier · geen Microsoft-omgeving · geen inkoopbevoegdheid · later opnieuw contact ·
gekwalificeerde kans · afspraak gepland · klant geworden · niet benaderen.

**Rules:** history is append-only (corrections supersede, never overwrite); "niet benaderen" creates a permanent
suppression with minimal identifiers; estimated pipeline (€3.500/mnd midpoint) is never reported as contracted revenue.

**Learning:** compare appointment rates by industry, size, score band, service, signal and Microsoft evidence with
Wilson intervals; label evidence as statistically meaningful / indicative / speculative; structural rule changes
require human approval.
