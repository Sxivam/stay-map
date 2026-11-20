# Stay Map

Every hostel, guesthouse, hotel, resort and villa in a place, on one map, with the direct phone number or website where the owner has published one. Built for Goa at New Year; works for any place on Earth with one command.

**Live map: https://sxivam.github.io/stay-map/**

No API keys, no accounts, no build step, no dependencies beyond Python 3 and a browser.

## Use it

```bash
python3 -m http.server 8765 --directory web
```

Open http://localhost:8765. Type what you want ("hostel near the beach in Anjuna with phone"), swipe the cards, tap WhatsApp to message the owner with your dates and group size already written.

## Make it for your own place

```bash
python3 pipeline/build.py "Bali, Indonesia"
```

That takes about a minute, writes `web/data/bali.json` and adds Bali to the place switcher. Any city, district, state or island that OpenStreetMap knows by name will work: `"Manali, India"`, `"Lisbon"`, `"Koh Phangan"`.

With Claude Code: open this folder and say *"build the stay map for Rishikesh and open it"*.

## Get more phone numbers

Open data only has a number for about one stay in five. Two optional steps add more, and both mark where each number came from on the card.

```bash
python3 pipeline/enrich_sites.py goa
```

Free. Reads the home and contact page of every stay that has a website but no number. For Goa it added 50.

```bash
python3 pipeline/enrich_google.py goa
```

Uses Google Maps listings through your own Apify account, which bills per listing. Run it as above to see what it will fetch, then add `--yes` to start. It needs your token in a `.env` file next to this README (`APIFY_TOKEN=...`); that file is ignored by git. It also adds ratings and stays that OpenStreetMap is missing. Afterwards run `pipeline/build.py` for the place once more so the new stays get a sea distance. Rebuilding never loses numbers already found.

## What you get and where it comes from

The base data is read from OpenStreetMap. Nothing is estimated or invented.

| On the card | Source |
|---|---|
| Name, type, location | OpenStreetMap `tourism=*` places |
| Phone, WhatsApp, website | Contact tags the owner or a mapper added |
| Distance to the sea | Measured to the nearest mapped beach or the coastline |
| Area | Nearest named village or town |

"Photos & prices" opens the place on Google Maps, because prices and live availability are not in any open dataset. The honest way to get a New Year price is to ask the owner, which is what the WhatsApp button is for.

Coverage depends on how well a place is mapped. Goa on 20 Nov 2026: 1,534 stays, 394 with a phone number (344 from OpenStreetMap, 50 read from the stays' own websites), 390 with a website. If a place is missing or wrong, "Source · fix this" on its card opens it on OpenStreetMap, where anyone can correct it; rerun the pipeline to pick up the change.

## Filming it

| Do this | Result |
|---|---|
| Add `?film` to the URL | Panels hidden, opening dive from the globe, then an automatic tour |
| Press `H` | Hide or show the panels |
| Press `R` | Replay the opening |
| Press `T` | Start the tour from the current results |
| Add `?nointro` | Skip the opening |

## Put it online

`web/` is a plain static site. This repo publishes it to GitHub Pages on every push to `main` (see `.github/workflows/pages.yml`); in a fork, set Settings → Pages → Source to "GitHub Actions" once. It also works as-is on Cloudflare Pages, Netlify or Vercel.

## How it is made

- `pipeline/build.py`: one Python file, standard library only. Finds the place, asks OpenStreetMap's Overpass service for stays, beaches, coastline and towns, writes one compact JSON file.
- `web/`: MapLibre GL from a CDN, dark satellite imagery from Esri, vector tiles from OpenFreeMap, three small files of our own.
- The sentence box is keyword matching in the browser, not an AI call, so it is instant and free.

## Licence

Code: MIT (see `LICENSE`). The data files in `web/data/` are derived from OpenStreetMap and stay under the ODbL.

## Credits

Map data © OpenStreetMap contributors (ODbL). Imagery © Esri. Tiles by OpenFreeMap. Please keep the credit line visible if you publish a copy.
