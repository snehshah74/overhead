import Globe from 'https://cdn.jsdelivr.net/npm/globe.gl@2.46.2/+esm';
import { sat, R, RAD, where, dist, elev } from './orbit.js';

const DAYS = 7;
const GROUPS = ['resource', 'weather', 'planet'];
const CATS = {
  photo: { t: 'Photographed', d: 'A real image of this spot is in a public archive. See it above.', c: '#7cf2c8' },
  likely: { t: 'Likely imaged', d: 'A camera that always looks straight down swept over this spot. Its pictures are not published here.', c: '#6aa8ff' },
  could: { t: 'Could have looked', d: 'A camera that can be pointed was in range. Its operator does not say whether it did.', c: '#c9a6ff' },
  over: { t: 'Passed high overhead', d: 'Climbed above 30° in your sky, but its camera was not aimed at you.', c: '#8a93a6' },
};
// Fixed cameras that always image a strip below them: name pattern → strip width in km.
const SWATH = [[/^SENTINEL-2/, 290], [/^LANDSAT/, 185], [/^(TERRA|AQUA)$/, 2330], [/^(SUOMI NPP|NOAA 2[01])/, 3000], [/^SENTINEL-3/, 1270], [/^(METOP|NOAA 1[589])/, 2900], [/^FENGYUN 3/, 2800]];
const OPERATOR = [[/^SENTINEL/, 'ESA · Copernicus'], [/^LANDSAT/, 'NASA · USGS'], [/^(TERRA|AQUA)/, 'NASA'], [/^SUOMI/, 'NASA · NOAA'], [/^(NOAA|GOES)/, 'NOAA'], [/^(METOP|METEOSAT)/, 'EUMETSAT'], [/^(FENGYUN|FY)/, 'CMA'], [/^GAOFEN/, 'CNSA'], [/^(FLOCK|SKYSAT|PLANET)/, 'Planet'], [/^WORLDVIEW|^GEOEYE/, 'Maxar'], [/^(CARTOSAT|RESOURCESAT|OCEANSAT|RISAT|EOS)/, 'ISRO'], [/^JILIN/, 'Chang Guang'], [/^HIMAWARI/, 'JMA'], [/^ELEKTRO|^METEOR|^KANOPUS|^RESURS/, 'Roscosmos'], [/^KOMPSAT/, 'KARI'], [/^ICEYE/, 'ICEYE'], [/^CAPELLA/, 'Capella Space'], [/^(SPOT|PLEIADES)/, 'Airbus'], [/^ALOS|^GCOM/, 'JAXA'], [/^CBERS/, 'INPE · CAST'], [/^(TERRASAR|TANDEM)/, 'DLR']];
// Public, well-known polar ground stations (approximate). Assumption for the edge lab, not any operator's real schedule.
const STATIONS = [['Svalbard', 78.23, 15.40], ['Kiruna', 67.88, 21.06], ['Inuvik', 68.32, -133.55], ['Fairbanks', 64.86, -147.85], ['Troll, Antarctica', -72.01, 2.53], ['Punta Arenas', -52.94, -70.85], ['Matera', 40.65, 16.70], ['Maspalomas', 27.76, -15.63], ['Wallops', 37.94, -75.46], ['Hartebeesthoek', -25.89, 27.69], ['Alice Springs', -23.76, 133.88]].map(([n, lat, lng]) => ({ n, lat, lng }));
const RAW_MB = 800, X_BAND_MBPS = 520, LOW_KBPS = 9.6; // typical Sentinel-2 L1C tile size; its published X-band rate; a small UHF-class link
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const ago = (ms) => { const h = (Date.now() - ms) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; };
const day = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const operator = (n) => OPERATOR.find(([r]) => r.test(n))?.[1] ?? '';

