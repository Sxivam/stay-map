#!/usr/bin/env python3
"""Build a stay map for any place from OpenStreetMap. No API key, no dependencies.

    python3 pipeline/build.py "Goa, India"
    python3 pipeline/build.py "Bali, Indonesia" --slug bali

Writes web/data/<slug>.json and adds the place to web/data/places.json.
Everything in the output comes from OpenStreetMap; nothing is estimated or invented.
"""
import argparse, datetime, json, math, os, re, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

UA = "staymap/0.1 (open-source stay map builder)"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data")

KINDS = {"hotel": "hotel", "motel": "hotel", "resort": "resort", "guest_house": "guesthouse", "hostel": "hostel",
         "apartment": "villa", "chalet": "villa", "camp_site": "camp"}
DIAL = {"in": "91", "id": "62", "th": "66", "lk": "94", "np": "977", "vn": "84", "ae": "971", "gb": "44", "us": "1", "ca": "1",
        "au": "61", "fr": "33", "de": "49", "es": "34", "it": "39", "pt": "351", "gr": "30", "tr": "90", "mx": "52", "br": "55",
        "jp": "81", "kr": "82", "my": "60", "sg": "65", "ph": "63", "za": "27", "eg": "20", "ma": "212", "nl": "31"}


def get(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network hiccup or a busy server: wait and retry
            if i == tries - 1:
                raise
            print(f"  retrying after: {e}", file=sys.stderr)
            time.sleep(4 * (i + 1))


def find_place(q):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": 5, "addressdetails": 1})
    hits = get(url)
    if not hits:
        sys.exit(f"Could not find a place called {q!r}. Try adding the country, e.g. 'Goa, India'.")
    hit = next((h for h in hits if h.get("osm_type") == "relation"), hits[0])
    s, n, w, e = (float(x) for x in hit["boundingbox"])
    area = {"relation": 3600000000, "way": 2400000000}.get(hit["osm_type"])
    return {"name": hit.get("name") or q.split(",")[0].strip(), "label": hit["display_name"], "cc": hit.get("address", {}).get("country_code", ""),
            "bbox": [w, s, e, n], "center": [(w + e) / 2, (s + n) / 2], "area": area + int(hit["osm_id"]) if area else None}


def overpass(place):
    scope = f"area({place['area']})->.a;" if place["area"] else ""
    w, s, e, n = place["bbox"]
    within = "(area.a)" if place["area"] else f"({s},{w},{n},{e})"
    q = f"""[out:json][timeout:170];{scope}
(nwr[tourism~"^(hotel|motel|resort|guest_house|hostel|apartment|chalet|camp_site)$"]{within};)->.stays;
.stays out center tags;
(nwr[natural=beach]{within};)->.b; .b out geom tags;
node[place~"^(city|town|village|suburb|neighbourhood)$"]{within}; out;
way[natural=coastline]({s},{w},{n},{e}); out geom;"""
    last = None
    for host in OVERPASS:
        try:
            return get(host, data=urllib.parse.urlencode({"data": q}).encode())["elements"]
        except Exception as ex:
            last = ex
            print(f"  {host} failed, trying the next server", file=sys.stderr)
    sys.exit(f"OpenStreetMap servers did not answer: {last}")


def metres(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110540)


def to_segment(p, a, b):
    """Metres from point p to the line a-b (all lon/lat), on a local flat grid."""
    k = math.cos(math.radians(p[1]))
    px, py = 0.0, 0.0
    ax, ay = (a[0] - p[0]) * 111320 * k, (a[1] - p[1]) * 110540
    bx, by = (b[0] - p[0]) * 111320 * k, (b[1] - p[1]) * 110540
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


def phone(tags, cc):
    raw = next((tags[k] for k in ("contact:whatsapp", "contact:mobile", "phone", "contact:phone", "mobile") if tags.get(k)), "")
    raw = re.split(r"[;,/]", raw)[0].strip()
    digits = re.sub(r"[^\d+]", "", raw)
    if len(re.sub(r"\D", "", digits)) < 7:
        return ""
    if digits.startswith("+"):
        return digits
    if digits.startswith("00"):
        return "+" + digits[2:]
    dial = DIAL.get(cc)
    if not dial:
        return digits
    digits = digits.lstrip("0")
    return "+" + (digits if digits.startswith(dial) and len(digits) > 10 else dial + digits)


def site(tags):
    u = next((tags[k] for k in ("website", "contact:website", "url") if tags.get(k)), "").split(";")[0].strip()
    return ("https://" + u if u and not u.startswith("http") else u)[:200]


def build(place, slug):
    els = overpass(place)
    beach_pts, towns, stays, seen, coast = [], [], [], set(), []
    for el in els:
        t = el.get("tags", {})
        if t.get("natural") == "coastline":
            g = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
            coast += list(zip(g, g[1:]))
        elif t.get("natural") == "beach":
            name = t.get("name:en") or t.get("name") or ""
            pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])] or ([(el["lon"], el["lat"])] if "lon" in el else [])
            for m in el.get("members", []):
                pts += [(p["lon"], p["lat"]) for p in m.get("geometry", [])]
            beach_pts += [(p, name) for p in pts]
        elif t.get("place") and "lon" in el:
            towns.append(((el["lon"], el["lat"]), t.get("name:en") or t.get("name") or "", t["place"] in ("city", "town", "village")))
    def locate(s, at):
        # Distance to the water: the nearer of a mapped beach and the sea's edge (many beaches are not drawn in OSM).
        d, bname = min(((metres(at, p), bn) for p, bn in beach_pts), key=lambda x: x[0]) if beach_pts else (None, "")
        near = [sg for sg in coast if abs(sg[0][0] - at[0]) < 0.2 and abs(sg[0][1] - at[1]) < 0.2]
        sea = min((to_segment(at, a_, b_) for a_, b_ in near), default=None)
        if sea is not None and (d is None or sea < d - 200):
            d, bname = sea, ""
        if d is not None:
            s["bd"] = int(round(d / 10) * 10)
            if bname:
                s["bn"] = bname
        named = [(metres(at, p), tn, big) for p, tn, big in towns if tn]
        if named:
            s["a"] = min(named)[1]  # nearest named locality, however small
            big = [x for x in named if x[2]]
            if big and min(big)[1] != s["a"]:
                s["t"] = min(big)[1]  # nearest village or town, for search

    for el in els:
        t = el.get("tags", {})
        kind = KINDS.get(t.get("tourism", ""))
        name = (t.get("name:en") or t.get("name") or "").strip()
        c = el.get("center") or el
        if not kind or not name or "lon" not in c:
            continue
        at = (round(c["lon"], 5), round(c["lat"], 5))
        key = (name.lower(), round(at[0], 3), round(at[1], 3))
        if key in seen:
            continue
        seen.add(key)
        s = {"id": el["type"][0] + str(el["id"]), "n": name[:80], "k": kind, "ll": at}
        locate(s, at)
        for key_, val in (("p", phone(t, place["cc"])), ("w", site(t)), ("e", (t.get("email") or t.get("contact:email") or "")[:80]),
                          ("st", t.get("stars", "")[:3]), ("r", t.get("rooms", "")[:5]),
                          ("ad", ", ".join(x for x in (t.get("addr:street"), t.get("addr:suburb") or t.get("addr:city")) if x)[:90])):
            if val:
                s[key_] = val
        if t.get("swimming_pool") == "yes" or t.get("leisure") == "swimming_pool":
            s["pool"] = 1
        if t.get("internet_access") in ("wlan", "yes", "wifi"):
            s["wifi"] = 1
        stays.append(s)
    # Re-apply anything the enrichment scripts found earlier, so a rebuild never loses it.
    web = os.path.join(OUT, slug + ".phones.json")
    if os.path.exists(web):
        found = json.load(open(web, encoding="utf-8"))
        for s in stays:
            if not s.get("p") and found.get(s["id"], {}).get("p"):
                s["p"], s["ps"] = found[s["id"]]["p"], "web"
    cache = os.path.join(OUT, slug + ".google.json")
    if os.path.exists(cache):
        import enrich_google
        lons, lats = [s["ll"][0] for s in stays], [s["ll"][1] for s in stays]
        enrich_google.merge({"stays": stays, "place": {"bbox": [min(lons), min(lats), max(lons), max(lats)], "cc": place["cc"]}},
                            json.load(open(cache, encoding="utf-8")))
        for s in stays:
            if s.get("src") == "google":
                locate(s, s["ll"])
    stays.sort(key=lambda s: (s.get("bd", 10 ** 9), s["n"]))
    return stays


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("place", help='e.g. "Goa, India"')
    ap.add_argument("--slug", help="short name used in the URL (default: from the place name)")
    a = ap.parse_args()
    print(f"Finding {a.place} ...")
    place = find_place(a.place)
    slug = a.slug or re.sub(r"[^a-z0-9]+", "-", place["name"].lower()).strip("-")
    print(f"  {place['label']}\nAsking OpenStreetMap for every stay, beach and town (can take a minute) ...")
    stays = build(place, slug)
    if not stays:
        sys.exit("No named stays found there. Check the place name.")
    lons, lats = [s["ll"][0] for s in stays], [s["ll"][1] for s in stays]
    meta = {"slug": slug, "name": place["name"], "label": place["label"], "center": [round(sum(lons) / len(lons), 4), round(sum(lats) / len(lats), 4)],
            "bbox": [min(lons), min(lats), max(lons), max(lats)], "built": datetime.date.today().isoformat(), "cc": place["cc"], "count": len(stays),
            "phones": sum(1 for s in stays if s.get("p")), "sites": sum(1 for s in stays if s.get("w")),
            "beaches": any("bd" in s for s in stays)}
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump({"place": meta, "stays": stays}, f, ensure_ascii=False, separators=(",", ":"))
    idx_path = os.path.join(OUT, "places.json")
    idx = json.load(open(idx_path, encoding="utf-8")) if os.path.exists(idx_path) else []
    entry = {k: meta[k] for k in ("slug", "name", "count", "built")}  # a rebuilt place keeps its position; the first one is the default
    idx = [entry if p["slug"] == slug else p for p in idx] if any(p["slug"] == slug for p in idx) else idx + [entry]
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    print(f"Done: {meta['count']} stays, {meta['phones']} with a phone number, {meta['sites']} with a website.\n"
          f"Saved web/data/{slug}.json. Open the map with ?place={slug}")


if __name__ == "__main__":
    main()
