import Fuse from "fuse.js";
import finalDoctorsRaw from "../data/finalDoctors.json";
import { getLocationFromBranch } from "../data/locationMap";

export interface HealthPackage {
  name: string;
  description: string;
  url: string;
}

interface CleanDoctorRecord {
  doctorName: string;
  resourceId: string | number;
  locationId?: string | number | null;
  regionId?: string | number | null;
  location?: string | null;
  speciality?: string | null;
}

// finalDoctors.json is a flat array; support both array and wrapped { doctors: [] } shapes.
const rawRecords: CleanDoctorRecord[] = (() => {
  if (Array.isArray(finalDoctorsRaw)) return finalDoctorsRaw as CleanDoctorRecord[];
  const wrapped = finalDoctorsRaw as { doctors?: CleanDoctorRecord[] };
  return wrapped.doctors ?? [];
})();

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

  // Explicit overrides for location strings that start with "Apollo ..." instead of a city name.
  // Keyed by normalized (lowercase, collapsed whitespace, stripped encoding artifacts) location string.
  const LOCATION_OVERRIDES: Record<string, { city: string; branch: string }> = {
    "apollo hospitals - financial district":       { city: "Hyderabad",       branch: "Financial District" },
    "apollo hospitals - pune":                     { city: "Pune",            branch: "Pune" },
    "apollo hospitals - trichy":                   { city: "Trichy",          branch: "Trichy" },
    "apollo hospitals indore":                     { city: "Indore",          branch: "Indore" },
    "apollo hospitals karaikudi":                  { city: "Karaikudi",       branch: "Karaikudi" },
    "apollo hospitals rourkela":                   { city: "Rourkela",        branch: "Rourkela" },
    "apollo hospitals-nashik":                     { city: "Nashik",          branch: "Nashik" },
    "apollo hospitals , narendrapur kolkata":      { city: "Kolkata",         branch: "Narendrapur" },
    "apollo hospitals, narendrapur kolkata":       { city: "Kolkata",         branch: "Narendrapur" },
    "apollo gleneagles hospital - main":           { city: "Kolkata",         branch: "Gleneagles" },
    "apollo hospital bhubaneswar":                 { city: "Bhubaneswar",     branch: "Bhubaneswar" },
    "apollo hospital sheshadripuram":              { city: "Bangalore",       branch: "Sheshadripuram" },
    "apollo hospital visakhapatnam":               { city: "Visakhapatnam",   branch: "Visakhapatnam" },
    "apollo hospital-health city visakhapatnam":   { city: "Visakhapatnam",   branch: "Health City" },
    "apollo kotturpuram new project":              { city: "Chennai",         branch: "Kotturpuram" },
    "apollo loga hospital karur":                  { city: "Karur",           branch: "Karur" },
    "apollo medical center-karapakkam":            { city: "Chennai",         branch: "Karapakkam" },
    "apollo one (mh)":                             { city: "Mumbai",          branch: "Mumbai" },
    "apollo precicare ecity":                      { city: "Bangalore",       branch: "Electronic City" },
    "apollo precicare hsr":                        { city: "Bangalore",       branch: "HSR" },
    "apollo proton cancer centre, chennai":        { city: "Chennai",         branch: "Proton Cancer Centre" },
    "apollo samudra hospitals - kakinada":         { city: "Kakinada",        branch: "Kakinada" },
    "apollo speciality hospital - teynampet":      { city: "Chennai",         branch: "Teynampet" },
    "apollo speciality hospital @ omr":            { city: "Chennai",         branch: "OMR" },
    "apollo speciality hospital nellore":          { city: "Nellore",         branch: "Nellore" },
    "apollo speciality hospitals vanagaram":       { city: "Chennai",         branch: "Vanagaram" },
    "apollo womens cancer centre - new delhi":     { city: "New Delhi",       branch: "Women's Cancer Centre" },
    "apollomedics international lifesciences limited": { city: "Lucknow",     branch: "Lucknow" },
    "apollo adlux hospital":                       { city: "Kochi",           branch: "Adlux" },
    "apollo bgs hospitals mysore":                 { city: "Mysore",          branch: "BGS" },
    "apollo cvhf - ahmedabad":                     { city: "Ahmedabad",       branch: "Ahmedabad" },
    "apollo sage hospital":                        { city: "Bhopal",          branch: "Bhopal" },
    "apollo heart center":                         { city: "Hyderabad",       branch: "Hyderaguda" },
  };

  // Normalize for lookup: lowercase, collapse whitespace, strip unicode garbage
  const normalizedKey = locationLabel
    .toLowerCase()
    .replace(/[\u00c2\u00e2\u20ac\u201c\u201d\u2013\u2014]/g, " ")  // strip encoding artifacts
    .replace(/\s+/g, " ")
    .trim();

  const override = LOCATION_OVERRIDES[normalizedKey];
  if (override) {
    return { city: override.city, branch: override.branch, locationLabel };
  }

  const parts = locationLabel.split(/\s*-\s*/).map((part) => part.trim()).filter(Boolean);
  const rawCity = parts[0] ?? locationLabel;
  const rawBranch = parts.slice(1).join(" - ");

  const city = resolveCanonicalCity(rawCity);

  // When the branch segment is just a generic "Apollo" or "Apollo Hospitals" label (no location info),
  // use the rawCity as the branch so it gets a meaningful name (e.g. "Secunderabad" not "Apollo").
  const isGenericApolloLabel = /^apollo\s*(hospitals?)?$/i.test(rawBranch.trim());
  const branch = rawBranch && !isGenericApolloLabel
    ? toTitleCase(rawBranch)
    : toTitleCase(rawCity);

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

