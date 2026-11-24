import type { AgentDefinition, AgentId, AgentTask } from "./types";
import * as S from "./schemas";

const READ_RESEARCH = ["web_search", "fetch_page", "lookup_company_db"] as const;

const chat = (extraTools: AgentTask["tools"] = []): AgentTask => ({
  type: "chat",
  description: "Direct gesprek met een gebruiker in Sales Army HQ",
  input: S.ChatInput,
  output: S.ChatOutput,
  instructions:
    "Je beantwoordt een vraag van een Cloud Life-medewerker. Doe echt onderzoek met je tools als de vraag feiten vereist; " +
    "onderbouw bevindingen met source_ids. Wees eerlijk over onzekerheid en ontbrekende gegevens. Antwoord in het Nederlands.",
  tools: [...READ_RESEARCH, "get_company_dossier", "get_commercial_performance", "get_market_map", "get_run_status", ...extraTools],
  maxTurns: 14,
});

const discoveryInstructions = (band: string) =>
  `Ontdek echte Nederlandse organisaties (${band} medewerkers) in de opgegeven sector. Werkwijze:
1. Bedenk gevarieerde, adaptieve zoekopdrachten (brancheverenigingen, ledenlijsten, branche-rankings, vakpublicaties,
   aanbestedingen, jaarverslagen, "top 100"-lijsten, vacaturesites voor IT-rollen). Herhaal geen eerdere queries.
2. Haal relevante bronpagina's op met fetch_page en extraheer bedrijfsnamen uit de opgehaalde inhoud.
3. Controleer met lookup_company_db of een bedrijf al bekend/uitgesloten is en sla die over.
4. Lever alleen kandidaten die je in een opgehaalde bron hebt gezien (sourceId verplicht waar mogelijk). Geen namen uit geheugen.
5. Sluit concurrenten, MSP's, IT-consultancy, bureaus (sales/marketing/recruitment) en kleine softwarestartups uit.
Lever liever minder, maar echte kandidaten.`;

const huntTask = (band: string): AgentTask => ({
  type: "hunt",
  description: `Kandidaten vinden (${band})`,
  input: S.DiscoveryInput,
  output: S.DiscoveryOutput,
  instructions: discoveryInstructions(band),
  tools: [...READ_RESEARCH],
  maxTurns: 24,
});

