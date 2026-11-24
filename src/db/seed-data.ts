/**
 * Reference data seeded into every installation. These are configuration
 * values, not research findings. NIS2 fields are *indicative* sector mappings
 * (Cyberbeveiligingswet / NIS2 Annex I & II); applicability must still be
 * assessed per organisation by the Lead Qualification Specialist.
 */
export const INDUSTRY_SEED: {
  code: string; nameNl: string; nameEn: string; priorityTier: number; nis2Sector: string | null; doraApplicable?: boolean;
}[] = [
  { code: "manufacturing", nameNl: "Maakindustrie", nameEn: "Manufacturing", priorityTier: 1, nis2Sector: "important" },
  { code: "industrial_engineering", nameNl: "Industriële engineering", nameEn: "Industrial engineering", priorityTier: 1, nis2Sector: "important" },
  { code: "food_production", nameNl: "Voedselproductie", nameEn: "Food production", priorityTier: 1, nis2Sector: "important" },
  { code: "logistics", nameNl: "Logistiek", nameEn: "Logistics", priorityTier: 1, nis2Sector: "essential" },
  { code: "healthcare", nameNl: "Zorg", nameEn: "Healthcare", priorityTier: 1, nis2Sector: "essential" },
  { code: "financial_services", nameNl: "Financiële dienstverlening", nameEn: "Financial services", priorityTier: 1, nis2Sector: "essential", doraApplicable: true },
  { code: "insurance", nameNl: "Verzekeringen", nameEn: "Insurance", priorityTier: 1, nis2Sector: null, doraApplicable: true },
  { code: "energy", nameNl: "Energie", nameEn: "Energy", priorityTier: 1, nis2Sector: "essential" },
  { code: "utilities", nameNl: "Nutsbedrijven", nameEn: "Utilities", priorityTier: 1, nis2Sector: "essential" },
  { code: "transportation", nameNl: "Transport", nameEn: "Transportation", priorityTier: 2, nis2Sector: "essential" },
  { code: "maritime", nameNl: "Maritiem", nameEn: "Maritime", priorityTier: 2, nis2Sector: "essential" },
  { code: "construction", nameNl: "Bouw", nameEn: "Construction", priorityTier: 2, nis2Sector: null },
  { code: "infrastructure", nameNl: "Infrastructuur", nameEn: "Infrastructure", priorityTier: 2, nis2Sector: null },
  { code: "wholesale", nameNl: "Groothandel", nameEn: "Wholesale", priorityTier: 2, nis2Sector: null },
  { code: "distribution", nameNl: "Distributie", nameEn: "Distribution", priorityTier: 2, nis2Sector: "important" },
  { code: "housing_associations", nameNl: "Woningcorporaties", nameEn: "Housing associations", priorityTier: 2, nis2Sector: null },
  { code: "retail_hq", nameNl: "Retail (hoofdkantoren)", nameEn: "Retail headquarters", priorityTier: 2, nis2Sector: null },
  { code: "education", nameNl: "Onderwijs", nameEn: "Education", priorityTier: 2, nis2Sector: null },
  { code: "municipalities", nameNl: "Gemeenten", nameEn: "Municipalities", priorityTier: 2, nis2Sector: "essential" },
  { code: "government", nameNl: "Overheid", nameEn: "Government organisations", priorityTier: 2, nis2Sector: "essential" },
  { code: "professional_services", nameNl: "Zakelijke dienstverlening", nameEn: "Established professional services", priorityTier: 3, nis2Sector: null },
  // Excluded sectors (tier 0) — competitors and non-ICP categories.
  { code: "it_services", nameNl: "IT-dienstverlening / MSP", nameEn: "IT services / MSP", priorityTier: 0, nis2Sector: null },
  { code: "cybersecurity", nameNl: "Cybersecurity-aanbieders", nameEn: "Cybersecurity providers", priorityTier: 0, nis2Sector: null },
  { code: "marketing_agency", nameNl: "Marketingbureaus", nameEn: "Marketing agencies", priorityTier: 0, nis2Sector: null },
  { code: "recruitment", nameNl: "Recruitmentbureaus", nameEn: "Recruitment agencies", priorityTier: 0, nis2Sector: null },
  { code: "sales_agency", nameNl: "Salesbureaus", nameEn: "Sales agencies", priorityTier: 0, nis2Sector: null },
  { code: "software_startup", nameNl: "Software-startups", nameEn: "Software startups", priorityTier: 0, nis2Sector: null },
];

/** Permanent seed exclusions required by Cloud Life. Domains to be added by administrators. */
export const EXCLUSION_SEED: { scope: "name" | "parent_company"; value: string; reason: string }[] = [
  { scope: "parent_company", value: "Visma", reason: "Seed-uitsluiting: Visma / ProActive" },
  { scope: "name", value: "ProActive", reason: "Seed-uitsluiting: Visma / ProActive" },
  { scope: "name", value: "Visma ProActive", reason: "Seed-uitsluiting: Visma / ProActive" },
  { scope: "name", value: "RedFoxBlue", reason: "Seed-uitsluiting: RedFoxBlue" },
  { scope: "name", value: "ZIGT Mediabureau", reason: "Seed-uitsluiting: ZIGT Mediabureau" },
  { scope: "name", value: "The Sales Unit", reason: "Seed-uitsluiting: The Sales Unit" },
];

export const SECTOR_EXCLUSIONS = ["it_services", "cybersecurity", "marketing_agency", "recruitment", "sales_agency", "software_startup"];