// ---------- globe ----------
const globe = new Globe($('globe'))
  .globeImageUrl('img/earth.jpg') // NASA Blue Marble, resized to 2048 px (446 KB instead of 1.4 MB)
  .backgroundColor('rgba(0,0,0,0)') // stars are CSS, see style.css
  .atmosphereColor('#7cf2c8').atmosphereAltitude(0.18)
  .particleLat('lat').particleLng('lng').particleAltitude('alt').particlesSize(1.6).particlesColor(() => 'rgba(238,241,246,.75)')
  .ringColor(() => (t) => `rgba(124,242,200,${1 - t})`).ringMaxRadius(4).ringPropagationSpeed(2).ringRepeatPeriod(1400)
  .pointColor('c').pointAltitude('alt').pointRadius('r').pointsMerge(false)
  .arcStartLat((d) => d.a.lat).arcStartLng((d) => d.a.lng).arcEndLat((d) => d.b.lat).arcEndLng((d) => d.b.lng).arcColor('c').arcStroke(0.6).arcDashLength(0.4).arcDashGap(0.15).arcDashAnimateTime(1500).arcAltitudeAutoScale(0.3)
  .pathPointLat((p) => p[0]).pathPointLng((p) => p[1]).pathPointAlt((p) => p[2]).pathColor(() => ['rgba(124,242,200,.1)', '#7cf2c8', 'rgba(124,242,200,.1)']).pathStroke(2).pathTransitionDuration(0)
  .onGlobeClick(({ lat, lng }) => go(lat, lng, `${lat.toFixed(3)}°, ${lng.toFixed(3)}°`));
globe.controls().autoRotate = true; globe.controls().autoRotateSpeed = 0.35;
globe.pointOfView({ lat: 20, lng: 10, altitude: 2.6 });
new ResizeObserver(() => globe.width(innerWidth).height(innerHeight)).observe(document.body);

// ---------- orbits ----------
const load = async (g) => {
  const local = await fetch(`data/${g}.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  return local.includes('\n1 ') ? local : fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`).then((r) => r.text());
};
const sats = Promise.all(GROUPS.map(load)).then((texts) => {
  const seen = new Map();
  texts.forEach((text, gi) => {
    const L = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    for (let i = 0; i + 2 < L.length; i += 3) {
      if (!L[i + 1].startsWith('1 ') || seen.has(L[i + 1].slice(2, 7))) continue;
      const rec = sat.twoline2satrec(L[i + 1], L[i + 2]), name = L[i].trim();
      seen.set(L[i + 1].slice(2, 7), { key: L[i + 1].slice(2, 7), l1: L[i + 1], l2: L[i + 2], name, rec, group: GROUPS[gi], geo: rec.no * 1440 / (2 * Math.PI) < 1.5, swath: SWATH.find(([r]) => r.test(name))?.[1] });
    }
  });
  return [...seen.values()];
});

