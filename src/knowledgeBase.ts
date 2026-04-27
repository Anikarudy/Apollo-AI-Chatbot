/**
 * knowledgeBase.ts
 * Apollo Assist – Consolidated Knowledge Base
 *
 * Hospital, speciality, and doctor data is auto-generated from
 * "Master Data (local).xlsx" via scripts/extractData.js.
 * Web packages and procedures are auto-generated via scripts/extractWebData.js.
 * Run `node scripts/extractData.js` to refresh after data changes.
 */

// ── GENERATED DATA (from Master Data xlsx) ───────────────────────────────
import {
  hospitalsByCity as _hospitals,
  specialities as _specialities,
  doctors as _doctors,
  allCities as _cities,
  type GeneratedHospital,
  type GeneratedSpeciality,
  type GeneratedDoctor,
} from "./generatedData";
import {
  healthPackages,
  topProcedures,
  type HealthPackage,
} from "./webData.generated";

// ── 1. CONTACT NUMBERS ──────────────────────────────────────────────────
export const contacts = {
  emergency: "1066",
  apolloLifelineInternational: "+91-40-4344-1066",
  healthHelpLine: "1860-500-1066",
  generalHelpLine: "08069991061",
  internationalEmail: "internationalcare@apollohospitals.com",
  onlinePayment: "https://pay.apollohospitals.com/",
  bookAppointmentUrl: "https://www.apollohospitals.com/doctors",
};

// ── 2. HOSPITALS BY CITY (54 locations, 29 cities from Master Data xlsx) ─
export type Hospital = GeneratedHospital;
export const hospitalsByCity: Record<string, Hospital[]> = _hospitals;
export const allCities: string[] = _cities;

// ── 3. SPECIALITIES (130 active with Apollo booking IDs) ─────────────────
export type Speciality = GeneratedSpeciality;
export const specialitiesWithIds: Speciality[] = _specialities;
export const specialities: string[] = _specialities.map(s => s.name);

// ── 4. DOCTORS (17 212 active from Master Data xlsx) ─────────────────────
export type Doctor = GeneratedDoctor;
export const doctors: Doctor[] = _doctors;

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
export type { HealthPackage };
export { healthPackages, topProcedures };

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

/** Search doctors by partial name (case-insensitive), returns up to `limit` results */
export function getDoctorsByName(query: string, limit = 8): Doctor[] {
  if (!query || query.trim().length < 2) return [];
  const q = query.toLowerCase().trim();
  return doctors.filter(d => d.name.toLowerCase().includes(q)).slice(0, limit);
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
    const hospitals = getHospitalsForCity(ctx.city);
    if (hospitals.length) {
      lines.push(`Hospitals in ${ctx.city}: ${hospitals.map((h) => h.name).join("; ")}`);
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
  lines.push(`Current bot state: ${currentState}`);

  return lines.join("\n");
}
