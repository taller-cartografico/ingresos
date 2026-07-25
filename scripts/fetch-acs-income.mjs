// Builds public/pr_income_tracts.geojson by joining:
//  - Census cartographic boundary tract polygons for Puerto Rico (STATEFP 72)
//  - ACS 5-Year median household income in the past 12 months (table B19013)
//
// Requires outbound internet access to www2.census.gov and api.census.gov.
// Run with: npm run fetch-data
//
// This script tries the most recent ACS 5-year vintage first and walks
// backwards until it finds a year the Census API actually serves, since the
// newest 5-year release isn't always up yet at any given moment.

import fs from 'fs';
import path from 'path';
import shp from 'shpjs';

const STATE_FIPS = '72';
const CANDIDATE_YEARS = [2024, 2023, 2022, 2021, 2020];
const TMP_DIR = path.resolve('scripts/tmp');
const OUT_PATH = path.resolve('public/pr_income_tracts.geojson');
const META_OUT_PATH = path.resolve('public/pr_income_meta.json');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchAcsIncomeByTract(year) {
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=NAME,B19013_001E,B19013_001M,B19001_001E&for=tract:*&in=state:${STATE_FIPS}`;
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

async function fetchTractBoundaries(year) {
  const url = `https://www2.census.gov/geo/tiger/GENZ${year}/shp/cb_${year}_${STATE_FIPS}_tract_500k.zip`;
  console.log(`Trying cartographic boundary vintage ${year}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, `cb_${year}_${STATE_FIPS}_tract_500k.zip`);
  fs.writeFileSync(zipPath, buf);
  const geojson = await shp(buf);
  return { year, geojson: Array.isArray(geojson) ? geojson[0] : geojson };
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
  console.log(`Using ACS 5-year ${acs.year}-${acs.records.length ? acs.year - 4 : '?'} data, ${acs.records.length} tracts.`);

  const boundaryYears = [...new Set([acs.year, ...CANDIDATE_YEARS])];
  const boundaries = await findFirstWorking(boundaryYears, fetchTractBoundaries);
  console.log(`Using ${boundaries.year} cartographic tract boundaries, ${boundaries.geojson.features.length} features.`);

  const incomeByGeoid = new Map(acs.records.map((r) => [r.geoid, r]));

  let matched = 0;
  const features = boundaries.geojson.features.map((f) => {
    const p = f.properties;
    const geoid = p.GEOID || p.GEOID20 || `${p.STATEFP}${p.COUNTYFP}${p.TRACTCE}`;
    const income = incomeByGeoid.get(geoid);
    if (income) matched++;

    // Round coordinates to keep the file small.
    function roundCoords(coords) {
      if (typeof coords[0] === 'number') {
        return coords.map((n) => Math.round(n * 100000) / 100000);
      }
      return coords.map(roundCoords);
    }
    const geometry = { ...f.geometry, coordinates: roundCoords(f.geometry.coordinates) };

    return {
      type: 'Feature',
      geometry,
      properties: {
        geoid,
        tract: p.NAME,
        municipio: income ? parseMunicipio(income.name) : (p.NAMELSADCO || '').replace(/ Municipio$/, ''),
        median_income: income ? income.medianIncome : null,
        moe: income ? income.moe : null,
        households: income ? income.households : null,
      },
    };
  });

  console.log(`Matched income data for ${matched} / ${features.length} tracts.`);

  const outGeojson = { type: 'FeatureCollection', features };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(outGeojson));

  const values = features
    .map((f) => f.properties.median_income)
    .filter((v) => v !== null && v !== undefined);
  const meta = {
    acsYear: acs.year,
    acsPeriod: `${acs.year - 4}-${acs.year}`,
    boundaryYear: boundaries.year,
    tractCount: features.length,
    tractsWithData: values.length,
    minIncome: Math.min(...values),
    maxIncome: Math.max(...values),
    medianOfMedians: values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)],
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(META_OUT_PATH, JSON.stringify(meta, null, 2));

  console.log('Wrote', OUT_PATH);
  console.log('Wrote', META_OUT_PATH);
  console.log(meta);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
