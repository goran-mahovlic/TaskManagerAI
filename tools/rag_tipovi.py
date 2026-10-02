#!/usr/bin/env python3
"""rag_tipovi.py — razvrstavanje i ZAŠTITA RAG dokumenata po vrsti.

Goran, 04.09.2026.: „u RAG smo imali i sistemska pravila i dodatne stvari, treba paziti da
ih se ne bi obrisalo — posebno prijašnje pogreške i pravila — ali bi to trebalo počistiti
i sortirati."

ŠTO RADI
    1. Svakom dokumentu upisuje `tip_regoc` — jedan od: pravilo, lekcija, pogreska,
       istrazivanje, spec, referenca, sjednica, izlaz-agenta, ocjena, ostalo.
       Izvorni `type`/`tip` se NE briše; dodaje se normalizirana oznaka po kojoj se može
       filtrirati bez poznavanja svih 60-ak povijesnih vrijednosti.
    2. Dokumentima koji nose pravila, lekcije i opise pogrešaka upisuje `zasticeno = True`.
       `rag_archive.py --drop` od tada odbija ukloniti kolekciju u kojoj takvih ima.

ZAŠTO ZAŠTITA, A NE SAMO OPREZ
    Čišćenje se pokreće alatom, a alat ne zna što je vrijedno. Dosad je jedina brana bila
    to što je popis kolekcija za brisanje sastavljen rukom. Oznaka `zasticeno` premješta
    branu s čovjeka na podatak: pravilo se ne može obrisati ni slučajno ni u žurbi.

PREPOZNAVANJE
    Prvo po metapodatku `type` (povijesne vrijednosti: critical_rule, critical_lesson,
    pravopis_rule, lesson, bug_fix, bug_report, SO …), zatim po sadržaju (naslovne riječi
    „PRAVILO", „LEKCIJA", „NIKAD", „greška/pogreška", „ne smije"). Bez pogotka → `ostalo`,
    bez zaštite. Radije nezaštićeno nego lažno zaštićeno: lažna zaštita bi zauvijek
    zaključala smeće u korpusu.

UPORABA
    python3 tools/rag_tipovi.py --pregled
    python3 tools/rag_tipovi.py --primijeni
    python3 tools/rag_tipovi.py --popis pravilo      # ispiši dokumente jedne vrste
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from collections import Counter

from tm_putanje import chroma_kolekcije as baza  # TM_CHROMA_HOST/TM_CHROMA_PORT, bez zadane adrese

# Povijesne vrijednosti `type` → normalizirana vrsta. Sve ostalo ide kroz sadržaj.
PO_TIPU = {
    "critical_rule": "pravilo", "rule": "pravilo", "pravopis_rule": "pravilo",
    "SO": "pravilo", "protocol": "pravilo", "system_rule": "pravilo",
    "critical_lesson": "lekcija", "lesson": "lekcija", "system_learning": "lekcija",
    "learning": "lekcija", "postmortem": "lekcija",
    "bug": "pogreska", "bug_fix": "pogreska", "bug_report": "pogreska",
    "incident": "pogreska", "error": "pogreska", "regression": "pogreska",
    "research": "istrazivanje", "istrazivanje": "istrazivanje", "analysis": "istrazivanje",
    "spec": "spec", "design_document": "spec", "implementation_plan": "spec",
    "plan": "spec", "architecture": "spec",
    "reference": "referenca", "cheatsheet": "referenca", "documentation": "referenca",
    "startup_context": "referenca", "infrastructure": "referenca", "credentials": "referenca",
    "session_summary": "sjednica", "auto_checkpoint": "sjednica", "checkpoint": "sjednica",
    "context_save": "sjednica",
    "completion": "izlaz-agenta", "full_output": "izlaz-agenta", "result": "izlaz-agenta",
    "explicit_rating": "ocjena", "implicit_rating": "ocjena",
}

# Sadržajni signali (gledaju se samo prva 4 retka i prvih 400 znakova).
UZORCI = [
    ("pravilo", re.compile(r"\bPRAVILO\b|\bNIKAD\b|\bOBAVEZNO\b|ne smije|zabranjeno|\bMORA\b", re.I)),
    ("pogreska", re.compile(r"\bgre[sš]k|\bpogre[sš]k|\bbug\b|root cause|incident|\bkvar\b|\bpad(a|ao)\b", re.I)),
    ("lekcija", re.compile(r"\blekcij|\bnau[cč]en|lesson|\bpouka\b|što smo naučili", re.I)),
    ("istrazivanje", re.compile(r"\bistra[zž]ivanj|\bresearch\b|usporedb|\banaliz", re.I)),
    ("spec", re.compile(r"\bspecifikacij|\barhitektur|\bADR\b|\bplan\b", re.I)),
]
ZASTICENE_VRSTE = {"pravilo", "lekcija", "pogreska"}


def dohvati(put: str, tijelo=None):
    if tijelo is None:
        return json.load(urllib.request.urlopen(put, timeout=60))
    req = urllib.request.Request(put, json.dumps(tijelo).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=180))


def kolekcije() -> dict[str, str]:
    return {c["name"]: c["id"] for c in dohvati(baza() + "?limit=500")}


def vrsta(meta: dict, tekst: str) -> str:
    t = str((meta or {}).get("type") or (meta or {}).get("tip") or "").strip()
    if t in PO_TIPU:
        return PO_TIPU[t]
    glava = "\n".join((tekst or "").splitlines()[:4])[:400]
    for ime, uzorak in UZORCI:
        if uzorak.search(glava):
            return ime
    return "ostalo"


def prolaz(primijeni: bool, samo_popis: str | None = None) -> int:
    kol = kolekcije()
    zbroj: Counter = Counter()
    zasticenih = 0
    primjeri: dict[str, list] = {}
    for ime, cid in sorted(kol.items()):
        n = dohvati(f"{baza()}/{cid}/count")
        if not n:
            continue
        d = dohvati(f"{baza()}/{cid}/get", {"limit": n, "include": ["metadatas", "documents"]})
        ids = d.get("ids") or []
        metas = d.get("metadatas") or []
        docs = d.get("documents") or []
        novi_ids, novi_metas = [], []
        for i, m, doc in zip(ids, metas, docs):
            m = dict(m or {})
            v = vrsta(m, doc or "")
            zbroj[v] += 1
            stit = v in ZASTICENE_VRSTE
            if stit:
                zasticenih += 1
            if samo_popis and v == samo_popis and len(primjeri.setdefault(ime, [])) < 5:
                primjeri[ime].append((i, (doc or "")[:110].replace("\n", " ")))
            if m.get("tip_regoc") == v and bool(m.get("zasticeno", False)) == stit:
                continue
            m["tip_regoc"] = v
            m["zasticeno"] = stit
            novi_ids.append(i)
            novi_metas.append(m)
        if primijeni and novi_ids:
            for k in range(0, len(novi_ids), 100):
                dohvati(f"{baza()}/{cid}/update",
                        {"ids": novi_ids[k:k + 100], "metadatas": novi_metas[k:k + 100]})
            print(f"  {ime:28} označeno {len(novi_ids):>5}")

    if samo_popis:
        print(f"Dokumenti vrste „{samo_popis}\":")
        for kolekcija, red in primjeri.items():
            print(f"\n  ── {kolekcija} ──")
            for i, t in red:
                print(f"    {i[:24]}  {t}")
        return 0

    ukupno = sum(zbroj.values())
    print(f"{'VRSTA':16}{'DOK':>7}{'udio':>8}")
    for v, n in zbroj.most_common():
        print(f"{v:16}{n:>7}{100*n/max(ukupno,1):>7.1f}%")
    print(f"\nUkupno {ukupno} dokumenata · ZAŠTIĆENO {zasticenih} "
          f"(pravila, lekcije i opisi pogrešaka — `rag_archive.py --drop` ih odbija ukloniti)")
    if not primijeni:
        print("\n(proba — ništa nije upisano; pokreni s --primijeni)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pregled", action="store_true")
    ap.add_argument("--primijeni", action="store_true")
    ap.add_argument("--popis", default=None, help="ispiši primjere jedne vrste")
    a = ap.parse_args()
    return prolaz(primijeni=a.primijeni, samo_popis=a.popis)


if __name__ == "__main__":
    sys.exit(main())
