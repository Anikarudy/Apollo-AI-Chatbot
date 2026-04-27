// scripts/transformDoctorData.js
// Run:  node scripts/transformDoctorData.js <input.csv|input.xlsx>
// Input must have columns:  location | doctorname | speciality
// Output: src/doctorLocationMapping.ts  (data + query functions)

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── STEP 1: CLEANING HELPERS ─────────────────────────────────────────────────

/** Normalize honorific prefixes (Dr./Ms./Mr./Prof.) → canonical "Title. " form. */
function normalizeDrPrefix(name) {
  return name
    // Canonicalise all Dr variants → Dr.
    .replace(/\bDR\.?\b/gi, 'Dr.')
    // Canonicalise Ms / Miss / Mrs variants → Ms.
    .replace(/\bM(?:RS?|ISS)\.?\b/gi, 'Ms.')
    // Canonicalise Mr variants → Mr.
    .replace(/\bMR\.?\b/gi, 'Mr.')
    // Canonicalise Prof variants → Prof.
    .replace(/\bPROF\.?\B/gi, 'Prof.')
    // Insert missing space after any honorific dot: Dr.Ram → Dr. Ram
    .replace(/\b(Dr|Ms|Mr|Prof)\.([A-Za-z])/g, '$1. $2')
    // Collapse multiple spaces after honorific
    .replace(/\b(Dr|Ms|Mr|Prof)\.\s{2,}/g, '$1. ')
    .trim();
}

