#!/usr/bin/env python3
"""rag_izdvoji.py — izdvoji vrijedno znanje iz naslijeđene PAI kolekcije prije njezina isključenja.

Vlasnik, 04.09.2026.: „pai_agent_general — možeš odvojiti po prijedlogu — ono što isto moramo
paziti: REGOČ, kako sustav radi i što radi, sve o agentima, multiagent pristupu… Istraživanja
van ovih naših projekata koje smo radili davnih dana, ULX3S, FPGA, SERENA, ZOD … to ne smije
nestati."

ZAŠTO OVAKO: `pai_agent_general-purpose` (2 615 dok.) miješa dvije stvari — rutinske izlaze
podagenata („conversion complete…") i stvarno znanje iz ranog razdoblja (FPGA istraživanja,
arhitektura agenata, alati). Isključiti cijelu kolekciju iz pretrage značilo bi izgubiti
drugo zbog prvog. Zato se vrijedno PRESELI u vlastitu kolekciju koja ostaje u pretrazi, a
tek ostatak se isključuje.

KRITERIJ (namjerno strog — lakše je poslije dodati nego naći izgubljeno):
    · tekst dulji od 800 znakova (kratki „gotovo je" izlazi otpadaju),
    · barem DVIJE različite teme od: fpga (ULX3S/ULX4M/ULX5M/ECP5/GateMate/PDP-1/fpg1),
      agenti (multiagent, orkestracija, spawn, imena agenata), sustav (TaskManager,
      RegocDaemon, hookovi, CLAUDE.md), alati (SERENA, ZOD, RAG/Chroma),
      istraživanje (analiza, usporedba, benchmark),
    · bez duplikata (otisak prvih 500 znakova).

Kopira se s ugrađenim vektorima (`embeddings`), pa se ne mora ništa ponovno ugrađivati.
Izvornik se NE briše — nakon provjere se samo isključuje iz zadane pretrage.

    python3 tools/rag_izdvoji.py --proba
    python3 tools/rag_izdvoji.py --primijeni
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from collections import Counter

from tm_putanje import chroma_kolekcije as baza  # TM_CHROMA_HOST/TM_CHROMA_PORT, bez zadane adrese
IZVOR = "pai_agent_general-purpose"
ODREDISTE = "regoc_znanje"
MIN_ZNAKOVA = 800

TEME = {
    "fpga": re.compile(r"ULX3S|ULX4M|ULX5M|ECP5|GateMate|FPGA|PDP-1|fpg1|Spacewar|verilog|yosys|nextpnr", re.I),
    "agenti": re.compile(r"multi-?agent|orkestrac|orchestrat|spawn|AgentFactory|REGOC_AGENTS|"
                         r"Kosjenka|Jelena|Potjeh|Malik|Manda", re.I),
    "sustav": re.compile(r"TaskManager|RegocDaemon|daemon|MessageQueue|autonomij|hook system|"
                         r"statusline|CLAUDE\.md", re.I),
    "alati": re.compile(r"\bSERENA\b|Serena MCP|\bZOD\b|zod schema|RAG|ChromaDB|Chroma", re.I),
    "istrazivanje": re.compile(r"istra[zž]ivanj|research|analiz|usporedb|benchmark|comparison", re.I),
}


def dohvati(put: str, tijelo=None):
    if tijelo is None:
        return json.load(urllib.request.urlopen(put, timeout=90))
    req = urllib.request.Request(put, json.dumps(tijelo).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))


def kolekcije() -> dict[str, str]:
    return {c["name"]: c["id"] for c in dohvati(baza() + "?limit=500")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proba", action="store_true")
    ap.add_argument("--primijeni", action="store_true")
    a = ap.parse_args()
    if not (a.proba or a.primijeni):
        ap.error("odaberi --proba ili --primijeni")

    kol = kolekcije()
    if IZVOR not in kol:
        print(f"nema kolekcije {IZVOR}")
        return 1
    cid = kol[IZVOR]
    n = dohvati(f"{baza()}/{cid}/count")
    d = dohvati(f"{baza()}/{cid}/get",
                {"limit": n, "include": ["documents", "metadatas", "embeddings"]})
    ids, docs = d["ids"], d["documents"]
    metas = d.get("metadatas") or [{}] * len(ids)
    embs = d.get("embeddings") or [None] * len(ids)

    vidjeni: set[str] = set()
    izbor = {"ids": [], "documents": [], "metadatas": [], "embeddings": []}
    razlozi: Counter = Counter()
    for i, doc, m, e in zip(ids, docs, metas, embs):
        t = doc or ""
        if len(t) < MIN_ZNAKOVA:
            continue
        h = hashlib.sha256(t[:500].encode()).hexdigest()
        if h in vidjeni:
            continue
        pogodci = {k for k, r in TEME.items() if r.search(t[:2500])}
        if len(pogodci) < 2:
            continue
        vidjeni.add(h)
        nm = dict(m or {})
        nm["tip_regoc"] = "istrazivanje" if "istrazivanje" in pogodci else "referenca"
        nm["zasticeno"] = True
        nm["izvor_kolekcija"] = IZVOR
        nm["teme"] = ",".join(sorted(pogodci))
        izbor["ids"].append(i)
        izbor["documents"].append(t)
        izbor["metadatas"].append(nm)
        izbor["embeddings"].append(e)
        razlozi[",".join(sorted(pogodci))] += 1

    print(f"{IZVOR}: {n} dokumenata → za izdvajanje {len(izbor['ids'])}")
    for k, v in razlozi.most_common(10):
        print(f"  {v:4}  {k}")
    if a.proba:
        print("\n(proba — ništa nije upisano)")
        return 0

    if ODREDISTE not in kol:
        dohvati(baza(), {"name": ODREDISTE, "metadata": {"svrha": "REGOČ znanje izdvojeno iz naslijeđenih PAI kolekcija"}})
        kol = kolekcije()
    cilj = kol[ODREDISTE]
    for k in range(0, len(izbor["ids"]), 100):
        dohvati(f"{baza()}/{cilj}/upsert", {
            "ids": izbor["ids"][k:k + 100],
            "documents": izbor["documents"][k:k + 100],
            "metadatas": izbor["metadatas"][k:k + 100],
            "embeddings": izbor["embeddings"][k:k + 100],
        })
    novo = dohvati(f"{baza()}/{cilj}/count")
    print(f"\n{ODREDISTE}: sada {novo} dokumenata (izvornik ostaje netaknut)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
