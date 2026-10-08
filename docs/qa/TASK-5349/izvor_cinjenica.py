# TASK-5349: preslikaj retke memorijskog bloka (ishod.json) na document_id u banci cvor_node_a (recall kroz posrednik 17795).
import json, re, urllib.request
URL = 'http://127.0.0.1:17795/v1/default/banks/cvor_node_a/memories/recall'
def recall(q):
    req = urllib.request.Request(URL, json.dumps({'query': q, 'budget': 'mid', 'max_tokens': 8192}).encode(), {'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=120)).get('results', [])
norm = lambda s: re.sub(r'[\[\]()]', '', re.sub(r'\s+', ' ', s)).strip().lower()[:90]
ish = json.load(open('ishod.json'))
karta = {}
for q in [x['pitanje'] for x in ish] + ['SEND_DOC slanje dokumenta', 'glas audio mp3 venv instaliraj-glas', 'token bota konfiguracija', 'bot kanal Klaudio Šaban', 'zagrade oznaka apsolutna putanja']:
    for r in recall(q):
        karta[norm(r.get('text', ''))] = r.get('document_id') or '?'
ukupno = {}
for i, x in enumerate(ish, 1):
    redci = [l[2:] for l in x['memorijskiBlok'].split('\n') if l.startswith('- ')]
    izvori = [karta.get(norm(r), 'nepoznato') for r in redci]
    s = sum(1 for d in izvori if str(d).startswith('savjet/'))
    print(f"P{i}: redaka {len(redci)}, iz savjet/* {s}  ->", {d: izvori.count(d) for d in sorted(set(map(str, izvori)))})
