"""Generator Excalidraw skice uređivača rasporeda (TASK-5169). Izlaz: uredivac-rasporeda.excalidraw u ovoj mapi.
PNG: npx excalidraw-brute-export-cli -i uredivac-rasporeda.excalidraw -o uredivac-rasporeda.png -f png -s 2 -b"""
import json, os, random
random.seed(5169)
E = []
def _id(): return 'e%06d' % random.randint(0, 999999)
def base(t, x, y, w, h, **k):
    d = dict(id=_id(), type=t, x=x, y=y, width=w, height=h, angle=0, strokeColor=k.get('s', '#1e1e1e'), backgroundColor=k.get('bg', 'transparent'),
             fillStyle=k.get('fill', 'solid'), strokeWidth=k.get('sw', 2), strokeStyle=k.get('ss', 'solid'), roughness=k.get('r', 1), opacity=100,
             groupIds=[], frameId=None, roundness={'type': 3} if t == 'rectangle' and k.get('round', True) else None, seed=random.randint(1, 2**31),
             version=1, versionNonce=random.randint(1, 2**31), isDeleted=False, boundElements=None, updated=1, link=None, locked=False)
    E.append(d); return d
def box(x, y, w, h, **k): return base('rectangle', x, y, w, h, **k)
def text(x, y, t, size=18, c='#1e1e1e'):
    lines = t.split('\n'); W = max(len(l) for l in lines) * size * 0.55; H = len(lines) * size * 1.25
    d = base('text', x, y, W, H, s=c)
    d.update(text=t, fontSize=size, fontFamily=1, textAlign='left', verticalAlign='top', baseline=size, containerId=None, originalText=t, lineHeight=1.25)
    return d
def crta(x, y, w, c):
    d = base('line', x, y, w, 0, s=c, sw=1)
    d.update(points=[[0, 0], [w, 0]], lastCommittedPoint=None, startBinding=None, endBinding=None, startArrowhead=None, endArrowhead=None)