// Live swarm: every satellite where it is right now.
async function swarm() {
  const now = Date.now();
  globe.particlesData([(await sats).map((s) => where(s.rec, now)).filter(Boolean).map((p) => ({ lat: p.lat, lng: p.lng, alt: Math.min(p.h / R, 0.9) }))]);
}
sats.then((s) => { $('stats').textContent = `${s.length} Earth-watching satellites · orbits from CelesTrak`; swarm(); setInterval(swarm, 2000); });
setInterval(() => ($('clock').textContent = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'), 1000);

// Every pass in the window, split across one worker per CPU core (started now, so they are warm by the first search).
const pool = Array.from({ length: Math.min(navigator.hardwareConcurrency || 4, 8) }, () => new Worker('worker.js', { type: 'module' }));
let runs = 0;
async function passes(list, here, progress) {
  const end = Date.now(), start = end - DAYS * 864e5, leo = list.filter((s) => !s.geo), byKey = new Map(leo.map((s) => [s.key, s])), run = ++runs;
  let done = 0;
  const parts = await Promise.all(pool.map((w, i) => new Promise((ok) => {
    w.onmessage = (e) => { if (e.data.run !== run) return; progress(++done, pool.length); ok(e.data.out); }; // ignore a slower, older search
    // Plain numbers only: the globe attaches 3D objects to `here`, which cannot be sent to a worker.
    w.postMessage({ run, tles: leo.filter((_, j) => j % pool.length === i).map((s) => [s.key, s.l1, s.l2, s.group, s.swath]), here: { lat: here.lat, lng: here.lng }, start, end });
  })));
  return parts.flat().map((p) => ({ ...p, s: byKey.get(p.key) })).sort((a, b) => b.at - a.at);
}

// Geostationary weather satellites that see this spot all the time.
const watchers = (list, here) => list.filter((s) => s.geo).map((s) => ({ s, p: where(s.rec, Date.now()) })).filter((x) => x.p && elev(x.p, here) > 5).map((x) => ({ ...x, e: elev(x.p, here) }));

async function photos(here) {
  const body = { collections: ['sentinel-2-l2a'], intersects: { type: 'Point', coordinates: [here.lng, here.lat] }, datetime: `${new Date(Date.now() - DAYS * 864e5).toISOString()}/${new Date().toISOString()}`, limit: 20 };
  const r = await fetch('https://earth-search.aws.element84.com/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  return r?.ok ? (await r.json()).features.map((f) => ({ t: Date.parse(f.properties.datetime), plat: f.properties.platform.toUpperCase(), cloud: Math.round(f.properties['eo:cloud_cover']), src: f.assets.thumbnail.href })) : [];
}

// ---------- edge lab: pixels vs. answers ----------
// First moment after `from` that the satellite is 5°+ above a ground station's horizon.
function contact(rec, from, limit = 6 * 36e5) {
  for (let t = from; t < from + limit; t += 3e4) {
    const p = where(rec, t);
    const st = p && STATIONS.find((s) => elev(p, s) >= 5);
    if (st) return { st, t, p };
  }
  return null;
}
// Could the answer hop through another satellite that is talking to a ground station sooner?
async function relay(self, from, until, list) {
  for (let t = from; t < until; t += 6e4) {
    const me = where(self.rec, t);
    if (!me) continue;
    for (const o of list) {
      if (o === self || o.geo) continue;
      const p = where(o.rec, t);
      if (!p || Math.hypot(p.eci.x - me.eci.x, p.eci.y - me.eci.y, p.eci.z - me.eci.z) > 3000) continue;
      const st = STATIONS.find((s) => elev(p, s) >= 5);
      if (st) return { via: o, st, t, me, p };
    }
    await new Promise((r) => setTimeout(r));
  }
  return null;
}
// A few pixel rules on the real photo: the kind of tiny filter that fits on a satellite computer. Rules, not a trained model.
async function photoPixels(img) {
  const im = new Image(); im.crossOrigin = 'anonymous'; im.src = `${img.src}?pixels`; await im.decode(); // ?pixels: separate cache entry from the plain <img> copy
  return im;
}
async function analyse(im) {
  const c = document.createElement('canvas'); c.width = c.height = 200;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0, 200, 200);
  const px = g.getImageData(0, 0, 200, 200).data, n = { cloud: 0, water: 0, vegetation: 0, land: 0 };
  let seen = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [r, gr, b] = [px[i], px[i + 1], px[i + 2]], hi = Math.max(r, gr, b), lo = Math.min(r, gr, b);
    if (hi < 10) continue; // outside the satellite's strip
    seen++;
    n[hi > 185 && hi - lo < 40 ? 'cloud' : b >= r && b >= gr - 6 && hi < 110 ? 'water' : gr > r && gr >= b ? 'vegetation' : 'land']++;
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Math.round((v / Math.max(seen, 1)) * 100)]));
}

