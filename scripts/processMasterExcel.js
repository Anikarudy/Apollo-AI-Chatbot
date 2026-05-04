const fs = require("fs");
const XLSX = require("xlsx");

// ==========================
// CONFIG
// ==========================
const INPUT_FILE = "data/master.xlsx";
const OUTPUT_FILE = "data/finalDoctors.json";

// ==========================
// HELPERS
// ==========================
function cleanString(val) {
  if (!val) return null;
  return String(val).trim();
}

function isValidName(name) {
  if (!name) return false;
  const cleaned = name.replace(/[^a-zA-Z ]/g, "").trim();
  return cleaned.length > 3;
}

// ==========================
// LOAD EXCEL
// ==========================
const workbook = XLSX.readFile(INPUT_FILE);

// ==========================
// PARSE SHEETS
// ==========================
const doctorSheet = XLSX.utils.sheet_to_json(workbook.Sheets["doctor"]);
const locationSheet = XLSX.utils.sheet_to_json(workbook.Sheets["location"]);

// ==========================
// CLEAN DOCTORS
// ==========================
const doctors = doctorSheet
  .filter(row => row["Doctor Identifier"] && row["Full Name"])
  .map(row => {
    const name = cleanString(row["Full Name"]);

    return {
      doctorName: name,
      resourceId: cleanString(row["Doctor Identifier"])
    };
  })
  .filter(doc => isValidName(doc.doctorName));

// ==========================
// CLEAN LOCATIONS
// ==========================
const locations = locationSheet
  .filter(row => row["AA location ID"])
  .map(row => ({
    branch: cleanString(row["Name"]),
    locationId: cleanString(row["AA location ID"]),
    city: cleanString(row["AA City"])
  }));

// ==========================
// LOAD EXISTING CLEAN DATA
// ==========================
const existing = JSON.parse(fs.readFileSync("data/clean.json", "utf-8"));
const existingDoctors = Array.isArray(existing) ? existing : (existing.doctors ?? []);

// ==========================
// MERGE LOGIC
// ==========================
const map = new Map();

// add existing first (priority)
existingDoctors.forEach(doc => {
  map.set(doc.resourceId, doc);
});

// add new doctors; if already exists, enrich with Excel data where clean.json fields are blank
doctors.forEach(doc => {
  if (map.has(doc.resourceId)) {
    const existing = map.get(doc.resourceId);
    map.set(doc.resourceId, {
      ...existing,
      // only fill in blanks — clean.json values always take priority
      doctorName: existing.doctorName || doc.doctorName,
      locationId: existing.locationId || null,
      city:       existing.city       || null,
      branch:     existing.branch     || null,
      speciality: existing.speciality || null,
    });
  } else {
    map.set(doc.resourceId, {
      doctorName: doc.doctorName,
      resourceId: doc.resourceId,
      locationId: null,
      regionId:   "1",
      city:       null,
      branch:     null,
      speciality: null,
    });
  }
});

const finalDoctors = Array.from(map.values());

// ==========================
// SAVE OUTPUT
// ==========================
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalDoctors, null, 2));

console.log("✅ Done. Output saved to:", OUTPUT_FILE);
console.log("Doctors count:", finalDoctors.length);
console.log("Locations parsed:", locations.length);