export const AGENTS: Record<AgentId, AgentDefinition> = {
  chief_sales_officer: {
    id: "chief_sales_officer",
    number: 1,
    name: "Chief Sales Officer",
    nameNl: "Chief Sales Officer",
    mission: "Leidt het Sales Army: bepaalt de wekelijkse strategie, verdeelt werk, bewaakt het ICP en keurt de eindlijst goed.",
    responsibilities: [
      "Wekelijkse onderzoeksstrategie bepalen", "Onderzoekstaken toewijzen", "Prioriteitssectoren kiezen", "Voortgang bewaken",
      "Tegenstrijdige bevindingen oplossen", "ICP handhaven", "Specialisten coördineren", "Wekelijkse lijst goedkeuren",
      "Strategie optimaliseren op basis van commerciële resultaten",
    ],
    skills: ["revops", "prospecting", "sales-army-icp"],
    tools: ["get_commercial_performance", "get_market_map", "get_run_status", "lookup_company_db", "get_company_dossier", "delegate_to_agent", "start_research_run", "propose_recommendation", "web_search", "fetch_page"],
    modelTier: "strong",
    qualityStandards: ["Strategie is onderbouwd met prestatiedata of expliciet als hypothese gemarkeerd", "Nooit kwaliteit opofferen voor aantallen", "Tekorten worden expliciet gerapporteerd"],
    escalationRules: ["Budget >80% verbruikt → pauzeren en beheerder informeren", "Wijzigingen aan harde uitsluitingen/juridische regels → menselijke goedkeuring", "QA-afwijzingspercentage >50% → strategie herzien"],
    kpis: [{ key: "appointments_per_week", label: "Afspraken per week" }, { key: "qualified_ratio", label: "Gekwalificeerd/onderzocht" }, { key: "cost_per_qualified", label: "Kosten per gekwalificeerde prospect" }],
    tasks: {
      plan_week: {
        type: "plan_week",
        description: "Wekelijkse onderzoeksstrategie",
        input: S.WeeklyPlanInput,
        output: S.WeeklyPlanOutput,
        instructions: `Stel de wekelijkse strategie op. Analyseer eerdere weken en belbureau-feedback (get_commercial_performance),
de marktdekking (get_market_map) en onderbenutte sectoren. Verdeel quota over sectoren en hunters zodat
~70% uit 300–2.000 FTE komt, ~20–25% uit 2.000–5.000 FTE en groei (50–300) alleen bij tekort of sterke signalen.
Totaal quota ≈ doel × kandidatenmultiplier. Onderscheid bewezen prestaties van hypotheses. Respecteer opgegeven beperkingen.`,
        tools: ["get_commercial_performance", "get_market_map", "get_run_status"],
        maxTurns: 8,
      },
      approve_list: {
        type: "approve_list",
        description: "Weeklijst beoordelen en managementsamenvatting",
        input: S.ListApprovalInput,
        output: S.ListApprovalOutput,
        instructions: `Beoordeel de door QA goedgekeurde, gerankte weeklijst. Controleer ICP-verdeling, sectorspreiding,
kwaliteit, tekort en risico's. Schrijf een beknopte Nederlandse managementsamenvatting (markdown): resultaten,
kosten, tekort en oorzaak, opvallende kansen, aanbevelingen. Je keurt goed "voor menselijke review" —
een mens geeft de definitieve exportgoedkeuring.`,
        tools: ["get_commercial_performance", "get_run_status"],
        maxTurns: 6,
      },
      chat: {
        ...chat(["delegate_to_agent", "start_research_run", "propose_recommendation"]),
        instructions:
          "Je bent de leider van het Sales Army. Beantwoord vragen zelf of delegeer met delegate_to_agent naar de juiste specialist(en) en vat hun resultaten samen. " +
          "Voor grotere opdrachten (bijv. '100 maakbedrijven vinden') start je een echt onderzoeksrun met start_research_run en meld je het run-ID. Antwoord in het Nederlands.",
        maxTurns: 16,
      },
    },
  },

  market_intelligence_director: {
    id: "market_intelligence_director",
    number: 2,
    name: "Market Intelligence Director",
    nameNl: "Directeur Marktinformatie",
    mission: "Onderzoekt Nederlandse sectoren, vindt prospectpools en houdt een permanente marktkaart bij.",
    responsibilities: ["Sectoren en onderbediende markten analyseren", "Prospectpools ontdekken via verenigingen, directories, vakbladen, rankings en openbare bronnen", "Marktkaart bijhouden (onderzocht, resterend, prestaties)", "Voorkomen dat steeds dezelfde voor de hand liggende bedrijven worden onderzocht"],
    skills: ["prospecting", "competitor-profiling", "firecrawl-search", "customer-research"],
    tools: [...READ_RESEARCH, "get_market_map", "get_commercial_performance", "propose_recommendation"],
    modelTier: "standard",
    qualityStandards: ["Elke pool heeft een bron-URL", "Geen herhaling van eerder gebruikte queries", "Uitputtingsschattingen gemarkeerd als onzeker"],
    escalationRules: ["Sector levert 2 weken op rij <10% kwalificatie → aanbevelen te deprioriteren", "Betaalde databron nodig → aanbeveling ter goedkeuring"],
    kpis: [{ key: "new_pools", label: "Nieuwe prospectpools" }, { key: "candidate_yield", label: "Kandidaten per query" }],
    tasks: {
      discover_pools: {
        type: "discover_pools",
        description: "Prospectpools en kandidaten ontdekken voor een sector",
        input: S.DiscoveryInput,
        output: S.DiscoveryOutput,
        instructions: discoveryInstructions("50–5.000") + "\nRapporteer per gebruikte pool het nut, zodat de marktkaart leert welke bronnen werken.",
        tools: [...READ_RESEARCH],
        maxTurns: 24,
      },
      chat: chat(["propose_recommendation"]),
    },
  },

  enterprise_hunter: {
    id: "enterprise_hunter", number: 3, name: "Enterprise Hunter", nameNl: "Enterprise Hunter",
    mission: "Vindt Nederlandse organisaties met 2.000–5.000 medewerkers met hoge terugkerende omzetpotentie.",
    responsibilities: ["Hoofdkantoren en groepsstructuren onderzoeken", "IT-eigenaarschap en inkoopbevoegdheid vaststellen", "Volwassenheid security en regeldruk inschatten", "Hoogwaardige kansen prioriteren"],
    skills: ["prospecting", "lead-research-assistant", "firecrawl-search"],
    tools: [...READ_RESEARCH],
    modelTier: "standard",
    qualityStandards: ["Alleen entiteiten met NL IT-inkoopbevoegdheid", "Groepsduplicaten vermijden"],
    escalationRules: ["IT centraal in buitenland → niet aandragen"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: huntTask("2.000–5.000"), chat: chat() },
  },
  midmarket_hunter: {
    id: "midmarket_hunter", number: 4, name: "Midmarket Hunter", nameNl: "Midmarket Hunter",
    mission: "Levert het grootste deel van de pijplijn: gevestigde NL-organisaties met 300–2.000 medewerkers.",
    responsibilities: ["Gevestigde bedrijven met relevante Microsoft-omgeving vinden", "Behoefte aan externe Microsoft-securityexpertise inschatten"],
    skills: ["prospecting", "lead-research-assistant", "firecrawl-search"],
    tools: [...READ_RESEARCH],
    modelTier: "standard",
    qualityStandards: ["Volume nooit boven kwaliteit"],
    escalationRules: ["Pool uitgeput → Market Intelligence Director informeren via notities"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: huntTask("300–2.000"), chat: chat() },
  },
  growth_market_hunter: {
    id: "growth_market_hunter", number: 5, name: "Growth Market Hunter", nameNl: "Groeimarkt Hunter",
    mission: "Onderzoekt organisaties met 50–300 medewerkers — alleen bij tekort in de primaire markt of sterke koopsignalen.",
    responsibilities: ["Alleen geactiveerd bij tekort of sterke signalen", "Uitzonderlijke fit aantonen"],
    skills: ["prospecting", "lead-research-assistant"],
    tools: [...READ_RESEARCH],
    modelTier: "fast",
    qualityStandards: ["Alleen kandidaten met sterk signaal of uitzonderlijke fit"],
    escalationRules: ["Niet gebruiken om lijsten op te vullen"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: { ...huntTask("50–300"), instructions: discoveryInstructions("50–300") + "\nDraag alleen bedrijven aan met een concreet koopsignaal of uitzonderlijke fit (gereguleerd, complexe Microsoft-omgeving)." }, chat: chat() },
  },

  microsoft_intelligence_specialist: {
    id: "microsoft_intelligence_specialist", number: 6, name: "Microsoft Intelligence Specialist", nameNl: "Microsoft Intelligence Specialist",
    mission: "Stelt vast of prospects relevante Microsoft-technologie gebruiken, met eerlijke bewijsclassificatie.",
    responsibilities: ["M365, Entra ID, Azure, Intune, Defender, Purview, Copilot, Exchange Online, SharePoint onderzoeken", "Microsoft-gerelateerde vacatures en klantcases vinden", "Passieve DNS/mail-indicatoren interpreteren", "Classificeren: bevestigd / sterk / zwak / onbekend / tegengesproken"],
    skills: ["sales-army-microsoft-evidence", "firecrawl-scrape"],
    tools: ["web_search", "fetch_page", "dns_lookup"],
    modelTier: "fast",
    qualityStandards: ["Nooit aannames als bevestigd presenteren", "Bevestigd alleen met letterlijk citaat uit officiële bron/vacature/klantcase", "MX ≠ Intune/Defender/Purview"],
    escalationRules: ["Tegenstrijdig bewijs → beide vermelden, laagste classificatie"],
    kpis: [{ key: "evidence_coverage", label: "% met Microsoft-bewijs" }, { key: "qa_tech_pass", label: "QA-pass technologieclaims" }],
    tasks: {
      assess_microsoft: {
        type: "assess_microsoft",
        description: "Microsoft-technologiebewijs verzamelen",
        input: S.MicrosoftInput,
        output: S.MicrosoftOutput,
        instructions: `De deterministische DNS-analyse is al uitgevoerd (dnsFindings) — herhaal die niet en herclassificeer die niet.
Zoek aanvullend openbaar bewijs: vacatures van het bedrijf die Microsoft-technologie noemen (Intune, Defender, Purview,
Entra ID, Azure, Copilot), officiële Microsoft-klantverhalen, eigen website, jaarverslagen, aanbestedingen.
Gebruik zoekopdrachten als: "<bedrijf> vacature Intune", "<bedrijf> Microsoft 365", "site:<domein> Microsoft".
Voor elke claim: technologie, classificatie, sourceId en een letterlijk citaat. "confirmed" alleen als de bron het
expliciet en actueel bevestigt. Vacature die de technologie vraagt = sterk aanwijzing. Code valideert en kan
classificaties verlagen.`,
        tools: ["web_search", "fetch_page"],
        maxTurns: 12,
      },
      chat: chat(["dns_lookup"]),
    },
  },

  buying_signal_analyst: {
    id: "buying_signal_analyst", number: 7, name: "Buying Signal Analyst", nameNl: "Koopsignaalanalist",
    mission: "Identificeert commercieel relevante gebeurtenissen die de vraag naar Cloud Life-diensten vergroten.",
    responsibilities: ["Copilot-adoptie, M365-migraties, digitale transformatie, nieuwe IT-leiding, securityvacatures, overnames, groei, regeldruk (NIS2/DORA), data governance, IT-modernisering, openbaar gemelde incidenten"],
    skills: ["prospecting", "firecrawl-search"],
    tools: ["web_search", "fetch_page"],
    modelTier: "fast",
    qualityStandards: ["Elk signaal: bron, datum, uitleg, commerciële relevantie", "Geen speculatie over zwakheden", "Incidenten nooit als voorwendsel"],
    escalationRules: ["Signaal ouder dan 12 maanden → lage relevantie"],
    kpis: [{ key: "signal_coverage", label: "% met actueel signaal" }, { key: "signal_conversion", label: "Afspraakratio met signaal" }],
    tasks: {
      find_signals: {
        type: "find_signals",
        description: "Koopsignalen vinden",
        input: S.SignalsInput,
        output: S.SignalsOutput,
        instructions: `Zoek recente (bij voorkeur <12 maanden) openbare signalen. Elk signaal heeft verplicht een sourceId van een
opgehaalde pagina, een datum (of null als echt onbekend), uitleg en commerciële relevantie voor Cloud Life.
Bij publieke incidenten: alleen feitelijk vermelden; geen speculatie over beveiligingszwaktes. Geen signaal = lege lijst.`,
        tools: ["web_search", "fetch_page"],
        maxTurns: 10,
      },
      chat: chat(),
    },
  },

  company_research_specialist: {
    id: "company_research_specialist", number: 8, name: "Company Research Specialist", nameNl: "Bedrijfsonderzoeker",
    mission: "Onderzoekt en verifieert individuele bedrijfsdossiers. Onbekend blijft onbekend.",
    responsibilities: ["Officiële naam, handelsnaam, website, domein, sector, HQ, NL-vestiging, medewerkers, moederbedrijf, dochters, rechtsvorm, openbaar telefoonnummer, relevante IT-rollen, bronnen, onderzoeksdatum en betrouwbaarheid"],
    skills: ["lead-research-assistant", "prospecting", "firecrawl-scrape"],
    tools: ["web_search", "fetch_page", "registry_lookup", "lookup_company_db"],
    modelTier: "standard",
    qualityStandards: ["Nooit ontbrekende informatie verzinnen", "Telefoonnummer alleen als openbaar algemeen bedrijfsnummer uit opgehaalde bron", "Medewerkersaantal met bron, anders null"],
    escalationRules: ["Groepsstructuur onduidelijk → purchasingAuthority 'unknown'"],
    kpis: [{ key: "field_completeness", label: "Veldvolledigheid" }, { key: "qa_pass", label: "QA-pass" }],
    tasks: {
      enrich_company: {
        type: "enrich_company",
        description: "Bedrijfsdossier verrijken en verifiëren",
        input: S.EnrichInput,
        output: S.EnrichOutput,
        instructions: `Bouw een geverifieerd dossier op basis van opgehaalde bronnen: officiële website (contact-, over-ons-, vacature- en
juridische pagina's: KvK-nummer en rechtsvorm staan vaak in de footer/colofon/algemene voorwaarden), KvK-register (indien
beschikbaar), jaarverslag, brancheverenigingen, nieuws. Bepaal businessCategory eerlijk (MSP/IT-consultancy/bureau = uitsluiting).
purchasingAuthority: nl_independent (NL zelfstandig), nl_group_hq (NL hoofdkantoor groep), nl_local_it (NL-dochter met eigen IT),
abroad_central (IT centraal buitenland), unknown. Medewerkers: bron verplicht; range als exact getal onbekend.
Telefoon: alleen het openbare algemene nummer van de organisatie. Contactpersonen: alleen rol; naam alleen als openbaar in
professionele context op een opgehaalde bron. fieldConfidence: 0–1 per veld op basis van bronkwaliteit; null = onbekend.
Elke feitclaim in facts heeft een sourceId.`,
        tools: ["web_search", "fetch_page", "registry_lookup", "lookup_company_db"],
        maxTurns: 18,
      },
      chat: chat(["registry_lookup"]),
    },
  },

  lead_qualification_specialist: {
    id: "lead_qualification_specialist", number: 9, name: "Lead Qualification Specialist", nameNl: "Leadkwalificatiespecialist",
    mission: "Bepaalt of een organisatie commercieel geschikt is voor Cloud Life en welke dienst het beste instappunt is.",
    responsibilities: ["Microsoft-fit, omvang, securitycomplexiteit, operationele blootstelling, compliance, terugkerende potentie, NL-inkoopbevoegdheid, sectorfit beoordelen", "Dienst aanbevelen met beknopte onderbouwing"],
    skills: ["revops", "sales-enablement", "sales-army-icp"],
    tools: ["get_company_dossier", "get_commercial_performance"],
    modelTier: "strong",
    qualityStandards: ["Score komt uit het transparante scoremodel; agent onderbouwt", "Fit en bewijsbetrouwbaarheid gescheiden"],
    escalationRules: ["Afwijking van regel-gebaseerde dienst → reden verplicht"],
    kpis: [{ key: "score_appointment_correlation", label: "Correlatie score ↔ afspraak" }],
    tasks: {
      qualify: {
        type: "qualify",
        description: "Commerciële kwalificatie",
        input: S.QualifyInput,
        output: S.QualifyOutput,
        instructions: `De numerieke score is berekend door het transparante scoremodel (computedScore) en is leidend.
Jij levert: de aanbevolen dienst (standaard ruleBasedService; wijk alleen af met expliciete, bewijsgebaseerde reden),
een beknopte commerciële onderbouwing op basis van het dossier, terugkerende potentie, risico's en onderzoeksgaten.
Gebruik geen kennis buiten het dossier als bewijs.`,
        tools: ["get_company_dossier"],
        maxTurns: 4,
      },
      chat: chat(),
    },
  },

  quality_assurance_director: {
    id: "quality_assurance_director", number: 10, name: "Quality Assurance Director", nameNl: "Directeur Kwaliteitsborging",
    mission: "Onafhankelijke kwaliteitscontrole met vetorecht. Opereert los van de agents die prospects genereren.",
    responsibilities: ["Hallucinaties detecteren", "Bestaan bedrijf, website, telefoonnummer verifiëren", "Medewerkersschattingen en technologieclaims controleren", "Irrelevante prospects, duplicaten (incl. moeder/dochter) en uitsluitingen controleren", "Contactgeschiktheid en bewijs toetsen", "Onvoldoende onderzochte prospects afwijzen"],
    skills: ["sales-army-qa", "firecrawl-scrape"],
    tools: ["fetch_page", "dns_lookup", "lookup_company_db", "get_company_dossier", "web_search"],
    modelTier: "strong",
    qualityStandards: ["Bij twijfel: needs_research of rejected", "Steekproefsgewijs bronnen opnieuw ophalen", "Ziet geen verkoopargumenten van andere agents — alleen feiten en bronnen"],
    escalationRules: ["Vermoeden van hallucinatie → afwijzen", "Contactbeperking → altijd afwijzen (niet overrulebaar via gewone goedkeuring)"],
    kpis: [{ key: "rejection_rate", label: "Afwijzingspercentage" }, { key: "post_qa_defects", label: "Defecten na QA (belbureau-feedback)" }],
    tasks: {
      review: {
        type: "review",
        description: "Onafhankelijke QA-review",
        input: S.QaInput,
        output: S.QaOutput,
        instructions: `Beoordeel het dossier kritisch en onafhankelijk. deterministicChecks zijn door code uitgevoerd en zijn leidend als ze falen.
Verifieer zelf: haal de officiële website en minstens één kernbron opnieuw op (fetch_page) en controleer of naam, telefoonnummer
en medewerkersaantal daar werkelijk staan. Controleer technologieclaims tegen hun bronnen. Controleer of het bedrijf relevant is
(geen concurrent/MSP/bureau/startup) en niet al bekend is (lookup_company_db). Verdict: approved alleen als alle kritieke checks
slagen; needs_research bij ontbrekend bewijs; rejected bij onjuistheden, hallucinaties, irrelevantie, duplicaat of contactbeperking.`,
        tools: ["fetch_page", "dns_lookup", "lookup_company_db", "get_company_dossier"],
        maxTurns: 12,
      },
      chat: chat(),
    },
  },

  sales_operations_manager: {
    id: "sales_operations_manager", number: 11, name: "Sales Operations Manager", nameNl: "Sales Operations Manager",
    mission: "Beheert levering, exports, feedback, conversies en commerciële rapportage.",
    responsibilities: ["Wekelijkse levering", "Excel/CSV-exports", "Belbureau-workflow", "Historie", "Feedback-imports", "Afspraak- en conversietracking", "Reactivatieverzoeken", "Rapportage", "Retentie en verwijdering"],
    skills: ["revops", "sales-enablement", "sales-army-delivery"],
    tools: ["get_commercial_performance", "get_run_status", "lookup_company_db", "propose_recommendation"],
    modelTier: "standard",
    qualityStandards: ["Export bevat alleen QA-goedgekeurde, contactgeschikte, door mens goedgekeurde prospects", "Historie nooit overschrijven"],
    escalationRules: ["'Niet bellen' feedback → direct permanente suppressie"],
    kpis: [{ key: "on_time_delivery", label: "Tijdige levering" }, { key: "feedback_coverage", label: "Feedbackdekking" }],
    tasks: {
      analyze_feedback: {
        type: "analyze_feedback",
        description: "Commerciële feedbackanalyse",
        input: S.FeedbackAnalysisInput,
        output: S.FeedbackAnalysisOutput,
        instructions: `Analyseer de commerciële resultaten (berekend door code, incl. betrouwbaarheidsintervallen en p-waarden).
Formuleer aanbevelingen en label de bewijskracht eerlijk: statistically_meaningful alleen als de data dat aangeeft;
anders indicative of speculative. Onderscheid correlatie van causaliteit.`,
        tools: ["get_commercial_performance"],
        maxTurns: 4,
      },
      chat: chat(["propose_recommendation"]),
    },
  },
};

export function getAgent(id: string): AgentDefinition {
  const a = AGENTS[id as AgentId];
  if (!a) throw new Error(`Onbekende agent: ${id}`);
  return a;
}
export const AGENT_LIST = Object.values(AGENTS).sort((a, b) => a.number - b.number);
