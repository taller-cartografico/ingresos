// Fetches ACS 5-Year median household income in the past 12 months (table
// B19013) for every census tract in Puerto Rico, and writes a small GEOID ->
// income lookup table. Boundaries come from the project's own
// `census tracts.geojson` / `Municipios.geojson` (see scripts/build-income-map.mjs),
// not from this script.
//
// Requires outbound internet access to api.census.gov.
// Run with: npm run fetch-data
//
// Tries the most recent ACS 5-year vintage first and walks backwards until
// it finds a year the Census API actually serves.

import fs from 'fs';
import path from 'path';

const STATE_FIPS = '72';
const CANDIDATE_YEARS = [2024, 2023, 2022, 2021, 2020];
const OUT_PATH = path.resolve('public/pr_income_by_tract.json');
const API_KEY = process.env.CENSUS_API_KEY;

if (!API_KEY) {
  console.error(
    'Missing CENSUS_API_KEY. Get a free key at https://api.census.gov/data/key_signup.html ' +
    'and set it as the CENSUS_API_KEY environment variable (or a GitHub Actions secret of the same name).'
  );
  process.exit(1);
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response for ${url}: ${text.slice(0, 300)}`);
  }
}

async function fetchAcsIncomeByTract(year) {
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=NAME,B19013_001E,B19013_001M,B19001_001E&for=tract:*&in=state:${STATE_FIPS}&key=${API_KEY}`;
  console.log(`Trying ACS 5-year ${year}...`);
  const rows = await fetchJson(url);
  const [header, ...data] = rows;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const records = data.map((row) => {
    const geoid = row[idx.state] + row[idx.county] + row[idx.tract];
    const estimate = Number(row[idx.B19013_001E]);
    const moe = Number(row[idx.B19013_001M]);
    const households = Number(row[idx.B19001_001E]);
    return {
      geoid,
      name: row[idx.NAME],
      medianIncome: estimate >= 0 ? estimate : null, // negative sentinels mean suppressed/N/A
      moe: estimate >= 0 ? moe : null,
      households: households >= 0 ? households : null,
    };
  });
  return { year, records };
}

async function findFirstWorking(years, fn) {
  let lastErr;
  for (const year of years) {
    try {
      return await fn(year);
    } catch (err) {
      console.warn(`  -> failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

function parseMunicipio(name) {
  // e.g. "Census Tract 4009, Aguadilla Municipio, Puerto Rico"
  const parts = name.split(',').map((s) => s.trim());
  if (parts.length >= 2) {
    return parts[1].replace(/ Municipio$/, '');
  }
  return null;
}

async function main() {
  const acs = await findFirstWorking(CANDIDATE_YEARS, fetchAcsIncomeByTract);
  console.log(`Using ACS 5-year ${acs.year - 4}-${acs.year} data, ${acs.records.length} tracts.`);

  const byGeoid = {};
  for (const r of acs.records) {
    byGeoid[r.geoid] = {
      median_income: r.medianIncome,
      moe: r.moe,
      households: r.households,
      municipio: parseMunicipio(r.name),
    };
  }

  const values = acs.records.map((r) => r.medianIncome).filter((v) => v !== null);
  const output = {
    acsYear: acs.year,
    acsPeriod: `${acs.year - 4}-${acs.year}`,
    tractCount: acs.records.length,
    tractsWithData: values.length,
    minIncome: Math.min(...values),
    maxIncome: Math.max(...values),
    generatedAt: new Date().toISOString(),
    byGeoid,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));
  console.log('Wrote', OUT_PATH);
  console.log({ ...output, byGeoid: `<${Object.keys(byGeoid).length} entries>` });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
