"""E2E kartice „Vrijednost korisničkih upita — cjenik S1–S6" i chipa ljudskog rada (TASK-5230).

Kvar (vlasnik, 04.10.2026.): kartica vječno „Računam…", „Osvježi" ne radi, projekti ne pokazuju
rad čovjeka. Uzrok: `vrijednost_inputa.py` traje 68 s, ruta ga je zvala sinkrono, a Bun
`idleTimeout` (10 s) prekida vezu → ERR_EMPTY_RESPONSE.

Ovaj test podmeće LAŽNI izračun koji traje 12 s (dulje od idleTimeouta) i broji svoja pokretanja,
pa na PRAVOJ ploči u Chromiumu i Firefoxu (pravi Gecko) provjerava:
  1. hladno (bez keša): „Računam u pozadini…", pa tablica — nikad vječni „Računam…" ni prekid veze;
  2. „Osvježi" (povjerljiv klik): tablica ostaje vidljiva, stiže NOVA brojka, točno jedan novi izračun;
  3. chip ∑ na kartici projekta pokazuje vrijednost ljudskog rada iz poProjektu, „bez PDV-a" u opisu;
  4. restart ploče: keš s diska → brojka u kartici < 5 s.
Svi klikovi su povjerljivi (Playwright: CDP Input.* / Juggler), bez dispatchEvent-a.
Ploča se diže u PRIVREMENOJ instalaciji (nikad 17781).

  TMPDIR=~/.tmp python3 tests/e2e/vrijednost_inputa_e2e.py --nacin pogon|paket [--korijen DIR]
      [--pogon-raspored REL]

Način `pogon` oponaša živu instalaciju domaćina: `--pogon-raspored` (ili `TM_POGON_RASPORED`) je
mapa te instalacije relativno prema $HOME — paket je ne zna i nema zadanu vrijednost (ADR-0001 O1.4).
"""
import asyncio, json, os, random, sqlite3, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright

def arg(ime, zadano=None):
    return sys.argv[sys.argv.index(ime) + 1] if ime in sys.argv else zadano

