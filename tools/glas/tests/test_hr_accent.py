"""Regresijski testovi za hr_accent (TASK-2652).

Pokretanje:  <venv>/bin/python -m pytest tools/glas/tests -q
Provjerava MJESTO naglaska (koji je slog po redu naglašen), ne točan fonemski niz —
tako testovi prežive sitne promjene espeakove fonemizacije.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hr_accent import PRIMARY, SECONDARY, _nuclei, _strip_marks, phonemize_hr  # noqa: E402
from piper.phonemize_espeak import EspeakPhonemizer  # noqa: E402

P = EspeakPhonemizer()


def stressed_syllable(word: str) -> int | None:
    """Koji je slog (0-baziran) naglašen nakon obrade? None = nenaglašeno."""
    ph = phonemize_hr(word, phonemizer=P)
    i = ph.find(PRIMARY)
    if i < 0:
        return None
    # Nukleuse računaj na CIJELOM nizu (rezanje bi pokvarilo test slogotvornog r:
    # u "kr" bi r ostalo bez desnog susjeda i lažno se brojalo kao nukleus),
    # pa prebroji koliko ih pada prije oznake naglaska.
    bare = _strip_marks(ph)
    return sum(1 for n in _nuclei(bare) if n < i - ph[:i].count(PRIMARY))


# (riječ, očekivani naglašeni slog) — provjereno prema standardnoj hrvatskoj normi
CASES = [
    # --- B1: posuđenice / izvedenice s ne-inicijalnim naglaskom ---
    ("televizija", 2),    # te-le-VI-zi-ja
    ("informacija", 2),   # in-for-MA-ci-ja
    ("organizacija", 3),  # or-ga-ni-ZA-ci-ja
    ("računalo", 1),      # ra-ČU-na-lo
    ("profesor", 1),      # pro-FE-sor
    ("direktor", 1),      # di-REK-tor
    ("restoran", 1),      # re-STO-ran
    ("banana", 1),        # ba-NA-na
    ("gitara", 1),        # gi-TA-ra
    ("automobil", 3),     # a-u-to-MO-bil (automòbil; moja prvotna procjena 2 bila je kriva)
    ("sveučilište", 1),   # sve-U-či-li-šte (sveùčilīšte, po korpusu)
    ("doviđenja", 2),     # do-vi-ĐE-nja
    ("oprostite", 1),     # o-PRO-sti-te
    ("zadatak", 1),       # za-DA-tak
    # --- B3: slogotvorno r je nukleus ---
    ("brzo", 0),          # BR-zo
    ("prvi", 0),          # PR-vi
    ("vrt", 0),           # VRT
    ("prst", 0),          # PRST
    ("cvrkut", 0),        # CVR-kut
    # --- espeakov default (1. slog) je TOČAN -> ne smije se pokvariti ---
    ("Zagreb", 0),
    ("nogomet", 0),
    ("hvala", 0),
    ("molim", 0),
    ("student", 0),
    ("doktor", 0),
    ("kruh", 0),
    # --- flektivni oblici ---
    ("sveučilištu", 1),
    ("profesora", 1),
    ("televiziju", 2),
    # --- nenaglašenice: ne smiju dobiti naglasak ---
    ("je", None),
    ("i", None),
    ("na", None),
    ("bez", None),
    ("se", None),
]


def main() -> int:
    passed = failed = 0
    for word, expected in CASES:
        got = stressed_syllable(word)
        ok = got == expected
        passed += ok
        failed += not ok
        if not ok:
            print(f"  FAIL {word:16s} očekivano slog={expected} dobiveno={got}"
                  f"  ({phonemize_hr(word, phonemizer=P)})")

    # Invarijanta: sekundarni naglasak (B2) nikad ne smije preživjeti
    sent = "Organizacija je napravila izvještaj o televiziji i računalima."
    out = phonemize_hr(sent, phonemizer=P)
    if SECONDARY in out:
        print(f"  FAIL B2: sekundarni naglasak preživio -> {out}")
        failed += 1
    else:
        passed += 1

    # Invarijanta: broj riječi = broj fonemskih komadića (poravnanje 1:1)
    for s in ["Dobar dan svima.", "Molim vas, pričekajte trenutak malo."]:
        if len(phonemize_hr(s, phonemizer=P).split()) != len(s.split()):
            print(f"  FAIL poravnanje riječ<->fonem: {s}")
            failed += 1
        else:
            passed += 1

    print(f"\n{passed} prošlo, {failed} palo")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
