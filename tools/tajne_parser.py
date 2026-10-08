#!/usr/bin/env python3
"""Python zrcalo parsera i otiska spremišta tajni (ADR-0007 §5.2, §7.1).

Isto ponašanje kao `src/LoginCreds.ts → parsirajRedak / otisak`; zajednički testni vektori
su u `tests/fixtures/tajne-vektori.json` (test `tests/tajne-spremiste.test.ts` ih vrti na
obje strane). Vrijednost tajne se NIKAD ne ispisuje — samo postoji/ne i otisak.

    tajne_parser.py --vektori tests/fixtures/tajne-vektori.json   # samoprovjera, izlaz 0/1
    tajne_parser.py --spremiste <put> --ime SMTP_PASSWORD [--json]  # postoji + otisak_hmac
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import sys

IME_RE = re.compile(r'^[A-Z][A-Z0-9_]{1,63}$')
IME_PARSER_RE = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
REDAK_RE = re.compile(r'^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')


def _dekodiraj_jednostruke(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == "'":
            kraj = s.find("'", i + 1)
            if kraj < 0:
                return None
            out.append(s[i + 1:kraj])
            i = kraj + 1
        elif s[i] == '\\' and i + 1 < len(s):
            out.append(s[i + 1])
            i += 2
        else:
            return None
    return ''.join(out)


def parsiraj_redak(redak):
    """Redak spremišta -> (ime, vrijednost, oblik) ili None."""
    if redak.endswith('\r'):
        redak = redak[:-1]
    m = REDAK_RE.match(redak)
    if not m or not IME_PARSER_RE.match(m.group(2)):
        return None
    ime, sirovo = m.group(2), m.group(3)
    if sirovo.startswith("'"):
        v = _dekodiraj_jednostruke(sirovo.rstrip())
        if v is not None:
            return ime, v, 'navodnici'
    t = sirovo.strip()
    if len(t) >= 2 and t.startswith('"') and t.endswith('"'):
        return ime, t[1:-1], 'dvostruki'
    return ime, re.sub(r'^["\']|["\']$', '', t), 'stari'


def procitaj(tekst, ime):
    v = None
    for r in tekst.split('\n'):
        p = parsiraj_redak(r)
        if p and p[0] == ime:
            v = p[1]
    return v


def otisak_hmac(vrijednost, kljuc):
    return hmac.new(kljuc, vrijednost.encode('utf-8'), hashlib.sha256).hexdigest()[:8]


def _vektori(put):
    with open(put, encoding='utf-8') as f:
        v = json.load(f)
    kljuc = bytes.fromhex(v['kljucHex'])
    greske = 0
    for o in v['otisci']:
        if otisak_hmac(o['vrijednost'], kljuc) != o['otisak']:
            greske += 1
            print('otisak se razlikuje za vektor #%d' % v['otisci'].index(o), file=sys.stderr)
    for r in v['retci']:
        p = parsiraj_redak(r['redak'])
        if (p[1] if p else None) != r['vrijednost']:
            greske += 1
            print('redak se razlikuje za vektor #%d' % v['retci'].index(r), file=sys.stderr)
    return 1 if greske else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vektori')
    ap.add_argument('--spremiste')
    ap.add_argument('--ime')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if a.vektori:
        return _vektori(a.vektori)
    if not (a.spremiste and a.ime):
        ap.error('--spremiste i --ime su obavezni')
    try:
        with open(a.spremiste, encoding='utf-8') as f:
            v = procitaj(f.read(), a.ime)
    except FileNotFoundError:
        v = None
    kljuc_put = os.path.join(os.path.dirname(a.spremiste), 'tajne-otisak.kljuc')
    otisak = None
    if v and os.path.exists(kljuc_put):
        with open(kljuc_put, 'rb') as f:
            otisak = otisak_hmac(v, f.read())
    rez = {'ime': a.ime, 'postoji': bool(v), 'otisak_hmac': otisak}
    print(json.dumps(rez) if a.json else '%s postoji=%s otisak_hmac=%s' % (a.ime, rez['postoji'], otisak))
    return 0


if __name__ == '__main__':
    sys.exit(main())
