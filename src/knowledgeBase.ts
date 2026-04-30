import masterDataRaw from "../data/master-data.json";

export interface HealthPackage {
  name: string;
  description: string;
  url: string;
}

interface MasterDoctorRecord {
  locationId: string | number;
  regionId: string | number;
  location: string;
  city: string;
  branch: string;
  serviceId: string | number;
  resourceId: string | number;
  doctorName: string;
  specialityId: string | number;
  speciality: string;
}

interface MasterDataFile {
  generatedAt: string;
  sourceFile: string;
  doctors: MasterDoctorRecord[];
  cities: string[];
  hospitalsByCity: Record<string, Array<{ name: string; city: string; locationId: string | number; url: string }>>;
  specialitiesWithIds: Array<{ name: string; aaId: string }>;
  locationFallbacksByCity?: Record<string, number[]>;
}

const masterData = masterDataRaw as MasterDataFile;
const locationFallbacksByCity = masterData.locationFallbacksByCity ?? {};

function toTitleCase(value: string): string {
  const minor = new Set(["and", "of", "the", "in", "at", "by", "for", "a"]);
  return String(value ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, idx) => {
      if (idx > 0 && minor.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

const canonicalCityMap = new Map(
  Object.keys(locationFallbacksByCity).map((city) => [city.toLowerCase(), city])
);

const cityAliases: Record<string, string> = {
  delhi: "New Delhi",
  "new delhi": "New Delhi",
  secunderabad: "Hyderabad",
  "navi mumbai": "Mumbai",
  jayanagar: "Bangalore",
  lucknow: "Lucknow",
  guwahati: "Guwahati",
  chennai: "Chennai",
  kolkata: "Kolkata",
  hyderabad: "Hyderabad",
  noida: "Noida",
  indore: "Indore",
  nellore: "Nellore",
  rourkela: "Rourkela",
  warangal: "Warangal",
  mysore: "Mysore",
  karaikudi: "Karaikudi",
  karur: "Karur",
  visakhapatnam: "Visakhapatnam",
  bhubaneswar: "Bhubaneswar",
  nashik: "Nashik",
  madurai: "Madurai",
  kochi: "Kochi",
  bilaspur: "Bilaspur",
  kakinada: "Kakinada",
  ahmedabad: "Ahmedabad",
  ahil: "Ahmedabad",
  apollomedics: "Lucknow",
  gleneagles: "Kolkata",
  "apollo heart center": "Chennai",
  teynampet: "Chennai",
  karapakkam: "Chennai",
  "apollo one": "Chennai",
  vanagaram: "Chennai",
  omr: "Chennai",
  kotturpuram: "Chennai",
  sheshadripuram: "Bangalore",
  ecity: "Bangalore",
  hsr: "Bangalore",
  "apollo sage": "Bhopal",
  "financial district": "Hyderabad",
  aherf: "Hyderabad",
  "a h e r f": "Hyderabad",
  "karim nagar": "Karimnagar",
  belenus: "Bangalore",
  miryalguda: "Warangal",
  adlux: "Kochi",
  samudra: "Kochi",
  "aphc subham": "Guwahati",
};

function resolveCanonicalCity(city: string, ...hints: Array<string | undefined>): string {
  const normalizedCity = toTitleCase(city);
  const direct = canonicalCityMap.get(normalizedCity.toLowerCase());
  if (direct) return direct;

  const bag = `${city} ${hints.filter(Boolean).join(" ")}`
    .toLowerCase()
    .replace(/â€“|–|-/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [alias, canonical] of Object.entries(cityAliases)) {
    if (bag.includes(alias)) return canonical;
  }

  for (const [lowerCanonical, canonical] of canonicalCityMap.entries()) {
    if (bag.includes(lowerCanonical)) return canonical;
  }

  return normalizedCity;
}

export const contacts = {
  emergency: "1066",
  apolloLifelineInternational: "+91-40-4344-1066",
  healthHelpLine: "1860-500-1066",
  generalHelpLine: "08069991061",
  internationalEmail: "internationalcare@apollohospitals.com",
  onlinePayment: "https://pay.apollohospitals.com/",
  bookAppointmentUrl: "https://www.apollohospitals.com/doctors",
};

export interface Hospital {
  name: string;
  city: string;
  locationId: string;
  url: string;
}

export interface Speciality {
  name: string;
  aaId: string;
}

export interface Doctor {
  name: string;
  speciality: string;
  location: string;
  branch: string;
  locationId: string;
  regionId: string;
  serviceId: string;
  resourceId: string;
  specialityId: string;
}

function isNumericLocationId(value: string | number | undefined): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}

const resourceLocationIdMap = (() => {
  const map = new Map<string, string>();
  for (const record of masterData.doctors) {
    const resourceId = String(record.resourceId ?? "").trim();
    if (!resourceId) continue;
    if (isNumericLocationId(record.locationId)) {
      map.set(resourceId, String(record.locationId).trim());
    }
  }
  return map;
})();

function fallbackLocationIdsForCity(city: string): string[] {
  const canonicalCity = resolveCanonicalCity(city);
  const match = Object.keys(locationFallbacksByCity).find((key) => key.toLowerCase() === canonicalCity.toLowerCase());
  if (!match) return [];
  return (locationFallbacksByCity[match] ?? []).map((value) => String(value));
}

function normalizeLocationId(city: string, locationId: string | number, fallbackIndex = 0, resourceId?: string): string {
  if (isNumericLocationId(locationId)) return String(locationId).trim();
  const mappedFromResource = resourceId ? resourceLocationIdMap.get(resourceId) : undefined;
  if (mappedFromResource) return mappedFromResource;
  const fallbackIds = fallbackLocationIdsForCity(city);
  return fallbackIds[fallbackIndex] ?? fallbackIds[0] ?? String(locationId).trim();
}

export const hospitalsByCity: Record<string, Hospital[]> = (() => {
  const byCity: Record<string, Hospital[]> = {};
  for (const [rawCity, hospitals] of Object.entries(masterData.hospitalsByCity)) {
    for (const [idx, hospital] of (hospitals ?? []).entries()) {
      const city = resolveCanonicalCity(rawCity, hospital.name, hospital.city);
      const normalizedHospital: Hospital = {
        ...hospital,
        city,
        locationId: normalizeLocationId(city, hospital.locationId, idx),
      };
      if (!byCity[city]) byCity[city] = [];
      if (!byCity[city].some((h) => h.name === normalizedHospital.name && h.locationId === normalizedHospital.locationId)) {
        byCity[city].push(normalizedHospital);
      }
    }
  }
  return byCity;
})();
export const allCities: string[] = Array.from(new Set([...masterData.cities.map((c) => resolveCanonicalCity(c)), ...Object.keys(hospitalsByCity), ...Object.keys(locationFallbacksByCity)])).sort((a, b) => a.localeCompare(b));
export const specialitiesWithIds: Speciality[] = masterData.specialitiesWithIds;
export const specialities: string[] = Array.from(new Set(specialitiesWithIds.map((s) => s.name))).sort();

export function getLocationFallbacksForCity(city?: string): string[] {
  const cityName = String(city ?? "").trim();
  if (!cityName) return [];
  return fallbackLocationIdsForCity(resolveCanonicalCity(cityName));
}

export const doctors: Doctor[] = (() => {
  const seen = new Set<string>();
  const result: Doctor[] = [];
  for (const d of masterData.doctors) {
    const city = resolveCanonicalCity(d.city, d.location, d.branch);
    const locationId = normalizeLocationId(city, d.locationId, 0, String(d.resourceId ?? "").trim());
    const key = [
      locationId,
      String(d.resourceId ?? ""),
      String(d.serviceId ?? ""),
      d.doctorName.toLowerCase(),
      d.speciality.toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: d.doctorName,
      speciality: d.speciality,
      location: city,
      branch: d.branch,
      locationId,
      regionId: String(d.regionId ?? "5"),
      serviceId: String(d.serviceId ?? ""),
      resourceId: String(d.resourceId ?? ""),
      specialityId: String(d.specialityId ?? ""),
    });
  }
  return result;
})();

// ── 5. SYMPTOM → SPECIALTY MAPPING ──────────────────────────────────────
export const symptomToSpecialty: Record<string, string> = {
  // Heart & chest
  "chest pain": "Cardiology",
  "heart attack": "Cardiology",
  "irregular heartbeat": "Cardiology",
  "palpitations": "Cardiology",
  "shortness of breath": "Pulmonology",
  "breathing difficulty": "Pulmonology",
  "cough": "Pulmonology",
  "chronic cough": "Pulmonology",
  // Neuro
  "headache": "Neurology",
  "migraine": "Neurology",
  "seizure": "Neurology",
  "epilepsy": "Neurology",
  "stroke": "Neurology",
  "paralysis": "Neurology",
  "numbness": "Neurology",
  "dizziness": "Neurology",
  "memory loss": "Neurology",
  // Ortho
  "joint pain": "Orthopaedics",
  "back pain": "Orthopaedics",
  "knee pain": "Orthopaedics",
  "bone pain": "Orthopaedics",
  "fracture": "Orthopaedics",
  "spine pain": "Spine Surgery",
  // Gastro
  "stomach pain": "Gastroenterology",
  "abdominal pain": "Gastroenterology",
  "nausea": "Gastroenterology",
  "vomiting": "Gastroenterology",
  "diarrhoea": "Gastroenterology",
  "constipation": "Gastroenterology",
  "jaundice": "Hepatology",
  "liver pain": "Hepatology",
  // Onco
  "lump": "Oncology",
  "tumour": "Oncology",
  "cancer": "Oncology",
  "blood in urine": "Urology",
  // Urology / Nephrology
  "frequent urination": "Urology",
  "kidney stone": "Urology",
  "kidney pain": "Nephrology",
  // Gynaecology
  "pcos": "Gynaecology",
  "period problem": "Gynaecology",
  "pregnancy": "Gynaecology",
  "fertility": "Fertility and Reproductive Medicine",
  // Endo / Diabetes
  "diabetes": "Diabetology",
  "thyroid": "Endocrinology",
  "weight gain": "Endocrinology",
  // Skin
  "skin rash": "Dermatology",
  "acne": "Dermatology",
  "psoriasis": "Dermatology",
  "hair loss": "Dermatology",
  // ENT
  "ear pain": "ENT",
  "hearing loss": "ENT",
  "sore throat": "ENT",
  "sinus": "ENT",
  // Eyes
  "eye pain": "Ophthalmology",
  "blurred vision": "Ophthalmology",
  // Paeds
  "child fever": "Paediatrics",
  "infant": "Neonatology",
  // Mental health
  "depression": "Psychiatry",
  "anxiety": "Psychiatry",
  "stress": "Psychology",
};

// ── 6. HEALTH CHECK PACKAGES + TOP PROCEDURES ───────────────────────────
export const healthPackages: Record<string, HealthPackage[]> = {
  Hyderabad: [
    { name: "Heart Health Checkup", description: "Cardiac risk panel", url: "https://prohealth.apollohospitals.com" },
    { name: "Primary Health Checkup", description: "Basic annual wellness check", url: "https://prohealth.apollohospitals.com" },
  ],
  Chennai: [
    { name: "Master Health Checkup", description: "All-round health assessment", url: "https://prohealth.apollohospitals.com" },
  ],
  Bangalore: [
    { name: "Heart Health Checkup", description: "Cardiac risk panel", url: "https://prohealth.apollohospitals.com" },
  ],
  Mumbai: [
    { name: "Womens Health Checkup", description: "Complete womens wellness screen", url: "https://prohealth.apollohospitals.com" },
  ],
};

export const topProcedures: string[] = [
  "CABG (Coronary Artery Bypass Grafting)",
  "PCI / Angioplasty",
  "Heart Transplant",
  "Liver Transplant",
  "Kidney Transplant",
  "Robotic Knee Replacement",
  "Proton Beam Therapy",
  "CAR-T Cell Therapy",
  "Stroke Care",
  "IVF / ICSI",
];

// ── 7. SERVICE CATEGORIES (from CRM export) ─────────────────────────────
// These are the broad categories that Apollo's call-centre handles
export const serviceCategories: string[] = [
  "Admission related",
  "AHC Apollo 24/7",
  "Ambulance Services",
  "Appointment Booking",
  "Billing & Insurance",
  "Call Centre Support",
  "Cancer Care",
  "Cardiac Sciences",
  "Clinical Query",
  "Complaints & Feedback",
  "Dental Services",
  "Diagnostics & Lab",
  "Discharge Process",
  "Emergency Services",
  "Fertility & IVF",
  "Gastroenterology",
  "General Query",
  "Health Checkup Packages",
  "Homecare",
  "Insurance Pre-authorization",
  "International Patient Services",
  "Medicines & Pharmacy",
  "Neurosciences",
  "Oncology",
  "Ophthalmology",
  "Organ Transplant",
  "Orthopaedics",
  "Paediatrics",
  "Physiotherapy",
  "Preventive Health",
  "Psychiatry & Mental Health",
  "Pulmonology",
  "Radiology",
  "Robotic Surgery",
  "Second Opinion",
  "Spine Surgery",
  "Urology",
  "Vascular Surgery",
  "Women's Health",
];

// ── 8. INTERNATIONAL PATIENT SERVICES ───────────────────────────────────
export const internationalServices = {
  email: "internationalcare@apollohospitals.com",
  helpline: "+91-40-4344-1066",
  website: "https://www.apollohospitals.com/international-patient-services/",
  countriesServed: "150+",
  patientsServed: "150 million+",
  journey: [
    "Analysis of your medical history by specialist team",
    "Pre-arrival telemedicine / video consultation",
    "Travel arrangement, airport pickup & hotel reservations",
    "Full hospital support: admission → treatment → discharge",
    "Post-hospitalization care plan and follow-up",
    "Apollo travels back with you – remote follow-up after return",
  ],
  featuredHospitals: ["Delhi", "Mumbai", "Chennai", "Ahmedabad", "Bangalore", "Hyderabad", "Kolkata"],
};

// ── 9. HELPER FUNCTIONS ──────────────────────────────────────────────────

/** Return hospitals for a given city (case-insensitive) */
export function getHospitalsForCity(city: string): Hospital[] {
  const key = Object.keys(hospitalsByCity).find(
    (k) => k.toLowerCase() === city.toLowerCase()
  );
  return key ? hospitalsByCity[key] : [];
}

/** Normalise a string for strict name matching: lowercase and collapse punctuation/whitespace */
function normaliseForSearch(s: string): string {
  return s.toLowerCase().replace(/[.\-,']/g, " ").replace(/\s+/g, " ").trim();
}

function normaliseDoctorName(s: string): string {
  return normaliseForSearch(s).replace(/^dr\s+/, "").trim();
}

/**
 * Search doctors by strict name rules:
 * - Single-word input: first token must match exactly ("arun" matches "Dr Arun Kumar", not "Dr Aruna"/"Dr Varun")
 * - Multi-word input: full name exact match or safe prefix match (startsWith)
 */
export function getDoctorsByName(query: string, limit = 8): Doctor[] {
  if (!query || query.trim().length < 2) return [];
  const q = normaliseDoctorName(query);
  if (q.length < 2) return [];

  const qParts = q.split(" ").filter(Boolean);
  const isSingleWord = qParts.length === 1;

  return doctors
    .filter(d => {
      const dn = normaliseDoctorName(d.name);
      if (!dn) return false;

      if (isSingleWord) {
        const firstToken = dn.split(" ")[0] ?? "";
        return firstToken === q;
      }

      return dn === q || dn.startsWith(q);
    })
    .slice(0, limit);
}

/**
 * Return the sub-branch names for a given city (Title Case) from the new mapping.
 * Used to populate branch-selection quick replies.
 */
export function getSubBranchesForCity(city: string): string[] {
  const key = city.trim().toLowerCase();
  return Array.from(
    new Set(
      doctors
        .filter((d) => d.location.toLowerCase() === key)
        .map((d) => d.branch)
        .filter((branch) => branch.length > 0)
    )
  ).sort();
}

/**
 * Return doctors from the new mapping for a given city + optional branch + optional speciality.
 * All inputs are normalised to UPPERCASE for matching.
 */
export function getDoctorsForLocation(
  city: string,
  branch?: string,
  speciality?: string
): Doctor[] {
  const cityKey = city.trim().toLowerCase();
  const branchKey = branch?.trim().toLowerCase();
  const specialityKey = speciality?.trim().toLowerCase();

  return doctors.filter((d) => {
    if (d.location.toLowerCase() !== cityKey) return false;
    if (branchKey && d.branch.toLowerCase() !== branchKey) return false;
    if (specialityKey && d.speciality.toLowerCase() !== specialityKey) return false;
    return true;
  });
}

/** Build an Apollo website doctor search URL for a specialty + location (branch preferred, else city) */
export function buildDoctorSearchUrl(specialty: string, city?: string, branch?: string): string {
  const base = "https://www.apollohospitals.com/doctors/";
  const params = new URLSearchParams();
  if (specialty) params.set("speciality", specialty.toUpperCase());
  const location = (branch && branch.trim()) || city;
  if (location) params.set("location", location);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Map symptom text to the most likely specialty */
export function mapSymptomToSpecialty(symptom: string): string | null {
  const lower = symptom.toLowerCase();
  for (const [keyword, specialty] of Object.entries(symptomToSpecialty)) {
    if (lower.includes(keyword)) return specialty;
  }
  return null;
}

/** Return health packages for a city (falls back to a generic message) */
export function getPackagesForCity(city: string): HealthPackage[] {
  const key = Object.keys(healthPackages).find(
    (k) => k.toLowerCase() === city.toLowerCase()
  );
  return key ? healthPackages[key] : [];
}

/**
 * Build a compact context string for the LLM system prompt.
 * Keeps it under ~1000 tokens.
 */
export function buildLlmContext(currentState: string, ctx: Record<string, string | undefined>): string {
  const lines: string[] = [
    "=== Apollo Assist Knowledge Base (summary) ===",
    `Emergency: ${contacts.emergency} | Lifeline: ${contacts.apolloLifelineInternational} | Health Helpline: ${contacts.healthHelpLine}`,
    `International patients: ${internationalServices.email} | ${internationalServices.helpline}`,
    `Cities with Apollo hospitals: ${allCities.join(", ")}`,
  ];

  if (ctx.city) {
    const subBranches = getSubBranchesForCity(ctx.city);
    if (subBranches.length) lines.push(`Branches in ${ctx.city}: ${subBranches.join("; ")}`);

    if (ctx.branch || ctx.specialty) {
      const localDocs = getDoctorsForLocation(ctx.city, ctx.branch, ctx.specialty);
      if (localDocs.length) {
        lines.push(`Doctors found: ${localDocs.slice(0, 8).map(d => `${d.name} (${toTitleCase(d.speciality)})`).join("; ")}`);
      }
    }

    const packages = getPackagesForCity(ctx.city);
    if (packages.length) {
      lines.push(`Health check packages in ${ctx.city}: ${packages.map((p) => p.name).join("; ")}`);
    }
  }

  if (ctx.symptomText) {
    const spec = mapSymptomToSpecialty(ctx.symptomText);
    if (spec) lines.push(`Recommended specialty for "${ctx.symptomText}": ${spec}`);
  }

  if (ctx.specialty) {
    lines.push(`User selected specialty: ${ctx.specialty}`);
  }

  lines.push(`Top procedures: ${topProcedures.slice(0, 10).join("; ")}`);
  lines.push(`Key specialties: ${specialities.slice(0, 20).join(", ")}`);
  lines.push(`Total doctors in database: ${doctors.length}`);
  lines.push(`Current bot state: ${currentState}`);

  return lines.join("\n");
}
