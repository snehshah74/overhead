// Orbit math shared by the page and the pass-finding workers.
import * as sat from 'https://cdn.jsdelivr.net/npm/satellite.js@7.1.0/+esm';
export { sat };
export const R = 6371, RAD = Math.PI / 180;

export function where(rec, ms) {
  const t = new Date(ms), pv = sat.propagate(rec, t);
  if (!pv?.position) return null;
  const g = sat.eciToGeodetic(pv.position, sat.gstime(t));
  return { lat: g.latitude / RAD, lng: g.longitude / RAD, h: g.height, eci: pv.position, t };
}
export const dist = (a, b) => { const s = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lng - a.lng) * RAD / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
export const elev = (p, here) => sat.ecfToLookAngles({ latitude: here.lat * RAD, longitude: here.lng * RAD, height: 0 }, sat.eciToEcf(p.eci, sat.gstime(p.t))).elevation / RAD;

// Every pass of one satellite: a cheap 2-minute scan finds each closest approach, then a precise 5-second refine.
const STEP = 12e4;
export function passesOf(s, here, start, end) {
  const ux = Math.cos(here.lat * RAD) * Math.cos(here.lng * RAD), uy = Math.cos(here.lat * RAD) * Math.sin(here.lng * RAD), uz = Math.sin(here.lat * RAD), out = [];
  let prev = Infinity, falling = false;
  for (let ms = start; ms <= end; ms += STEP) {
    const p = sat.sgp4(s.rec, (ms / 864e5 + 2440587.5 - s.rec.jdsatepoch) * 1440)?.position; // same time math as propagate(), minus the Date work
    if (!p) break;
    const g = sat.gstime(new Date(ms)), c = Math.cos(g), si = Math.sin(g), x = p.x * c + p.y * si, y = p.y * c - p.x * si;
    const d = R * Math.acos(Math.min(1, (x * ux + y * uy + p.z * uz) / Math.hypot(x, y, p.z))); // ground distance via the angle between two Earth-fixed directions
    if (d > prev && falling && prev < 3000) { const r = refine(s, here, ms - STEP); if (r) out.push(r); }
    falling = d < prev; prev = d;
  }
  return out;
}
function refine(s, here, ms) {
  let best = null;
  for (let t = ms - STEP; t <= ms + STEP; t += 5e3) {
    const p = where(s.rec, t);
    if (p) { const d = dist(here, p); if (!best || d < best.d) best = { d, p }; }
  }
  if (!best) return null;
  const e = elev(best.p, here), offNadir = Math.atan2(best.d, best.p.h) / RAD;
  const cat = s.swath && best.d <= s.swath / 2 ? 'likely' : s.group !== 'weather' && offNadir <= 45 ? 'could' : e >= 30 ? 'over' : null;
  return cat && { at: best.p.t.getTime(), d: best.d, h: best.p.h, offNadir, cat };
}
