'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SOURCE_FILE = process.argv[2] || 'Untitled spreadsheet.xlsx';
const sourcePath = path.join(__dirname, '..', SOURCE_FILE);
const outDir = path.join(__dirname, '..', 'data');
const outPath = path.join(outDir, 'master-data.json');

function isNumericId(value) {
  return /^\d+$/.test(String(value ?? '').trim());
}

function loadExistingLocationFallbacks() {
  if (!fs.existsSync(outPath)) return {};
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    return existing.locationFallbacksByCity && typeof existing.locationFallbacksByCity === 'object'
      ? existing.locationFallbacksByCity
      : {};
  } catch {
    return {};
  }
}

function toTitleCase(value) {
  const minor = new Set(['and', 'of', 'the', 'in', 'at', 'by', 'for', 'a']);
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, idx) => {
      if (idx > 0 && minor.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function cleanId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/\.0$/, '');
}

function parseLocation(rawLocation) {
  const location = String(rawLocation ?? '').replace(/\s+/g, ' ').trim();
  if (!location) return { city: '', branch: '', location };

  const split = location.split(/\s*-\s*/);
  const city = toTitleCase(split[0] || '');
  const branch = split.length > 1 ? toTitleCase(split.slice(1).join(' - ')) : '';
  return { city, branch, location: toTitleCase(location) };
}

function toRecord(row) {
  const locationRaw = row.location ?? row.Location ?? '';
  const doctorName = String(row.doctorname ?? row['doctor name'] ?? row.DoctorName ?? '').replace(/\s+/g, ' ').trim();
  const speciality = String(row.speciality ?? row.Speciality ?? row.specialty ?? '').replace(/\s+/g, ' ').trim();

  const parsed = parseLocation(locationRaw);
  return {
    locationId: cleanId(row.locationid ?? row.LocationID ?? row.locationId),
    regionId: cleanId(row.regionid ?? row.RegionID ?? row.regionId) || '5',
    location: parsed.location,
    city: parsed.city,
    branch: parsed.branch,
    serviceId: cleanId(row.serviceid ?? row.ServiceID ?? row.serviceId),
    resourceId: cleanId(row.resourceid ?? row.ResourceID ?? row.resourceId),
    doctorName: toTitleCase(doctorName),
    specialityId: cleanId(row.specialityid ?? row.SpecialityID ?? row.specialtyid),
    speciality: toTitleCase(speciality),
  };
}

function validRecord(record) {
  const hasRequiredFields = !!(record.city && record.locationId && record.resourceId && record.doctorName);
  if (!hasRequiredFields) return false;

  // Ignore header-like rows that can appear as normal data rows.
  const headerLike = new Set(['locationid', 'resourceid', 'doctorname', 'speciality', 'location']);
  if (headerLike.has(String(record.resourceId || '').toLowerCase())) return false;
  if (headerLike.has(String(record.doctorName || '').toLowerCase())) return false;
  return true;
}

function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source workbook not found: ${sourcePath}`);
  }

  const workbook = XLSX.readFile(sourcePath);
  const firstSheet = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });

  const seen = new Set();
  const doctors = [];
  const locationFallbacksByCity = loadExistingLocationFallbacks();
  for (const row of rows) {
    const record = toRecord(row);
    if (!isNumericId(record.locationId)) {
      const fallback = locationFallbacksByCity[record.city]?.[0];
      if (isNumericId(fallback)) {
        record.locationId = String(fallback);
      }
    }
    if (!validRecord(record)) continue;
    const fingerprint = [
      record.locationId,
      record.resourceId,
      record.serviceId,
      record.doctorName.toLowerCase(),
      record.speciality.toLowerCase(),
    ].join('|');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    doctors.push(record);
  }

  const hospitalsByCity = {};
  for (const r of doctors) {
    const city = r.city;
    if (!hospitalsByCity[city]) hospitalsByCity[city] = [];
    if (!hospitalsByCity[city].some((h) => h.locationId === r.locationId)) {
      hospitalsByCity[city].push({
        name: r.location,
        city,
        locationId: r.locationId,
        url: `https://www.apollohospitals.com/doctors/?location=${encodeURIComponent(city)}`,
      });
    }
  }

  Object.keys(hospitalsByCity).forEach((city) => {
    hospitalsByCity[city].sort((a, b) => a.name.localeCompare(b.name));
  });

  const specialitiesWithIds = [];
  const specialitySeen = new Set();
  for (const r of doctors) {
    if (!r.speciality) continue;
    const key = `${r.speciality.toLowerCase()}|${r.specialityId}`;
    if (specialitySeen.has(key)) continue;
    specialitySeen.add(key);
    specialitiesWithIds.push({ name: r.speciality, aaId: r.specialityId || '' });
  }
  specialitiesWithIds.sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFile: SOURCE_FILE,
    doctors,
    cities: Object.keys(hospitalsByCity).sort(),
    hospitalsByCity,
    specialitiesWithIds,
    locationFallbacksByCity,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Source sheet: ${firstSheet}`);
  console.log(`Doctors: ${doctors.length}`);
  console.log(`Cities: ${payload.cities.length}`);
  console.log(`Specialities: ${specialitiesWithIds.length}`);
  console.log(`Written: ${outPath}`);
}

main();