// A real vision model, run on this device the way a model would run on the satellite's computer.
// CLIP is a general image model (not trained on satellite photos): it picks the best caption for each tile.
// Short labels tested best on real tiles; "forest" and "clouds" pulled too many tiles, so cloud cover comes from the pixel rules.
const LABELS = { water: 'water', desert: 'desert', city: 'a city', farmland: 'farmland' };
const LABEL_C = { water: '#3b8bd4', desert: '#e0b36a', city: '#e2564a', farmland: '#9bd35a' };
const GRID = 6;
// On a GPU with 16-bit support (WebGPU): ~4× faster than CPU and as accurate as the 8-bit CPU model in our tests.
let model;
const loadModel = () => (model ??= (async () => {
  const gpu = (await navigator.gpu?.requestAdapter())?.features.has('shader-f16');
  const spec = gpu ? { device: 'webgpu', dtype: 'fp16', name: 'CLIP ViT-B/32, 16-bit, GPU', mb: 303 } : { device: 'wasm', dtype: 'q8', name: 'CLIP ViT-B/32, 8-bit, CPU', mb: 154 };
  const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm');
  return { ...spec, clip: await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', { device: spec.device, dtype: spec.dtype }) };
})());
async function aiRead(im, say) {
  const t0 = performance.now();
  say('Loading the vision model (first time only, then cached)…');
  const m = await loadModel();
  const load = performance.now() - t0, tiles = [], urls = [], c = document.createElement('canvas'), g = c.getContext('2d'), s = im.naturalWidth / GRID;
  c.width = c.height = 224;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    g.drawImage(im, x * s, y * s, s, s, 0, 0, 224, 224);
    const px = g.getImageData(0, 0, 224, 224).data;
    let dark = 0; for (let i = 0; i < px.length; i += 16) dark += px[i] + px[i + 1] + px[i + 2] < 30;
    if (dark > px.length / 32) continue; // mostly outside the satellite's strip
    tiles.push({ x, y }); urls.push(c.toDataURL('image/jpeg', 0.9));
  }
  say(`Model reading ${tiles.length} tiles at once…`);
  const t1 = performance.now(), out = urls.length ? await m.clip(urls, Object.values(LABELS).map((v) => `a satellite image of ${v}`)) : [];
  out.forEach(([top], i) => Object.assign(tiles[i], { label: Object.keys(LABELS).find((k) => top.label.endsWith(LABELS[k])), score: top.score }));
  const run = performance.now() - t1, pct = Object.fromEntries(Object.keys(LABELS).map((k) => [k, Math.round((tiles.filter((t) => t.label === k).length / Math.max(tiles.length, 1)) * 100)]));
  return { tiles, pct, load, msPerTile: run / Math.max(tiles.length, 1), name: m.name, mb: m.mb };
}
function aiMap(im, ai) {
  const c = $('aimap'), g = c.getContext('2d'), w = (c.width = c.height = 320) / GRID;
  g.drawImage(im, 0, 0, 320, 320);
  for (const t of ai.tiles) { g.globalAlpha = 0.38; g.fillStyle = LABEL_C[t.label]; g.fillRect(t.x * w, t.y * w, w, w); g.globalAlpha = 1; g.strokeStyle = 'rgba(0,0,0,.35)'; g.strokeRect(t.x * w, t.y * w, w, w); }
}

async function edgeLab(p) {
  const box = $('lab');
  box.innerHTML = '<p class="big">Following the data down…</p>';
  const list = await sats, raw = contact(p.s.rec, p.at);
  const hop = raw && (await relay(p.s, p.at, raw.t, list));
  const im = await photoPixels(p.img).catch(() => null), mix = im && (await analyse(im));
  const ai = im && (await aiRead(im, (t) => (box.innerHTML = `<p class="big">${t}</p>`)).catch((e) => (console.error(e), null)));
  const answer = JSON.stringify({ place: [+state.here.lat.toFixed(3), +state.here.lng.toFixed(3)], seen: new Date(p.at).toISOString().slice(0, 16), by: p.s.name, ...(mix ? { cloud: mix.cloud } : {}), ...(ai ? { ground: ai.pct } : mix ? { pct: mix } : {}) });
  const bytes = new Blob([answer]).size, ansT = hop ? hop.t : raw?.t;
  const mins = (t) => (t ? `${Math.max(1, Math.round((t - p.at) / 6e4))} min` : 'over 6 h');
  globe.arcsData([raw && { a: raw.p, b: raw.st, c: '#6aa8ff' }, hop && { a: hop.me, b: hop.p, c: '#7cf2c8' }, hop && { a: hop.p, b: hop.st, c: '#7cf2c8' }].filter(Boolean));
  box.innerHTML = `
    <div class="duel">
      <div><p class="mono">Send the pixels</p><b class="num">${RAW_MB} MB</b><p>One full tile, all 13 bands. It waits for a big dish: <b>${raw ? esc(raw.st.n) : 'none in 6 h'}</b>, ${mins(raw?.t)} after capture, then ~${Math.round((RAW_MB * 8) / X_BAND_MBPS)} s at ${X_BAND_MBPS} Mbit/s, behind everything else queued.</p></div>
      <div><p class="mono">Send the answer</p><b class="num">${bytes.toLocaleString()} B</b><p>${hop ? `Hops to <b>${esc(hop.via.name)}</b>, which is already talking to <b>${esc(hop.st.n)}</b>: down ${mins(hop.t)} after capture.` : `Rides the same first contact, ${mins(raw?.t)} after capture.`} Even a slow ${LOW_KBPS} kbit/s link moves it in ${((bytes * 8) / (LOW_KBPS * 1000)).toFixed(1)} s.</p></div>
    </div>
    ${ai ? `<p class="mono">What the model saw</p><canvas id="aimap"></canvas>
    <div class="legend mono">${Object.keys(LABELS).map((k) => `<span><i style="background:${LABEL_C[k]}"></i>${k} ${ai.pct[k]}%</span>`).join('')}</div>
    <div class="edge mono"><span>Model<b>${ai.name}</b></span><span>Size<b>${ai.mb} MB</b></span><span>Load<b>${(ai.load / 1000).toFixed(1)} s</b></span><span>Per tile<b>${Math.round(ai.msPerTile)} ms</b></span><span>Tiles<b>${ai.tiles.length}</b></span></div>
    <p class="d">The model labels the ground in each tile; cloud cover (${mix?.cloud ?? '?'}%) comes from the pixel rules, which catch bright cloud better. CLIP is a general image model, not trained on satellite photos, so expect some wrong tiles.</p>` : '<p class="d">The vision model could not run in this browser, so the answer uses the colour rules only.</p>'}
    <p class="mono">The answer, as it would be sent</p><pre>${esc(JSON.stringify(JSON.parse(answer), null, 1))}</pre>
    <p class="note">${Math.round((RAW_MB * 1e6) / bytes).toLocaleString()}× smaller${ansT && raw && ansT < raw.t ? `, and ${Math.round((raw.t - ansT) / 6e4)} min sooner` : ''}. Times come from real orbits over ${STATIONS.length} public ground stations. The tile size, link rates and station list are stated assumptions; the satellite-to-satellite hop is hypothetical, since these satellites don't relay for each other today. The model runs on this device on the downloaded preview, standing in for software running on the satellite's own computer.</p>`;
  if (ai) aiMap(im, ai);
}

