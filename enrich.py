import json, re, time, os, sys, urllib.request

UA = {"Content-Type": "application/json", "Accept": "application/json",
      "User-Agent": "amdz-catalog-enricher/1.0"}
PROG, DELAY = "enrich_progress.json", 2.2

def al_query(query, variables, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request("https://graphql.anilist.co",
                data=json.dumps({"query": query, "variables": variables}).encode(), headers=UA)
            return json.loads(urllib.request.urlopen(req, timeout=20).read())["data"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                w = 20 + i * 15; print(f"  429 rate limit, tunggu {w}s..."); time.sleep(w); continue
            return None
        except Exception:
            time.sleep(5)
    return None

def normalize(t):
    t = t.lower()
    t = re.sub(r'[“”"\'`:;,.!?()\[\]{}~\-_/\\|@#$%^&*+=<>]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def season_num(t):
    for pat in [r'\b(\d+)(?:th|nd|rd|st)\s+season\b', r'\bseason\s*(\d+)\b',
                r'\bpart\s*(\d+)\b', r'\bcour\s*(\d+)\b', r'\bs(\d+)\b']:
        m = re.search(pat, t, re.I)
        if m: return int(m.group(1))
    m = re.search(r'\b(II|III|IV|V|VI)\b', t)
    return {'II':2,'III':3,'IV':4,'V':5,'VI':6}.get(m.group(1)) if m else None

def clean_for_search(t):
    t = re.sub(r'\b\d+(?:th|nd|rd|st)\s+season\b', ' ', t, flags=re.I)
    t = re.sub(r'\b(?:season|part|cour)\s*\d+\b', ' ', t, flags=re.I)
    t = re.sub(r'\bs\d+\b', ' ', t, flags=re.I)
    t = re.sub(r'\s+-\s+.*$', '', t)
    return re.sub(r'\s+', ' ', t).strip()

def search_terms(title):
    c = clean_for_search(title); w = c.split(); terms = [c]
    for n in (8, 6, 4):
        if len(w) > n: terms.append(' '.join(w[:n]))
    if len(w) <= 3: terms.append(title)
    seen, out = set(), []
    for t in terms:
        if t and t not in seen: seen.add(t); out.append(t)
    return out

def score_match(src_full, src_clean, cand):
    best = 0.0
    titles = [cand['title'].get(k) or '' for k in ('romaji','english','native')] + (cand.get('synonyms') or [])
    ns_clean = normalize(src_clean)
    for t in titles:
        if not t: continue
        nt = normalize(t); nw = nt.split()
        for sw in (ns_clean.split(), normalize(src_full).split()):
            if sw and nw: best = max(best, sum(1 for x in sw if x in nw) / len(sw))
        if nt and ns_clean and (nt in ns_clean or ns_clean in nt): best = max(best, 0.95)
    want = season_num(src_full)
    cs = season_num(' '.join(titles)) or 1
    if want: best += 0.25 if cs == want else -0.35
    if re.search(r'\bmovie\b|\bfilm\b', src_full, re.I) and cand.get('format') == 'MOVIE': best += 0.1
    return best

Q = """query($s:String){Page(page:1,perPage:6){media(type:ANIME,search:$s,isAdult:false){id title{romaji english native} genres seasonYear startDate{year} format synonyms}}}"""

def find_best(title):
    for term in search_terms(title):
        d = al_query(Q, {"s": term})
        media = (d or {}).get("Page", {}).get("media", [])
        if not media: continue
        time.sleep(DELAY)
        best, bs = None, -1
        for m in media:
            s = score_match(title, clean_for_search(title), m)
            if s > bs: bs, best = s, m
        thresh = 0.55 if len(title.split()) <= 4 else 0.6
        return (best, bs) if bs >= thresh else (None, bs)
    return None, 0

def is_generic(g): return not g or all(x.strip().lower() in ('anime','sub indo') for x in g)

SRC = sys.argv[1] if len(sys.argv) > 1 else "catalog.json"
catalog = json.load(open(SRC, encoding="utf-8"))
prog = json.load(open(PROG)) if os.path.exists(PROG) else {}
todo = [a for a in catalog if not a.get("year") or is_generic(a.get("genres"))]
print(f"{len(todo)} judul perlu diproses, {len(prog)} sudah ada progress")

try:
    for a in todo:
        t = a["title"]
        if t in prog: continue
        m, sc = find_best(t)
        if m:
            prog[t] = {"anilist_id": m["id"], "title_romaji": m["title"].get("romaji"),
                       "title_english": m["title"].get("english"),
                       "year": str(m.get("seasonYear") or (m.get("startDate") or {}).get("year") or ""),
                       "genres": (m.get("genres") or [])[:4], "score": round(sc, 2)}
        else:
            prog[t] = {"unmatched": True, "score": round(sc, 2)}
        json.dump(prog, open(PROG, "w"), ensure_ascii=False)
        print(("OK  " if m else "MISS"), t[:60], f"({len(prog)}/{len(todo)})")
        time.sleep(DELAY)
except KeyboardInterrupt:
    print("\nDi-pause. Jalankan lagi untuk lanjut (progress aman).")

unmatched, fixed = [], 0
for a in catalog:
    p = prog.get(a["title"])
    if not p or p.get("unmatched"):
        if p: unmatched.append({"id": a["id"], "title": a["title"], "score": p.get("score")})
        continue
    if not a.get("year") and p["year"]: a["year"] = p["year"]
    if is_generic(a.get("genres")) and p["genres"]: a["genres"] = p["genres"]; fixed += 1
    a["anilist_id"] = p["anilist_id"]; a["title_english"] = p["title_english"]; a["title_romaji"] = p["title_romaji"]

json.dump(catalog, open("catalog_enriched.json", "w"), ensure_ascii=False, indent=1)
json.dump(unmatched, open("report_unmatched.json", "w"), ensure_ascii=False, indent=1)
print(f"\nSelesai! Genre terisi: {fixed}, tahun terisi, belum ke-match: {len(unmatched)}")
print("Output: catalog_enriched.json (ganti catalog.json di repo) + report_unmatched.json")