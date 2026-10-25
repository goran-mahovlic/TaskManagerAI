#!/usr/bin/env python3
"""
tajna_redak.py — Python zrcalo `LoginCreds.parsirajRedak` (TASK-5345, ADR-0007 §5.2, nalaz N1).

ZAŠTO POSTOJI: spremište tajni se NE smije učitavati s `set -a; . spremište` — goli redak
`IME=vrijednost` tada je izvršni kod ljuske. Potrošač u ljusci uzme SAMO svoje ime:

    EMAIL_PASSWORD="$(python3 tajna_redak.py --get EMAIL_PASSWORD --file <spremište>)"

Čita `IME='…'` (oblik koji piše pisač), `IME="…"`, goli `IME=…` i `export IME=…`.
Ništa ne izvršava i ne razvija `$…`. Zadnji redak imena pobjeđuje (kao u ljusci).
Testni vektori su zajednički s TS stranom: tests/tajne-n1-5345.test.ts.

Exit: 0 = nađeno (vrijednost na stdout, bez prijelaza retka), 1 = nema, 2 = greška poziva.

TASK-5343 (ADR-0007 §7.1): i otisak — HMAC-SHA256 s ključem čvora (`tajne-otisak.kljuc` uz
spremište), prvih 8 hex, isto kao `LoginCreds.otisak`. Vrijednost se pritom NE ispisuje:

    tajna_redak.py --otisak IME --file <spremište>         # {"ime","postoji","otisak_hmac"}
    tajna_redak.py --vektori tests/fixtures/tajne-vektori.json   # samoprovjera TS = Python
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import sys

DODJELA = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')


def _dekodiraj_rijec(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c in ' \t':
            break
        if c == "'":
            kraj = s.find("'", i + 1)
            if kraj < 0:
                return None
            out.append(s[i + 1:kraj]); i = kraj + 1
        elif c == '"':
            i += 1
            while True:
                if i >= len(s):
                    return None
                d = s[i]
                if d == '"':
                    i += 1; break
                if d == '\\' and i + 1 < len(s) and s[i + 1] in '$`"\\':
                    out.append(s[i + 1]); i += 2; continue
                out.append(d); i += 1
        elif c == '\\' and i + 1 < len(s):
            out.append(s[i + 1]); i += 2
        else:
            out.append(c); i += 1
    return ''.join(out)


def parsiraj_redak(redak):
    """(ime, vrijednost) ili None za komentar / ne-dodjelu."""
    m = DODJELA.match(redak[:-1] if redak.endswith('\r') else redak)
    if not m:
        return None
    sirovo = m.group(2).strip()
    if sirovo[:1] in ("'", '"'):
        v = _dekodiraj_rijec(sirovo)
        if v is not None:
            return m.group(1), v
    return m.group(1), re.sub(r'''^["']|["']$''', '', sirovo)


def procitaj(putanja, ime):
    v = None
    try:
        with open(putanja, encoding='utf-8', errors='surrogateescape') as fh:
            for r in fh.read().split('\n'):
                p = parsiraj_redak(r)
                if p and p[0] == ime:
                    v = p[1]
    except OSError:
        return None
    return v or None


CLAUDE_TOKEN_IME = 'CLAUDE_CODE_OAUTH_TOKEN'


def okolina_claudea(putanja, env=None):
    """TASK-5792 (zrcalo `ClaudePrijava.sTokenomPretplate`): okolina za `claude -p`. Kad je okolina
    nema (ploča na macOS-u kreće bez `s-okolinom.sh --tajne`), iz spremišta se uzima SAMO token
    pretplate; preusmjereni poziv (ANTHROPIC_BASE_URL) ga ne smije nositi."""
    o = dict(os.environ if env is None else env)
    if o.get('ANTHROPIC_BASE_URL'):
        o.pop(CLAUDE_TOKEN_IME, None)
    elif not o.get(CLAUDE_TOKEN_IME):
        t = procitaj(putanja, CLAUDE_TOKEN_IME)
        if t:
            o[CLAUDE_TOKEN_IME] = t
    return o


def otisak_hmac(vrijednost, kljuc):
    return hmac.new(kljuc, vrijednost.encode('utf-8'), hashlib.sha256).hexdigest()[:8]


def _vektori(put):
    with open(put, encoding='utf-8') as f:
        v = json.load(f)
    kljuc = bytes.fromhex(v['kljucHex'])
    greske = 0
    for i, o in enumerate(v['otisci']):
        if otisak_hmac(o['vrijednost'], kljuc) != o['otisak']:
            greske += 1
            print('otisak se razlikuje za vektor #%d' % i, file=sys.stderr)
    for i, r in enumerate(v['retci']):
        p = parsiraj_redak(r['redak'])
        if (p[1] if p else None) != r['vrijednost']:
            greske += 1
            print('redak se razlikuje za vektor #%d' % i, file=sys.stderr)
    return 1 if greske else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--get', metavar='IME')
    g.add_argument('--otisak', metavar='IME')
    g.add_argument('--vektori', metavar='JSON')
    ap.add_argument('--file')
    a = ap.parse_args()
    if a.vektori:
        return _vektori(a.vektori)
    if not a.file:
        ap.error('--file je obavezan')
    if a.otisak:
        v = procitaj(a.file, a.otisak)
        kljuc_put = os.path.join(os.path.dirname(a.file), 'tajne-otisak.kljuc')
        o = None
        if v and os.path.exists(kljuc_put):
            with open(kljuc_put, 'rb') as fh:
                o = otisak_hmac(v, fh.read())
        print(json.dumps({'ime': a.otisak, 'postoji': bool(v), 'otisak_hmac': o}))
        return 0
    v = procitaj(a.file, a.get)
    if v is None:
        return 1
    sys.stdout.write(v)
    return 0


if __name__ == '__main__':
    sys.exit(main())
