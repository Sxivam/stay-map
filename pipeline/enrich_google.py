#!/usr/bin/env python3
"""Add phone numbers, ratings and missing stays from Google Maps listings, through your Apify account.

    python3 pipeline/enrich_google.py goa              # shows what it will do and the rough cost, then stops
    python3 pipeline/enrich_google.py goa --yes        # runs it
    python3 pipeline/enrich_google.py goa --yes --max 500   # smaller, cheaper run

Needs an Apify API token in the APIFY_TOKEN environment variable, or in a file called .env next to README.md:
    APIFY_TOKEN=apify_api_xxxxxxxx
Apify bills your account per place returned; check the current price on the Actor's page before a big run.
Results are saved in web/data/<slug>.google.json, so merging again later costs nothing.
"""
import argparse, json, math, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "data")
ACTOR = "compass~crawler-google-places"
API = "https://api.apify.com/v2"
SEARCHES = ["hotel", "guest house", "homestay", "hostel", "resort", "villa", "beach huts", "service apartment"]
KIND = [("hostel", "hostel"), ("resort", "resort"), ("villa", "villa"), ("apartment", "villa"), ("cottage", "villa"), ("holiday home", "villa"),
        ("guest house", "guesthouse"), ("homestay", "guesthouse"), ("bed & breakfast", "guesthouse"), ("lodge", "guesthouse"), ("inn", "guesthouse"),
        ("camp", "camp"), ("hotel", "hotel"), ("motel", "hotel")]


def token():
    t = os.environ.get("APIFY_TOKEN", "")
    env = os.path.join(ROOT, ".env")
    if not t and os.path.exists(env):
        for line in open(env, encoding="utf-8"):
            if line.strip().startswith("APIFY_TOKEN="):
                t = line.split("=", 1)[1].strip().strip("\"'")
    return t


def call(method, path, tok, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def scrape(place, tok, per_search):
    run = call("POST", f"/acts/{ACTOR}/runs", tok, {
        "searchStringsArray": SEARCHES, "locationQuery": place["label"], "maxCrawledPlacesPerSearch": per_search,
        "language": "en", "skipClosedPlaces": True, "scrapePlaceDetailPage": False, "maxImages": 0, "maxReviews": 0})["data"]
    print(f"Started Apify run {run['id']}. This can take 10 to 40 minutes; safe to leave running.")
    while run["status"] in ("READY", "RUNNING"):
        time.sleep(20)
        run = call("GET", f"/actor-runs/{run['id']}", tok)["data"]
        print("  ", run["status"], flush=True)
    if run["status"] != "SUCCEEDED":
        sys.exit(f"Apify run ended as {run['status']}. Open it in the Apify console to see why.")
    items, offset = [], 0
    while True:
        page = call("GET", f"/datasets/{run['defaultDatasetId']}/items?clean=true&format=json&limit=1000&offset={offset}", tok)
        items += page
        offset += len(page)
        if len(page) < 1000:
            return items


def metres(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 110540)


def words(name):
    drop = {"hotel", "resort", "guest", "house", "guesthouse", "hostel", "the", "and", "goa", "beach", "villa", "homestay", "stay", "by", "rooms", "inn"}
    return {w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in drop and len(w) > 1}


def same(a, b):
    wa, wb = words(a), words(b)
    return bool(wa and wb) and len(wa & wb) / min(len(wa), len(wb)) >= 0.6


def merge(data, items):
    stays, cc = data["stays"], data["place"].get("cc", "")
    w, s, e, n = data["place"]["bbox"]
    grid = {}
    for st in stays:
        grid.setdefault((round(st["ll"][0], 2), round(st["ll"][1], 2)), []).append(st)
    filled = added = 0
    seen = set()
    for it in items:
        loc, name, pid = it.get("location") or {}, (it.get("title") or "").strip(), it.get("placeId")
        if not name or loc.get("lng") is None or pid in seen or it.get("permanentlyClosed"):
            continue
        seen.add(pid)
        at = (round(loc["lng"], 5), round(loc["lat"], 5))
        if not (w - 0.05 <= at[0] <= e + 0.05 and s - 0.05 <= at[1] <= n + 0.05):
            continue
        phone = re.sub(r"[^\d+]", "", it.get("phoneUnformatted") or it.get("phone") or "")
        near = [st for dx in (-0.01, 0, 0.01) for dy in (-0.01, 0, 0.01) for st in grid.get((round(at[0] + dx, 2), round(at[1] + dy, 2)), [])]
        hit = next((st for st in sorted(near, key=lambda st: metres(st["ll"], at)) if metres(st["ll"], at) < 150 and same(st["n"], name)), None)
        if hit is None:
            cat = (it.get("categoryName") or "").lower()
            kind = next((k for key, k in KIND if key in cat or key in name.lower()), None)
            if not kind:
                continue  # not a place to stay (restaurants and shops also match these searches)
            hit = {"id": "g" + re.sub(r"\W", "", pid or name)[:24], "n": name[:80], "k": kind, "ll": at, "src": "google"}
            if it.get("city") or it.get("neighborhood"):
                hit["a"] = it.get("neighborhood") or it.get("city")
            stays.append(hit)
            grid.setdefault((round(at[0], 2), round(at[1], 2)), []).append(hit)
            added += 1
        if phone and not hit.get("p"):
            hit["p"], hit["ps"] = (phone if phone.startswith("+") else "+" + phone), "google"
            filled += 1
        if it.get("website") and not hit.get("w") and "google.com" not in it["website"]:
            hit["w"] = it["website"][:200]
        if it.get("totalScore"):
            hit["g"], hit["gn"] = it["totalScore"], it.get("reviewsCount") or 0
        if it.get("url"):
            hit["gu"] = it["url"]
    return filled, added


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slug")
    ap.add_argument("--yes", action="store_true", help="actually run (spends Apify credit)")
    ap.add_argument("--max", type=int, default=4000, help="most places to fetch in total (default 4000)")
    a = ap.parse_args()
    path, cache = os.path.join(DATA, a.slug + ".json"), os.path.join(DATA, a.slug + ".google.json")
    data = json.load(open(path, encoding="utf-8"))
    if os.path.exists(cache):
        items = json.load(open(cache, encoding="utf-8"))
        print(f"Using {len(items)} saved Google Maps listings from an earlier run (no cost).")
    else:
        per = max(20, a.max // len(SEARCHES))
        print(f"Will search Google Maps in {data['place']['label']} for: {', '.join(SEARCHES)}.\n"
              f"Up to {per * len(SEARCHES)} listings, billed to your Apify account per listing returned.")
        tok = token()
        if not a.yes:
            sys.exit("Nothing has run yet. Add --yes to start." + ("" if tok else " (No APIFY_TOKEN found yet; see the top of this file.)"))
        if not tok:
            sys.exit("No APIFY_TOKEN found. Put it in the environment or in a .env file next to README.md.")
        items = scrape(data["place"], tok, per)
        json.dump(items, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    filled, added = merge(data, items)
    st = data["stays"]
    data["place"].update(count=len(st), phones=sum(1 for x in st if x.get("p")), sites=sum(1 for x in st if x.get("w")))
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"Added numbers to {filled} stays and {added} stays that were missing. Now {len(st)} stays, {data['place']['phones']} with a number.\n"
          f"Now run pipeline/build.py for this place once more: it keeps these results and works out sea distance for the new stays.")


if __name__ == "__main__":
    main()
