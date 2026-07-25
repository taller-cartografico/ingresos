import './style.css';
import maplibregl from 'maplibre-gl';

const BASE = import.meta.env.BASE_URL;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [-66.45, 18.2],
  zoom: 8.3,
  minZoom: 7,
  maxZoom: 16,
  pitch: 0,
});

map.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true,
}), 'bottom-right');

map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

// Sequential single-hue ramp (Lino -> Ceiba), light = low income, dark = high income.
const COLOR_RAMP = ['#f2ede4', '#d8e2d1', '#b8c4bc', '#85a496', '#476558', '#1d3a2f'];
const NO_DATA_COLOR = '#c1c8c3';
const NUM_CLASSES = COLOR_RAMP.length;

const currency = new Intl.NumberFormat('es-PR', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat('es-PR');

// ---------------------------------------------------------------------------
// Loading overlay: real progress across the fetches below, with a small
// minimum-duration floor so it doesn't just flash on a fast connection.
// ---------------------------------------------------------------------------
const loadingOverlay = document.getElementById('loading-overlay');
const loadingPct = document.getElementById('loading-pct');
const loadingFill = document.getElementById('loading-progress-fill');
const TOTAL_STEPS = 4; // map style, tracts, municipios, income
let stepsDone = 0;
function bumpLoading() {
  stepsDone += 1;
  const pct = Math.min(100, Math.round((stepsDone / TOTAL_STEPS) * 100));
  if (loadingPct) loadingPct.textContent = `${pct}%`;
  if (loadingFill) loadingFill.style.width = `${pct}%`;
}
function hideLoadingOverlay() {
  if (!loadingOverlay) return;
  loadingOverlay.classList.add('fade-out');
  setTimeout(() => loadingOverlay.remove(), 500);
}

const mapLoaded = new Promise((resolve) => map.on('load', resolve)).then((r) => { bumpLoading(); return r; });
const tractsFetch = fetch(`${BASE}pr_tracts_boundaries.geojson`).then((r) => r.json()).then((d) => { bumpLoading(); return d; });
const municipiosFetch = fetch(`${BASE}pr_municipios.geojson`).then((r) => r.json()).then((d) => { bumpLoading(); return d; });
const incomeFetch = fetch(`${BASE}pr_income_by_tract.json`).then((r) => r.json()).then((d) => { bumpLoading(); return d; });
const minDuration = new Promise((resolve) => setTimeout(resolve, 700));

Promise.all([mapLoaded, tractsFetch, municipiosFetch, incomeFetch, minDuration])
  .then(([, tracts, municipios, income]) => init(tracts, municipios, income))
  .catch((err) => {
    console.error(err);
    if (loadingPct) loadingPct.textContent = 'Error al cargar los datos.';
  });

function init(tractsGeojson, municipiosGeojson, incomeData) {
  // --- Join income data onto tract features -------------------------------
  const municipioByCountyfp = new Map();
  municipiosGeojson.features.forEach((f) => {
    municipioByCountyfp.set(f.properties.countyfp, f.properties.municipio);
  });

  const values = [];
  tractsGeojson.features.forEach((f) => {
    const p = f.properties;
    const income = incomeData.byGeoid[p.GEOID];
    p.median_income = income ? income.median_income : null;
    p.moe = income ? income.moe : null;
    p.households = income ? income.households : null;
    p.municipio = municipioByCountyfp.get(p.COUNTYFP) || (income && income.municipio) || 'Puerto Rico';
    if (typeof p.median_income === 'number') values.push(p.median_income);
  });
  values.sort((a, b) => a - b);

  function quantileBreak(fraction) {
    const idx = (values.length - 1) * fraction;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return values[lo];
    return values[lo] + (values[hi] - values[lo]) * (idx - lo);
  }
  const breaks = [];
  for (let i = 1; i < NUM_CLASSES; i++) breaks.push(Math.round(quantileBreak(i / NUM_CLASSES)));

  function percentileOf(value) {
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < value) lo = mid + 1; else hi = mid;
    }
    return Math.round((lo / values.length) * 100);
  }

  // --- Legend ---------------------------------------------------------------
  const legendEl = document.getElementById('legend');
  if (legendEl) {
    const edges = [values[0], ...breaks, values[values.length - 1]];
    let html = '<p class="legend-title">Ingreso Mediano Anual</p>';
    for (let i = 0; i < NUM_CLASSES; i++) {
      const lo = currency.format(edges[i]);
      const hi = currency.format(edges[i + 1]);
      html += `<div class="legend-row"><span class="legend-swatch" style="background:${COLOR_RAMP[i]}"></span><span class="legend-label">${lo} – ${hi}</span></div>`;
    }
    html += `<div class="legend-row"><span class="legend-swatch" style="background:${NO_DATA_COLOR}"></span><span class="legend-label">Sin datos</span></div>`;
    legendEl.innerHTML = html;
  }

  // --- Source note ------------------------------------------------------
  const sourceNote = document.getElementById('source-note');
  if (sourceNote) {
    sourceNote.textContent = `Fuente: Census Bureau, ACS 5 años ${incomeData.acsPeriod}`;
  }

  // --- Map layers -----------------------------------------------------------
  map.addSource('tracts', {
    type: 'geojson',
    data: tractsGeojson,
    generateId: true,
    attribution: '<a href="https://www.census.gov/programs-surveys/acs" target="_blank">ACS 5-Year Estimates © U.S. Census Bureau</a>',
  });

  map.addSource('municipios', { type: 'geojson', data: municipiosGeojson });

  const fillColorExpr = [
    'case',
    ['==', ['get', 'median_income'], null], NO_DATA_COLOR,
    [
      'step',
      ['get', 'median_income'],
      COLOR_RAMP[0],
      breaks[0], COLOR_RAMP[1],
      breaks[1], COLOR_RAMP[2],
      breaks[2], COLOR_RAMP[3],
      breaks[3], COLOR_RAMP[4],
      breaks[4], COLOR_RAMP[5],
    ],
  ];

  map.addLayer({
    id: 'tracts-fill',
    type: 'fill',
    source: 'tracts',
    paint: {
      'fill-color': fillColorExpr,
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0.75],
    },
  }, 'water');

  map.addLayer({
    id: 'tracts-outline',
    type: 'line',
    source: 'tracts',
    paint: { 'line-color': '#2c2c28', 'line-width': 0.5, 'line-opacity': 0.25 },
  }, 'water');

  map.addLayer({
    id: 'municipios-outline',
    type: 'line',
    source: 'municipios',
    paint: { 'line-color': '#2c2c28', 'line-width': 1.2, 'line-opacity': 0.5 },
  }, 'water');

  map.addLayer({
    id: 'municipios-mask',
    type: 'fill',
    source: 'municipios',
    filter: ['!=', 'municipio', ''],
    paint: { 'fill-color': '#2c2c28', 'fill-opacity': 0 },
  }, 'water');

  map.addLayer({
    id: 'municipios-stroke',
    type: 'line',
    source: 'municipios',
    filter: ['==', 'municipio', ''],
    paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0 },
  }, 'water');

  // --- Hover: feature-state highlight + floating tooltip ---------------------
  let hoveredId = null;
  const tooltip = document.createElement('div');
  tooltip.className = 'hover-tooltip';
  tooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:30;background:var(--lino,#f2ede4);border:1px solid rgba(44,44,40,.15);border-radius:4px;padding:6px 10px;font-family:"Hanken Grotesk",sans-serif;font-size:13px;box-shadow:2px 2px 0 rgba(44,44,40,.15);max-width:240px;';
  document.getElementById('app').appendChild(tooltip);

  map.on('mousemove', 'tracts-fill', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (!e.features.length) return;
    if (hoveredId !== null) map.setFeatureState({ source: 'tracts', id: hoveredId }, { hover: false });
    hoveredId = e.features[0].id;
    map.setFeatureState({ source: 'tracts', id: hoveredId }, { hover: true });

    const p = e.features[0].properties;
    const incomeLabel = typeof p.median_income === 'number' ? currency.format(p.median_income) : 'Sin datos';
    tooltip.innerHTML = `<strong>${p.municipio}</strong> — Sector ${p.NAME}<br/><span style="color:var(--primary,#1d3a2f);font-weight:700;">${incomeLabel}</span>`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.point.x + 14}px`;
    tooltip.style.top = `${e.point.y + 14}px`;
  });

  map.on('mouseleave', 'tracts-fill', () => {
    map.getCanvas().style.cursor = '';
    if (hoveredId !== null) map.setFeatureState({ source: 'tracts', id: hoveredId }, { hover: false });
    hoveredId = null;
    tooltip.style.display = 'none';
  });

  // --- Side panel -------------------------------------------------------------
  const infoPanel = document.getElementById('info-panel');
  const infoContent = document.getElementById('info-content');
  const closeBtn = document.getElementById('close-panel');
  if (closeBtn) closeBtn.addEventListener('click', () => infoPanel.classList.add('closed'));

  function renderTract(props) {
    if (!infoPanel || !infoContent) return;
    infoPanel.classList.remove('closed');

    const hasIncome = typeof props.median_income === 'number';
    const incomeBlock = hasIncome
      ? `<div class="income-figure">
           <span class="caption">Ingreso mediano por hogar</span>
           <span class="value">${currency.format(props.median_income)}</span>
           <span class="moe">± ${currency.format(props.moe || 0)} (margen de error)</span>
         </div>
         <table>
           <tr><th>Percentil en Puerto Rico</th><td>${percentileOf(props.median_income)}%</td></tr>
           <tr><th>Hogares (aprox.)</th><td>${props.households != null ? number.format(props.households) : '—'}</td></tr>
           <tr><th>GEOID</th><td>${props.GEOID}</td></tr>
         </table>`
      : `<div class="income-figure">
           <span class="caption">Ingreso mediano por hogar</span>
           <span class="value" style="color:var(--on-surface-variant,#424845);font-size:24px;">Sin datos</span>
         </div>
         <span class="no-data-badge">Dato suprimido o sector no residencial</span>
         <table><tr><th>GEOID</th><td>${props.GEOID}</td></tr></table>`;

    infoContent.innerHTML = `
      <div class="income-data">
        <h3>${props.NAMELSAD}</h3>
        <p class="tract-municipio">${props.municipio} Municipio, Puerto Rico</p>
        ${incomeBlock}
        <p class="body-sm source-line">Fuente: U.S. Census Bureau, ACS 5 años ${incomeData.acsPeriod}, Tabla B19013</p>
      </div>`;
  }

  map.on('click', 'tracts-fill', (e) => {
    if (e.defaultPrevented || !e.features.length) return;
    renderTract(e.features[0].properties);
  });

  // --- Header collapse/expand -------------------------------------------------
  const mainHeader = document.getElementById('main-header');
  const collapseBtn = document.getElementById('collapse-btn');
  const expandBtn = document.getElementById('expand-btn');
  function collapseMenu() { mainHeader.classList.add('collapsed'); expandBtn.classList.remove('hidden'); }
  function expandMenu() { mainHeader.classList.remove('collapsed'); expandBtn.classList.add('hidden'); }
  if (collapseBtn) collapseBtn.addEventListener('click', collapseMenu);
  if (expandBtn) expandBtn.addEventListener('click', expandMenu);

  map.on('click', 'municipios-mask', (e) => {
    if (map.getPaintProperty('municipios-mask', 'fill-opacity') > 0) {
      e.preventDefault();
      const select = document.getElementById('municipio-select');
      if (select) { select.value = ''; select.dispatchEvent(new Event('change')); }
    }
  });
  map.on('mouseenter', 'municipios-mask', () => {
    if (map.getPaintProperty('municipios-mask', 'fill-opacity') > 0) map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'municipios-mask', () => { map.getCanvas().style.cursor = ''; });

  // --- Municipio dropdown -------------------------------------------------
  const select = document.getElementById('municipio-select');
  const clearBtn = document.getElementById('clear-municipio-btn');
  const municipioSummary = document.createElement('p');
  municipioSummary.className = 'body-sm';
  municipioSummary.style.marginTop = '8px';
  select?.insertAdjacentElement('afterend', municipioSummary);

  const names = municipiosGeojson.features
    .map((f) => f.properties.municipio)
    .sort((a, b) => a.localeCompare(b, 'es'));
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select?.appendChild(opt);
  });

  function boundsOfFeature(feature) {
    let coords = [];
    if (feature.geometry.type === 'MultiPolygon') coords = feature.geometry.coordinates.flat(2);
    else if (feature.geometry.type === 'Polygon') coords = feature.geometry.coordinates.flat(1);
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    coords.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  select?.addEventListener('change', (e) => {
    const selected = e.target.value;
    if (!selected) {
      map.setPaintProperty('municipios-mask', 'fill-opacity', 0);
      map.setPaintProperty('municipios-stroke', 'line-opacity', 0);
      map.flyTo({ center: [-66.45, 18.2], zoom: 8.3 });
      if (clearBtn) clearBtn.style.display = 'none';
      municipioSummary.textContent = '';
      return;
    }

    if (clearBtn) clearBtn.style.display = 'block';
    map.setFilter('municipios-mask', ['!=', 'municipio', selected]);
    map.setPaintProperty('municipios-mask', 'fill-opacity', 0.8);
    map.setFilter('municipios-stroke', ['==', 'municipio', selected]);
    map.setPaintProperty('municipios-stroke', 'line-opacity', 1);

    const feature = municipiosGeojson.features.find((f) => f.properties.municipio === selected);
    if (feature) map.fitBounds(boundsOfFeature(feature), { padding: 60 });

    const countyfp = feature?.properties.countyfp;
    const tractIncomes = tractsGeojson.features
      .filter((f) => f.properties.COUNTYFP === countyfp && typeof f.properties.median_income === 'number')
      .map((f) => f.properties.median_income);
    if (tractIncomes.length) {
      const avg = tractIncomes.reduce((a, b) => a + b, 0) / tractIncomes.length;
      municipioSummary.textContent = `Ingreso mediano promedio: ${currency.format(avg)} (${tractIncomes.length} sectores)`;
    } else {
      municipioSummary.textContent = 'Sin datos suficientes para este municipio.';
    }
  });

  clearBtn?.addEventListener('click', () => {
    if (select) { select.value = ''; select.dispatchEvent(new Event('change')); }
  });

  // --- "Ver Mi Sector Censal" (GPS) ------------------------------------------
  const locateBtn = document.getElementById('locate-btn');
  locateBtn?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('Tu navegador no soporta geolocalización.');
      return;
    }
    locateBtn.disabled = true;
    locateBtn.textContent = 'Buscando...';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = [position.coords.longitude, position.coords.latitude];
        map.flyTo({ center: coords, zoom: 13, speed: 1.2 });
        map.once('moveend', () => {
          const point = map.project(coords);
          const features = map.queryRenderedFeatures(point, { layers: ['tracts-fill'] });
          locateBtn.disabled = false;
          locateBtn.textContent = 'Ver Mi Sector Censal';
          if (features.length) {
            renderTract(features[0].properties);
          } else {
            alert('No encontramos un sector censal en tu ubicación (¿estás fuera de Puerto Rico?).');
          }
        });
      },
      () => {
        alert('No pudimos obtener tu ubicación. Verifica los permisos de localización del navegador.');
        locateBtn.disabled = false;
        locateBtn.textContent = 'Ver Mi Sector Censal';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  hideLoadingOverlay();
}