const cleanData = { doctors: rawRecords };

export const doctors: Doctor[] = (() => {
  const seen = new Set<string>();
  const result: Doctor[] = [];

  for (const record of cleanData.doctors ?? []) {
    const name = String(record.doctorName ?? "").trim();
    const resourceId = String(record.resourceId ?? "").trim();

    // Skip records that aren't usable:
    // - no resourceId
    // - name too short (≤5 alphabetic chars)
    // - initials-only pattern like "A D" or "Dr X"
    const alphaName = name.replace(/[^a-zA-Z ]/g, "").trim();
    if (
      !resourceId ||
      alphaName.length <= 5 ||
      /^[A-Z]\s?[A-Z]$/.test(alphaName)
    ) continue;

    const speciality = String(record.speciality ?? "").trim();
    const { city, branch } = parseLocation(String(record.location ?? ""));
    const mappedLoc = getLocationFromBranch(branch);
    const locationId = String(record.locationId ?? "").trim() || mappedLoc?.locationId || "";
    const regionId = String(record.regionId ?? "").trim() || mappedLoc?.regionId || "1";

    if (!name || !resourceId || !speciality || !city) continue;

    const dedupeKey = `${name.toLowerCase()}|${resourceId}|${locationId}|${regionId}`;
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
  // ── General / Infectious ─────────────────────────────────────────────────
  "fever": "General Physician",
  "high fever": "General Physician",
  "low grade fever": "General Physician",
  "flu": "General Physician",
  "influenza": "General Physician",
  "cold": "General Physician",
  "common cold": "General Physician",
  "body ache": "General Physician",
  "body pain": "General Physician",
  "fatigue": "General Physician",
  "tiredness": "General Physician",
  "weakness": "General Physician",
  "chills": "General Physician",
  "sweating": "General Physician",
  "night sweats": "General Physician",
  "loss of appetite": "General Physician",
  "weight loss": "General Physician",
  "swelling": "General Physician",
  "infection": "General Physician",
  "viral": "General Physician",
  "malaria": "General Physician",
  "dengue": "General Physician",
  "typhoid": "General Physician",
  "covid": "General Physician",
  "mouth ulcer": "General Physician",
  "bleeding": "General Physician",
  "general checkup": "General Physician",
  "health checkup": "General Physician",
  "vaccination": "General Physician",
  "immunization": "General Physician",

  // ── Heart & Cardiology ───────────────────────────────────────────────────
  "chest pain": "Cardiology",
  "chest tightness": "Cardiology",
  "heart attack": "Cardiology",
  "irregular heartbeat": "Cardiology",
  "palpitations": "Cardiology",
  "high bp": "Cardiology",
  "low bp": "Cardiology",
  "blood pressure": "Cardiology",
  "hypertension": "Cardiology",
  "cholesterol": "Cardiology",
  "bypass": "Cardiology",
  "angioplasty": "Cardiology",
  "angiogram": "Cardiology",
  "heart failure": "Cardiology",
  "edema": "Cardiology",
  "leg swelling": "Cardiology",

  // ── Lungs / Pulmonology ──────────────────────────────────────────────────
  "shortness of breath": "Pulmonology",
  "breathing difficulty": "Pulmonology",
  "breathlessness": "Pulmonology",
  "cough": "Pulmonology",
  "chronic cough": "Pulmonology",
  "wheezing": "Pulmonology",
  "asthma": "Pulmonology",
  "chest congestion": "Pulmonology",
  "tuberculosis": "Pulmonology",
  "tb": "Pulmonology",
  "pneumonia": "Pulmonology",
  "lung": "Pulmonology",

  // ── Brain & Neurology ────────────────────────────────────────────────────
  "headache": "Neurology",
  "migraine": "Neurology",
  "seizure": "Neurology",
  "epilepsy": "Neurology",
  "stroke": "Neurology",
  "paralysis": "Neurology",
  "numbness": "Neurology",
  "dizziness": "Neurology",
  "memory loss": "Neurology",
  "tremor": "Neurology",
  "parkinson": "Neurology",
  "alzheimer": "Neurology",
  "dementia": "Neurology",
  "multiple sclerosis": "Neurology",
  "nerve pain": "Neurology",
  "neuropathy": "Neurology",
  "vertigo": "Neurology",
  "fainting": "Neurology",

  // ── Bones & Orthopaedics ────────────────────────────────────────────────
  "joint pain": "Orthopaedics",
  "back pain": "Orthopaedics",
  "knee pain": "Orthopaedics",
  "bone pain": "Orthopaedics",
  "fracture": "Orthopaedics",
  "neck pain": "Orthopaedics",
  "shoulder pain": "Orthopaedics",
  "hip pain": "Orthopaedics",
  "ankle pain": "Orthopaedics",
  "wrist pain": "Orthopaedics",
  "hand pain": "Orthopaedics",
  "foot pain": "Orthopaedics",
  "muscle pain": "Orthopaedics",
  "muscle cramp": "Orthopaedics",
  "sports injury": "Orthopaedics",
  "osteoporosis": "Orthopaedics",
  "arthritis": "Orthopaedics",
  "frozen shoulder": "Orthopaedics",
  "ligament": "Orthopaedics",
  "tendon": "Orthopaedics",

  // ── Spine ────────────────────────────────────────────────────────────────
  "spine pain": "Spine Surgery",
  "scoliosis": "Spine Surgery",
  "disc": "Spine Surgery",
  "slipped disc": "Spine Surgery",
  "herniated disc": "Spine Surgery",
  "sciatica": "Spine Surgery",
  "lower back pain": "Spine Surgery",

  // ── Stomach & Gastroenterology ──────────────────────────────────────────
  "stomach pain": "Gastroenterology",
  "abdominal pain": "Gastroenterology",
  "nausea": "Gastroenterology",
  "vomiting": "Gastroenterology",
  "diarrhoea": "Gastroenterology",
  "diarrhea": "Gastroenterology",
  "constipation": "Gastroenterology",
  "bloating": "Gastroenterology",
  "gas": "Gastroenterology",
  "indigestion": "Gastroenterology",
  "acid reflux": "Gastroenterology",
  "heartburn": "Gastroenterology",
  "ulcer": "Gastroenterology",
  "stomach ulcer": "Gastroenterology",
  "ibs": "Gastroenterology",
  "irritable bowel": "Gastroenterology",
  "colitis": "Gastroenterology",
  "crohn": "Gastroenterology",
  "gallstone": "Gastroenterology",
  "gall bladder": "Gastroenterology",
  "gallbladder": "Gastroenterology",
  "pancreatitis": "Gastroenterology",
  "rectal bleeding": "Gastroenterology",

  // ── Liver / Hepatology ───────────────────────────────────────────────────
  "jaundice": "Hepatology",
  "liver pain": "Hepatology",
  "hepatitis": "Hepatology",
  "cirrhosis": "Hepatology",
  "fatty liver": "Hepatology",

  // ── General Surgery ──────────────────────────────────────────────────────
  "hernia": "General Surgery",
  "appendix": "General Surgery",
  "piles": "General Surgery",
  "haemorrhoid": "General Surgery",
  "hemorrhoid": "General Surgery",
  "fistula": "General Surgery",
  "fissure": "General Surgery",
  "appendicitis": "General Surgery",

  // ── Cancer / Oncology ────────────────────────────────────────────────────
  "lump": "Oncology",
  "tumour": "Oncology",
  "tumor": "Oncology",
  "cancer": "Oncology",
  "lymphoma": "Oncology",
  "leukemia": "Oncology",

  // ── Kidneys / Nephrology ─────────────────────────────────────────────────
  "kidney pain": "Nephrology",
  "kidney disease": "Nephrology",
  "creatinine": "Nephrology",
  "dialysis": "Nephrology",

  // ── Urology ──────────────────────────────────────────────────────────────
  "blood in urine": "Urology",
  "frequent urination": "Urology",
  "kidney stone": "Urology",
  "urine infection": "Urology",
  "uti": "Urology",
  "burning urination": "Urology",
  "prostate": "Urology",
  "testicular": "Urology",
  "erectile": "Urology",
  "incontinence": "Urology",

  // ── Women's Health / Gynaecology ─────────────────────────────────────────
  "pcos": "Gynaecology",
  "period problem": "Gynaecology",
  "irregular period": "Gynaecology",
  "menstrual": "Gynaecology",
  "menstruation": "Gynaecology",
  "pregnancy": "Gynaecology",
  "vaginal": "Gynaecology",
  "ovarian": "Gynaecology",
  "uterine": "Gynaecology",
  "uterus": "Gynaecology",
  "ovary": "Gynaecology",
  "breast pain": "Gynaecology",
  "cervical": "Gynaecology",
  "menopause": "Gynaecology",

  // ── Fertility ────────────────────────────────────────────────────────────
  "fertility": "Fertility and Reproductive Medicine",
  "ivf": "Fertility and Reproductive Medicine",
  "infertility": "Fertility and Reproductive Medicine",

  // ── Diabetes / Endocrinology ─────────────────────────────────────────────
  "diabetes": "Diabetology",
  "sugar": "Diabetology",
  "blood sugar": "Diabetology",
  "high sugar": "Diabetology",
  "thyroid": "Endocrinology",
  "weight gain": "Endocrinology",
  "obesity": "Endocrinology",
  "hormone": "Endocrinology",
  "adrenal": "Endocrinology",

  // ── Skin / Dermatology ───────────────────────────────────────────────────
  "skin rash": "Dermatology",
  "rash": "Dermatology",
  "acne": "Dermatology",
  "psoriasis": "Dermatology",
  "hair loss": "Dermatology",
  "itching": "Dermatology",
  "itch": "Dermatology",
  "skin allergy": "Dermatology",
  "eczema": "Dermatology",
  "dandruff": "Dermatology",
  "pigmentation": "Dermatology",
  "fungal": "Dermatology",
  "nail": "Dermatology",
  "hives": "Dermatology",
  "urticaria": "Dermatology",
  "vitiligo": "Dermatology",

  // ── ENT ──────────────────────────────────────────────────────────────────
  "ear pain": "ENT",
  "hearing loss": "ENT",
  "sore throat": "ENT",
  "sinus": "ENT",
  "runny nose": "ENT",
  "blocked nose": "ENT",
  "stuffy nose": "ENT",
  "sneezing": "ENT",
  "nosebleed": "ENT",
  "nose bleed": "ENT",
  "tinnitus": "ENT",
  "ear block": "ENT",
  "ear infection": "ENT",
  "throat pain": "ENT",
  "hoarse voice": "ENT",
  "hoarseness": "ENT",
  "loss of smell": "ENT",
  "loss of taste": "ENT",
  "swallowing": "ENT",
  "tonsil": "ENT",
  "adenoid": "ENT",
  "snoring": "ENT",

  // ── Eyes / Ophthalmology ─────────────────────────────────────────────────
  "eye pain": "Ophthalmology",
  "blurred vision": "Ophthalmology",
  "vision problem": "Ophthalmology",
  "red eye": "Ophthalmology",
  "redness of eye": "Ophthalmology",
  "dry eye": "Ophthalmology",
  "watery eye": "Ophthalmology",
  "cataract": "Ophthalmology",
  "glaucoma": "Ophthalmology",
  "eye infection": "Ophthalmology",
  "specs": "Ophthalmology",
  "spectacles": "Ophthalmology",

  // ── Paediatrics ──────────────────────────────────────────────────────────
  "child fever": "Paediatrics",
  "child": "Paediatrics",
  "baby": "Paediatrics",
  "kids": "Paediatrics",
  "toddler": "Paediatrics",
  "teenager": "Paediatrics",
  "pediatric": "Paediatrics",
  "paediatric": "Paediatrics",
  "autism": "Paediatrics",
  "growth problem": "Paediatrics",

  // ── Neonatology ──────────────────────────────────────────────────────────
  "infant": "Neonatology",
  "newborn": "Neonatology",

  // ── Psychiatry / Mental Health ───────────────────────────────────────────
  "depression": "Psychiatry",
  "anxiety": "Psychiatry",
  "stress": "Psychiatry",
  "sleep problem": "Psychiatry",
  "insomnia": "Psychiatry",
  "panic": "Psychiatry",
  "phobia": "Psychiatry",
  "mood": "Psychiatry",
  "mental health": "Psychiatry",
  "adhd": "Psychiatry",
  "ocd": "Psychiatry",
  "bipolar": "Psychiatry",
  "schizophrenia": "Psychiatry",
  "eating disorder": "Psychiatry",
  "anger issues": "Psychiatry",

  // ── Rheumatology ─────────────────────────────────────────────────────────
  "rheumatoid": "Rheumatology",
  "lupus": "Rheumatology",
  "gout": "Rheumatology",
  "fibromyalgia": "Rheumatology",
  "autoimmune": "Rheumatology",

  // ── Haematology ──────────────────────────────────────────────────────────
  "anaemia": "Haematology",
  "anemia": "Haematology",
  "blood disorder": "Haematology",
  "sickle cell": "Haematology",
  "thalassemia": "Haematology",
  "clotting": "Haematology",
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

// ── Fuzzy name search with edit-distance post-filter ─────────────────────────

/** O(n) space Levenshtein edit distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * True if the normalized query is within edit distance of ANY token in the doctor's name.
 * Budget: floor(queryLen * 0.3), minimum 1.
 * e.g. "shamila"(7) → max 2 edits:  "sharmila" dist=1 ✓  "ashmita" dist=3 ✗  "lakshmi" dist=6 ✗
 */
function isEditClose(doctorName: string, query: string): boolean {
  const normQ = normaliseDoctorName(query);
  if (!normQ) return false;
  const maxEdits = Math.max(1, Math.floor(normQ.length * 0.3));
  const tokens = normaliseDoctorName(doctorName).split(" ").filter(Boolean);
  return tokens.some((tok) => levenshtein(normQ, tok) <= maxEdits);
}

let _fuseAll: Fuse<Doctor> | null = null;
function getFuseAll(): Fuse<Doctor> {
  if (!_fuseAll) {
    _fuseAll = new Fuse<Doctor>(doctors, {
      keys: [{ name: "name", weight: 1.0 }],
      threshold: 0.25,
      includeScore: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }
  return _fuseAll;
}

/**
 * Fuzzy doctor name search with edit-distance post-filter.
 * Replaces getDoctorsByName for user-facing queries — handles misspellings and partial names.
 */
export function fuzzyDoctorsByName(query: string, limit = 200): Doctor[] {
  const trimmed = (query ?? "").trim();
  if (!trimmed || trimmed.length < 2) return [];

  const candidates = getFuseAll()
    .search(trimmed)
    .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
    .map((r) => r.item);

  return candidates.filter((d) => isEditClose(d.name, trimmed)).slice(0, limit);
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