/** Title-case a full name token-by-token, preserving "Dr." */
function titleCaseName(name) {
  const MIN_WORDS = ['and', 'or', 'of', 'the', 'in', 'at', 'by', 'for'];
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      if (word === 'Dr.') return 'Dr.';                                  // preserve
      const lower = word.toLowerCase();
      if (i > 0 && MIN_WORDS.includes(lower)) return lower;             // keep lowercase
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Return null for empty / obviously corrupted names */
function cleanDoctorName(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Flatten multi-line entries
  let name = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (name.length < 3)                         return null;  // too short
  if (/^[^a-zA-Z]+$/.test(name))              return null;  // no letters
  if (/^(aaa|test|xxx|zzz|null|n\/a)/i.test(name)) return null;

  return name;
}

// ─── STEP 2: LOCATION PARSER ──────────────────────────────────────────────────

/**
 * Split "CITY - BRANCH" into { main_location, sub_branch }.
 * Handles:
 *   "DELHI - SARITA VIHAR"  → { main_location: "DELHI", sub_branch: "SARITA VIHAR" }
 *   "DELHI-SARITA VIHAR"    → same
 *   "CHENNAI"               → { main_location: "CHENNAI", sub_branch: null }
 */
function parseLocation(location) {
  if (!location || typeof location !== 'string') {
    return { main_location: 'UNKNOWN', sub_branch: null };
  }

  const trimmed = location.trim().toUpperCase();

  // Prefer " - " with surrounding spaces
  const spDash = trimmed.indexOf(' - ');
  if (spDash !== -1) {
    return {
      main_location: trimmed.slice(0, spDash).trim(),
      sub_branch:    trimmed.slice(spDash + 3).trim() || null,
    };
  }

  // Fall back to bare '-'
  const bareDash = trimmed.indexOf('-');
  if (bareDash > 0 && bareDash < trimmed.length - 1) {
    return {
      main_location: trimmed.slice(0, bareDash).trim(),
      sub_branch:    trimmed.slice(bareDash + 1).trim() || null,
    };
  }

  return { main_location: trimmed, sub_branch: null };
}

// ─── STEP 7: GROUPED-DOCTOR SPLITTER ─────────────────────────────────────────

/** "Dr.A AND Dr.B" / "Dr.X / Dr.Y" / "Dr.A & Dr.B" → ["Dr.A", "Dr.B"] */
function splitGroupedDoctors(raw) {
  // Split on AND / & / /  only when surrounded by spaces (guards "S/O", "A&E" etc.)
  const parts = raw
    .split(/\s+(?:AND|&|\/)\s+/i)
    .map(p => p.trim())
    .filter(p => p.length >= 3 && /[a-zA-Z]/.test(p));
  return parts.length > 1 ? parts : [raw];
}

// ─── STEPS 3-5: HIERARCHICAL GROUPING + DEDUP ─────────────────────────────────

/**
 * Core transform: raw rows → nested DoctorLocationMap.
 *
 * @param {Array<{location:string, doctorname:string, speciality:string}>} rawRows
 * @returns {{ map: DoctorLocationMap, stats: object }}
 */
function transformData(rawRows) {
  const seen  = new Set();     // dedup fingerprints
  const map   = {};            // final nested structure
  let skipped = 0;
  let splitCt = 0;

  for (const row of rawRows) {
    // ── Guard: skip null / non-object rows (Step 7) ──────────────
    if (!row || typeof row !== 'object') { skipped++; continue; }

    // Flexible column name resolution
    const rawLocation = String(
      row.location  || row.Location  || row.LOCATION  || ''
    ).trim();
    const rawDoctor = String(
      row.doctorname || row.DoctorName || row['Doctor Name'] ||
      row.doctor_name || row.DOCTORNAME || ''
    ).trim();
    const rawSpeciality = String(
      row.speciality || row.Speciality || row.specialty ||
      row.Specialty  || row.SPECIALITY || ''
    ).trim();

    // Skip rows missing essential fields
    if (!rawLocation || !rawDoctor) { skipped++; continue; }

    // ── Step 2: parse location ────────────────────────────────────
    const { main_location, sub_branch } = parseLocation(rawLocation);
    const branchKey = sub_branch || '_MAIN';

    // ── Step 7: split grouped doctors ────────────────────────────
    const parts = splitGroupedDoctors(rawDoctor);
    if (parts.length > 1) splitCt++;

    for (const rawName of parts) {
      // ── Step 1: clean + normalise name ───────────────────────
      const cleaned = cleanDoctorName(rawName);
      if (!cleaned) { skipped++; continue; }

      const normalised  = normalizeDrPrefix(cleaned);
      const doctorName  = titleCaseName(normalised);

      // ── Step 5: missing speciality → "UNKNOWN" ────────────────
      const speciality  = rawSpeciality || 'UNKNOWN';

      // ── Step 5: dedup (case-insensitive) ──────────────────────
      const fingerprint = `${main_location}|${branchKey}|${doctorName.toLowerCase()}|${speciality.toLowerCase()}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      // ── Steps 3-4: build nested map ───────────────────────────
      if (!map[main_location])             map[main_location] = {};
      if (!map[main_location][branchKey])  map[main_location][branchKey] = [];

      map[main_location][branchKey].push({ doctor_name: doctorName, speciality });
    }
  }

  const totalDoctors = Object.values(map)
    .flatMap(b => Object.values(b))
    .reduce((s, arr) => s + arr.length, 0);

  return {
    map,
    stats: {
      locations:    Object.keys(map).length,
      totalDoctors,
      skipped,
      splitEntries: splitCt,
    },
  };
}

// ─── READ INPUT ───────────────────────────────────────────────────────────────

/**
 * Read a CSV (RFC 4180) or xlsx file into an array of plain objects.
 * Column headers are lowercased and space-normalised.
 */
function readInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV has no data rows');

    // Parse header
    const headers = parseCsvLine(lines[0]).map(h =>
      h.trim().toLowerCase().replace(/\s+/g, '_')
    );

    return lines.slice(1).map(line => {
      const values = parseCsvLine(line);
      const row    = {};
      headers.forEach((h, i) => { row[h] = (values[i] ?? '').trim(); });
      return row;
    });
  }

  if (ext === '.xlsx' || ext === '.xls') {
    let XLSX;
    try { XLSX = require('xlsx'); }
    catch (_) { throw new Error('xlsx package not found. Run: npm install xlsx'); }

    const wb = XLSX.readFile(filePath);
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  }

  throw new Error(`Unsupported file type: "${ext}". Provide .csv or .xlsx`);
}

/** Minimal RFC 4180 CSV line parser (handles quoted fields with commas). */
function parseCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
      else                                   inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── STEP 6 + 8: TYPESCRIPT CODE GENERATOR ───────────────────────────────────

function generateTypeScript(map, stats) {
  const totalDoctors   = stats?.totalDoctors ?? 0;
  const totalLocations = Object.keys(map).length;

  // Pretty-print sample for comment
  const sampleLocs = Object.keys(map).slice(0, 5).join(', ');

  return `// AUTO-GENERATED by scripts/transformDoctorData.js – DO NOT EDIT MANUALLY
// Source: Master_Details (local).xlsx → location + doctorname + speciality mapping
// Stats: ${totalLocations} main locations, ${totalDoctors} doctor entries
// Sample locations: ${sampleLocs || '(empty – re-run with data file)'}

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface DoctorEntry {
  doctor_name: string;
  speciality:  string;
}

/**
 * Nested map:  main_location → sub_branch → DoctorEntry[]
 *
 * Sub-branches without a dash in the source location string use the key "_MAIN".
 */
export type DoctorLocationMap = Record<string, Record<string, DoctorEntry[]>>;

// ─── GENERATED DATA ──────────────────────────────────────────────────────────

export const doctorLocationMap: DoctorLocationMap = ${JSON.stringify(map, null, 2)};

// ─── QUERY FUNCTIONS ─────────────────────────────────────────────────────────

/**
 * Returns every sub-branch and its doctors for the given main location.
 *
 * @example
 *   getDoctorsByMainLocation("DELHI")
 *   // → { "SARITA VIHAR": [...], "NOIDA": [...] }
 */
export function getDoctorsByMainLocation(
  main_location: string
): Record<string, DoctorEntry[]> | null {
  if (!main_location?.trim()) return null;
  return doctorLocationMap[main_location.trim().toUpperCase()] ?? null;
}

/**
 * Returns all doctors in a specific branch.
 *
 * Pass \`"_MAIN"\` as sub_branch for hospitals that have no dash in the location string.
 *
 * @example
 *   getDoctorsBySubBranch("DELHI", "SARITA VIHAR")
 */
export function getDoctorsBySubBranch(
  main_location: string,
  sub_branch:    string
): DoctorEntry[] | null {
  if (!main_location?.trim() || !sub_branch?.trim()) return null;
  const locKey    = main_location.trim().toUpperCase();
  const branchKey = sub_branch.trim().toUpperCase();
  return doctorLocationMap[locKey]?.[branchKey] ?? null;
}

/**
 * Returns doctors matching a given speciality within a specific branch.
 *
 * Comparison is case-insensitive.
 *
 * @example
 *   getDoctorsBySpeciality("DELHI", "SARITA VIHAR", "Cardiology")
 */
export function getDoctorsBySpeciality(
  main_location: string,
  sub_branch:    string,
  speciality:    string
): DoctorEntry[] {
  const doctors = getDoctorsBySubBranch(main_location, sub_branch);
  if (!doctors || !speciality?.trim()) return [];
  const target = speciality.trim().toLowerCase();
  return doctors.filter(d => d.speciality.toLowerCase() === target);
}

/**
 * Returns all main location keys present in the map (sorted A-Z).
 */
export function getAllMainLocations(): string[] {
  return Object.keys(doctorLocationMap).sort();
}

/**
 * Returns the sub-branch keys for a given main location (sorted A-Z).
 * "_MAIN" represents locations with no explicit sub-branch in the source data.
 */
export function getSubBranches(main_location: string): string[] {
  const branches = getDoctorsByMainLocation(main_location);
  return branches ? Object.keys(branches).sort() : [];
}

/**
 * Returns all unique specialities available across an entire main location.
 */
export function getSpecialitiesByMainLocation(main_location: string): string[] {
  const branches = getDoctorsByMainLocation(main_location);
  if (!branches) return [];
  const set = new Set<string>();
  Object.values(branches).flat().forEach(d => set.add(d.speciality));
  return Array.from(set).sort();
}
`;
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const inputFile = process.argv[2];
const outPath   = path.join(__dirname, '..', 'src', 'doctorLocationMapping.ts');

if (!inputFile) {
  console.log('Usage:  node scripts/transformDoctorData.js <input.csv|input.xlsx>');
  console.log('');
  console.log('Input file columns required: location, doctorname, speciality');
  console.log('');
  console.log('Example CSV rows:');
  console.log('  location,doctorname,speciality');
  console.log('  "DELHI - SARITA VIHAR","Dr. Ramesh Kumar","Cardiology"');
  console.log('  "HYDERABAD - JUBILEE HILLS","Dr. Priya Sharma","Neurology"');
  console.log('');
  console.log('Generating empty template → src/doctorLocationMapping.ts ...');
  fs.writeFileSync(outPath, generateTypeScript({}, { totalDoctors: 0 }), 'utf8');
  console.log('Done. Re-run with a data file to populate the mapping.');
  process.exit(0);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: file not found: ${inputFile}`);
  process.exit(1);
}

console.log(`Reading: ${inputFile}`);
let rawRows;
try {
  rawRows = readInput(inputFile);
} catch (err) {
  console.error(`Error reading file: ${err.message}`);
  process.exit(1);
}
console.log(`  → ${rawRows.length} raw rows`);

const { map, stats } = transformData(rawRows);
console.log(`  → ${stats.locations} main locations`);
console.log(`  → ${stats.totalDoctors} unique doctor entries`);
console.log(`  → ${stats.splitEntries} grouped entries split`);
console.log(`  → ${stats.skipped} rows skipped (empty / corrupted)`);

// Cleaned dataset sample (first 5 entries from each location)
console.log('\nCleaned sample:');
for (const [loc, branches] of Object.entries(map).slice(0, 3)) {
  for (const [branch, doctors] of Object.entries(branches).slice(0, 2)) {
    console.log(`  ${loc} / ${branch}:`);
    doctors.slice(0, 3).forEach(d =>
      console.log(`    - ${d.doctor_name} (${d.speciality})`)
    );
  }
}

fs.writeFileSync(outPath, generateTypeScript(map, stats), 'utf8');
console.log(`\nWritten: src/doctorLocationMapping.ts`);
