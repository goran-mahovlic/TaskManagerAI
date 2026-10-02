#!/usr/bin/env python3
"""odaberi_workflow.py — treba li zadatak ići po tijeku rada i po kojem.

Goran, 04.09.2026.: „htio bih da naši agenti koriste workflow po potrebi … to bi se trebalo
revidirati kod kreiranja zadatka: koji će se odrađivati po workflowu, koji neće, i koji
workflow."

ODLUKA JE DETERMINISTIČKA. Ne pita se model: izbor tijeka je jeftina odluka koja se donosi
pri svakom otvaranju zadatka, a LLM na tom mjestu je kod nas već jednom promašio 92 %
prometa. Ovdje odlučuju oznaka, okidači iz kataloga i težina posla — sve provjerljivo.

REDOSLIJED (prvi koji se poklopi) — W0/TASK-4620:
    1. oznaka `bez-workflowa` → nikad tijek. PRVA, jer po nalogu §6.1 „uvijek pobjeđuje":
       i izričitu oznaku `workflow:<id>` i način `on`. Zaustavljanje je jeftinije od
       krivo pokrenutog tijeka.
    2. izričita oznaka `workflow:<id>` na zadatku (preskače prag težine, ali NE i `enabled`),
    3. okidač iz `agents/workflows.json` uz uvjet da je težina >= `najmanja_tezina`,
    4. inače: bez tijeka, jedan izvršitelj.

Tijek s `enabled: false` (razina 2 prekidača) ponaša se kao da ga u katalogu nema — ne bira
ga ni okidač ni izričita oznaka. Globalni prekidač (`config/workflow-gate.json`, razina 3)
NIJE posao ovog alata: on je CLI za ljude i uvijek odgovara na pitanje „što BI se odabralo".
Način rada primjenjuje pogon — `src/core/WorkflowGate.ts`, koji je izvor istine za
odluku; parnost dviju preslika drži `tests/workflow-gate-parity.test.ts` (ADR-0004).

Težina je ljestvica 1–100 (E1 1–15, E2 16–35, E3 36–60, E4 61–80, E5 81–100). Ako nije
zadana, procjenjuje se grubo iz duljine i glagola — namjerno oprezno, jer je krivo pokrenut
tijek skuplji od propuštenog.

    python3 tools/odaberi_workflow.py --naslov "Ne radi prijava na stranicu" --tezina 40
    python3 tools/odaberi_workflow.py --naslov "..." --opis "..." --json
    python3 tools/odaberi_workflow.py --popis
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

KATALOG = Path(__file__).resolve().parent.parent / "agents" / "workflows.json"

# Gruba procjena težine kad je nema: samo dokaz da je posao velik diže ocjenu.
GLAGOLI_RADA = re.compile(
    r"\b(implementiraj|napravi|izradi|popravi|prepravi|dodaj|istraž|prouči|analiziraj|"
    r"provjeri|testiraj|uskladi|prenesi|postavi)\w*", re.IGNORECASE)


def ucitaj(put: Path = KATALOG) -> dict:
    return json.loads(put.read_text(encoding="utf-8"))


def ukljucen(w: dict) -> bool:
    """Razina 2 prekidača: `enabled` po tijeku. Polje koje nedostaje = uključen."""
    return w.get("enabled", True) is not False


def procijeni_tezinu(tekst: str) -> int:
    """1–100, oprezno. Bez dokaza da je posao velik ostaje nisko."""
    t = tekst.strip()
    bodovi = 10
    if len(t) > 120:
        bodovi += 10
    if len(t) > 400:
        bodovi += 10
    bodovi += min(20, 5 * len(set(m.group(0).lower() for m in GLAGOLI_RADA.finditer(t))))
    if re.search(r"\n\s*[-*\d]", t):          # nabrajanje = više koraka
        bodovi += 10
    if re.search(r"\b\d+\s*(dana|tjedn|mjesec)", t, re.IGNORECASE):
        bodovi += 15
    return max(1, min(100, bodovi))


def odaberi(naslov: str, opis: str = "", tezina: int | None = None,
            oznake: list[str] | None = None, katalog: dict | None = None) -> dict:
    k = katalog or ucitaj()
    oznake = [str(o).strip().lower() for o in (oznake or [])]
    tekst = f"{naslov}\n{opis}".strip()
    t = tezina if isinstance(tezina, int) else procijeni_tezinu(tekst)

    # Razina 1 — kočnica na zadatku. PRVA: „uvijek pobjeđuje" (nalog §6.1).
    if "bez-workflowa" in oznake:
        return {"workflow": None, "kod": "bez-workflowa",
                "razlog": "oznaka `bez-workflowa` na zadatku", "tezina": t, "koraci": []}

    for o in oznake:
        if o.startswith("workflow:"):
            wid = o.split(":", 1)[1].strip()
            w = k["workflows"].get(wid)
            if w is None:
                return {"workflow": None, "kod": "oznaka-nepoznat",
                        "razlog": f'oznaka traži nepoznat tijek „{wid}"',
                        "tezina": t, "koraci": []}
            if not ukljucen(w):
                return {"workflow": None, "kod": "oznaka-ugasen",
                        "razlog": f'tijek „{wid}" je ugašen (enabled=false)',
                        "tezina": t, "koraci": []}
            return {"workflow": wid, "kod": "oznaka",
                    "razlog": "izričita oznaka na zadatku",
                    "tezina": t, "koraci": w["koraci"]}

    # Ugašen tijek se preskače kao da ga nema, ali se PAMTI — inače bi razlog „nijedan
    # okidač ne odgovara" sakrio to da je tijek zapravo ručno isključen.
    preskoceni: list[str] = []
    for wid, w in k["workflows"].items():
        for uzorak in w.get("okidaci", []):
            if not re.search(uzorak, tekst, re.IGNORECASE):
                continue
            if not ukljucen(w):
                preskoceni.append(wid)
                break
            prag = int(w.get("najmanja_tezina", 0))
            if t < prag:
                return {"workflow": None, "kod": "prelagan",
                        "razlog": f'okidač „{uzorak}" pogađa {wid}, ali težina {t} < {prag}',
                        "tezina": t, "koraci": []}
            return {"workflow": wid, "kod": "okidac", "razlog": f'okidač „{uzorak}"',
                    "tezina": t, "koraci": w["koraci"]}

    if preskoceni:
        return {"workflow": None, "kod": "ugasen",
                "razlog": "okidač pogađa, ali je tijek ugašen (enabled=false): "
                          + ", ".join(preskoceni),
                "tezina": t, "koraci": []}
    return {"workflow": None, "kod": "nema-okidaca",
            "razlog": "nijedan okidač ne odgovara", "tezina": t, "koraci": []}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--naslov", default="")
    ap.add_argument("--opis", default="")
    ap.add_argument("--tezina", type=int, default=None)
    ap.add_argument("--oznake", default="", help="zarezom odvojeno")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--popis", action="store_true")
    ap.add_argument("--katalog", default=None,
                    help="drugi katalog (za provjeru parnosti s WorkflowGate.ts)")
    a = ap.parse_args()

    k = ucitaj(Path(a.katalog)) if a.katalog else ucitaj()
    if a.popis:
        print(f"{'ID':22}{'NAJMANJA TEŽINA':>16}  KORACI")
        for wid, w in k["workflows"].items():
            koraci = " → ".join(s["agent"] for s in w["koraci"])
            stanje = "" if ukljucen(w) else "  [UGAŠEN]"
            print(f"{wid:22}{w.get('najmanja_tezina', 0):>16}  {koraci}{stanje}")
            print(f"{'':22}{'':16}  okidači: {', '.join(w.get('okidaci', []))[:90]}")
        return 0

    if not a.naslov:
        ap.error("treba --naslov (ili --popis)")
    odluka = odaberi(a.naslov, a.opis, a.tezina,
                     [o for o in a.oznake.split(",") if o.strip()], k)
    if a.json:
        print(json.dumps(odluka, ensure_ascii=False))
        return 0
    if odluka["workflow"]:
        w = k["workflows"][odluka["workflow"]]
        print(f"tijek: {odluka['workflow']} — {w['naziv']} (težina {odluka['tezina']})")
        print(f"razlog: {odluka['razlog']}")
        for i, s in enumerate(w["koraci"], 1):
            vj = f" [{s['vjestina']}]" if s.get("vjestina") else ""
            print(f"  {i}. {s['agent']}{vj}: {s['opis']}")
    else:
        print(f"bez tijeka — jedan izvršitelj (težina {odluka['tezina']})")
        print(f"razlog: {odluka['razlog']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
