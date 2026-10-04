"""QA TASK-5171 — neovisna provjera uređivača rasporeda Config stranice (TASK-5170).

Pravi preglednici: Chromium i Firefox (Gecko), desktop 1440 i mobitel 390 s dodirom.
Ulaz je POVJERLJIV (Playwright miš/tipkovnica/tap; dodirno vučenje u Chromiumu kroz CDP
Input.dispatchTouchEvent). Firefox u Playwrightu nema touch-move → na mobitelu Gecko vuče mišem,
a gumbe dira pravim tapom.

Razlika prema autorovu tests/e2e/config_raspored_e2e.py: ovdje se gađa POSTOJEĆA ploča (i živi
pogon 17781), provjerava se gumb Odustani (ne samo Esc), cijela tablica settings prije/poslije,
redci settings_history, drugi otvoreni prozor (WS) i završno stanje = početno (Zadano).

  TMPDIR=~/.tmp python3 tests/e2e/qa_5171_config_raspored.py --url http://127.0.0.1:17781 \
      --baza ~/.claude/regoc/data/regoc.db --oznaka pogon --snimke DIR
  TMPDIR=~/.tmp python3 tests/e2e/qa_5171_config_raspored.py --paket KORIJEN --oznaka paket --snimke DIR
"""
import asyncio, json, os, random, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright

def arg(ime, zadano=None):
    return sys.argv[sys.argv.index(ime) + 1] if ime in sys.argv else zadano

URL, BAZA, OZNAKA = arg('--url'), arg('--baza'), arg('--oznaka', 'ploca')
PAKET, SNIMKE = arg('--paket'), arg('--snimke')
rez = []

def provjeri(preg, ime, uvjet, info=''):
    rez.append((preg, ime, bool(uvjet), info))
    print(f"  {'PASS' if uvjet else 'FAIL'} [{preg}] {ime} {info}", flush=True)

