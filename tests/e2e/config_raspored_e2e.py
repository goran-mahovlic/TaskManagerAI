"""E2E uređivača rasporeda Config stranice (TASK-5170) na PRAVOJ ploči — Chromium + Firefox (pravi Gecko).

Svi događaji su POVJERLJIVI (isTrusted): miš i tipkovnica kroz Playwright (Chromium: CDP Input.*,
Firefox: Juggler — ulaz preglednika), dodir u Chromiumu kroz CDP Input.dispatchTouchEvent.
NEMA dispatchEvent-a ni sintetičkih PointerEvent-a. Granica: Playwright za Firefox nema
touch-move, pa se na mobilnom prikazu (390 px, has_touch) u Geckou vuče povjerljivim mišem, a
gumbi se diraju povjerljivim dodirom (touchscreen.tap).

Ploča se diže u PRIVREMENOJ instalaciji (nikad 17781): paket — TM_HOME + scripts/init-db.ts;
pogon — podmetnut HOME sa shemom prepisanom iz žive baze otvorene samo za čitanje. Raspored mapa
pogona NIJE u paketu (ADR-0001 O1.4): `--raspored` (ili TM_POGON_RASPORED) je mapa s `data/` i
`config/` RELATIVNO prema HOME, `--ziva-baza` (ili TM_POGON_BAZA) puna putanja žive baze.

  TMPDIR=~/.tmp python3 tests/e2e/config_raspored_e2e.py --nacin paket [--korijen DIR] [--snimke DIR]
  TMPDIR=~/.tmp python3 tests/e2e/config_raspored_e2e.py --nacin pogon --korijen DIR \
      --raspored <mapa pod HOME> --ziva-baza <baza pogona> [--snimke DIR]
(TMPDIR mora biti na disku — /tmp je tmpfs od 100 MB i renderer pada, nalaz TASK-5169 §11.)"""
import asyncio, json, os, random, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright

def arg(ime, zadano=None):
    return sys.argv[sys.argv.index(ime) + 1] if ime in sys.argv else zadano

