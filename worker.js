// Finds passes for a share of the satellites, off the main thread.
import { sat, passesOf } from './orbit.js';
onmessage = ({ data: { tles, here, start, end } }) =>
  postMessage(tles.flatMap(([key, l1, l2, group, swath]) => passesOf({ rec: sat.twoline2satrec(l1, l2), group, swath }, here, start, end).map((p) => ({ ...p, key }))));
