# Overhead

Pick any place on Earth. See which Earth-observing satellites passed over it in the last 7 days, and the real Sentinel-2 photos taken there.

Free end to end: a static site with no backend, no API keys and no build step.

## How it works
- **Orbits:** satellite orbital elements (TLEs) for CelesTrak's `resource`, `weather` and `planet` groups. A GitHub Action refreshes `data/<group>.txt` once a day; if a file is missing, the page fetches CelesTrak directly.
- **Passes:** [satellite.js](https://github.com/shashwatak/satellite-js) propagates each orbit minute by minute over the last 7 days in your browser and finds each satellite's closest approach. Each pass is sorted by meaning: **photographed** (a Sentinel-2 image of the spot exists), **likely imaged** (a fixed, always-down camera's strip covered the spot), **could have looked** (a pointable camera was within 45° of straight down), or **passed high overhead** (above 30° in the sky). Geostationary weather satellites that see the spot all the time are listed separately. Past positions come from current elements, so older passes are approximate.
- **Photos:** Sentinel-2 L2A scenes from [Earth Search](https://element84.com/earth-search/) (Element84, AWS Open Data). Each preview shows the whole 110 km tile.
- **Edge lab (pixels vs. answers):** for a photographed pass, the page follows the photo to the ground. It runs the orbit forward to the first of 11 public ground stations the satellite can reach, checks whether a nearby satellite already in contact with a station could relay sooner (hypothetical, since these satellites don't relay for each other), and reads the photo's pixels in your browser with simple colour rules to produce a tiny "answer" (cloud, water, vegetation, land %). It then compares ~800 MB of raw tile with that answer. The tile size, link rates and station list are stated assumptions; the colour rules are rules, not a trained model.
- **Globe:** [globe.gl](https://github.com/vasturiano/globe.gl). **Place search:** OpenStreetMap Nominatim.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000.

## Deploy free on GitHub Pages
Push to GitHub, then Settings → Pages → Deploy from branch → `main`, folder `/`. The "Refresh orbits" action then updates `data/` daily; run it once from the Actions tab to refresh straight away.

## Credits
Orbital data: CelesTrak. Imagery: contains modified Copernicus Sentinel data, processed by ESA, via Earth Search on AWS Open Data. Search: © OpenStreetMap contributors.

MIT licensed.
