#!/usr/bin/env python3
"""
mobilni_promet.py — ploča na mobitelu preko spore mreže (TASK-5184).

Otvara ploču u Chromiumu s emulacijom mobitela (Pixel 5) i usporenom mrežom (CDP
Network.emulateNetworkConditions), pa mjeri ono što je vlasnik vidio na mobitelu:
  • vrijeme prvog prikaza  — od navigacije do trenutka kad TOTAL više nije „-"
  • bajtove po minuti      — HTTP (encodedDataLength, dakle nakon gzipa) + WS okviri
  • stanje zaglavlja       — tekst #status-text i klasa #connection-status kroz vrijeme
  • pageerror / console.error / requestfailed
Po želji glumi „mobitel zaspao / promijenio mrežu": mreža offline N s, pa natrag,
uz visibilitychange hidden → visible, i bilježi vraća li se zaglavlje samo.

Poziv:
  python3 tests/e2e/mobilni_promet.py --url http://<adresa-ploce>:17781 \
      --profil slow3g --trajanje 120 --spavanje 30 --izlaz mjerenje.json
"""
import argparse
import json
import time
from collections import Counter
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

# Chrome DevTools predlošci (bajtovi/s, ms). „slow3g" = DevTools Slow 3G (400 kbit/s, 2 s RTT),
# „fast3g" = DevTools Fast 3G (1,44 Mbit/s, 563 ms RTT).
PROFILI = {
    'slow3g': {'latency': 2000, 'downloadThroughput': 400 * 1024 / 8, 'uploadThroughput': 400 * 1024 / 8},
    'fast3g': {'latency': 563, 'downloadThroughput': 1440 * 1024 / 8, 'uploadThroughput': 675 * 1024 / 8},
    'bez': None,
}


