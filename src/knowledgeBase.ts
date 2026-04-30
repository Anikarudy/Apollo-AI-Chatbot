import cleanDataRaw from "../data/clean.json";

export interface HealthPackage {
  name: string;
  description: string;
  url: string;
}

interface CleanDoctorRecord {
  doctorName: string;
  resourceId: string | number;
  locationId?: string | number;
  regionId: string | number;
  location: string;
  speciality: string;
}

interface CleanDataFile {
  doctors: CleanDoctorRecord[];
}

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

const cityAliases: Record<string, string> = {
  delhi: "New Delhi",
  "new delhi": "New Delhi",
  secunderabad: "Hyderabad",
  "navi mumbai": "Mumbai",
  "karim nagar": "Karimnagar",
};

function resolveCanonicalCity(rawCity: string): string {
  const normalized = toTitleCase(rawCity).trim();
  if (!normalized) return "Unknown";
  const alias = cityAliases[normalized.toLowerCase()];
  return alias ?? normalized;
}

function parseLocation(rawLocation: string): { city: string; branch: string; locationLabel: string } {
  const locationLabel = String(rawLocation ?? "").replace(/\s+/g, " ").trim();
  if (!locationLabel) {
    return { city: "Unknown", branch: "Unknown", locationLabel: "Unknown" };
  }

  const parts = locationLabel.split(/\s*-\s*/).map((part) => part.trim()).filter(Boolean);
  const rawCity = parts[0] ?? locationLabel;
  const rawBranch = parts.slice(1).join(" - ");

  const city = resolveCanonicalCity(rawCity);
  const branch = rawBranch ? toTitleCase(rawBranch) : city;

  return { city, branch, locationLabel };
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

const cleanData = cleanDataRaw as CleanDataFile;

export const doctors: Doctor[] = (() => {
  const seen = new Set<string>();
  const result: Doctor[] = [];

  for (const record of cleanData.doctors ?? []) {
    const name = String(record.doctorName ?? "").trim();
    const resourceId = String(record.resourceId ?? "").trim();
    const locationId = String(record.locationId ?? "").trim();
    const regionId = String(record.regionId ?? "1").trim() || "1";
    const speciality = String(record.speciality ?? "").trim();
    const { city, branch } = parseLocation(String(record.location ?? ""));

    if (!name || !resourceId || !speciality || !city) continue;

    const dedupeKey = `${name.toLowerCase()}|${resourceId}|${regionId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    result.push({
      name,
      speciality,
      location: city,
      branch,
      locationId,
      regionId,
      serviceId: "",
      resourceId,
      specialityId: "",
    });
  }

  return result;
})();

const locationIdsByCity: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const doctor of doctors) {
    if (!doctor.locationId) continue;
    if (!map[doctor.location]) map[doctor.location] = [];
    if (!map[doctor.location].includes(doctor.locationId)) {
      map[doctor.location].push(doctor.locationId);
    }
  }
  return map;
})();

export function getLocationFallbacksForCity(city?: string): string[] {
  const cityName = String(city ?? "").trim();
  if (!cityName) return [];
  const canonical = resolveCanonicalCity(cityName);
  return [...(locationIdsByCity[canonical] ?? [])];
}

export const hospitalsByCity: Record<string, Hospital[]> = (() => {
  const byCity: Record<string, Hospital[]> = {};

  for (const doctor of doctors) {
    if (!doctor.locationId) continue;
    if (!byCity[doctor.location]) byCity[doctor.location] = [];

    const hospital: Hospital = {
      name: `Apollo ${doctor.branch}`,
      city: doctor.location,
      locationId: doctor.locationId,
      url: buildDoctorSearchUrl("", doctor.location, doctor.branch),
    };

    if (!byCity[doctor.location].some((h) => h.locationId === hospital.locationId && h.name === hospital.name)) {
      byCity[doctor.location].push(hospital);
    }
  }

  return byCity;
})();

export const allCities: string[] = Object.keys(hospitalsByCity).sort((a, b) => a.localeCompare(b));

export const specialitiesWithIds: Speciality[] = (() => {
  const names = Array.from(new Set(doctors.map((doctor) => doctor.speciality).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  return names.map((name, idx) => ({ name, aaId: String(idx + 1) }));
})();

export const specialities: string[] = specialitiesWithIds.map((speciality) => speciality.name);

// ── 5. SYMPTOM → SPECIALTY MAPPING ──────────────────────────────────────
export const symptomToSpecialty: Record<string, string> = {
  "chest pain": "Cardiology",
  "heart attack": "Cardiology",
  "irregular heartbeat": "Cardiology",
  "palpitations": "Cardiology",
  "shortness of breath": "Pulmonology",
  "breathing difficulty": "Pulmonology",
  "cough": "Pulmonology",
  "chronic cough": "Pulmonology",
  "headache": "Neurology",
  "migraine": "Neurology",
  "seizure": "Neurology",
  "epilepsy": "Neurology",
  "stroke": "Neurology",
  "paralysis": "Neurology",
  "numbness": "Neurology",
  "dizziness": "Neurology",
  "memory loss": "Neurology",
  "joint pain": "Orthopaedics",
  "back pain": "Orthopaedics",
  "knee pain": "Orthopaedics",
  "bone pain": "Orthopaedics",
  "fracture": "Orthopaedics",
  "spine pain": "Spine Surgery",
  "stomach pain": "Gastroenterology",
  "abdominal pain": "Gastroenterology",
  "nausea": "Gastroenterology",
  "vomiting": "Gastroenterology",
  "diarrhoea": "Gastroenterology",
  "constipation": "Gastroenterology",
  "jaundice": "Hepatology",
  "liver pain": "Hepatology",
  "lump": "Oncology",
  "tumour": "Oncology",
  "cancer": "Oncology",
  "blood in urine": "Urology",
  "frequent urination": "Urology",
  "kidney stone": "Urology",
  "kidney pain": "Nephrology",
  "pcos": "Gynaecology",
  "period problem": "Gynaecology",
  "pregnancy": "Gynaecology",
  "fertility": "Fertility and Reproductive Medicine",
  "diabetes": "Diabetology",
  "thyroid": "Endocrinology",
  "weight gain": "Endocrinology",
  "skin rash": "Dermatology",
  "acne": "Dermatology",
  "psoriasis": "Dermatology",
  "hair loss": "Dermatology",
  "ear pain": "ENT",
  "hearing loss": "ENT",
  "sore throat": "ENT",
  "sinus": "ENT",
  "eye pain": "Ophthalmology",
  "blurred vision": "Ophthalmology",
  "child fever": "Paediatrics",
  "infant": "Neonatology",
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
    "Full hospital support: admission -> treatment -> discharge",
    "Post-hospitalization care plan and follow-up",
    "Apollo travels back with you - remote follow-up after return",
  ],
  featuredHospitals: ["Delhi", "Mumbai", "Chennai", "Ahmedabad", "Bangalore", "Hyderabad", "Kolkata"],
};

// ── 9. HELPER FUNCTIONS ──────────────────────────────────────────────────

/** Return hospitals for a given city (case-insensitive) */
export function getHospitalsForCity(city: string): Hospital[] {
  const canonical = resolveCanonicalCity(city);
  return hospitalsByCity[canonical] ?? [];
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
 * - Single-word input: first token must match exactly.
 * - Multi-word input: full name exact match or safe prefix match.
 */
export function getDoctorsByName(query: string, limit = 8): Doctor[] {
  if (!query || query.trim().length < 2) return [];
  const q = normaliseDoctorName(query);
  if (q.length < 2) return [];

  const qParts = q.split(" ").filter(Boolean);
  const isSingleWord = qParts.length === 1;

  return doctors
    .filter((doctor) => {
      const normalizedName = normaliseDoctorName(doctor.name);
      if (!normalizedName) return false;

      if (isSingleWord) {
        const firstToken = normalizedName.split(" ")[0] ?? "";
        return firstToken === q;
      }

      return normalizedName === q || normalizedName.startsWith(q);
    })
    .slice(0, limit);
}

/** Return the sub-branch names for a given city. */
export function getSubBranchesForCity(city: string): string[] {
  const canonical = resolveCanonicalCity(city);
  return Array.from(
    new Set(
      doctors
        .filter((doctor) => doctor.location.toLowerCase() === canonical.toLowerCase())
        .map((doctor) => doctor.branch)
        .filter((branch) => branch.length > 0)
    )
  ).sort();
}

/** Return doctors for a given city + optional branch + optional speciality. */
export function getDoctorsForLocation(city: string, branch?: string, speciality?: string): Doctor[] {
  const cityKey = resolveCanonicalCity(city).toLowerCase();
  const branchKey = branch?.trim().toLowerCase();
  const specialityKey = speciality?.trim().toLowerCase();

  return doctors.filter((doctor) => {
    if (doctor.location.toLowerCase() !== cityKey) return false;
    if (branchKey && doctor.branch.toLowerCase() !== branchKey) return false;
    if (specialityKey && doctor.speciality.toLowerCase() !== specialityKey) return false;
    return true;
  });
}

/** Build an Apollo website doctor search URL for a specialty + location (branch preferred, else city). */
export function buildDoctorSearchUrl(specialty: string, city?: string, branch?: string): string {
  const base = "https://www.apollohospitals.com/doctors/";
  const params = new URLSearchParams();
  if (specialty) params.set("speciality", specialty.toUpperCase());
  const location = (branch && branch.trim()) || city;
  if (location) params.set("location", location);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Map symptom text to the most likely specialty. */
export function mapSymptomToSpecialty(symptom: string): string | null {
  const lower = symptom.toLowerCase();
  for (const [keyword, specialty] of Object.entries(symptomToSpecialty)) {
    if (lower.includes(keyword)) return specialty;
  }
  return null;
}

/** Return health packages for a city. */
export function getPackagesForCity(city: string): HealthPackage[] {
  const key = Object.keys(healthPackages).find((candidate) => candidate.toLowerCase() === city.toLowerCase());
  return key ? healthPackages[key] : [];
}
