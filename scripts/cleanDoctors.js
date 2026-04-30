const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "../data/raw.txt"); // your pasted file
const outputPath = path.join(__dirname, "../data/clean.json");

// TEMP mapping (replace later with real API mapping)
const LOCATION_MAP = {
  "DELHI - SARITA VIHAR": "10201"
};

function cleanName(name) {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isValidDoctor(name) {
  if (!name) return false;
  if (name.toLowerCase().includes("group")) return false;
  if (name.toLowerCase().startsWith("mr.")) return false;
  return true;
}

function parseFile(content) {
  const lines = content.split("\n").slice(1); // skip header
  const seen = new Set();
  const doctors = [];

  for (let line of lines) {
    const cols = line.split("\t");

    if (cols.length < 8) continue;

    let [
      locationIdRaw,
      regionId,
      location,
      serviceId,
      resourceId,
      doctorName,
      specialityId,
      speciality
    ] = cols;

    doctorName = cleanName(doctorName);

    if (!isValidDoctor(doctorName)) continue;
    if (!resourceId || !location) continue;

    const locationId = LOCATION_MAP[location.trim()];
    if (!locationId) continue;

    const key = `${doctorName}-${resourceId}-${locationId}`;
    if (seen.has(key)) continue;

    seen.add(key);

    doctors.push({
      doctorName,
      resourceId,
      locationId,
      regionId: regionId || "1",
      location,
      speciality
    });
  }

  return doctors;
}

function main() {
  const raw = fs.readFileSync(inputPath, "utf-8");
  const doctors = parseFile(raw);

  fs.writeFileSync(outputPath, JSON.stringify({ doctors }, null, 2));

  console.log(`✅ Cleaned ${doctors.length} doctors`);
}

main();