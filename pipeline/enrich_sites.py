#!/usr/bin/env python3
"""Fill in missing phone numbers by reading each stay's own website. Free, no key.

    python3 pipeline/enrich_sites.py goa

For every stay that has a website but no number, this opens the home page (and the contact page if needed)
and takes the number the owner published there: a tel: or WhatsApp link first, a written number second.
Found numbers are saved in web/data/<slug>.phones.json so a later rebuild keeps them, and marked "ps": "web".
"""
import concurrent.futures as cf, html, json, os, re, ssl, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "data")
UA = "Mozilla/5.0 (compatible; staymap/0.1; reads public contact details)"
CTX = ssl.create_default_context()
DIAL = {"in": "91", "id": "62", "th": "66", "lk": "94", "np": "977", "vn": "84", "gb": "44", "us": "1", "pt": "351", "es": "34", "it": "39", "gr": "30"}


def fetch(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=12, context=CTX) as r:
            if "html" not in r.headers.get("Content-Type", "html"):
                return "", url
            return r.read(600_000).decode("utf-8", "replace"), r.geturl()
    except Exception:
        return "", url


def clean(raw, dial):
    d = re.sub(r"[^\d+]", "", html.unescape(urllib.parse.unquote(raw)))
    if d.startswith("00"):
        d = "+" + d[2:]
    if d.startswith("+"):
        return d if 9 <= len(d) <= 16 else ""
    d = d.lstrip("0")
    if dial and d.startswith(dial) and len(d) > 10:
        return "+" + d
    if dial == "91":
        return "+91" + d if len(d) == 10 and d[0] in "6789" or len(d) in (10, 11) and d[0] in "2345678" else ""
    return ("+" + dial + d) if dial and 7 <= len(d) <= 11 else ""


def numbers(page, dial):
    """Best number on a page: WhatsApp link, then tel: link, then a number written in the text."""
    for pat in (r"(?:wa\.me/|whatsapp\.com/send/?\?(?:[^\"'>]*&)?phone=)(\+?[\d%]{9,18})", r"href=[\"']tel:([^\"'>]{7,24})"):
        for m in re.findall(pat, page, flags=re.I):
            n = clean(m, dial)
            if n:
                return n
    text = re.sub(r"<(script|style)[\s\S]*?</\1>|<[^>]+>", " ", page)
    for m in re.findall(r"(?<![\d.])(\+\d{1,3}[\s\-]?\(?\d{2,5}\)?[\s\-]?\d{3,5}[\s\-]?\d{3,5})(?![\d.])", text):
        n = clean(m, dial)
        if n:
            return n
    if dial == "91":
        for m in re.findall(r"(?<![\d.])(?:0|91[\s\-]?)?([6-9]\d{4}[\s\-]?\d{5})(?![\d.])", text):
            return "+91" + re.sub(r"\D", "", m)
    return ""


def lookup(stay, dial):
    page, final = fetch(stay["w"])
    n = numbers(page, dial) if page else ""
    if not n and page:
        links = re.findall(r"href=[\"']([^\"'#>]*contact[^\"'#>]*)[\"']", page, flags=re.I)
        for link in list(dict.fromkeys(links))[:2]:
            sub, _ = fetch(urllib.parse.urljoin(final, html.unescape(link)))
            n = numbers(sub, dial) if sub else ""
            if n:
                break
    return stay["id"], n, bool(page)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    slug = sys.argv[1]
    path = os.path.join(DATA, slug + ".json")
    data = json.load(open(path, encoding="utf-8"))
    side_path = os.path.join(DATA, slug + ".phones.json")
    side = json.load(open(side_path, encoding="utf-8")) if os.path.exists(side_path) else {}
    cc = data["place"].get("cc", "in")
    dial = DIAL.get(cc, "")
    todo = [s for s in data["stays"] if s.get("w") and not s.get("p") and s["id"] not in side]
    print(f"Reading {len(todo)} websites ...")
    reached = 0
    with cf.ThreadPoolExecutor(8) as pool:
        for sid, n, ok in pool.map(lambda s: lookup(s, dial), todo):
            reached += ok
            side[sid] = {"p": n, "ps": "web"} if n else {}
    json.dump(side, open(side_path, "w", encoding="utf-8"), indent=0)
    added = 0
    for s in data["stays"]:
        extra = side.get(s["id"])
        if extra and extra.get("p") and not s.get("p"):
            s["p"], s["ps"] = extra["p"], extra["ps"]
            added += 1
    data["place"]["phones"] = sum(1 for s in data["stays"] if s.get("p"))
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"Reached {reached} of {len(todo)} sites. Added {added} numbers. {data['place']['phones']} of {len(data['stays'])} stays now have one.")


if __name__ == "__main__":
    main()
