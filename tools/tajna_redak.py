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
"""
import argparse
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--get', required=True, metavar='IME')
    ap.add_argument('--file', required=True)
    a = ap.parse_args()
    v = procitaj(a.file, a.get)
    if v is None:
        return 1
    sys.stdout.write(v)
    return 0


if __name__ == '__main__':
    sys.exit(main())
