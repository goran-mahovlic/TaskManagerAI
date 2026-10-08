"""Testovi determinističkog normalizatora (sloj 1) — primjeri pravila izgovora.

Pokretanje: <venv>/bin/python -m pytest tools/glas/tests -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from hr_normalize import broj, normaliziraj, podijeli, redni


@pytest.mark.parametrize("n,ocekivano", [
    (0, "nula"), (8, "osam"), (15, "petnaest"), (21, "dvadeset jedan"),
    (100, "sto"), (245, "dvjesto četrdeset pet"),
    (1000, "tisuću"), (2026, "dvije tisuće dvadeset šest"), (5000, "pet tisuća"),
    (12000, "dvanaest tisuća"), (22000, "dvadeset dvije tisuće"),
    (1_000_000, "milijun"), (3_000_000, "tri milijuna"),
])
def test_glavni_broj(n, ocekivano):
    assert broj(n) == ocekivano


@pytest.mark.parametrize("n,padez,ocekivano", [
    (4, "nom", "četvrti"), (15, "gen", "petnaestog"), (31, "gen", "trideset prvog"),
    (1, "gen", "prvog"), (3, "gen", "trećeg"), (3, "lok", "trećem"), (20, "nom", "dvadeseti"),
])
def test_redni_broj(n, padez, ocekivano):
    assert redni(n, padez) == ocekivano


@pytest.mark.parametrize("ulaz,ocekivano", [
    # nadnevci (tablica iz PRIPREMA_*.md)
    ("Pregled dana, nedjelja 4.10.2026.",
     "Pregled dana, nedjelja četvrti listopada dvije tisuće dvadeset šeste."),
    ("rokovi od 15.10. do 31.12. su fiksni.",
     "rokovi od petnaestog listopada do trideset prvog prosinca su fiksni."),
    ("s rokom 1.11.", "s rokom prvog studenoga."),
    ("Sastanak je 4. 10. 2026.", "Sastanak je četvrti listopada dvije tisuće dvadeset šeste."),
    # brojevi → riječi
    ("otvoreno je 8 kartica", "otvoreno je osam kartica"),
    ("imamo 2 kartice", "imamo dvije kartice"),
    ("i 2 zadatka", "i dva zadatka"),
    # postotak, euro, decimale
    ("točnost 72,0 %", "točnost sedamdeset dva zarez nula posto"),
    ("rast 15%", "rast petnaest posto"),
    ("cijena 150 €", "cijena sto pedeset eura"),
    ("cijena €21", "cijena dvadeset jedan euro"),
    ("ukupno 1.500 EUR", "ukupno tisuću petsto eura"),
    # kratice: slovkanje + leksikon
    ("potpisi PDT obrazaca", "potpisi pe-de-te obrazaca"),
    ("na Deck ploči", "na Dek ploči"),
    ("projekt ULX-PRECOM", "projekt u-el-iks Precom"),
    # interne oznake
    ("obveze za M1", "obveze za prvi mjesec"),
    ("Kosjenka je završila TASK-5223", "Kosjenka je završila zadatak pet tisuća dvjesto dvadeset tri"),
    # vrijeme i rasponi
    ("u 14:30", "u četrnaest i trideset"),
    ("u 9:00", "u devet sati"),
    ("stranice 15–20", "stranice petnaest do dvadeset"),
    # znakovi
    ("Ivan & Deborah", "Ivan i Deborah"),
    ("vidi https://example.com/x", "vidi poveznicu"),
])
def test_normaliziraj(ulaz, ocekivano):
    assert normaliziraj(ulaz) == ocekivano


def test_normalizirani_tekst_ostaje_netaknut():
    t = "Ništa se ne naručuje prije te odluke."
    assert normaliziraj(t) == t


def test_mjesecni_raspon():
    assert normaliziraj("za 01–03/2026") == "za siječanj, veljaču i ožujak dvije tisuće dvadeset šeste"


def test_podjela_na_odlomke_i_recenice():
    t = "Prva rečenica. Druga rečenica!\n\nTreća u novom odlomku? Četvrta"
    assert podijeli(t) == [["Prva rečenica.", "Druga rečenica!"], ["Treća u novom odlomku?", "Četvrta."]]


def test_podjela_ne_reze_kod_rednog_broja_i_kratice():
    # nakon normalizacije nema "15." pa podjela ne smije rezati usred
    t = normaliziraj("Rok je 15.10. za sve. Hvala.")
    assert podijeli(t) == [["Rok je petnaesti listopada za sve.", "Hvala."]]


def test_prazan_tekst():
    assert normaliziraj("") == ""
    assert podijeli("   ") == []


def test_godina_u_lokativu_i_genitivu():
    assert normaliziraj("u 2026. godini") == "u dvije tisuće dvadeset šestoj godini"
    assert normaliziraj("kraj 2025. godine") == "kraj dvije tisuće dvadeset pete godine"


def test_obavijest_regoca():
    assert normaliziraj("REGOČ: Jelena je završila TASK-5223 (3 testa, 100%).") == \
        "Regoč: Jelena je završila zadatak pet tisuća dvjesto dvadeset tri (tri testa, sto posto)."


def test_oznaka_sa_slovima_i_brojkama_se_slovka():
    assert normaliziraj("mjeri na ULX4M-LS") == "mjeri na u-el-iks-četiri-em-el-es"
    assert normaliziraj("model K2 ep5306") == "model ka-dva ep pet tisuća tristo šest"
