import type { AgentDefinition, AgentId, AgentTask } from "./types";
import * as S from "./schemas";

/**
 * The eleven Sales Army agents (v2). Design principles after the engineering review:
 *  - Deterministic code does everything that needs no judgement (crawling, DNS, regex extraction,
 *    dedup, exclusions, scoring, eligibility, ranking, export).
 *  - Per-company model work is ONE cheap extraction call over pages already retrieved; tool-using
 *    agents are activated dynamically only for promising candidates with real gaps.
 *  - Strategic agents (CSO, Market Intelligence, Hunters) work on SOURCES and STRATEGY, not on
 *    individual companies. The CSO never touches single companies in the pipeline.
 *  - No two agents retrieve the same page: all research goes through one cached ResearchService.
 */
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
  maxTurns: 12,
  skills: "all",
});

const huntInstructions = (focus: string) => `Je zoekt organisaties die NIET via standaard zoekopdrachten of bekende ledenlijsten te vinden zijn. Focus: ${focus}
Werkwijze: gebruik gevarieerde, specifieke zoekopdrachten; haal bronnen op met fetch_page; lever alleen organisaties die je in een
opgehaalde bron hebt gezien (sourceId verplicht). Noem in poolsUsed elke bronpagina met een LIJST van organisaties die het waard
is om later opnieuw te oogsten — die wordt permanent in de bronnendatabase opgenomen. Herhaal geen eerdere zoekopdrachten
(previousQueries). Sluit concurrenten, MSP's, IT-consultancy, bureaus en kleine softwarestartups uit. Geen namen uit geheugen.`;

const hunt = (focus: string, tier: AgentTask["modelTier"] = "standard"): AgentTask => ({
  type: "hunt",
  description: `Gerichte prospectjacht (${focus.split(":")[0]})`,
  input: S.DiscoveryInput,
  output: S.DiscoveryOutput,
  instructions: huntInstructions(focus),
  tools: [...READ_RESEARCH],
  maxTurns: 14,
  modelTier: tier,
  skills: "all",
});