def main() -> int:
    ap = argparse.ArgumentParser(description='Ploča na mobitelu preko spore mreže — mjerenje prometa i prvog prikaza')
    ap.add_argument('--url', default='http://localhost:17781')
    ap.add_argument('--profil', choices=list(PROFILI), default='slow3g')
    ap.add_argument('--trajanje', type=int, default=120, help='sekunde promatranja nakon učitavanja')
    ap.add_argument('--spavanje', type=int, default=0, help='sekunde offline + hidden u sredini promatranja (0 = bez)')
    ap.add_argument('--izlaz', default='')
    a = ap.parse_args()

    bajtovi = Counter()        # putanja -> bajtova (HTTP nakon kompresije)
    zahtjevi = Counter()       # putanja -> broj dovršenih zahtjeva
    ws_bajtovi = Counter()     # tip WS poruke -> bajtova
    ws_okvira = Counter()
    url_po_id = {}
    greske, konzola, pali = [], [], []
    stanja = []                # (t, tekst, klasa)

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(**p.devices['Pixel 5'])
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send('Network.enable')
        prof = PROFILI[a.profil]
        if prof:
            cdp.send('Network.emulateNetworkConditions', {'offline': False, **prof})

        def put(u):
            pu = urlparse(u)
            return pu.path or u

        cdp.on('Network.requestWillBeSent', lambda e: url_po_id.__setitem__(e['requestId'], e['request']['url']))

        # Nedovršen prijenos (9,4 MB na 3G) nikad ne javi loadingFinished — zato se broje i
        # djelomično primljeni bajtovi (dataReceived), a dovršeni zamjenjuju zbroj točnom brojkom.
        djelomicno = Counter()
        dovrseno = set()

        def primljeno(e):
            djelomicno[e['requestId']] += int(e.get('encodedDataLength', 0) or 0)
        cdp.on('Network.dataReceived', primljeno)

        def gotovo(e):
            u = url_po_id.get(e['requestId'], '?')
            bajtovi[put(u)] += int(e.get('encodedDataLength', 0))
            zahtjevi[put(u)] += 1
            dovrseno.add(e['requestId'])
        cdp.on('Network.loadingFinished', gotovo)

        def okvir(e):
            pl = e['response'].get('payloadData', '')
            tip = '?'
            try:
                tip = json.loads(pl).get('type', '?')
            except Exception:
                pass
            ws_bajtovi[tip] += len(pl.encode('utf-8'))
            ws_okvira[tip] += 1
        cdp.on('Network.webSocketFrameReceived', okvir)

        page.on('pageerror', lambda e: greske.append(str(e)))
        page.on('console', lambda m: konzola.append(f'{m.type}: {m.text}'[:300]) if m.type in ('error', 'warning') else None)
        page.on('requestfailed', lambda r: pali.append(f'{put(r.url)} {r.failure}'))

        t0 = time.time()
        page.goto(a.url, wait_until='commit', timeout=120000)
        prvi_prikaz = None

        def uzorak():
            try:
                return page.evaluate("""() => [
                    (document.getElementById('total-count')||{}).textContent || '',
                    (document.getElementById('status-text')||{}).textContent || '',
                    (document.getElementById('connection-status')||{}).className || '']""")
            except Exception:
                return ['', '', '']

        kraj = t0 + a.trajanje
        sredina = t0 + a.trajanje / 2
        spavao = False
        zadnje = None
        while time.time() < kraj:
            total, tekst, klasa = uzorak()
            t = round(time.time() - t0, 1)
            if prvi_prikaz is None and total.strip() not in ('', '-'):
                prvi_prikaz = t
            if (tekst, klasa) != zadnje:
                stanja.append([t, tekst, klasa])
                zadnje = (tekst, klasa)
            if a.spavanje and not spavao and time.time() >= sredina:
                spavao = True
                stanja.append([t, '--- SPAVANJE: offline + hidden ---', ''])
                cdp.send('Network.emulateNetworkConditions', {'offline': True, 'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})
                page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
                                        Object.defineProperty(document, 'hidden', {value: true, configurable: true});
                                        document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('offline')); }""")
                kraj_sna = time.time() + a.spavanje
                while time.time() < kraj_sna:
                    _, tekst, klasa = uzorak()
                    if (tekst, klasa) != zadnje:
                        stanja.append([round(time.time() - t0, 1), tekst, klasa])
                        zadnje = (tekst, klasa)
                    time.sleep(0.5)
                cdp.send('Network.emulateNetworkConditions', {'offline': False, **(prof or {'latency': 0, 'downloadThroughput': -1, 'uploadThroughput': -1})})
                page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true});
                                        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
                                        document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); }""")
                stanja.append([round(time.time() - t0, 1), '--- BUDAN: online + visible ---', ''])
            time.sleep(0.5)

        trajalo = time.time() - t0
        for rid, n in djelomicno.items():
            if rid not in dovrseno:
                bajtovi[put(url_po_id.get(rid, '?')) + ' (nedovršeno)'] += n
        total, tekst, klasa = uzorak()
        b.close()

    http_ukupno = sum(bajtovi.values())
    ws_ukupno = sum(ws_bajtovi.values())
    rez = {
        'url': a.url, 'profil': a.profil, 'trajanje_s': round(trajalo, 1),
        'prvi_prikaz_s': prvi_prikaz,
        'http_bajtova': http_ukupno, 'ws_bajtova': ws_ukupno,
        'bajtova_po_minuti': round((http_ukupno + ws_ukupno) / trajalo * 60),
        'po_putanji': dict(sorted(((k, {'bajtova': v, 'zahtjeva': zahtjevi[k]}) for k, v in bajtovi.items()), key=lambda kv: -kv[1]['bajtova'])[:15]),
        'ws_po_tipu': {k: {'bajtova': v, 'okvira': ws_okvira[k]} for k, v in ws_bajtovi.most_common()},
        'zavrsno_stanje': {'total': total, 'status_text': tekst, 'klasa': klasa},
        'stanja_zaglavlja': stanja,
        'pageerror': greske, 'console': konzola[:30], 'requestfailed': pali[:30],
    }
    out = json.dumps(rez, ensure_ascii=False, indent=2)
    print(out)
    if a.izlaz:
        with open(a.izlaz, 'w') as f:
            f.write(out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
