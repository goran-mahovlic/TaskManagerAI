"""E2E prototipa uređivača rasporeda (TASK-5169) — Chromium + Firefox (pravi Gecko), miš i dodir.
Pokretanje (iz ove mape):  TMPDIR=~/.tmp python3 e2e_prototip.py [--snimke DIR]
Napomena: TMPDIR mora biti na disku — /tmp je tmpfs od 100 MB i renderer pada (ENOSPC)."""
import asyncio, sys, os, threading, functools, http.server, socketserver
from playwright.async_api import async_playwright

MAPA = os.path.dirname(os.path.abspath(__file__))
SNIMKE = sys.argv[sys.argv.index('--snimke') + 1] if '--snimke' in sys.argv else None
rez = []
def provjeri(preg, ime, uvjet, info=''):
    rez.append((preg, ime, bool(uvjet), info)); print(f"  {'PASS' if uvjet else 'FAIL'} [{preg}] {ime} {info}")

def posluzi():
    class Tiho(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    h = functools.partial(Tiho, directory=MAPA)
    s = socketserver.TCPServer(('127.0.0.1', 0), h); threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, s.server_address[1]

RED1 = "[...document.querySelectorAll('#info-grid > .info-card')].filter(c=>{let p=c;while(p&&!p.classList.contains('info-skupina'))p=p.previousElementSibling;return p&&p.id===arguments[0]}).map(c=>c.id)"
def red(sk): return f"(()=>{{const a=['{sk}'];return {RED1.replace('arguments[0]','a[0]')}}})()"

async def vuci_misem(pg, od, do, koraka=12):
    a = await pg.locator(od).bounding_box(); b = await pg.locator(do).bounding_box()
    await pg.mouse.move(a['x'] + a['width']/2, a['y'] + a['height']/2); await pg.mouse.down()
    for i in range(1, koraka + 1):
        await pg.mouse.move(a['x'] + a['width']/2 + (b['x'] + 20 - a['x'] - a['width']/2) * i / koraka, a['y'] + a['height']/2 + (b['y'] + 20 - a['y'] - a['height']/2) * i / koraka)
        await pg.wait_for_timeout(16)
    await pg.mouse.up()

async def desktop(p, ime, port):
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    pg = await b.new_page(viewport={'width': 1440, 'height': 900})
    greske = []; pg.on('pageerror', lambda e: greske.append(str(e))); pg.on('console', lambda m: greske.append(m.text) if m.type == 'error' else None)
    await pg.goto(f'http://127.0.0.1:{port}/prototip.html'); await pg.evaluate('localStorage.clear()'); await pg.reload()
    g = pg.locator('#cr-uredi')
    provjeri(ime, 'početno stanje: ✎ Uredi raspored', (await g.inner_text()).startswith('✎ Uredi raspored'))
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/proto_{ime}_1440_mirovanje.png')
    zadano1 = await pg.evaluate(red('cfg-skupina-1'))
    await g.click()
    provjeri(ime, 'klik → uređivanje (traka + 💾 Spremi)', await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and '💾 Spremi raspored' in await g.inner_text() and await pg.locator('#cr-traka').is_visible())
    # vrijednosti zaključane
    kl = pg.locator('#info-concurrency-card input[type=range]')
    v0 = await kl.input_value(); kb = await kl.bounding_box()
    await pg.mouse.click(kb['x'] + kb['width'] * 0.95, kb['y'] + kb['height'] / 2)
    provjeri(ime, 'klizač vrijednosti u uređivanju NE reagira (inert)', await kl.input_value() == v0 and await pg.evaluate("!!document.querySelector('#info-concurrency-card input').closest('[inert]')"), f'{v0}→{await kl.input_value()}')
    # vuci Vrata autonomije ispred Usporednih agenata
    await vuci_misem(pg, '#info-autonomija-card .cr-hvat', '#info-concurrency-card')
    r1 = await pg.evaluate(red('cfg-skupina-1'))
    provjeri(ime, 'drag&drop mišem: Vrata autonomije na 1. mjesto', r1[0] == 'info-autonomija-card', str(r1))
    # pokušaj preko granice skupine
    await vuci_misem(pg, '#info-concurrency-card .cr-hvat', '#info-agents-card')
    provjeri(ime, 'kartica ne prelazi u drugu skupinu', 'info-concurrency-card' in await pg.evaluate(red('cfg-skupina-1')))
    # promjena veličine kutom: lijevo za jedan stupac, dolje 120 px
    k = await pg.locator('#info-hindsight-card .cr-kut').bounding_box(); kol = (await pg.locator('#info-grid').bounding_box())['width'] / 4
    await pg.mouse.move(k['x'] + 30, k['y'] + 30); await pg.mouse.down()
    for i in range(1, 11): await pg.mouse.move(k['x'] + 30 - kol * i / 10, k['y'] + 30 + 120 * i / 10); await pg.wait_for_timeout(16)
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/proto_{ime}_1440_mijenjam.png')
    await pg.mouse.up()
    m = await pg.evaluate("[document.getElementById('info-hindsight-card').dataset.crW, document.getElementById('info-hindsight-card').dataset.crH, Math.round(document.getElementById('info-hindsight-card').getBoundingClientRect().height)]")
    provjeri(ime, 'resize kutom: ½ → ¼ i visina u koracima od 40 px', m[0] == '1' and m[1] and int(m[1]) % 40 == 0 and abs(int(m[1]) - m[2]) <= 1, str(m))
    n = await g.get_attribute('data-izmjena')
    provjeri(ime, 'brojač izmjena na gumbu > 0', int(n) > 0, n)
    # tipkovnica
    await pg.focus('#info-rag-card'); await pg.keyboard.press('Shift+ArrowLeft')
    provjeri(ime, 'tipkovnica: Shift+← smanjuje širinu', await pg.evaluate("document.getElementById('info-rag-card').dataset.crW") == '3')
    await pg.focus('#info-login-card'); await pg.keyboard.press('ArrowDown')
    provjeri(ime, 'tipkovnica: ↓ pomiče karticu', (await pg.evaluate(red('cfg-skupina-3')))[1] == 'info-login-card')
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/proto_{ime}_1440_uredivanje.png')
    nacrt = await pg.evaluate('JSON.stringify(CfgRaspored.trenutni())')
    # Esc poništava, Vrati vraća
    await pg.keyboard.press('Escape')
    provjeri(ime, 'Esc: izlaz bez spremanja, raspored vraćen', not await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and await pg.evaluate(red('cfg-skupina-1')) == zadano1 and await pg.evaluate("localStorage.getItem('prototip.config.raspored')") is None)
    provjeri(ime, 'poruka „Poništeno" s gumbom Vrati', await pg.locator('#cr-poruka-gumb').is_visible())
    await pg.click('#cr-poruka-gumb')
    provjeri(ime, 'Vrati: nacrt i uređivanje se vraćaju', await pg.evaluate('JSON.stringify(CfgRaspored.trenutni())') == nacrt and await pg.evaluate("document.body.classList.contains('cr-uredivanje')"))
    # isti gumb sprema
    await g.click(); await pg.wait_for_timeout(500)
    sp = await pg.evaluate("localStorage.getItem('prototip.config.raspored')")
    provjeri(ime, 'isti gumb sprema i izlazi', sp is not None and not await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and (await g.inner_text()).startswith('✎'))
    await pg.reload()
    provjeri(ime, 'nakon osvježavanja raspored ostaje', (await pg.evaluate(red('cfg-skupina-1')))[0] == 'info-autonomija-card' and await pg.evaluate("document.getElementById('info-hindsight-card').dataset.crW") == '1')
    # spremi bez izmjena ne piše
    await g.click(); await g.click(); await pg.wait_for_timeout(300)
    provjeri(ime, 'Spremi bez izmjena: ništa nije zapisano', await pg.evaluate("localStorage.getItem('prototip.config.raspored')") == sp)
    # Zadano
    await g.click(); await pg.click('#cr-zadano'); await g.click(); await pg.wait_for_timeout(500)
    provjeri(ime, '↺ Zadano + Spremi: ključ obrisan, zadani raspored', await pg.evaluate("localStorage.getItem('prototip.config.raspored')") is None and await pg.evaluate(red('cfg-skupina-1')) == zadano1)
    # neispravan raspored odbijen, ostaje u uređivanju
    await g.click()
    await pg.evaluate("document.getElementById('info-rag-card').dataset.crW='9'")
    await g.click(); await pg.wait_for_timeout(500)
    provjeri(ime, 'nevaljan raspored (w=9): odbijen, ostaje uređivanje, poruka greške', await pg.evaluate("document.body.classList.contains('cr-uredivanje')") and 'NIJE spremljen' in await pg.inner_text('#cr-poruka'))
    provjeri(ime, 'bez JS grešaka u konzoli', not greske, str(greske[:3]))
    await b.close()

async def mobitel(p, ime, port):
    b = await getattr(p, ime).launch(**({'args': ['--no-sandbox', '--disable-dev-shm-usage']} if ime == 'chromium' else {}))
    ctx = await b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=(ime == 'chromium'))
    pg = await ctx.new_page(); greske = []; pg.on('pageerror', lambda e: greske.append(str(e)))
    await pg.goto(f'http://127.0.0.1:{port}/prototip.html'); await pg.evaluate('localStorage.clear()'); await pg.reload()
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/proto_{ime}_390_mirovanje.png')
    await pg.locator('#cr-uredi').tap()
    provjeri(ime + '-mob', 'dodir gumba → uređivanje, sažeto uključeno', await pg.evaluate("document.body.classList.contains('cr-uredivanje') && document.body.classList.contains('cr-sazeto')"))
    provjeri(ime + '-mob', 'ručke: touch-action none, ≥44 px', await pg.evaluate("(()=>{const h=document.querySelector('.cr-hvat'),r=h.getBoundingClientRect();return getComputedStyle(h).touchAction==='none'&&r.width>=44&&r.height>=44})()"))
    if SNIMKE: await pg.screenshot(path=f'{SNIMKE}/proto_{ime}_390_uredivanje.png')
    await pg.evaluate("window.scrollTo(0, document.getElementById('cfg-skupina-2').getBoundingClientRect().top + scrollY - 120)")
    a = await pg.locator('#info-modelsetup-card .cr-hvat').bounding_box(); c = await pg.locator('#info-agents-card').bounding_box()
    provjeri(ime + '-mob', 'ručka i cilj u vidnom polju', a['y'] + 44 < 844 and c['y'] > 0, f"{round(a['y'])}/{round(c['y'])}")
    x0, y0, x1, y1 = a['x'] + 22, a['y'] + 22, c['x'] + 30, c['y'] + 8
    if ime == 'chromium':
        # pravi dodir kroz CDP → preglednik sam proizvodi pointer događaje (pointerType=touch)
        s = await ctx.new_cdp_session(pg)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
        for i in range(1, 13):
            await s.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / 12, 'y': y0 + (y1 - y0) * i / 12}]}); await pg.wait_for_timeout(16)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        nacin = 'CDP touch'
    else:
        # Gecko: Playwright nema touch-drag; šaljemo PointerEvent pointerType=touch (logika, ne gesta)
        await pg.evaluate("""([x0,y0,x1,y1])=>{const o=(t,x,y,el)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:x,clientY:y,button:0}));
          const h=document.elementFromPoint(x0,y0);o('pointerdown',x0,y0,h);for(let i=1;i<=12;i++)o('pointermove',x0+(x1-x0)*i/12,y0+(y1-y0)*i/12,document);o('pointerup',x1,y1,document)}""", [x0, y0, x1, y1])
        nacin = 'PointerEvent touch'
    r2 = await pg.evaluate(red('cfg-skupina-2'))
    provjeri(ime + '-mob', f'dodirom povučeno ({nacin}): Podržani modeli na 1. mjesto', r2[0] == 'info-modelsetup-card', str(r2))
    await pg.wait_for_timeout(400)  # čovjek ne tapka 50 ms nakon otpuštanja; Chrome to čita kao dvostruki dodir
    await pg.locator('#cr-sazmi').tap(); await pg.wait_for_timeout(350)  # Chromium-mobilna emulacija isporuči click nakon što tap() vrati
    provjeri(ime + '-mob', 'Sažmi isključuje sažeti prikaz', not await pg.evaluate("document.body.classList.contains('cr-sazeto')"))
    await pg.locator('#info-rag-card').scroll_into_view_if_needed()
    kb = await pg.locator('#info-rag-card .cr-kut').bounding_box()
    w0 = await pg.evaluate("document.getElementById('info-rag-card').dataset.crW")
    if ime == 'chromium':
        await s.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': kb['x'] + 22, 'y': kb['y'] + 22}]})
        for i in range(1, 9): await s.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': kb['x'] + 22 - 15 * i, 'y': kb['y'] + 22 + 20 * i}]}); await pg.wait_for_timeout(16)
        await s.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    else:
        await pg.evaluate("""([x,y])=>{const o=(t,x,y,el)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,pointerId:8,pointerType:'touch',isPrimary:true,clientX:x,clientY:y,button:0}));
          o('pointerdown',x,y,document.elementFromPoint(x,y));for(let i=1;i<=8;i++)o('pointermove',x-15*i,y+20*i,document);o('pointerup',x-120,y+160,document)}""", [kb['x'] + 22, kb['y'] + 22])
    m = await pg.evaluate("[document.getElementById('info-rag-card').dataset.crW, document.getElementById('info-rag-card').dataset.crH]")
    provjeri(ime + '-mob', 'na mobitelu kut mijenja samo visinu (širina ostaje)', m[0] == w0 and m[1] is not None, str(m))
    sw = await pg.evaluate('document.documentElement.scrollWidth')
    provjeri(ime + '-mob', 'nema vodoravnog preljeva na 390 px', sw <= 390, f'scrollWidth={sw}')
    await pg.wait_for_timeout(400); await pg.locator('#cr-uredi').tap(); await pg.wait_for_timeout(500)
    provjeri(ime + '-mob', 'dodir istog gumba sprema', await pg.evaluate("localStorage.getItem('prototip.config.raspored')") is not None)
    provjeri(ime + '-mob', 'bez JS grešaka', not greske, str(greske[:3]))
    await b.close()

async def main():
    s, port = posluzi()
    async with async_playwright() as p:
        for ime in ('chromium', 'firefox'):
            print('==', ime, 'desktop'); await desktop(p, ime, port)
            print('==', ime, 'mobitel'); await mobitel(p, ime, port)
    s.shutdown()
    pr = sum(1 for r in rez if r[2]); print(f'\n{pr} pass, {len(rez) - pr} fail')
    sys.exit(0 if pr == len(rez) else 1)
asyncio.run(main())
