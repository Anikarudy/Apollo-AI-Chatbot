// scripts/buildJubileeDoctors.js
// Extracts and cleans Jubilee Hills doctors from jubileeHillsDoctors.json
// Output: data/jubileeDoctors.json

const fs = require("fs");
const path = require("path");

const src = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/jubileeHillsDoctors.json"), "utf8"));

function titleCase(str) {
  return str
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const seen = new Set();
const result = [];

for (const doc of src) {
  const rawName = (doc.doctorName || "").trim();
  // Preserve Dr. prefix casing, title-case the rest
  const name = rawName.replace(/^dr\.?\s*/i, "").trim();
  const fullName = name ? "Dr. " + titleCase(name) : "";
  const specialty = titleCase((doc.speciality || "").trim()) || null;
  const locationId = (doc.locationId || "").trim() || null;
  const resourceId = (doc.resourceId || "").trim();

  if (!fullName || !resourceId) continue;

  // Dedup by resourceId
  if (seen.has(resourceId)) continue;
  seen.add(resourceId);

  result.push({
    name: fullName,
    specialty,
    location: "Jubilee Hills",
    resourceId,
    locationId,
  });
}

fs.writeFileSync(
  path.join(__dirname, "../data/jubileeDoctors.json"),
  JSON.stringify(result, null, 2)
);

console.log("Written data/jubileeDoctors.json — entries:", result.length);
console.log("Sample:", JSON.stringify(result.slice(0, 3), null, 2));