NACIN = arg('--nacin', 'pogon')
KORIJEN = os.path.abspath(arg('--korijen', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')))
POGON_RASPORED = arg('--pogon-raspored', os.environ.get('TM_POGON_RASPORED', '')).strip('/')
SPORO_S = 12
rez = []

def provjeri(preg, ime, uvjet, info=''):
    rez.append((preg, ime, bool(uvjet), info)); print(f"  {'PASS' if uvjet else 'FAIL'} [{preg}] {ime} {info}", flush=True)

LAZNI = r'''
import json, os, sys, time
dom = os.environ["T5230_DOM"]
br = os.path.join(dom, "pokretanja")
n = int(open(br).read()) + 1 if os.path.exists(br) else 1
open(br, "w").write(str(n))
time.sleep(float(os.environ.get("T5230_SPORO", "12")))
pid = open(os.path.join(dom, "projekt")).read().strip() if os.path.exists(os.path.join(dom, "projekt")) else "PRJ-X"
raz = {"S1": 10, "S2": 5, "S3": 2, "S4": 1, "S5": 0, "S6": 1}
print(json.dumps({
  "cjenik": {"S1": 0.05, "S2": 0.2, "S3": 1, "S4": 5, "S5": 15, "S6": 50},
  "poKorisniku": {"Korisnik A": {"eur": 100.0 * n, "upita": 1000 * n, "razredi": raz}},
  "poProjektu": {pid: {"naziv": "E2E projekt", "eur": 123.45, "upita": 19, "razredi": raz,
                       "poKorisniku": {"Korisnik A": {"eur": 123.45, "upita": 19}}}},
  "upita": 1000 * n, "ukupnoEur": 100.0 * n, "razdoblje": ["2026-09-01", "2026-10-04"]}))
'''

def pripremi():
    dom = tempfile.mkdtemp(prefix='t5230-', dir=os.path.expanduser('~/.tmp'))
    open(os.path.join(dom, 'lazni_vrijednost.py'), 'w').write(LAZNI)
    env = dict(os.environ)
    env.update(T5230_DOM=dom, T5230_SPORO=str(SPORO_S), TM_VRIJEDNOST_SCRIPT=os.path.join(dom, 'lazni_vrijednost.py'))
    if NACIN == 'paket':
        os.makedirs(os.path.join(dom, 'config'))
        open(os.path.join(dom, 'config', 'features.json'), 'w').write('{}')
        env.update(TM_HOME=dom, REGOC_SPAWN_LEASE_DIR=os.path.join(dom, 'najmovi'), NODE_ENV='production', BUN_TEST='')
        subprocess.run(['bun', 'scripts/init-db.ts'], cwd=KORIJEN, env=env, check=True, capture_output=True)
        kes = os.path.join(dom, 'data', 'vrijednost_inputa_kes.json')
    else:
        if not POGON_RASPORED:
            sys.exit('--nacin pogon traži --pogon-raspored REL (mapa žive instalacije relativno prema $HOME)')
        podaci = os.path.join(POGON_RASPORED, 'data')
        for d in ('.tmp', podaci, os.path.join(POGON_RASPORED, 'config')):
            os.makedirs(os.path.join(dom, d), exist_ok=True)
        ziva = sqlite3.connect('file:' + os.path.join(os.path.expanduser('~'), podaci, 'regoc.db') + '?mode=ro', uri=True)
        shema = [r[0] for r in ziva.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END")]
        ziva.close()
        t = sqlite3.connect(os.path.join(dom, podaci, 'regoc.db'))
        for s in shema:
            try: t.execute(s)
            except Exception: pass
        t.commit(); t.close()
        env.update(HOME=dom)
        kes = os.path.join(dom, podaci, 'vrijednost_inputa_kes.json')
    return dom, env, kes

def podigni(dom, env):
    port = 21000 + random.randint(0, 15000)
    env = dict(env); env.update(TM_PORT=str(port), REGOC_TASKWEBUI_PORT=str(port))
    log = open(os.path.join(dom, f'ploca-{port}.log'), 'w')
    proc = subprocess.Popen(['bun', 'src/TaskWebUI.ts'], cwd=KORIJEN, env=env, stdout=log, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    for _ in range(300):
        try:
            if urllib.request.urlopen(url + '/api/projects', timeout=2).status == 200: return proc, url
        except Exception: time.sleep(0.1)
    proc.kill(); raise SystemExit('ploča se nije podigla: ' + open(log.name).read()[-2000:])

def napravi_projekt(url, dom):
    r = urllib.request.Request(url + '/api/projects', method='POST', data=json.dumps({'name': 'E2E projekt 5230', 'description': 'e2e'}).encode(),
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=5) as o: p = json.loads(o.read())
    pid = p.get('id') or (p.get('project') or {}).get('id')
    open(os.path.join(dom, 'projekt'), 'w').write(pid)
    return pid

def pokretanja(dom):
    p = os.path.join(dom, 'pokretanja')
    return int(open(p).read()) if os.path.exists(p) else 0

def ima(t, hr, en):
    """Ploča pogona je zadano na hrvatskom, paket na engleskom — brojka/tekst u bilo kojem od njih."""
    return hr in t or en in t

BOX = "(document.getElementById('vrijednost-box')||{}).innerText||''"
INFO = "(document.getElementById('vrijednost-izvor')||{}).innerText||''"

async def preglednik(p, ime):
    return await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))

async def jedan(p, ime):
    dom, env, kes = pripremi()
    proc, url = podigni(dom, env)
    try:
        pid = napravi_projekt(url, dom)
        b = await preglednik(p, ime)
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
        prazni = []; pg.on('requestfailed', lambda r: prazni.append(r.url) if 'vrijednost' in r.url else None)
        await pg.goto(url + '/'); await pg.wait_for_timeout(800)

        # 1. hladno
        t0 = time.time()
        await pg.locator('.tab-btn[data-tab="potrosnja"]').click()
        await pg.wait_for_timeout(1500)
        prvi = await pg.evaluate(BOX)
        provjeri(ime, 'hladno: odmah „Računam…" (izračun traje %d s)' % SPORO_S, 'Računam' in prvi or 'Computing' in prvi, repr(prvi[:60]))
        vidjeno_nedostupan = False; stiglo = None
        for _ in range(int((SPORO_S + 20) / 0.5)):
            t = await pg.evaluate(BOX)
            if 'nije dostupan' in t or 'unavailable' in t: vidjeno_nedostupan = True
            if 'Korisnik A' in t: stiglo = time.time() - t0; break
            await pg.wait_for_timeout(500)
        provjeri(ime, 'hladno: tablica stigne iako izračun traje dulje od idleTimeouta (10 s)', stiglo is not None, f'{stiglo and round(stiglo, 1)} s')
        provjeri(ime, 'hladno: nikad „nedostupan", nijedan prekinut zahtjev', not vidjeno_nedostupan and not prazni, str(prazni[:2]))
        tekst = await pg.evaluate(BOX)
        provjeri(ime, 'tablica: 1.000 upita, 100,00 € i cjenik bez PDV-a', ima(tekst, '1.000', '1,000') and ima(tekst, '100,00 €', '100.00 €') and ima(tekst, 'bez PDV-a', 'excl. VAT'))
        provjeri(ime, 'hladno: točno jedan izračun', pokretanja(dom) == 1, str(pokretanja(dom)))

        # 2. Osvježi (donja brana 20 s od zadnjeg izračuna)
        await pg.wait_for_timeout(21000)
        t1 = time.time()
        await pg.locator('#vrijednost-refresh-btn').click()
        await pg.wait_for_timeout(1200)
        za_vrijeme = await pg.evaluate(BOX); info = await pg.evaluate(INFO)
        provjeri(ime, 'Osvježi: tablica ostaje vidljiva dok se računa, „osvježavam…"', 'Korisnik A' in za_vrijeme and ima(info, 'osvježavam', 'refreshing'), repr(info))
        nova = None
        for _ in range(int((SPORO_S + 20) / 0.5)):
            if ima(await pg.evaluate(BOX), '2.000', '2,000'): nova = time.time() - t1; break
            await pg.wait_for_timeout(500)
        info = await pg.evaluate(INFO)
        provjeri(ime, 'Osvježi: stigne NOVA brojka (2.000 upita) bez ponovnog klika', nova is not None, f'{nova and round(nova, 1)} s')
        provjeri(ime, 'Osvježi: info više ne kaže „osvježavam…"', not ima(info, 'osvježavam', 'refreshing'), repr(info))
        provjeri(ime, 'Osvježi: točno jedan novi izračun (ukupno 2)', pokretanja(dom) == 2, str(pokretanja(dom)))

        # 3. chip na projektu
        await pg.locator('.tab-btn[data-tab="projects"]').click()
        chip = pg.locator('.c-vrijednost').first
        ok = False; txt = ''; naslov = ''
        for _ in range(40):
            if await chip.count():
                txt = await chip.inner_text(); naslov = await chip.get_attribute('title') or ''
                if ima(txt, '123,45', '123.45'): ok = True; break
            await pg.wait_for_timeout(250)
        provjeri(ime, 'chip ∑ na kartici projekta: 123,45 € iz poProjektu', ok, repr(txt))
        provjeri(ime, 'chip: opis kaže „ljudskog rada" i „bez PDV-a"', ima(naslov, 'ljudskog rada', 'human work') and ima(naslov, 'bez PDV-a', 'excl. VAT'), repr(naslov[:90]))
        provjeri(ime, 'nema JS pogrešaka', not greske, str(greske[:2]))
        await b.close()
    finally:
        proc.terminate(); proc.wait(timeout=10)

    # 4. restart ploče — keš s diska
    provjeri(ime, 'keš zapisan na disk', os.path.exists(kes), kes)
    proc, url = podigni(dom, env)
    try:
        b = await preglednik(p, ime)
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(url + '/'); await pg.wait_for_timeout(500)
        t0 = time.time()
        await pg.locator('.tab-btn[data-tab="potrosnja"]').click()
        stiglo = None
        for _ in range(50):
            if ima(await pg.evaluate(BOX), '2.000', '2,000'): stiglo = time.time() - t0; break
            await pg.wait_for_timeout(100)
        provjeri(ime, 'nakon restarta: brojka u kartici < 5 s (keš s diska)', stiglo is not None and stiglo < 5, f'{stiglo and round(stiglo, 2)} s')
        provjeri(ime, 'nakon restarta: bez novog izračuna (keš svjež)', pokretanja(dom) == 2, str(pokretanja(dom)))
        await b.close()
    finally:
        proc.terminate(); proc.wait(timeout=10)

async def main():
    async with async_playwright() as p:
        for ime in ('chromium', 'firefox'):
            await jedan(p, ime)
    n_ok = sum(1 for r in rez if r[2]); n_fail = len(rez) - n_ok
    print(f'\n{NACIN}: {n_ok} pass, {n_fail} fail')
    sys.exit(1 if n_fail else 0)

asyncio.run(main())