// ---------- sun, for the timeline's daylight bands ----------
function sunUp(here, ms) {
  const d = ms / 864e5 - 10957.5, g = (357.529 + 0.98560028 * d) * RAD, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, e = 23.439 * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L)), ha = sat.gstime(new Date(ms)) + here.lng * RAD - ra;
  return Math.sin(here.lat * RAD) * Math.sin(dec) + Math.cos(here.lat * RAD) * Math.cos(dec) * Math.cos(ha) > 0;
}

// ---------- story ----------
let state = null;
async function go(lat, lng, name) {
  const here = { lat, lng };
  history.replaceState(null, '', `?q=${lat.toFixed(4)},${lng.toFixed(4)}&n=${encodeURIComponent(name)}`);
  globe.controls().autoRotate = false;
  globe.pointOfView({ lat, lng, altitude: 1.4 }, 1600).ringsData([here]).pathsData([]).pointsData([{ lat, lng, c: '#7cf2c8', alt: 0.005, r: 0.35 }]);
  $('intro').classList.add('gone'); document.body.className = 'results';
  $('panel').hidden = false;
  $('story').innerHTML = `<p class="mono">${lat.toFixed(4)}°, ${lng.toFixed(4)}°</p><div class="place">${esc(name)}</div><p class="big">Tracing a week of orbits…</p>`;
  const [list, imgs] = await Promise.all([sats, photos(here)]);
  const ps = await passes(list, here, (i, n) => ($('story').querySelector('.big').textContent = `Tracing a week of orbits on ${n} cores… ${i} done`));
  for (const img of imgs) { // tie each archive photo to the pass that took it
    const p = ps.find((x) => x.s.name.startsWith(img.plat) && Math.abs(x.at - img.t) < 15 * 6e4);
    if (p) Object.assign(p, { cat: 'photo', img }); else img.orphan = true;
  }
  state = { here, name, ps, imgs: imgs.sort((a, b) => a.cloud - b.cloud), geo: watchers(list, here), filter: null };
  render();
}

