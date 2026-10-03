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

Stvarni prekid (TASK-5185): uz --prekid N preglednik ide kroz lokalni TCP posrednik
(Chromium --host-resolver-rules preslika host:port ploče na posrednik, Host zaglavlje ostaje
isto), koji N s ili RESETIRA sve veze i odbija nove (--nacin rst), ili ih pretvori u
„crnu rupu" — podaci nestaju bez FIN/RST, kao kad mobitel promijeni mrežu (--nacin crna_rupa),
ili ih samo zaustavi pa nakon povratka dostavi zaostalo (--nacin zastoj — Tailscale tunel pao
i vratio se, TCP retransmisija uspije).
navigator.onLine se pri tome NE mijenja — preglednik ništa ne zna. Nakon prekida stare veze
ostaju mrtve, nove rade. Mjeri se koliko nakon povratka zaglavlje kaže „Spojeno" i završavaju li
dohvati ploče poslije povratka (dohvati_ploce: zaglavljen dohvat drži bravu „jedan u letu").

Poziv:
  python3 tests/e2e/mobilni_promet.py --url http://<adresa-ploce>:17781 \
      --profil slow3g --trajanje 120 --spavanje 30 --izlaz mjerenje.json
"""
import argparse
import json
import socket
import threading
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


class Posrednik:
    """TCP posrednik koji zna stvarno prekinuti mrežu (rst | crna_rupa) i vratiti je."""

    def __init__(self, cilj_host, cilj_port):
        self.cilj = (cilj_host, cilj_port)
        self.nacin = 'radi'
        self.veze = []            # [klijent, upstream, mrtva]
        self.lock = threading.Lock()
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(('127.0.0.1', 0))
        self.srv.listen(64)
        self.port = self.srv.getsockname()[1]
        self.prihvaceno = 0
        self.tece = threading.Event()
        self.tece.set()
        threading.Thread(target=self._prihvat, daemon=True).start()

    @staticmethod
    def _rst(sk):
        try:
            sk.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b'\x01\x00\x00\x00\x00\x00\x00\x00')
            sk.close()
        except Exception:
            pass

    def _prihvat(self):
        while True:
            try:
                k, _ = self.srv.accept()
            except Exception:
                return
            self.prihvaceno += 1
            if self.nacin == 'rst':
                self._rst(k)
                continue
            if self.nacin == 'zastoj':
                self.tece.wait()          # SYN „visi" dok se mreža ne vrati
            if self.nacin == 'crna_rupa':
                # TCP se spoji (lokalno), ali ništa ne prolazi — veza je „mrtva" zauvijek.
                v = [k, None, True]
                with self.lock:
                    self.veze.append(v)
                threading.Thread(target=self._pumpa, args=(k, None, v), daemon=True).start()
                continue
            try:
                u = socket.create_connection(self.cilj, timeout=10)
                u.settimeout(None)
            except Exception:
                self._rst(k)
                continue
            v = [k, u, False]
            with self.lock:
                self.veze.append(v)
            threading.Thread(target=self._pumpa, args=(k, u, v), daemon=True).start()
            threading.Thread(target=self._pumpa, args=(u, k, v), daemon=True).start()

    def _pumpa(self, iz, u, v):
        while True:
            try:
                d = iz.recv(65536)
            except Exception:
                d = b''
            if not d:
                if not v[2]:
                    for sk in (iz, u):
                        try:
                            sk.shutdown(socket.SHUT_RDWR)
                        except Exception:
                            pass
                return
            self.tece.wait()              # zastoj: zadrži pa dostavi nakon povratka
            if v[2] or u is None:
                continue          # crna rupa: proguta podatke, ne zatvara
            try:
                u.sendall(d)
            except Exception:
                return

    def prekini(self, nacin):
        self.nacin = nacin
        if nacin == 'zastoj':
            self.tece.clear()
            return
        with self.lock:
            for v in self.veze:
                if nacin == 'rst':
                    self._rst(v[0])
                    if v[1]:
                        self._rst(v[1])
                else:
                    v[2] = True

    def vrati(self):
        self.nacin = 'radi'
        self.tece.set()


def najdulje_spajam(stanja, kraj):
    """Najdulji neprekinuti interval u kojem zaglavlje kaže „Connecting…/Spajam se…"."""
    najv, od = 0.0, None
    for t, tekst, _ in stanja + [[kraj, '__kraj__', '']]:
        if tekst.startswith('---'):
            continue
        spajam = tekst.lower().startswith(('connecting', 'spajam'))
        if spajam and od is None:
            od = t
        elif not spajam and od is not None:
            najv, od = max(najv, t - od), None
    return round(najv, 1)


def spojeno_nakon(stanja, t_povratka):
    if t_povratka is None:
        return None
    for t, tekst, klasa in stanja:
        if t >= t_povratka and not tekst.startswith('---') and 'disconnected' not in klasa:
            return round(t - t_povratka, 1)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description='Ploča na mobitelu preko spore mreže — mjerenje prometa i prvog prikaza')
    ap.add_argument('--url', default='http://localhost:17781')
    ap.add_argument('--profil', choices=list(PROFILI), default='slow3g')
    ap.add_argument('--trajanje', type=int, default=120, help='sekunde promatranja nakon učitavanja')
    ap.add_argument('--spavanje', type=int, default=0, help='sekunde offline + hidden u sredini promatranja (0 = bez)')
    ap.add_argument('--prekid', type=int, default=0, help='sekunde STVARNOG prekida kroz TCP posrednik (0 = bez)')
    ap.add_argument('--nacin', choices=['rst', 'crna_rupa', 'zastoj'], default='crna_rupa')
    ap.add_argument('--prekid-u', type=int, default=0, help='sekunda početka prekida (0 = pola trajanja)')
    ap.add_argument('--izlaz', default='')
    a = ap.parse_args()

    bajtovi = Counter()        # putanja -> bajtova (HTTP nakon kompresije)
    zahtjevi = Counter()       # putanja -> broj dovršenih zahtjeva
    ws_bajtovi = Counter()     # tip WS poruke -> bajtova
    ws_okvira = Counter()
    url_po_id = {}
    t_start = [time.time()]
    greske, konzola, pali = [], [], []
    stanja = []                # (t, tekst, klasa)

    with sync_playwright() as p:
        posrednik = None
        argumenti = []
        if a.prekid:
            pu = urlparse(a.url)
            port = pu.port or (443 if pu.scheme == 'https' else 80)
            posrednik = Posrednik(socket.gethostbyname(pu.hostname), port)
            argumenti = [f'--host-resolver-rules=MAP {pu.hostname}:{port} 127.0.0.1:{posrednik.port}']
        b = p.chromium.launch(args=argumenti)
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
        # Dohvati ploče kroz vrijeme: [poslano_s, gotovo_s|None, kraj] — zaglavljen dohvat drži bravu
        # „jedan u letu", pa se vidi kao poslano bez gotovo i bez novih zahtjeva poslije povratka.
        ploca_zahtjevi = {}

        def ploca_poslano(e):
            u = e['request']['url']
            if '/api/tasks?' in u or '/api/upute/stanje' in u or '/api/unverified' in u:
                ploca_zahtjevi[e['requestId']] = [round(time.time() - t_start[0], 1), None, put(u)]
        cdp.on('Network.requestWillBeSent', ploca_poslano)

        def ploca_kraj(e, kako):
            z = ploca_zahtjevi.get(e['requestId'])
            if z and z[1] is None:
                z[1] = round(time.time() - t_start[0], 1)
                z[2] += ' ' + kako
        cdp.on('Network.loadingFinished', lambda e: ploca_kraj(e, 'ok'))
        cdp.on('Network.loadingFailed', lambda e: ploca_kraj(e, 'PALO:' + e.get('errorText', '')))

        # Nedovršen prijenos (9,4 MB na 3G) nikad ne javi loadingFinished — zato se broje i
        # djelomično primljeni bajtovi (dataReceived), a dovršeni zamjenjuju zbroj točnom brojkom.
        djelomicno = Counter()
        dovrseno = set()

        po_minuti = Counter()      # minuta od starta -> bajtova (HTTP primljeno + WS oba smjera)

        def minuta():
            return int((time.time() - t_start[0]) // 60)

        def primljeno(e):
            n = int(e.get('encodedDataLength', 0) or 0)
            djelomicno[e['requestId']] += n
            po_minuti[minuta()] += n
        cdp.on('Network.dataReceived', primljeno)

        def gotovo(e):
            u = url_po_id.get(e['requestId'], '?')
            n = int(e.get('encodedDataLength', 0))
            bajtovi[put(u)] += n
            # dataReceived ne nosi zaglavlja (a često ni tijelo) — ostatak se knjiži u minutu završetka
            po_minuti[minuta()] += max(0, n - djelomicno[e['requestId']])
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
            po_minuti[minuta()] += len(pl.encode('utf-8'))
        cdp.on('Network.webSocketFrameReceived', okvir)
        ws_poslano = Counter()

        def okvir_van(e):
            n = len(e['response'].get('payloadData', '').encode('utf-8'))
            ws_poslano['bajtova'] += n
            ws_poslano['okvira'] += 1
            po_minuti[minuta()] += n
        cdp.on('Network.webSocketFrameSent', okvir_van)
        ws_otvoreno = []
        cdp.on('Network.webSocketCreated', lambda e: ws_otvoreno.append(round(time.time() - t_start[0], 1)))

        page.on('pageerror', lambda e: greske.append(str(e)))
        page.on('console', lambda m: konzola.append(f'{m.type}: {m.text}'[:300]) if m.type in ('error', 'warning') else None)
        page.on('requestfailed', lambda r: pali.append(f'{put(r.url)} {r.failure}'))

        t0 = time.time()
        t_start[0] = t0
        page.goto(a.url, wait_until='commit', timeout=120000)
        prvi_prikaz = None

        def uzorak():
            try:
                return page.evaluate("""() => [
                    Array.from(document.querySelectorAll('#tab-tasks .stat-value')).map(e => e.textContent.trim()).join('|'),
                    (document.getElementById('status-text')||{}).textContent || '',
                    (document.getElementById('connection-status')||{}).className || '']""")
            except Exception:
                return ['', '', '']

        kraj = t0 + a.trajanje
        sredina = t0 + a.trajanje / 2
        brojke_uzorci = []
        prekid_od = t0 + (a.prekid_u or a.trajanje / 2)
        prekid_do = None
        prekinuto = False
        spavao = False
        zadnje = None
        while time.time() < kraj:
            total, tekst, klasa = uzorak()
            t = round(time.time() - t0, 1)
            if prvi_prikaz is None and total and '-' not in total.split('|'):
                prvi_prikaz = t
            if total != (brojke_uzorci[-1][1] if brojke_uzorci else None):
                brojke_uzorci.append([t, total])
            if (tekst, klasa) != zadnje:
                stanja.append([t, tekst, klasa])
                zadnje = (tekst, klasa)
            if posrednik and not prekinuto and time.time() >= prekid_od:
                prekinuto = True
                posrednik.prekini(a.nacin)
                stanja.append([t, f'--- PREKID ({a.nacin}) ---', ''])
            if posrednik and prekinuto and prekid_do is None and time.time() >= prekid_od + a.prekid:
                posrednik.vrati()
                prekid_do = time.time()
                stanja.append([round(prekid_do - t0, 1), '--- MREŽA VRAĆENA ---', ''])
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
        'po_minuti': {str(k): v for k, v in sorted(po_minuti.items())},
        'ws_poslano': dict(ws_poslano),
        'dohvati_ploce': sorted(ploca_zahtjevi.values()),
        'ws_otvoreno_s': ws_otvoreno,
        'brojke_kroz_vrijeme': brojke_uzorci,
        'crtica_nakon_prvog_prikaza': sum(1 for tt, v in brojke_uzorci
                                          if prvi_prikaz is not None and tt > prvi_prikaz and '-' in v.split('|')),
        'najdulje_spajam_s': najdulje_spajam(stanja, round(trajalo, 1)),
        'prekid': ({'nacin': a.nacin, 'od_s': round(prekid_od - t0, 1),
                    'do_s': round(prekid_do - t0, 1) if prekid_do else None,
                    'spojeno_nakon_povratka_s': spojeno_nakon(stanja, (prekid_do - t0) if prekid_do else None),
                    'tcp_prihvaceno': posrednik.prihvaceno} if posrednik else None),
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