def podigni_paket(korijen):
    port = 22000 + random.randint(0, 9000)
    dom = tempfile.mkdtemp(prefix='qa5171-', dir=os.path.expanduser('~/.tmp'))
    os.makedirs(os.path.join(dom, 'config'))
    open(os.path.join(dom, 'config', 'features.json'), 'w').write('{}')
    env = dict(os.environ, TM_HOME=dom, REGOC_SPAWN_LEASE_DIR=os.path.join(dom, 'najmovi'), NODE_ENV='production', BUN_TEST='')
    subprocess.run(['bun', 'scripts/init-db.ts'], cwd=korijen, env=env, check=True, capture_output=True)
    env.update(TM_PORT=str(port), REGOC_TASKWEBUI_PORT=str(port))
    proc = subprocess.Popen(['bun', 'src/TaskWebUI.ts'], cwd=korijen, env=env, stdout=open(os.path.join(dom, 'ploca.log'), 'w'), stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    for _ in range(200):
        try:
            if urllib.request.urlopen(url + '/api/config/raspored', timeout=2).status == 200:
                return proc, url, dom, os.path.join(dom, 'data', 'tasks.db')
        except Exception: time.sleep(0.1)
    proc.kill(); raise SystemExit('paket se nije podigao')

def baza_ro():
    return sqlite3.connect('file:' + os.path.expanduser(BAZA) + '?mode=ro', uri=True)

def postavke():
    """Sve postavke OSIM rasporeda — to se ne smije mijenjati."""
    c = baza_ro()
    try: return dict(c.execute("SELECT key, value FROM settings WHERE key != 'config.raspored'").fetchall())
    finally: c.close()

def povijest_od(id0):
    c = baza_ro()
    try: return c.execute('SELECT id, key, changed_by, source FROM settings_history WHERE id > ? ORDER BY id', (id0,)).fetchall()
    finally: c.close()

def zadnji_id():
    c = baza_ro()
    try: return c.execute('SELECT COALESCE(MAX(id), 0) FROM settings_history').fetchone()[0]
    finally: c.close()

def api_raspored():
    with urllib.request.urlopen(URL + '/api/config/raspored', timeout=5) as o: return json.loads(o.read())

RED = """(sk)=>[...document.querySelectorAll('#info-grid > .info-card')].filter(c=>{let p=c;while(p&&!p.classList.contains('info-skupina'))p=p.previousElementSibling;return p&&p.id===sk}).map(c=>c.id)"""
async def red(pg, sk): return await pg.evaluate(RED, sk)
async def uredujem(pg): return await pg.evaluate("document.body.classList.contains('cr-uredivanje')")
async def sirina(pg, id_): return await pg.evaluate(f"document.getElementById('{id_}').dataset.crW")

async def na_config(pg):
    b = pg.locator('.tab-btn[data-tab="info"]')
    if await b.is_visible(): await b.click()
    else: await pg.evaluate("switchTab('info')")  # mobilni izbornik — navigacija nije predmet QA
    await pg.wait_for_function("document.getElementById('tab-info').classList.contains('active') && window.CfgRaspored && !document.getElementById('info-grid').classList.contains('cr-ceka')")
    await pg.wait_for_timeout(300)

async def vuci_misem(pg, od, do):
    await pg.locator(od).scroll_into_view_if_needed()
    a = await pg.locator(od).bounding_box(); b = await pg.locator(do).bounding_box()
    x0, y0 = a['x'] + a['width'] / 2, a['y'] + a['height'] / 2
    x1, y1 = b['x'] + 20, max(b['y'] + 20, 10)
    await pg.mouse.move(x0, y0); await pg.mouse.down()
    for i in range(1, 15):
        await pg.mouse.move(x0 + (x1 - x0) * i / 14, y0 + (y1 - y0) * i / 14); await pg.wait_for_timeout(16)
    await pg.wait_for_timeout(60); await pg.mouse.up()

async def suzi_kutom(pg, id_):
    """Kut kartice: lijevo za jedan stupac i dolje 120 px."""
    await pg.locator(f'#{id_}').scroll_into_view_if_needed()
    k = await pg.locator(f'#{id_} .cr-kut').bounding_box(); kol = (await pg.locator('#info-grid').bounding_box())['width'] / 4
    x, y = k['x'] + k['width'] / 2, k['y'] + k['height'] / 2
    await pg.mouse.move(x, y); await pg.mouse.down()
    for i in range(1, 11): await pg.mouse.move(x - kol * i / 10, y + 120 * i / 10); await pg.wait_for_timeout(16)
    await pg.mouse.up()

def biljezi(pg):
    z = []
    pg.on('request', lambda r: z.append((r.method, r.url.split('?')[0].split(':', 2)[-1])) if r.method in ('PUT', 'POST', 'PATCH', 'DELETE') else None)
    return z

async def spremi(pg):
    async with pg.expect_response(lambda r: r.url.endswith('/api/config/raspored') and r.request.method == 'PUT', timeout=8000) as o:
        await pg.click('#cr-uredi')
    await pg.wait_for_function("!document.body.classList.contains('cr-uredivanje')", timeout=5000)
    return (await o.value).status

async def desktop(p, ime):
    tag = f'{ime}-1440'
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    ctx = await b.new_context(viewport={'width': 1440, 'height': 900})
    pg = await ctx.new_page(); greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
    drugi = await ctx.new_page()  # drugi prozor iste ploče — mora dobiti raspored kroz WS
    z = biljezi(pg)
    await pg.goto(URL + '/'); await na_config(pg); await drugi.goto(URL + '/'); await na_config(drugi)
    s0, h0 = postavke(), zadnji_id()
    zad1, zad3 = await red(pg, 'cfg-skupina-1'), await red(pg, 'cfg-skupina-3')
    w0 = await sirina(pg, 'info-concurrency-card')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_1_prije.png', full_page=True)

    # ── Odustani (gumb) ──
    await pg.click('#cr-uredi')
    provjeri(tag, 'Uredi → uređivanje, gumb postaje Spremi', await uredujem(pg) and '💾' in await pg.inner_text('#cr-uredi'))
    await vuci_misem(pg, '#info-autonomija-card .cr-hvat', '#info-concurrency-card')
    await suzi_kutom(pg, 'info-concurrency-card')
    r = await red(pg, 'cfg-skupina-1')
    provjeri(tag, 'okvir se pomiče (vučenje ručkom) i mijenja veličinu (kut)', r[0] == 'info-autonomija-card' and await sirina(pg, 'info-concurrency-card') != w0, f'{r[:2]} w {w0}→{await sirina(pg, "info-concurrency-card")}')
    n = len(z)
    await pg.locator('#cr-odustani').scroll_into_view_if_needed(); await pg.click('#cr-odustani')
    await pg.wait_for_timeout(300)
    provjeri(tag, 'Odustani: izlaz, raspored vraćen, NULA zahtjeva', not await uredujem(pg) and await red(pg, 'cfg-skupina-1') == zad1 and await sirina(pg, 'info-concurrency-card') == w0 and len(z) == n, str(z[n:]))
    await pg.reload(); await na_config(pg)
    provjeri(tag, 'Odustani: nakon osvježavanja i dalje početni raspored', await red(pg, 'cfg-skupina-1') == zad1)

    # ── Esc ──
    await pg.click('#cr-uredi'); await vuci_misem(pg, '#info-autonomija-card .cr-hvat', '#info-concurrency-card')
    n = len(z); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
    provjeri(tag, 'Esc: izlaz, raspored vraćen, NULA zahtjeva', not await uredujem(pg) and await red(pg, 'cfg-skupina-1') == zad1 and len(z) == n)
    provjeri(tag, 'Odustani/Esc: settings_history bez novog retka', povijest_od(h0) == [], str(povijest_od(h0)))

    # ── Spremi istim gumbom ──
    await pg.click('#cr-uredi')
    await vuci_misem(pg, '#info-autonomija-card .cr-hvat', '#info-concurrency-card')
    await suzi_kutom(pg, 'info-concurrency-card')
    await pg.focus('#info-login-card'); await pg.keyboard.press('ArrowDown')
    ocek1, ocek3, w1 = await red(pg, 'cfg-skupina-1'), await red(pg, 'cfg-skupina-3'), await sirina(pg, 'info-concurrency-card')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_2_uredivanje.png', full_page=True)
    st = await spremi(pg)
    provjeri(tag, 'isti gumb Spremi → PUT 200, izlaz iz uređivanja', st == 200 and (await pg.inner_text('#cr-uredi')).startswith('✎'), f'HTTP {st}')
    puti = [x for x in z if x[0] != 'GET']
    provjeri(tag, 'jedini pisući zahtjev je PUT /api/config/raspored', all(x[1].endswith('/api/config/raspored') for x in puti), str(puti))
    await pg.reload(); await na_config(pg)
    provjeri(tag, 'nakon osvježavanja raspored ostaje (redoslijed + širina)', await red(pg, 'cfg-skupina-1') == ocek1 and await red(pg, 'cfg-skupina-3') == ocek3 and await sirina(pg, 'info-concurrency-card') == w1, f'{ocek1[:2]} w={w1}')
    try:
        await drugi.wait_for_function(f"({RED})('cfg-skupina-1')[0] === 'info-autonomija-card'", timeout=5000); ws = True
    except Exception: ws = False
    provjeri(tag, 'drugi otvoreni prozor dobiva novi raspored bez osvježavanja (WS)', ws)
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_3_poslije_osvjezavanja.png', full_page=True)
    hist = povijest_od(h0)
    provjeri(tag, 'audit: settings_history ima redak config.raspored, nijedan drugi ključ', len(hist) >= 1 and all(h[1] == 'config.raspored' for h in hist), str(hist))
    provjeri(tag, 'vrijednosti postavki nepromijenjene (cijela tablica settings)', postavke() == s0, f'{len(s0)} ključeva')

    # ── Zadano ──
    h1 = zadnji_id()
    await pg.click('#cr-uredi'); await pg.click('#cr-zadano')
    provjeri(tag, '↺ Zadano odmah prikazuje zadani raspored', await red(pg, 'cfg-skupina-1') == zad1, str((await red(pg, 'cfg-skupina-1'))[:2]))
    st = await spremi(pg)
    await pg.reload(); await na_config(pg)
    provjeri(tag, 'Zadano + Spremi: API raspored=null, nakon osvježavanja zadani raspored', st == 200 and api_raspored()['raspored'] is None and await red(pg, 'cfg-skupina-1') == zad1 and await red(pg, 'cfg-skupina-3') == zad3 and await sirina(pg, 'info-concurrency-card') == w0)
    provjeri(tag, 'audit: vraćanje na zadano zabilježeno', [h[1] for h in povijest_od(h1)] == ['config.raspored'], str(povijest_od(h1)))
    provjeri(tag, 'vrijednosti postavki i dalje nepromijenjene', postavke() == s0)
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_4_zadano.png', full_page=True)
    provjeri(tag, 'bez JS grešaka', not greske, str(greske[:3]))
    await b.close()

async def mobitel(p, ime):
    tag = f'{ime}-390'
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=(ime == 'chromium'))
    pg = await ctx.new_page(); greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
    z = biljezi(pg)
    await pg.goto(URL + '/'); await na_config(pg)
    s0, h0 = postavke(), zadnji_id()
    zad2 = await red(pg, 'cfg-skupina-2')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_1_prije.png')
    cdp = await ctx.new_cdp_session(pg) if ime == 'chromium' else None

    async def tapni(sel):
        await pg.locator(sel).scroll_into_view_if_needed(); await pg.locator(sel).tap(); await pg.wait_for_timeout(400)

    async def vuci(od, do):
        await pg.evaluate("window.scrollTo(0, document.getElementById('cfg-skupina-2').getBoundingClientRect().top + scrollY - 160)")
        await pg.wait_for_timeout(150)
        a = await pg.locator(od).bounding_box(); c = await pg.locator(do).bounding_box()
        x0, y0, x1, y1 = a['x'] + a['width'] / 2, a['y'] + a['height'] / 2, c['x'] + 60, c['y'] + 8
        if cdp:
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
            for i in range(1, 13):
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / 12, 'y': y0 + (y1 - y0) * i / 12}]}); await pg.wait_for_timeout(16)
            for _ in range(6):  # prst stane prije podizanja — inače Chrome to čita kao fling
                await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x1, 'y': y1}]}); await pg.wait_for_timeout(20)
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        else:
            await pg.mouse.move(x0, y0); await pg.mouse.down()
            for i in range(1, 13): await pg.mouse.move(x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await pg.wait_for_timeout(16)
            await pg.mouse.up()
        await pg.wait_for_timeout(400)

    nacin = 'CDP dodir' if cdp else 'miš (Gecko bez touch-move)'
    # Odustani dodirom
    await tapni('#cr-uredi')
    provjeri(tag, 'dodir Uredi → uređivanje', await uredujem(pg))
    await vuci('#info-modelsetup-card .cr-hvat', '#info-agents-card')
    provjeri(tag, f'vučenje ({nacin}) pomiče okvir', (await red(pg, 'cfg-skupina-2'))[0] == 'info-modelsetup-card', str((await red(pg, 'cfg-skupina-2'))[:2]))
    n = len(z); await tapni('#cr-odustani')
    provjeri(tag, 'dodir Odustani: izlaz, vraćeno, NULA zahtjeva', not await uredujem(pg) and await red(pg, 'cfg-skupina-2') == zad2 and len(z) == n)
    # Spremi dodirom
    await tapni('#cr-uredi'); await vuci('#info-modelsetup-card .cr-hvat', '#info-agents-card')
    ocek = await red(pg, 'cfg-skupina-2')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_2_uredivanje.png')
    await pg.evaluate('window.scrollTo(0,0)')
    async with pg.expect_response(lambda r: r.url.endswith('/api/config/raspored') and r.request.method == 'PUT', timeout=8000) as o:
        await tapni('#cr-uredi')
    st = (await o.value).status
    await pg.reload(); await na_config(pg)
    provjeri(tag, 'dodir Spremi → 200; nakon osvježavanja raspored ostaje', st == 200 and await red(pg, 'cfg-skupina-2') == ocek and ocek[0] == 'info-modelsetup-card', f'HTTP {st}')
    if SNIMKE:
        await pg.evaluate("window.scrollTo(0, document.getElementById('cfg-skupina-2').getBoundingClientRect().top + scrollY - 80)")
        await pg.screenshot(path=f'{SNIMKE}/{OZNAKA}_{tag}_3_poslije_osvjezavanja.png')
    hist = povijest_od(h0)
    provjeri(tag, 'audit samo config.raspored; settings nepromijenjen', hist and all(h[1] == 'config.raspored' for h in hist) and postavke() == s0, str(hist))
    sw = await pg.evaluate('document.documentElement.scrollWidth')
    provjeri(tag, 'nema vodoravnog preljeva', sw <= 390, f'scrollWidth={sw}')
    # Zadano dodirom
    await pg.evaluate('window.scrollTo(0,0)')
    await tapni('#cr-uredi'); await tapni('#cr-zadano')
    async with pg.expect_response(lambda r: r.url.endswith('/api/config/raspored') and r.request.method == 'PUT', timeout=8000):
        await tapni('#cr-uredi')
    await pg.reload(); await na_config(pg)
    provjeri(tag, 'dodir Zadano + Spremi: raspored=null, zadani redoslijed', api_raspored()['raspored'] is None and await red(pg, 'cfg-skupina-2') == zad2)
    provjeri(tag, 'bez JS grešaka', not greske, str(greske[:3]))
    await b.close()

async def main():
    global URL, BAZA
    proc = dom = None
    if PAKET:
        proc, URL, dom, BAZA = podigni_paket(PAKET)
    print(f'== {OZNAKA} {URL}  baza {BAZA}', flush=True)
    poc = api_raspored()['raspored']
    if poc is not None: raise SystemExit('početni raspored nije zadani — ne diram tuđi raspored')
    try:
        async with async_playwright() as p:
            for ime in ('chromium', 'firefox'):
                print('==', ime, 'desktop', flush=True); await desktop(p, ime)
                print('==', ime, 'mobitel', flush=True); await mobitel(p, ime)
        provjeri('kraj', 'završno stanje = početno (raspored null)', api_raspored()['raspored'] is None)
    finally:
        if proc: proc.kill(); shutil.rmtree(dom, ignore_errors=True)
    pr = sum(1 for r in rez if r[2]); print(f'\n{pr} pass, {len(rez) - pr} fail')
    sys.exit(0 if pr == len(rez) else 1)

asyncio.run(main())
