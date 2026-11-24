/**
 * Seed catalogue for the discovery-source database.
 *
 * PAGE seeds are homepages of well-known Dutch industry associations and trade fairs. They are
 * inserted with status "unverified": the first harvest validates them (fetches the site, follows
 * links to member/exhibitor lists) and marks them active, exhausted or blocked. They are starting
 * points, not research findings. The Market Intelligence Director adds new sources over time.
 *
 * QUERY seeds are reusable search templates ({sector} = Dutch sector name, {regio} = region) aimed
 * at companies that ordinary searches miss: vacancies naming Microsoft technology, Microsoft partner
 * case studies (the customer is the prospect), regional business parks, rankings, annual reports.
 */
export interface SourceSeed {
  kind: "page" | "query";
  sourceType: string;
  name: string;
  url?: string;
  query?: string;
  industries: string[];
  region?: string;
  reharvestDays?: number;
}

export const PAGE_SEEDS: SourceSeed[] = [
  { kind: "page", sourceType: "association", name: "FME (technologische industrie)", url: "https://www.fme.nl/", industries: ["manufacturing", "industrial_engineering"] },
  { kind: "page", sourceType: "association", name: "Koninklijke Metaalunie", url: "https://www.metaalunie.nl/", industries: ["manufacturing", "industrial_engineering"] },
  { kind: "page", sourceType: "association", name: "VNCI (chemische industrie)", url: "https://www.vnci.nl/", industries: ["manufacturing"] },
  { kind: "page", sourceType: "association", name: "NRK (rubber- en kunststofindustrie)", url: "https://www.nrk.nl/", industries: ["manufacturing"] },
  { kind: "page", sourceType: "association", name: "FNLI (levensmiddelenindustrie)", url: "https://www.fnli.nl/", industries: ["food_production"] },
  { kind: "page", sourceType: "association", name: "TLN (Transport en Logistiek Nederland)", url: "https://www.tln.nl/", industries: ["logistics", "transportation"] },
  { kind: "page", sourceType: "association", name: "evofenedex", url: "https://www.evofenedex.nl/", industries: ["logistics", "wholesale", "distribution"] },
  { kind: "page", sourceType: "association", name: "KVNR (reders)", url: "https://www.kvnr.nl/", industries: ["maritime"] },
  { kind: "page", sourceType: "association", name: "Bouwend Nederland", url: "https://www.bouwendnederland.nl/", industries: ["construction", "infrastructure"] },
  { kind: "page", sourceType: "association", name: "Techniek Nederland", url: "https://www.technieknederland.nl/", industries: ["construction", "infrastructure"] },
  { kind: "page", sourceType: "association", name: "Netbeheer Nederland", url: "https://www.netbeheernederland.nl/", industries: ["utilities", "energy"] },
  { kind: "page", sourceType: "association", name: "Energie-Nederland", url: "https://www.energie-nederland.nl/", industries: ["energy"] },
  { kind: "page", sourceType: "association", name: "Vewin (drinkwaterbedrijven)", url: "https://www.vewin.nl/", industries: ["utilities"] },
  { kind: "page", sourceType: "association", name: "Aedes (woningcorporaties)", url: "https://www.aedes.nl/", industries: ["housing_associations"] },
  { kind: "page", sourceType: "association", name: "NVZ (ziekenhuizen)", url: "https://www.nvz-ziekenhuizen.nl/", industries: ["healthcare"] },
  { kind: "page", sourceType: "association", name: "ActiZ (ouderenzorg)", url: "https://www.actiz.nl/", industries: ["healthcare"] },
  { kind: "page", sourceType: "association", name: "Verbond van Verzekeraars", url: "https://www.verzekeraars.nl/", industries: ["insurance"] },
  { kind: "page", sourceType: "association", name: "NVB (banken)", url: "https://www.nvb.nl/", industries: ["financial_services"] },
  { kind: "page", sourceType: "association", name: "VNG (gemeenten)", url: "https://www.vng.nl/", industries: ["municipalities"] },
  { kind: "page", sourceType: "trade_fair", name: "Technishow", url: "https://www.technishow.nl/", industries: ["manufacturing", "industrial_engineering"], reharvestDays: 365 },
  { kind: "page", sourceType: "trade_fair", name: "Europort", url: "https://www.europort.nl/", industries: ["maritime"], reharvestDays: 365 },
];

const Q = (sourceType: string, name: string, query: string, industries: string[] = [], reharvestDays = 30): SourceSeed => ({ kind: "query", sourceType, name, query, industries, reharvestDays });
export const QUERY_SEEDS: SourceSeed[] = [
  Q("vacancy", "Vacatures: Microsoft Intune", 'vacature "Microsoft Intune" {sector} Nederland'),
  Q("vacancy", "Vacatures: Microsoft 365 beheer", 'vacature "Microsoft 365" systeembeheerder {sector}'),
  Q("vacancy", "Vacatures: informatiebeveiliging", 'vacature informatiebeveiliging "security officer" {sector}'),
  Q("partner_reference", "Partnercases: Microsoft 365", 'klantcase "Microsoft 365" migratie {sector}'),
  Q("partner_reference", "Partnercases: Intune/Defender", 'klantcase Intune Defender {sector}'),
  Q("partner_reference", "Partnercases: Purview/Copilot", 'klantverhaal "Microsoft Purview" OR "Copilot" {sector}'),
  Q("ms_customer_reference", "Microsoft-klantverhalen NL", 'Microsoft klantverhaal {sector} Nederland site:microsoft.com'),
  Q("ranking", "Rankings: grootste bedrijven", '"top 100" grootste {sector} bedrijven Nederland', [], 180),
  Q("ranking", "Rankings: grootste werkgevers", 'grootste werkgevers {sector} Nederland lijst', [], 180),
  Q("trade_fair", "Vakbeurzen: exposanten", 'exposantenlijst vakbeurs {sector} 2026', [], 180),
  Q("publication", "Vakbladen: bedrijvenoverzichten", 'vakblad {sector} overzicht bedrijven Nederland', [], 90),
  Q("annual_report", "Jaarverslagen", 'jaarverslag 2025 {sector} "aantal medewerkers" Nederland', [], 180),
  Q("group_structure", "Groepsstructuren", '"onze werkmaatschappijen" {sector} Nederland', [], 180),
  Q("procurement", "Aanbestedende diensten (M365)", 'aanbesteding "Microsoft 365" {sector} aanbestedende dienst', ["healthcare", "education", "municipalities", "government", "housing_associations", "utilities"], 60),
  ...["Rotterdam-Rijnmond", "Brainport Eindhoven", "Twente", "Venlo", "Moerdijk", "Amsterdam Westpoort", "Groningen", "Zwolle", "Tilburg", "Arnhem-Nijmegen", "Drechtsteden", "Haaglanden"].map((r) =>
    ({ ...Q("business_park", `Bedrijventerreinen ${r}`, `ondernemersvereniging bedrijventerrein ${r} leden`, [], 180), region: r })),
  ...["Brainport Development", "Oost NL", "InnovationQuarter", "NOM Noord-Nederland", "BOM Brabant", "LIOF Limburg"].map((r) =>
    ({ ...Q("regional_network", `Regionaal netwerk ${r}`, `${r} bedrijven {sector} portfolio`, [], 180), region: r })),
];