def arrow(x1, y1, x2, y2, c='#1e1e1e', ss='solid', label=None, lx=None, ly=None):
    d = base('arrow', x1, y1, x2 - x1, y2 - y1, s=c, ss=ss)
    d.update(points=[[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint=None, startBinding=None, endBinding=None, startArrowhead=None, endArrowhead='arrow')
    if label: text(lx, ly, label, 15, c)

J, B, G, R, INK = '#f59e0b', '#3b82f6', '#2f9e44', '#e03131', '#1e1e1e'
text(40, 20, 'TASK-5169 · Uređivač rasporeda Config stranice — JEDAN gumb', 28)
text(40, 60, 'Grga · 03.10.2026. · jantar = raspored, plavo = vrijednosti (nikad se ne miješaju)', 16, '#555')

# A — stroj stanja
text(40, 110, 'A · stroj stanja gumba', 22, J)
def st(x, y, t, sub, col, bg):
    box(x, y, 260, 96, s=col, bg=bg); text(x + 14, y + 12, t, 20); text(x + 14, y + 44, sub, 14, '#444')
st(60, 160, 'MIROVANJE', 'gumb: ✎ Uredi raspored\nkartice žive, sve radi', B, '#e7f0ff')
st(60, 400, 'UREĐIVANJE', 'gumb: 💾 Spremi raspored (+broj)\nsadržaj kartica inert', J, '#fff3d6')
st(60, 640, 'SPREMAM', 'gumb: … Spremam (aria-busy)\nPUT /api/config/raspored', G, '#e6f6ea')
arrow(150, 256, 150, 400, J, label='klik ✎', lx=160, ly=315)
arrow(250, 640, 250, 496, R, label='400/409:\nostaje\nuređivanje', lx=160, ly=560)
arrow(110, 496, 110, 640, G, label='klik 💾\n(ima izmjena)', lx=0, ly=545)
arrow(320, 690, 480, 690, G); text(330, 700, '200 → „spremljeno"', 15, G)
box(480, 640, 180, 96, s=B, bg='#e7f0ff'); text(494, 656, 'MIROVANJE\n(novi raspored)', 18)
arrow(320, 420, 480, 260, '#666', label='Esc / ✕ Odustani\n→ vrati početni\n+ poruka [Vrati] 6 s', lx=335, ly=100)
box(480, 170, 180, 90, s='#666', bg='#f1f3f5'); text(494, 185, 'MIROVANJE\n(stari raspored)', 18)
arrow(320, 470, 480, 660, '#666', ss='dashed', label='💾 bez izmjena\n→ ništa se ne piše', lx=400, ly=500)
text(60, 770, '↺ Zadano: u uređivanju primijeni zadani raspored; Spremi tada šalje {zadano:true}\n→ ključ se briše, povijest bilježi „→ zadano".  beforeunload upozorava na nespremljeno.', 15, '#444')

# B — desktop
X = 760
text(X, 110, 'B · desktop ≥ 900 px — uređivanje (mreža 4 stupca)', 22, J)
box(X, 150, 820, 590, s=INK, bg='#0f172a', round=False)
box(X, 150, 820, 70, s=J, bg='#111827', round=False)
text(X + 16, 162, 'REGOČ postavke', 18, '#f1f5f9')
for dx, t, w in [(390, '▤ Sažmi', 86), (486, '↺ Zadano', 96), (592, '✕ Odustani', 106)]:
    box(X + dx - 100, 160, w, 32, s='#64748b', bg='#1e293b'); text(X + dx - 92, 166, t, 15, '#cbd5e1')
box(X + 610, 158, 190, 36, s=J, bg=J); text(X + 622, 166, '💾 Spremi raspored', 15, '#1a1205')
box(X + 788, 148, 24, 22, s=R, bg=R); text(X + 795, 150, '4', 14, '#fff')
text(X + 16, 198, '✎ UREĐIVANJE RASPOREDA · ⠿ povuci · ◢ veličina · Esc odustaje · vrijednosti zaključane', 13, J)
for i in range(20): box(X + i * 41, 216, 22, 6, s=J, bg=J, round=False, r=0, sw=1)
text(X + 16, 234, '01 Strop i vrata autonomije', 16, '#93c5fd')
def kart(x, y, w, h, naslov, mj, akt=False):
    box(x, y, w, h, s=J, bg='#1e293b', ss='solid' if akt else 'dashed', sw=3 if akt else 2)
    text(x + 10, y + 8, '⠿', 20, J); text(x + 36, y + 10, naslov, 14, '#60a5fa')
    box(x + w - 92, y + 8, 82, 22, s=J, bg='#3b2a0a'); text(x + w - 86, y + 11, mj, 13, J)
    for k in range(3): crta(x + 40, y + 50 + k * 16, w * 0.55, '#475569')
    text(x + w - 26, y + h - 28, '◢', 20, J)
kart(X + 16, 262, 390, 140, 'VRATA AUTONOMIJE', '½ · auto')
kart(X + 420, 262, 230, 200, 'HS', '¼ · 240 px', akt=True)
box(X + 16, 416, 390, 110, s=J, bg='#3b2a0a', ss='dashed'); text(X + 110, 458, 'mjesto pada (placeholder)', 15, J)
box(X + 470, 486, 300, 110, s=J, bg='#1e293b', sw=3); text(X + 480, 496, '⠿  USPOREDNI AGENTI (vučem)', 14, '#60a5fa')
text(X + 480, 526, 'prati prst/miš · nagib .6° · sjena', 13, '#cbd5e1')
arrow(X + 466, 540, X + 410, 480, J, ss='dashed')
text(X + 16, 616, 'pravila: samo unutar svoje skupine · širina 1–4 stupca · visina auto ili 160–1200 px (korak 40)\nsadržaj kartica inert (klizači, prekidači, „Spremi" vrijednosti ne reagiraju)\ntočkasta mreža = crtaći stol · zaglavlje s gumbom ljepljivo', 13, '#cbd5e1')
text(X + 16, 690, 'tipkovnica: ↑↓←→ pomak · Shift+←→ širina · Shift+↑↓ visina · A = prirodna visina · Esc', 13, '#cbd5e1')

# C — mobitel
X2 = 1640
text(X2, 110, 'C · mobitel 390 px — sažeto', 22, J)
box(X2, 150, 260, 560, s=INK, bg='#0f172a', sw=3)
for i, t in enumerate(['▤', '↺', '✕']): box(X2 + 10 + i * 50, 162, 44, 44, s='#64748b', bg='#1e293b'); text(X2 + 24 + i * 50, 172, t, 18, '#cbd5e1')
box(X2 + 162, 162, 88, 44, s=J, bg=J); text(X2 + 170, 175, '💾 Spremi', 14, '#1a1205')
text(X2 + 10, 214, '✎ UREĐIVANJE · vrijednosti zaključane', 11, J)
for i in range(7): box(X2 + i * 37, 232, 20, 5, s=J, bg=J, round=False, r=0, sw=1)
y = 250
for t in ['USPOREDNI AGENTI', 'POZIVI HINDSIGHTA', 'VRATA AUTONOMIJE', 'AGENTS & MODELS', 'KLASIFIKATOR', 'MEMORIJA (TEST)']:
    box(X2 + 10, y, 240, 50, s=J, bg='#1e293b', ss='dashed'); text(X2 + 18, y + 12, '⠿', 20, J); text(X2 + 44, y + 15, t, 13, '#60a5fa'); text(X2 + 222, y + 24, '◢', 16, J); y += 60
text(X2, 720, 'zaglavlje ljepljivo — 💾 uvijek pod palcem\nručke 44×44, touch-action:none samo na ručki\n(ostatak kartice skrola stranicu)\nsažeto = samo naslovi → kratak put vučenja\nkut mijenja samo visinu (1 stupac)', 14, '#444')

izlaz = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'uredivac-rasporeda.excalidraw')
json.dump({'type': 'excalidraw', 'version': 2, 'source': 'https://excalidraw.com', 'elements': E,
           'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}, open(izlaz, 'w'), ensure_ascii=False, indent=1)
print(len(E), 'elemenata →', izlaz)