function render() {
  const { here, name, ps, imgs, geo, filter } = state;
  const count = (c) => ps.filter((p) => p.cat === c).length;
  const sats = Object.values(ps.reduce((m, p) => { (m[p.s.name] ??= { s: p.s, ps: [] }).ps.push(p); return m; }, {}))
    .map((g) => ({ ...g, cat: ['photo', 'likely', 'could', 'over'].find((c) => g.ps.some((p) => p.cat === c)), close: Math.min(...g.ps.map((p) => p.d)) }))
    .filter((g) => !filter || g.ps.some((p) => p.cat === filter))
    .sort((a, b) => 'plco'.indexOf(a.cat[0]) - 'plco'.indexOf(b.cat[0]) || b.ps.length - a.ps.length);
  const best = imgs[0];
  $('story').innerHTML = `
    <p class="mono">${here.lat.toFixed(4)}°, ${here.lng.toFixed(4)}°</p>
    <div class="place">${esc(name)}</div>
    <p class="big">In the last 7 days, <b>${new Set(ps.map((p) => p.s.name)).size}</b> satellites came over ${esc(name)}.</p>
    <p class="mono">${ps.length} passes · ${imgs.length} public photo${imgs.length === 1 ? '' : 's'} · ${geo.length} watching nonstop</p>
    ${best ? `<h3 class="mono"><span>The clearest look</span><span>${imgs.length} photos</span></h3>
      <figure class="hero" style="margin:0"><img id="heroimg" src="${esc(best.src)}" alt="Sentinel-2 photo of ${esc(name)}">
        <figcaption><b id="herocap">${esc(best.plat)} · ${day(best.t)}</b><span class="mono" id="herosub">${best.cloud}% cloud · 10 m per pixel · ${ago(best.t)} · hover to zoom</span></figcaption></figure>
      <div class="strip">${imgs.map((m, i) => `<img src="${esc(m.src)}" data-i="${i}" class="${i ? '' : 'on'}" alt="">`).join('')}</div>
      ${ps.some((p) => p.img) ? `<h3 class="mono"><span>Edge lab: pixels vs. answers</span><span>real orbits</span></h3>
      <p class="d">What if the satellite worked out the answer onboard instead of sending the whole picture down? Pick a photo above, then:</p>
      <button class="run mono" id="runlab">Follow this photo to the ground →</button><div id="lab"></div>` : ''}`
      : '<h3 class="mono">No public photo this week</h3><p class="note">Sentinel-2 revisits every few days; clouds or timing can leave a week empty.</p>'}
    <h3 class="mono"><span>What each pass means</span><span>tap to filter</span></h3>
    <div class="cats">${Object.entries(CATS).map(([k, c]) => `<button class="cat ${filter === k ? 'on' : ''}" data-cat="${k}"><span class="n" style="color:${c.c}">${count(k)}</span><span class="t">${c.t}</span><span class="d">${c.d}</span></button>`).join('')}</div>
    <h3 class="mono"><span>The week, hour by hour</span><span>shaded = daylight here</span></h3>
    <canvas id="tl"></canvas>
    <div class="legend mono">${Object.entries(CATS).map(([, c]) => `<span><i style="background:${c.c}"></i>${c.t}</span>`).join('')}</div>
    <h3 class="mono"><span>${filter ? CATS[filter].t : 'Every satellite'}</span><span>${sats.length}</span></h3>
    <ul class="sats">${sats.slice(0, 12).map(satRow).join('')}</ul>
    ${sats.length > 12 ? `<button class="more mono" id="more">Show all ${sats.length}</button>` : ''}
    ${geo.length ? `<h3 class="mono"><span>Watching nonstop</span><span>${geo.length}</span></h3><ul class="sats">${geo.map((g) => `<li><span class="dot" style="background:#f2b33d"></span><span><span class="nm">${esc(g.s.name)}</span><br><span class="meta">${esc(operator(g.s.name))} · parked ${Math.abs(g.p.lng).toFixed(1)}°${g.p.lng < 0 ? 'W' : 'E'} · ${Math.round(g.e)}° up in your sky</span></span><span class="cnt">∞<small>always</small></span></li>`).join('')}</ul>` : ''}
    <p class="note">A pass is the moment a satellite came closest to this spot, computed in your browser from public orbital elements; older passes are approximate. "Off to the side" is the angle from straight down. Photos are Copernicus Sentinel-2 previews of the whole 110 km tile.</p>`;
  bind(sats);
  timeline();
}