NACIN = arg('--nacin', 'paket')
KORIJEN = os.path.abspath(arg('--korijen', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')))
SNIMKE = arg('--snimke')
RASPORED = arg('--raspored', os.environ.get('TM_POGON_RASPORED'))
ZIVA_BAZA = arg('--ziva-baza', os.environ.get('TM_POGON_BAZA'))
rez = []

def provjeri(preg, ime, uvjet, info=''):
    rez.append((preg, ime, bool(uvjet), info)); print(f"  {'PASS' if uvjet else 'FAIL'} [{preg}] {ime} {info}", flush=True)

# ── privremena ploča ──────────────────────────────────────────────────────────
def podigni():
    port = 21000 + random.randint(0, 15000)
    dom = tempfile.mkdtemp(prefix='t5170-', dir=os.path.expanduser('~/.tmp'))
    env = dict(os.environ)
    if NACIN == 'paket':
        os.makedirs(os.path.join(dom, 'config'))
        open(os.path.join(dom, 'config', 'features.json'), 'w').write('{}')
        env.update(TM_HOME=dom, REGOC_SPAWN_LEASE_DIR=os.path.join(dom, 'najmovi'), NODE_ENV='production', BUN_TEST='')
        subprocess.run(['bun', 'scripts/init-db.ts'], cwd=KORIJEN, env=env, check=True, capture_output=True)
        env.update(TM_PORT=str(port), REGOC_TASKWEBUI_PORT=str(port))
        baza = os.path.join(dom, 'data', 'tasks.db')
    else:
        if not (RASPORED and ZIVA_BAZA):
            raise SystemExit('--nacin pogon traži --raspored i --ziva-baza (ili TM_POGON_RASPORED / TM_POGON_BAZA)')
        for d in ('.tmp', os.path.join(RASPORED, 'data'), os.path.join(RASPORED, 'config')):
            os.makedirs(os.path.join(dom, d), exist_ok=True)
        ziva = sqlite3.connect('file:' + os.path.expanduser(ZIVA_BAZA) + '?mode=ro', uri=True)
        shema = [r[0] for r in ziva.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END")]
        ziva.close()
        baza = os.path.join(dom, RASPORED, 'data', os.path.basename(ZIVA_BAZA))
        t = sqlite3.connect(baza)
        for s in shema:
            try: t.execute(s)
            except Exception: pass
        t.commit(); t.close()
        env.update(HOME=dom, REGOC_TASKWEBUI_PORT=str(port))
    log = open(os.path.join(dom, 'ploca.log'), 'w')
    proc = subprocess.Popen(['bun', 'src/TaskWebUI.ts'], cwd=KORIJEN, env=env, stdout=log, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    for _ in range(200):
        try:
            if urllib.request.urlopen(url + '/api/config/raspored', timeout=2).status == 200: return proc, url, dom, baza
        except Exception: time.sleep(0.1)
    proc.kill(); raise SystemExit('ploča se nije podigla: ' + open(os.path.join(dom, 'ploca.log')).read()[-2000:])

def povijest(baza):
    c = sqlite3.connect('file:' + baza + '?mode=ro', uri=True)
    try: return c.execute('SELECT key FROM settings_history ORDER BY id').fetchall()
    finally: c.close()

def api(url, metoda='GET', tijelo=None):
    r = urllib.request.Request(url + '/api/config/raspored', method=metoda, data=None if tijelo is None else json.dumps(tijelo).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=5) as o: return o.status, json.loads(o.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

RED = """(sk)=>[...document.querySelectorAll('#info-grid > .info-card')].filter(c=>{let p=c;while(p&&!p.classList.contains('info-skupina'))p=p.previousElementSibling;return p&&p.id===sk}).map(c=>c.id)"""
async def red(pg, sk): return await pg.evaluate(RED, sk)

async def na_config(pg):
    b = pg.locator('.tab-btn[data-tab="info"]')
    if await b.is_visible(): await b.click()
    else: await pg.evaluate("switchTab('info')")  # mobilni izbornik — navigacija nije predmet testa
    await pg.wait_for_function("document.getElementById('tab-info').classList.contains('active') && window.CfgRaspored && !document.getElementById('info-grid').classList.contains('cr-ceka')")

async def vuci_misem(pg, od, do, koraka=14):
    """Vuče kao čovjek: miš ne izlazi iz prozora. Cilj izvan vidnog polja → do ruba (autoskrol), pa na cilj."""
    vis = pg.viewport_size['height']
    a = await pg.locator(od).bounding_box()
    x0, y0 = a['x'] + a['width'] / 2, a['y'] + a['height'] / 2
    await pg.mouse.move(x0, y0); await pg.mouse.down()
    b = await pg.locator(do).bounding_box()
    x1, y1 = b['x'] + 20, min(max(b['y'] + 20, 10), vis - 10)
    for i in range(1, koraka + 1):
        await pg.mouse.move(x0 + (x1 - x0) * i / koraka, y0 + (y1 - y0) * i / koraka); await pg.wait_for_timeout(16)
    for _ in range(150):  # autoskrol dok cilj ne uđe u prozor (najviše ~3 s)
        b = await pg.locator(do).bounding_box()
        if 10 <= b['y'] + 20 <= vis - 90: break
        await pg.mouse.move(x1, y1 + (1 if _ % 2 else -1) * 0.5); await pg.wait_for_timeout(20)
    await pg.mouse.move(b['x'] + 20, b['y'] + 20, steps=4); await pg.wait_for_timeout(16)
    await pg.mouse.up()

def prati(pg):
    zahtjevi = []
    pg.on('request', lambda r: zahtjevi.append((r.method, r.url.split('?')[0].split('127.0.0.1')[-1])) if r.method in ('PUT', 'POST') else None)
    return zahtjevi

async def desktop(p, ime, url, baza):
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    pg = await b.new_page(viewport={'width': 1440, 'height': 900})
    greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
    zahtjevi = prati(pg)
    await pg.goto(url + '/'); await na_config(pg)
    g = pg.locator('#cr-uredi')
    provjeri(ime, 'početno stanje: ✎ Uredi raspored, aria-pressed=false', (await g.inner_text()).startswith('✎') and await g.get_attribute('aria-pressed') == 'false')
    zadano1 = await red(pg, 'cfg-skupina-1')
    await g.click()
    provjeri(ime, 'klik → uređivanje (traka, 💾 Spremi, Osvježi skriven)', await pg.evaluate("document.body.classList.contains('cr-uredivanje')")
             and '💾' in await g.inner_text() and await pg.locator('#cr-traka').is_visible() and not await pg.locator('#info-refresh-btn').is_visible())
    # vrijednosti zaključane: pravi klik na klizač „Usporednih agenata"
    kl = pg.locator('#usp-strop')
    await kl.wait_for(state='attached', timeout=10000)
    v0 = await kl.input_value(); kb = await kl.bounding_box()
    await pg.mouse.click(kb['x'] + kb['width'] * 0.95, kb['y'] + kb['height'] / 2); await pg.wait_for_timeout(300)
    provjeri(ime, 'klizač vrijednosti u uređivanju NE reagira (inert), nijedan PUT vrijednosti', await kl.input_value() == v0
             and await pg.evaluate("!!document.getElementById('usp-strop').closest('[inert]')") and not [z for z in zahtjevi if '/api/config/' in z[1]], f'{v0}→{await kl.input_value()}')
    await vuci_misem(pg, '#info-autonomija-card .cr-hvat', '#info-concurrency-card')
    r1 = await red(pg, 'cfg-skupina-1')
    provjeri(ime, 'drag&drop mišem: Vrata autonomije na 1. mjesto', r1[0] == 'info-autonomija-card', str(r1))
    await vuci_misem(pg, '#info-concurrency-card .cr-hvat', '#info-agents-card')
    provjeri(ime, 'kartica ne prelazi u drugu skupinu, vučenje završeno', 'info-concurrency-card' in await red(pg, 'cfg-skupina-1')
             and not await pg.evaluate("document.body.classList.contains('cr-vuce') || !!document.querySelector('.cr-mjesto')"))
    await pg.locator('#info-concurrency-card').scroll_into_view_if_needed()
    k = await pg.locator('#info-concurrency-card .cr-kut').bounding_box(); kol = (await pg.locator('#info-grid').bounding_box())['width'] / 4
    await pg.mouse.move(k['x'] + 30, k['y'] + 30); await pg.mouse.down()
    for i in range(1, 11): await pg.mouse.move(k['x'] + 30 - kol * i / 10, k['y'] + 30 + 120 * i / 10); await pg.wait_for_timeout(16)
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{NACIN}_{ime}_1440_mijenjam.png')
    await pg.mouse.up()
    m = await pg.evaluate("(()=>{const c=document.getElementById('info-concurrency-card');return [c.dataset.crW, c.dataset.crH, Math.round(c.getBoundingClientRect().height)]})()")
    provjeri(ime, 'resize kutom: ½ → ¼ i visina u koracima od 40 px', m[0] == '1' and m[1] and int(m[1]) % 40 == 0 and abs(int(m[1]) - m[2]) <= 1, str(m))
    n = await g.get_attribute('data-izmjena')
    provjeri(ime, 'brojač izmjena na gumbu > 0', int(n) > 0, n)
    await pg.focus('#info-rag-card'); await pg.keyboard.press('Shift+ArrowLeft')
    provjeri(ime, 'tipkovnica: Shift+← smanjuje širinu', await pg.evaluate("document.getElementById('info-rag-card').dataset.crW") == '3')
    await pg.focus('#info-login-card'); await pg.keyboard.press('ArrowDown')
    provjeri(ime, 'tipkovnica: ↓ pomiče karticu', (await red(pg, 'cfg-skupina-3'))[1] == 'info-login-card')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{NACIN}_{ime}_1440_uredivanje.png')
    nacrt = await pg.evaluate('JSON.stringify(CfgRaspored.trenutni())')
    puts = len(zahtjevi)
    await pg.keyboard.press('Escape')
    provjeri(ime, 'Esc: izlaz bez spremanja, raspored vraćen, nula zahtjeva', not await pg.evaluate("document.body.classList.contains('cr-uredivanje')")
             and await red(pg, 'cfg-skupina-1') == zadano1 and len(zahtjevi) == puts)
    provjeri(ime, 'poruka „Poništeno" s gumbom Vrati', await pg.locator('#cr-poruka-gumb').is_visible())
    await pg.click('#cr-poruka-gumb')
    provjeri(ime, 'Vrati: nacrt i uređivanje se vraćaju', await pg.evaluate('JSON.stringify(CfgRaspored.trenutni())') == nacrt and await pg.evaluate("document.body.classList.contains('cr-uredivanje')"))
    async with pg.expect_response(lambda r: r.url.endswith('/api/config/raspored') and r.request.method == 'PUT') as odg:
        await g.click()
    await pg.wait_for_function("!document.body.classList.contains('cr-uredivanje')", timeout=5000)
    st, b1 = api(url)
    provjeri(ime, 'isti gumb sprema (PUT 200) i izlazi', (await odg.value).status == 200 and b1['raspored'] and not await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and (await g.inner_text()).startswith('✎'))
    provjeri(ime, 'audit: redak u settings_history samo za config.raspored', povijest(baza)[-1][0] == 'config.raspored' and all(k[0] in ('config.raspored', 'agents.max_concurrent') for k in povijest(baza)), str(povijest(baza)[-3:]))
    await pg.reload(); await na_config(pg)
    provjeri(ime, 'nakon osvježavanja raspored ostaje', (await red(pg, 'cfg-skupina-1'))[0] == 'info-autonomija-card' and await pg.evaluate("document.getElementById('info-concurrency-card').dataset.crW") == '1')
    puts = len([z for z in zahtjevi if z[0] == 'PUT'])
    await g.click(); await g.click(); await pg.wait_for_timeout(300)
    provjeri(ime, 'Spremi bez izmjena: nijedan zahtjev, ništa zapisano', len([z for z in zahtjevi if z[0] == 'PUT']) == puts and api(url)[1]['osnova'] == b1['osnova'])
    # drugi uređaj spremi u međuvremenu → 409, uređivanje ostaje otvoreno
    await g.click()
    await pg.focus('#info-rag-card'); await pg.keyboard.press('Shift+ArrowLeft')
    s2, _ = api(url, 'PUT', {'raspored': {'v': 1, 'redoslijed': ['info-rag-card'], 'kartice': {'info-rag-card': {'w': 4, 'h': 480}}}, 'osnova': b1['osnova'], 'by': 'drugi-uredaj'})
    await g.click(); await pg.wait_for_timeout(500)
    provjeri(ime, '409: drugi uređaj je spremio — poruka, uređivanje ostaje', s2 == 200 and await pg.evaluate("document.body.classList.contains('cr-uredivanje')")
             and await pg.evaluate("document.getElementById('cr-poruka').classList.contains('greska')")
             and ('drugom uređaju' in await pg.inner_text('#cr-poruka') or 'another device' in await pg.inner_text('#cr-poruka')))
    await pg.keyboard.press('Escape'); await pg.reload(); await na_config(pg)
    await g.click(); await pg.click('#cr-zadano')
    async with pg.expect_response(lambda r: r.url.endswith('/api/config/raspored') and r.request.method == 'PUT'):
        await g.click()
    await pg.wait_for_timeout(200)
    provjeri(ime, '↺ Zadano + Spremi: ključ obrisan, zadani raspored', api(url)[1]['raspored'] is None and await red(pg, 'cfg-skupina-1') == zadano1)
    await g.click()
    await pg.evaluate("document.getElementById('info-rag-card').dataset.crW='9'")
    puts = len(zahtjevi)
    await g.click(); await pg.wait_for_timeout(300)
    provjeri(ime, 'nevaljan raspored (w=9): odbijen, ostaje uređivanje, poruka greške', await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and await pg.evaluate("document.getElementById('cr-poruka').classList.contains('greska')") and len(zahtjevi) == puts)
    await pg.keyboard.press('Escape')
    provjeri(ime, 'bez JS grešaka', not greske, str(greske[:3]))
    await b.close()

async def zadrzi(s, pg, x, y):
    """Prst pred pad stane (~120 ms). Bez toga Chrome brzo otpuštanje (460 px / 200 ms) čita kao fling,
    a SLJEDEĆI dodir koji zaustavlja fling ne proizvodi click (izmjereno: „Sažmi" bez ijednog clicka)."""
    for _ in range(6):
        await s.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y}]}); await pg.wait_for_timeout(20)

async def mobitel(p, ime, url, baza):
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=(ime == 'chromium'))
    pg = await ctx.new_page(); greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
    await pg.goto(url + '/'); await na_config(pg)
    await pg.locator('#cr-uredi').scroll_into_view_if_needed()
    await pg.locator('#cr-uredi').tap(); await pg.wait_for_timeout(350)  # mobilna emulacija isporuči click nakon tap()
    provjeri(ime + '-mob', 'dodir gumba → uređivanje, sažeto uključeno', await pg.evaluate("document.body.classList.contains('cr-uredivanje') && document.body.classList.contains('cr-sazeto')"))
    provjeri(ime + '-mob', 'ručke: touch-action none, ≥44 px; gumbi ≥44 px', await pg.evaluate("""(()=>{const h=document.querySelector('#info-grid .cr-hvat'),r=h.getBoundingClientRect();
      const g=['cr-sazmi','cr-zadano','cr-odustani','cr-uredi'].map(i=>document.getElementById(i).getBoundingClientRect());
      return getComputedStyle(h).touchAction==='none'&&r.width>=44&&r.height>=44&&g.every(x=>x.height>=44&&x.width>=44)})()"""))
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{NACIN}_{ime}_390_uredivanje.png')
    await pg.evaluate("window.scrollTo(0, document.getElementById('cfg-skupina-2').getBoundingClientRect().top + scrollY - 160)")
    await pg.wait_for_timeout(100)
    a = await pg.locator('#info-modelsetup-card .cr-hvat').bounding_box(); c = await pg.locator('#info-agents-card').bounding_box()
    x0, y0, x1, y1 = a['x'] + 22, a['y'] + 22, c['x'] + 60, c['y'] + 8
    if ime == 'chromium':
        s = await ctx.new_cdp_session(pg)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
        for i in range(1, 13):
            await s.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / 12, 'y': y0 + (y1 - y0) * i / 12}]}); await pg.wait_for_timeout(16)
        await zadrzi(s, pg, x1, y1)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        nacin = 'CDP touch'
    else:
        await pg.mouse.move(x0, y0); await pg.mouse.down()
        for i in range(1, 13): await pg.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await pg.wait_for_timeout(16)
        await pg.mouse.up()
        nacin = 'povjerljivi miš (Gecko nema touch-move u Playwrightu)'
    r2 = await red(pg, 'cfg-skupina-2')
    provjeri(ime + '-mob', f'povučeno ({nacin}): Podržani modeli na 1. mjesto', r2[0] == 'info-modelsetup-card', str(r2))
    await pg.wait_for_timeout(400)
    await pg.locator('#cr-sazmi').tap(); await pg.wait_for_timeout(350)
    provjeri(ime + '-mob', 'Sažmi isključuje sažeti prikaz', not await pg.evaluate("document.body.classList.contains('cr-sazeto')"))
    await pg.locator('#info-rag-card .cr-kut').scroll_into_view_if_needed()
    kb = await pg.locator('#info-rag-card .cr-kut').bounding_box()
    w0 = await pg.evaluate("document.getElementById('info-rag-card').dataset.crW")
    kx, ky = kb['x'] + 22, kb['y'] + 22
    if ime == 'chromium':
        await s.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': kx, 'y': ky}]})
        for i in range(1, 9): await s.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': kx - 15 * i, 'y': ky - 25 * i}]}); await pg.wait_for_timeout(16)
        await zadrzi(s, pg, kx - 120, ky - 200)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    else:
        await pg.mouse.move(kx, ky); await pg.mouse.down()
        for i in range(1, 9): await pg.mouse.move(kx - 15 * i, ky - 25 * i); await pg.wait_for_timeout(16)
        await pg.mouse.up()
    m = await pg.evaluate("[document.getElementById('info-rag-card').dataset.crW, document.getElementById('info-rag-card').dataset.crH]")
    provjeri(ime + '-mob', 'na mobitelu kut mijenja samo visinu (širina ostaje)', m[0] == w0 and m[1] is not None, str(m))
    sw = await pg.evaluate('document.documentElement.scrollWidth')
    provjeri(ime + '-mob', 'nema vodoravnog preljeva na 390 px', sw <= 390, f'scrollWidth={sw}')
    await pg.wait_for_timeout(400)
    await pg.evaluate("window.scrollTo(0, 0)")
    await pg.locator('#cr-uredi').tap(); await pg.wait_for_timeout(700)
    st, bb = api(url)
    ro = (bb.get('raspored') or {}).get('redoslijed') or []
    provjeri(ime + '-mob', 'dodir istog gumba sprema (Podržani modeli ispred Agenata)', 'info-modelsetup-card' in ro and 'info-agents-card' in ro
             and ro.index('info-modelsetup-card') < ro.index('info-agents-card'), str(ro[:6]))
    provjeri(ime + '-mob', 'bez JS grešaka', not greske, str(greske[:3]))
    api(url, 'PUT', {'zadano': True, 'by': 'e2e'})
    await b.close()

async def main():
    proc, url, dom, baza = podigni()
    print(f'== ploča ({NACIN}) {url}  baza {baza}', flush=True)
    try:
        async with async_playwright() as p:
            for ime in ('chromium', 'firefox'):
                print('==', ime, 'desktop', flush=True); await desktop(p, ime, url, baza)
                print('==', ime, 'mobitel', flush=True); await mobitel(p, ime, url, baza)
    finally:
        proc.kill(); shutil.rmtree(dom, ignore_errors=True)
    pr = sum(1 for r in rez if r[2]); print(f'\n{pr} pass, {len(rez) - pr} fail')
    sys.exit(0 if pr == len(rez) else 1)

asyncio.run(main())