export const AGENTS: Record<AgentId, AgentDefinition> = {
  chief_sales_officer: {
    id: "chief_sales_officer",
    number: 1,
    name: "Chief Sales Officer",
    nameNl: "Chief Sales Officer",
    mission: "Leidt het Sales Army strategisch: kiest sectoren en bronnenmix per week, bewaakt het ICP, beoordeelt de eindlijst en schrijft de managementsamenvatting. Micromanaget geen individuele bedrijven.",
    responsibilities: [
      "Wekelijkse onderzoeksstrategie en sectorquota bepalen", "Bronnenmix sturen op basis van bronrendement", "Voortgang en tekorten bewaken",
      "ICP handhaven", "Gebruikersopdrachten delegeren in HQ", "Wekelijkse lijst beoordelen en samenvatten", "Strategie optimaliseren op basis van commerciële resultaten",
    ],
    skills: ["revops", "prospecting", "sales-army-icp"],
    tools: ["get_commercial_performance", "get_market_map", "get_run_status", "lookup_company_db", "get_company_dossier", "delegate_to_agent", "start_research_run", "propose_recommendation", "web_search", "fetch_page"],
    modelTier: "strong",
    activation: "1× per run (strategie) + 1× per run (lijstbeoordeling) + HQ-gesprekken",
    qualityStandards: ["Strategie onderbouwd met prestatiedata of expliciet als hypothese", "Nooit kwaliteit opofferen voor aantallen", "Tekorten expliciet rapporteren"],
    escalationRules: ["Budget >80% verbruikt → pauzeren en beheerder informeren", "Wijzigingen aan harde uitsluitingen/juridische regels → menselijke goedkeuring", "QA-afwijzingspercentage >50% → strategie herzien"],
    kpis: [{ key: "appointments_per_week", label: "Afspraken per week" }, { key: "qualified_ratio", label: "Gekwalificeerd/onderzocht" }, { key: "cost_per_qualified", label: "Kosten per gekwalificeerde prospect" }],
    tasks: {
      plan_week: {
        type: "plan_week",
        description: "Wekelijkse onderzoeksstrategie",
        input: S.WeeklyPlanInput,
        output: S.WeeklyPlanOutput,
        instructions: `Stel de wekelijkse strategie op op basis van prestaties (met betrouwbaarheidsintervallen), marktdekking en bronrendement
(sourceStats: welke bronnen leveren unieke én gekwalificeerde bedrijven). Verdeel quota over sectoren: ~70% 300–2.000 FTE,
~20–25% 2.000–5.000 FTE; groei (50–300) alleen bij tekort. Kies searchThemes die NIEUWE bronnen kunnen opleveren (beurzen,
regionale netwerken, rankings, groepsstructuren, Microsoft-referenties, vacatures). Onderscheid bewezen prestaties van hypotheses.`,
        tools: ["get_commercial_performance", "get_market_map", "get_run_status"],
        maxTurns: 4,
        effort: "medium",
        skills: "all",
      },
      approve_list: {
        type: "approve_list",
        description: "Weeklijst beoordelen en managementsamenvatting",
        input: S.ListApprovalInput,
        output: S.ListApprovalOutput,
        instructions: `Beoordeel de door QA goedgekeurde, gerankte weeklijst: ICP-verdeling, sectorspreiding, kwaliteit, tekort en risico's.
Schrijf een beknopte Nederlandse managementsamenvatting (markdown): resultaten, kosten, tekort en oorzaak, best presterende bronnen,
aanbevelingen. Je keurt goed "voor menselijke review" — een mens geeft de definitieve exportgoedkeuring.`,
        tools: [],
        maxTurns: 2,
        effort: "medium",
        skills: "project",
      },
      chat: {
        ...chat(["delegate_to_agent", "start_research_run", "propose_recommendation"]),
        instructions:
          "Je bent de leider van het Sales Army. Beantwoord vragen zelf of delegeer met delegate_to_agent naar de juiste specialist(en) en vat hun resultaten samen. " +
          "Voor grotere opdrachten (bijv. '100 maakbedrijven vinden') start je een echte onderzoeksrun met start_research_run en meld je het run-ID. Antwoord in het Nederlands.",
        maxTurns: 14,
      },
    },
  },

  market_intelligence_director: {
    id: "market_intelligence_director",
    number: 2,
    name: "Market Intelligence Director",
    nameNl: "Directeur Marktinformatie",
    mission: "Bouwt en onderhoudt de permanente bronnendatabase: vindt nieuwe ontdekkingsbronnen (verenigingen, beurzen, rankings, bedrijventerreinen, publicaties, referenties) en haalt organisaties uit bronpagina's.",
    responsibilities: ["Nieuwe ontdekkingsbronnen vinden per sector", "Lijsten met organisaties uit bronpagina's extraheren (goedkope modeltaak)", "Bronrendement en marktdekking bewaken", "Uitgeputte bronnen herkennen"],
    skills: ["prospecting", "competitor-profiling", "firecrawl-search", "customer-research"],
    tools: [...READ_RESEARCH, "get_market_map", "get_commercial_performance", "propose_recommendation"],
    modelTier: "standard",
    activation: "Scouting: alleen als een sector te weinig productieve bronnen heeft. Lijstextractie: per geoogste bronpagina waar deterministische linkextractie onvoldoende oplevert.",
    qualityStandards: ["Elke bron heeft een opgehaalde URL of herbruikbare zoekopdracht", "Namen alleen zoals letterlijk op de pagina", "Uitputtingsschattingen gemarkeerd als onzeker"],
    escalationRules: ["Bron levert 2 oogsten op rij 0 nieuwe bedrijven → uitgeput", "Betaalde databron nodig → aanbeveling ter goedkeuring"],
    kpis: [{ key: "new_sources", label: "Nieuwe productieve bronnen" }, { key: "unique_per_source", label: "Unieke bedrijven per bron" }],
    tasks: {
      scout_sources: {
        type: "scout_sources",
        description: "Nieuwe ontdekkingsbronnen vinden",
        input: S.ScoutInput,
        output: S.ScoutOutput,
        instructions: `Vind NIEUWE, herbruikbare bronnen die lijsten met Nederlandse organisaties in deze sector bevatten en die niet in existingSources
staan: ledenlijsten van branche- en regionale verenigingen, exposanten-/standhouderslijsten van vakbeurzen, branche-rankings en
"top 100"-overzichten, bedrijventerreinen en parkmanagement, regionale netwerken (bijv. ontwikkelingsmaatschappijen), vakbladen met
bedrijvenoverzichten, groepsstructuren ("onze werkmaatschappijen"), Microsoft-klantverhalen en partnerreferenties (klantcases noemen
de klant), aanbestedende diensten. Haal kandidaat-pagina's op met fetch_page om te bevestigen dat er werkelijk een lijst op staat;
lever die URL. Voor bronnen die alleen via zoeken werken: lever een zoekopdracht met {sector}. Geen social media, geen vacaturesites
waarvan de voorwaarden scrapen verbieden.`,
        tools: ["web_search", "fetch_page"],
        maxTurns: 10,
        effort: "medium",
        skills: "all",
      },
      extract_companies: {
        type: "extract_companies",
        description: "Organisaties uit een bronpagina extraheren",
        input: S.ListExtractInput,
        output: S.ListExtractOutput,
        instructions: `Extraheer de organisaties die deze pagina opsomt of noemt (leden, exposanten, klanten in een case, werkgever van een
vacature, dochterbedrijven, gerankte bedrijven, aanbestedende dienst). Neem namen LETTERLIJK over zoals ze op de pagina staan; voeg
een website alleen toe als die op de pagina staat. Sla de organisatie die de pagina publiceert over (tenzij het een vacature of eigen
case is), net als leveranciers/partners/IT-dienstverleners. Lever direct met submit_result.`,
        tools: [],
        maxTurns: 2,
        modelTier: "fast",
        effort: "low",
        skills: "none",
        maxTokens: 6000,
      },
      chat: chat(["propose_recommendation"]),
    },
  },

  enterprise_hunter: {
    id: "enterprise_hunter", number: 3, name: "Enterprise Hunter", nameNl: "Enterprise Hunter",
    mission: "Vindt Nederlandse organisaties met 2.000–5.000 medewerkers via groepsstructuren, jaarverslagen en rankings — en stelt vast waar IT wordt ingekocht.",
    responsibilities: ["Groepsstructuren en NL-hoofdkantoren onderzoeken", "Jaarverslagen en rankings als bron gebruiken", "IT-inkoopbevoegdheid in NL bevestigen", "Hoogwaardige terugkerende kansen vinden"],
    skills: ["prospecting", "lead-research-assistant", "firecrawl-search"],
    tools: [...READ_RESEARCH],
    modelTier: "standard",
    activation: "1× per run als de strategie enterprise-quotum heeft",
    qualityStandards: ["Alleen entiteiten met NL IT-inkoopbevoegdheid", "Groepsduplicaten vermijden"],
    escalationRules: ["IT centraal in buitenland → niet aandragen"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: hunt("enterprise 2.000–5.000 FTE: groepsstructuren, jaarverslagen, rankings van grootste werkgevers, NL-hoofdkantoren van groepen"), chat: chat() },
  },
  midmarket_hunter: {
    id: "midmarket_hunter", number: 4, name: "Midmarket Hunter", nameNl: "Midmarket Hunter",
    mission: "Vindt moeilijk vindbare middelgrote organisaties (300–2.000 FTE) via signaalgedreven zoekwerk: Microsoft-vacatures, partnerreferenties, regionale netwerken en vakpublicaties.",
    responsibilities: ["Signaalgedreven ontdekking (vacatures met Microsoft-technologie, partnercases)", "Regionale en sectorspecifieke netwerken aanboren", "Gaten opvullen die de bronnendatabase niet dekt"],
    skills: ["prospecting", "lead-research-assistant", "firecrawl-search"],
    tools: [...READ_RESEARCH],
    modelTier: "standard",
    activation: "Wanneer een sector onvoldoende kandidaten uit bronnen oplevert, en in de tekortronde",
    qualityStandards: ["Volume nooit boven kwaliteit"],
    escalationRules: ["Pool uitgeput → Market Intelligence Director informeren via notities"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: hunt("midmarket 300–2.000 FTE: vacatures die Microsoft 365/Intune/Entra/Defender/Purview noemen, klantcases van Microsoft-partners, regionale ondernemersnetwerken, vakbladen"), chat: chat() },
  },
  growth_market_hunter: {
    id: "growth_market_hunter", number: 5, name: "Growth Market Hunter", nameNl: "Groeimarkt Hunter",
    mission: "Onderzoekt organisaties met 50–300 medewerkers — alleen bij tekort in de primaire markt of sterke koopsignalen.",
    responsibilities: ["Alleen geactiveerd in de tekortronde", "Uitzonderlijke fit aantonen (gereguleerd, complexe Microsoft-omgeving, sterk signaal)"],
    skills: ["prospecting", "lead-research-assistant"],
    tools: [...READ_RESEARCH],
    modelTier: "fast",
    activation: "Alleen in de tekortronde van een run",
    qualityStandards: ["Alleen kandidaten met sterk signaal of uitzonderlijke fit"],
    escalationRules: ["Niet gebruiken om lijsten op te vullen"],
    kpis: [{ key: "qualified_ratio", label: "Kwalificatieratio" }],
    tasks: { hunt: hunt("groei 50–300 FTE, alleen met concreet koopsignaal of gereguleerde data", "fast"), chat: chat() },
  },

  microsoft_intelligence_specialist: {
    id: "microsoft_intelligence_specialist", number: 6, name: "Microsoft Intelligence Specialist", nameNl: "Microsoft Intelligence Specialist",
    mission: "Zoekt aanvullend openbaar bewijs voor Microsoft-technologie wanneer de deterministische DNS- en website-analyse geen sterk bewijs opleverde.",
    responsibilities: ["Microsoft-vacatures, klantverhalen, partnerreferenties en publicaties vinden", "Classificeren per technologie: bevestigd / sterk / zwak / onbekend / tegengesproken"],
    skills: ["sales-army-microsoft-evidence", "firecrawl-scrape"],
    tools: ["web_search", "fetch_page", "dns_lookup"],
    modelTier: "fast",
    activation: "Alleen voor kansrijke kandidaten waarvan Microsoft 365-bewijs na screening zwakker is dan 'sterk aangewezen'",
    qualityStandards: ["Nooit aannames als bevestigd presenteren", "Bevestigd alleen met letterlijk citaat uit gezaghebbende bron", "MX ≠ Intune/Defender/Purview"],
    escalationRules: ["Tegenstrijdig bewijs → beide vermelden, laagste classificatie"],
    kpis: [{ key: "evidence_coverage", label: "% met Microsoft-bewijs" }, { key: "qa_tech_pass", label: "QA-pass technologieclaims" }],
    tasks: {
      assess_microsoft: {
        type: "assess_microsoft",
        description: "Microsoft-technologiebewijs verzamelen",
        input: S.MicrosoftInput,
        output: S.MicrosoftOutput,
        instructions: `De DNS-analyse en de scan van de eigen website zijn al uitgevoerd (dnsFindings) — herhaal en herclassificeer die niet.
Zoek gericht (max. 3 zoekopdrachten): vacatures van dit bedrijf die Microsoft-technologie noemen, Microsoft-klantverhalen,
klantcases van Microsoft-partners waarin dit bedrijf de klant is, jaarverslag/IT-publicaties. Per claim: technologie, classificatie,
sourceId en letterlijk citaat. "confirmed" alleen als de bron het expliciet en actueel bevestigt. Code valideert en kan verlagen.`,
        tools: ["web_search", "fetch_page"],
        maxTurns: 6,
        effort: "low",
        skills: "project",
        maxTokens: 6000,
      },
      chat: chat(["dns_lookup"]),
    },
  },

  buying_signal_analyst: {
    id: "buying_signal_analyst", number: 7, name: "Buying Signal Analyst", nameNl: "Koopsignaalanalist",
    mission: "Identificeert recente, onderbouwde gebeurtenissen die de vraag naar Protect 365 of Purview Care vergroten.",
    responsibilities: ["Copilot-adoptie, M365-migraties, nieuwe IT-leiding, securityvacatures, overnames, NIS2/DORA, data governance, IT-modernisering, openbare incidenten"],
    skills: ["prospecting", "firecrawl-search"],
    tools: ["web_search", "fetch_page"],
    modelTier: "fast",
    activation: "Alleen voor kandidaten met voorlopige fit ≥ drempel (instelling signalsMinFit); signalen van de eigen website zijn dan al deterministisch gevonden",
    qualityStandards: ["Elk signaal: bron, datum, uitleg, commerciële relevantie", "Geen speculatie over zwakheden", "Incidenten nooit als voorwendsel"],
    escalationRules: ["Signaal ouder dan 12 maanden → lage relevantie"],
    kpis: [{ key: "signal_coverage", label: "% met actueel signaal" }, { key: "signal_conversion", label: "Afspraakratio met signaal" }],
    tasks: {
      find_signals: {
        type: "find_signals",
        description: "Koopsignalen vinden",
        input: S.SignalsInput,
        output: S.SignalsOutput,
        instructions: `Zoek recente (<12 maanden) openbare signalen buiten de eigen website (nieuws, persberichten, jaarverslag). Max. 2 zoekopdrachten.
Elk signaal heeft verplicht een sourceId van een opgehaalde pagina, een datum (of null), uitleg en relevantie voor Cloud Life.
Bij publieke incidenten: alleen feitelijk; geen speculatie. Geen signaal = lege lijst.`,
        tools: ["web_search", "fetch_page"],
        maxTurns: 6,
        effort: "low",
        skills: "none",
        maxTokens: 5000,
      },
      chat: chat(),
    },
  },

  company_research_specialist: {
    id: "company_research_specialist", number: 8, name: "Company Research Specialist", nameNl: "Bedrijfsonderzoeker",
    mission: "Zet opgehaalde pagina's om in een geverifieerd bedrijfsdossier (één goedkope extractie) en vult alleen bij kansrijke kandidaten gericht de kritieke gaten.",
    responsibilities: ["Officiële naam, sector, omvang, groep, inkoopbevoegdheid, rechtsvorm, compliance-relevantie en IT-rollen vastleggen met citaat", "Gericht gaten vullen (medewerkers, rechtsvorm, telefoonnummer, groepsstructuur)"],
    skills: ["lead-research-assistant", "prospecting", "firecrawl-scrape"],
    tools: ["web_search", "fetch_page", "registry_lookup", "lookup_company_db"],
    modelTier: "standard",
    activation: "Extractie: elke kandidaat die de gratis screening doorstaat. Gatenvulling: alleen kansrijke kandidaten met kritieke gaten na KvK-lookup",
    qualityStandards: ["Nooit ontbrekende informatie verzinnen", "Elk veld met letterlijk citaat uit een opgehaalde bron", "Onbekend blijft null"],
    escalationRules: ["Groepsstructuur onduidelijk → purchasingAuthority 'unknown'"],
    kpis: [{ key: "field_completeness", label: "Veldvolledigheid" }, { key: "qa_pass", label: "QA-pass" }],
    tasks: {
      extract_profile: {
        type: "extract_profile",
        description: "Bedrijfsprofiel extraheren uit opgehaalde pagina's",
        input: S.ExtractProfileInput,
        output: S.ExtractProfileOutput,
        instructions: `Je krijgt pagina's die al zijn opgehaald (homepage, contact, over ons, colofon, vacatures) en deterministische bevindingen.
Extraheer uitsluitend wat in die pagina's staat; elk gevuld veld krijgt een sourceId en een LETTERLIJK citaat uit die pagina
(code controleert dit en verwijdert velden waarvan het citaat niet voorkomt). businessCategory eerlijk bepalen
(MSP/IT-consultancy/bureau = uitsluiting). purchasingAuthority: nl_independent / nl_group_hq / nl_local_it / abroad_central / unknown.
Contactrollen alleen als ze op de pagina staan; naam alleen in professionele context. Lever direct met submit_result.`,
        tools: [],
        maxTurns: 2,
        modelTier: "fast",
        effort: "low",
        skills: "none",
        maxTokens: 6000,
      },
      deep_research: {
        type: "deep_research",
        description: "Kritieke gaten gericht onderzoeken",
        input: S.GapFillInput,
        output: S.GapFillOutput,
        instructions: `Vul ALLEEN de opgegeven gaten (gaps). knownSources zijn al opgehaald en staan in de database — haal die niet opnieuw op.
Gebruik gerichte bronnen: jaarverslag, KvK-register (registry_lookup indien beschikbaar), groepswebsite, persberichten, vakbladen.
Maximaal 4 nieuwe pagina's. Elk antwoord met sourceId en letterlijk citaat; onvindbaar → null en in stillUnknown.`,
        tools: ["web_search", "fetch_page", "registry_lookup"],
        maxTurns: 8,
        effort: "medium",
        skills: "project",
        maxTokens: 6000,
      },
      chat: chat(["registry_lookup"]),
    },
  },

  lead_qualification_specialist: {
    id: "lead_qualification_specialist", number: 9, name: "Lead Qualification Specialist", nameNl: "Leadkwalificatiespecialist",
    mission: "Schrijft voor de eindlijst in batches een beknopte, op bewijs gebaseerde commerciële onderbouwing en toetst de aanbevolen dienst (Protect 365 / Purview Care of een assessment als instap).",
    responsibilities: ["Commerciële onderbouwing per prospect (batch van max. 20)", "Dienst-aanbeveling toetsen tegen het dossier", "Terugkerende potentie inschatten"],
    skills: ["revops", "sales-enablement", "sales-army-icp"],
    tools: ["get_company_dossier"],
    modelTier: "standard",
    activation: "Alleen bij het afronden van een run, in batches, voor de geselecteerde prospects. De score zelf is deterministisch.",
    qualityStandards: ["Score komt uit het transparante scoremodel; agent onderbouwt", "Afwijking van regel-dienst alleen met reden", "Geen nieuwe diensten introduceren"],
    escalationRules: ["Afwijking van regel-gebaseerde dienst → reden verplicht"],
    kpis: [{ key: "score_appointment_correlation", label: "Correlatie score ↔ afspraak" }],
    tasks: {
      rationale_batch: {
        type: "rationale_batch",
        description: "Commerciële onderbouwing (batch)",
        input: S.RationaleBatchInput,
        output: S.RationaleBatchOutput,
        instructions: `Schrijf per bedrijf 2–4 zinnen commerciële onderbouwing, uitsluitend gebaseerd op de meegegeven feiten en score. Kerndiensten zijn
Protect 365 en Purview Care; assessments en implementatieprojecten zijn instappunten naar een terugkerende relatie. Neem de
regel-dienst over tenzij de feiten een andere instap duidelijk beter onderbouwen (geef dan serviceReason). Lever één item per companyId.`,
        tools: [],
        maxTurns: 2,
        effort: "low",
        skills: "project",
        maxTokens: 8000,
      },
      chat: chat(),
    },
  },

  quality_assurance_director: {
    id: "quality_assurance_director", number: 10, name: "Quality Assurance Director", nameNl: "Directeur Kwaliteitsborging",
    mission: "Onafhankelijke kwaliteitscontrole met vetorecht, alleen op kandidaten die de lijst kunnen halen. Opereert los van de agents die prospects genereren.",
    responsibilities: ["Hallucinaties detecteren", "Bestaan, website, telefoonnummer en medewerkersaantal verifiëren", "Technologieclaims tegen bronnen toetsen", "Irrelevante prospects, duplicaten en uitsluitingen controleren", "Contactgeschiktheid en bewijs toetsen"],
    skills: ["sales-army-qa", "firecrawl-scrape"],
    tools: ["fetch_page", "dns_lookup", "lookup_company_db", "get_company_dossier", "web_search"],
    modelTier: "strong",
    activation: "Alleen voor kandidaten die na deterministische scoring 'sterk' of 'uitzonderlijk' zijn",
    qualityStandards: ["Bij twijfel: needs_research of rejected", "Steekproefsgewijs één bron opnieuw ophalen", "Ziet geen verkoopargumenten van andere agents"],
    escalationRules: ["Vermoeden van hallucinatie → afwijzen", "Contactbeperking → altijd afwijzen"],
    kpis: [{ key: "rejection_rate", label: "Afwijzingspercentage" }, { key: "post_qa_defects", label: "Defecten na QA (belbureau-feedback)" }],
    tasks: {
      review: {
        type: "review",
        description: "Onafhankelijke QA-review",
        input: S.QaInput,
        output: S.QaOutput,
        instructions: `Beoordeel het dossier kritisch en onafhankelijk. deterministicChecks (door code) zijn leidend als ze falen.
De bronfragmenten staan in het dossier; haal hoogstens één kernbron opnieuw op als je twijfelt (fetch_page). Controleer naam,
telefoonnummer, medewerkersaantal, technologieclaims, relevantie (geen concurrent/MSP/bureau/startup) en duplicaten.
approved alleen als alle kritieke checks slagen; needs_research bij ontbrekend bewijs; rejected bij onjuistheden of hallucinaties.`,
        tools: ["fetch_page", "lookup_company_db"],
        maxTurns: 4,
        effort: "medium",
        skills: "project",
        maxTokens: 6000,
      },
      chat: chat(),
    },
  },

  sales_operations_manager: {
    id: "sales_operations_manager", number: 11, name: "Sales Operations Manager", nameNl: "Sales Operations Manager",
    mission: "Analyseert wekelijks de commerciële resultaten en formuleert aanbevelingen. Levering, exports, imports en retentie zijn deterministische processen onder zijn verantwoordelijkheid.",
    responsibilities: ["Wekelijkse feedbackanalyse", "Aanbevelingen met eerlijke bewijskracht", "Bewaken van levering, imports, conversies en retentie (deterministisch)"],
    skills: ["revops", "sales-enablement", "sales-army-delivery"],
    tools: ["get_commercial_performance", "get_run_status", "lookup_company_db", "propose_recommendation"],
    modelTier: "standard",
    activation: "1× per week (maandag 06:00) wanneer er belresultaten zijn",
    qualityStandards: ["Export bevat alleen QA-goedgekeurde, contactgeschikte, door mens goedgekeurde prospects", "Historie nooit overschrijven"],
    escalationRules: ["'Niet bellen' feedback → direct permanente suppressie"],
    kpis: [{ key: "on_time_delivery", label: "Tijdige levering" }, { key: "feedback_coverage", label: "Feedbackdekking" }],
    tasks: {
      analyze_feedback: {
        type: "analyze_feedback",
        description: "Commerciële feedbackanalyse",
        input: S.FeedbackAnalysisInput,
        output: S.FeedbackAnalysisOutput,
        instructions: `Analyseer de commerciële resultaten (berekend door code, incl. betrouwbaarheidsintervallen en p-waarden) en het bronrendement.
Formuleer aanbevelingen en label de bewijskracht eerlijk: statistically_meaningful alleen als de data dat aangeeft;
anders indicative of speculative. Onderscheid correlatie van causaliteit.`,
        tools: [],
        maxTurns: 2,
        effort: "medium",
        skills: "project",
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