function satRow(g) {
  const last = g.ps[0];
  return `<li data-n="${esc(g.s.name)}"><span class="dot" style="background:${CATS[g.cat].c}"></span>
    <span><span class="nm">${esc(g.s.name)}</span><br><span class="meta">${esc(operator(g.s.name) || g.s.group)} · last ${ago(last.at)} · closest ${Math.round(g.close)} km off</span></span>
    <span class="cnt">${g.ps.length}<small>passes</small></span></li>`;
}

function bind(sats) {
  const st = $('story');
  st.querySelectorAll('.cat').forEach((b) => (b.onclick = () => { state.filter = state.filter === b.dataset.cat ? null : b.dataset.cat; render(); }));
  st.querySelectorAll('.strip img').forEach((im) => (im.onclick = () => {
    const m = state.imgs[im.dataset.i];
    $('heroimg').src = m.src; $('herocap').textContent = `${m.plat} · ${day(m.t)}`; $('herosub').textContent = `${m.cloud}% cloud · 10 m per pixel · ${ago(m.t)} · hover to zoom`;
    st.querySelectorAll('.strip img').forEach((x) => x.classList.toggle('on', x === im));
    const p = state.ps.find((x) => x.img === m); if (p) replay(p);
  }));
  st.querySelectorAll('.sats li[data-n]').forEach((li) => (li.onclick = () => replay(state.ps.filter((p) => p.s.name === li.dataset.n).sort((a, b) => 'plco'.indexOf(a.cat[0]) - 'plco'.indexOf(b.cat[0]) || a.d - b.d)[0])));
  if ($('runlab')) new IntersectionObserver((e, o) => { if (e[0].isIntersecting) { o.disconnect(); loadModel(); } }).observe($('runlab')); // warm the model while they read
  $('runlab')?.addEventListener('click', () => { const sel = state.imgs[st.querySelector('.strip img.on').dataset.i], p = state.ps.find((x) => x.img === sel) ?? state.ps.find((x) => x.img); replay(p); edgeLab(p); });
  $('more')?.addEventListener('click', (e) => { e.target.remove(); st.querySelector('.sats').innerHTML = sats.map(satRow).join(''); bind(sats); });
}

// Fly the satellite over the spot again: its track ±8 min, a moving marker, and a line down to the ground.
let anim = 0;
function replay(p) {
  cancelAnimationFrame(anim);
  document.querySelectorAll('.sats li').forEach((li) => li.classList.toggle('on', li.dataset.n === p.s.name));
  const track = [];
  for (let t = p.at - 48e4; t <= p.at + 48e4; t += 1e4) { const w = where(p.s.rec, t); if (w) track.push([w.lat, w.lng, w.h / R]); }
  globe.pathsData([track]).pointOfView({ lat: state.here.lat, lng: state.here.lng, altitude: 1.1 }, 900);
  const c = CATS[p.cat].c, t0 = performance.now(), base = { lat: state.here.lat, lng: state.here.lng, c: '#7cf2c8', alt: 0.005, r: 0.35 };
  const step = (now) => {
    const k = ((now - t0) % 6000) / 6000, w = where(p.s.rec, p.at - 48e4 + k * 96e4);
    if (w) globe.pointsData([base, { lat: w.lat, lng: w.lng, alt: w.h / R, c, r: 0.6 }]);
    anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
  tip(`${p.s.name} · ${day(p.at)} · ${Math.round(p.offNadir)}° off to the side · ${Math.round(p.d)} km away · ${CATS[p.cat].t}`);
}

function tip(text, x, y) {
  const el = $('tip');
  el.textContent = text; el.hidden = !text;
  Object.assign(el.style, x == null ? { left: '24px', top: 'auto', bottom: '44px' } : { left: `${x + 12}px`, top: `${y + 12}px`, bottom: 'auto' });
}

function timeline() {
  const cv = $('tl'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const end = Date.now(), start = end - DAYS * 864e5, x = (t) => ((t - start) / (end - start)) * W, rows = Object.keys(CATS), rowY = (c) => 16 + rows.indexOf(c) * 24;
  g.fillStyle = 'rgba(242,179,61,.07)';
  for (let t = start; t < end; t += 9e5) if (sunUp(state.here, t)) g.fillRect(x(t), 0, x(t + 9e5) - x(t) + 0.5, H - 18);
  g.fillStyle = '#8a93a6'; g.font = '10px IBM Plex Mono';
  for (let d = new Date(start).setHours(24, 0, 0, 0); d < end; d += 864e5) { g.fillRect(x(d), 0, 1, H - 18); g.fillText(new Date(d).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(), x(d) + 3, H - 4); }
  const dots = state.ps.filter((p) => !state.filter || p.cat === state.filter).map((p) => ({ p, X: x(p.at), Y: rowY(p.cat) }));
  for (const d of dots) { g.fillStyle = CATS[d.p.cat].c; g.globalAlpha = d.p.cat === 'photo' ? 1 : 0.55; g.beginPath(); g.arc(d.X, d.Y, d.p.cat === 'photo' ? 4 : 2, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  const near = (e) => { const r = cv.getBoundingClientRect(); return dots.reduce((b, d) => { const k = Math.hypot(d.X - (e.clientX - r.left), d.Y - (e.clientY - r.top)); return k < (b?.k ?? 10) ? { ...d, k } : b; }, null); };
  cv.onmousemove = (e) => { const d = near(e); tip(d ? `${d.p.s.name} · ${day(d.p.at)} · ${CATS[d.p.cat].t}` : '', e.clientX, e.clientY); };
  cv.onmouseleave = () => tip('');
  cv.onclick = (e) => { const d = near(e); if (d) replay(d.p); };
}

// ---------- intro controls ----------
// Place suggestions as you type: Photon (Komoot, OpenStreetMap data), free and built for autocomplete.
let hits = [], pick = -1, typing;
const showSugg = () => {
  $('sugg').innerHTML = hits.map((h, i) => `<li role="option" data-i="${i}" class="${i === pick ? 'on' : ''}"><b>${esc(h.name)}</b><span>${esc(h.where)}</span></li>`).join('');
  $('sugg').hidden = !hits.length; $('q').setAttribute('aria-expanded', String(hits.length > 0));
};
const choose = (h) => { hits = []; showSugg(); $('q').value = h.name; go(h.lat, h.lng, h.name); };
$('q').oninput = () => {
  clearTimeout(typing);
  const q = $('q').value.trim();
  if (q.length < 2) { hits = []; return showSugg(); }
  typing = setTimeout(async () => {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`).then((x) => x.json()).catch(() => ({ features: [] }));
    if ($('q').value.trim() !== q) return; // a newer keystroke won
    hits = r.features.map((f) => ({ name: f.properties.name ?? q, where: [f.properties.city, f.properties.state, f.properties.country].filter((v) => v && v !== f.properties.name).join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
      .filter((h, i, all) => all.findIndex((o) => o.name === h.name && o.where === h.where) === i);
    pick = -1; showSugg();
  }, 220);
};
$('q').onkeydown = (e) => {
  if (!hits.length || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Escape') { hits = []; return showSugg(); }
  pick = (pick + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length; showSugg();
};
$('sugg').onmousedown = (e) => { const li = e.target.closest('li'); if (li) choose(hits[li.dataset.i]); };
$('search').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  if (hits.length) return choose(hits[Math.max(pick, 0)]);
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lang=en`).then((x) => x.json()).catch(() => ({ features: [] }));
  const f = r.features[0];
  f ? go(f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.name ?? q) : ($('q').value = '', $('q').placeholder = 'Not found. Try another place');
};
document.querySelectorAll('[data-ll]').forEach((b) => (b.onclick = () => { const [la, ln] = b.dataset.ll.split(',').map(Number); go(la, ln, b.dataset.n); }));
$('me').onclick = () => navigator.geolocation.getCurrentPosition((p) => go(p.coords.latitude, p.coords.longitude, 'Near you'));
$('back').onclick = () => { cancelAnimationFrame(anim); document.body.className = ''; tip(''); $('panel').hidden = true; $('intro').classList.remove('gone'); globe.pathsData([]).pointsData([]).ringsData([]).arcsData([]); globe.controls().autoRotate = true; history.replaceState(null, '', location.pathname); };
const q = new URLSearchParams(location.search);
if (q.get('q')) { const [la, ln] = q.get('q').split(',').map(Number); go(la, ln, q.get('n') || q.get('q')); }
