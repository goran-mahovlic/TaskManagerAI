#!/usr/bin/env python3
"""vrijednost_inputa.py — vrijednost rada po korisničkom upitu (cjenik S1–S6).

Vlasnik, 04.09.2026.: „napravi izračun koliko se novaca potrošilo na user input … to mora
biti podijeljeno po korisnicima."

ŠTO OVO JEST: procjena VRIJEDNOSTI isporučenog rada po vlasnikovu cjeniku, ne trošak tokena.
Trošak modela je zasebna brojka (`cost_log`, ~4 400 USD) i njih dvoje se ne miješaju:
jedno je što nas rad košta, drugo koliko vrijedi.

CJENIK (vlasnik, 04.09.2026.)
    S1 Simple      0,05 €   jednostavno pitanje / naredba
    S2 Standard    0,20 €   normalan poslovni ili informativni upit
    S3 Complex     1,00 €   tehnički problem koji traži razmišljanje
    S4 Expert      5,00 €   ozbiljna analiza / debugging / projektantska odluka
    S5 Research   15,00 €   istraživanje, usporedba izvora, zaključak
    S6 Project    50,00 €   konkretan dio projekta, višekoračni rad i iteracije

KAKO SE RAZVRSTAVA — MJERENO, NE NAGAĐANO
    Razred se određuje iz onoga što je zabilježeno u transkriptu za taj upit: koliko je
    koraka model napravio, je li i koliko puta posegnuo za alatima, kojim alatima
    (pretraga weba/RAG-a = istraživanje; pisanje datoteka/git = projektni rad) i koliko
    je taj odsječak stajao. Namjerno se NE pita model za ocjenu: 1 341 upit × jedan poziv
    klasifikatora bio bi skuplji od svega što mjeri, a ranije mjerenje (TASK-2559) pokazalo
    je da LLM-vrata na vrućem putu krivo skreću 92 % prometa.

    Prag se čita odozgo prema dolje; prvi koji se poklopi određuje razred.

UPORABA
    python3 tools/vrijednost_inputa.py                 # tablica po korisniku i razredu
    python3 tools/vrijednost_inputa.py --po-projektu
    python3 tools/vrijednost_inputa.py --json
    python3 tools/vrijednost_inputa.py --primjeri      # po tri primjera za svaki razred
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ALATI = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("uvoz", ALATI / "uvoz_telegram_zadataka.py")
uvoz = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uvoz)

CIJENE = {"S1": 0.05, "S2": 0.20, "S3": 1.00, "S4": 5.00, "S5": 15.00, "S6": 50.00}
NAZIVI = {
    "S1": "Simple — jednostavno pitanje / naredba",
    "S2": "Standard — poslovni ili informativni upit",
    "S3": "Complex — tehnički problem koji traži razmišljanje",
    "S4": "Expert — analiza / debugging / projektantska odluka",
    "S5": "Research — istraživanje i usporedba izvora",
    "S6": "Project work — višekoračni rad na projektu",
}
ALATI_ISTRAZIVANJA = {"WebSearch", "WebFetch", "mcp__pcbparts", "Agent", "Task"}
ALATI_PISANJA = {"Write", "Edit", "NotebookEdit", "MultiEdit"}

# Nadimci pošiljatelja → ime na računu: `korisnici` u uvoz-telegrama.json (TASK-5108 — imena
# ljudi su podatak instalacije, ne kod). Bez konfiguracije ime ide kako je napisano.
KORISNICI = uvoz.KORISNICI


def korisnik(posiljatelj: str) -> str:
    """Ime pošiljatelja → korisnik s računa. Sve što nije prepoznato ide u „(nepoznat)".

    Bez ovoga u popis upadne i pokoji artefakt raščlambe (biljeg `[OD:` zna se pojaviti
    unutar citiranog teksta), pa se na računu stvori „korisnik" od 200 znakova.
    """
    ime = (posiljatelj or "").split("(")[0].strip().lower()
    if ime in KORISNICI:
        return KORISNICI[ime]
    if not ime or len(ime) > 20 or not re.fullmatch(r"[a-zšđčćž .-]+", ime):
        return "(nepoznat)"
    return ime.title()


def segmenti_s_alatima(path: Path) -> list[dict]:
    """Kao `uvoz.segmenti_sjednice`, ali uz popis alata i broj njihovih poziva."""
    segs: list[dict] = []
    tek: dict | None = None
    vidjeni: set[str] = set()
    posiljatelj = None
    redni = 0

    def zatvori():
        nonlocal tek
        if tek and (tek["out"] or tek["cr"] or tek["cw"]):
            tek["usd"] = round(uvoz.cijena(tek["in"], tek["out"], tek["cr"], tek["cw"],
                                           tek["model"], tek["cw1h"]), 4)
            segs.append(tek)
        tek = None

    try:
        fh = uvoz.otvori(path)
    except OSError:
        return []
    with fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except (ValueError, TypeError):
                continue
            ts = rec.get("timestamp")
            if rec.get("type") == "user":
                c = (rec.get("message") or {}).get("content")
                blob = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                if "[OD: " in (blob or ""):
                    zatvori()
                    m = uvoz.BILJEG.search(blob)
                    posiljatelj = (m.group(1).strip() if m else posiljatelj or "?")
                    zadnji = re.sub(r"^[^\]]*\]\s*", "", blob.split("[OD: ")[-1])
                    redni += 1
                    tek = {
                        "session_id": uvoz.sesija_id(path), "redni": redni,
                        "posiljatelj": posiljatelj, "zahtjev": uvoz.ocisti(zadnji)[:2000],
                        "start": ts, "kraj": ts, "in": 0, "out": 0, "cr": 0, "cw": 0,
                        "cw1h": 0, "model": "claude-opus-5", "koraka": 0,
                        "alati": set(), "poziva_alata": 0,
                    }
            elif rec.get("type") == "assistant" and tek is not None:
                msg = rec.get("message") or {}
                mid = msg.get("id")
                if mid:
                    if mid in vidjeni:
                        continue
                    vidjeni.add(mid)
                u = msg.get("usage") or {}
                tek["in"] += u.get("input_tokens", 0) or 0
                tek["out"] += u.get("output_tokens", 0) or 0
                tek["cr"] += u.get("cache_read_input_tokens", 0) or 0
                tek["cw"] += u.get("cache_creation_input_tokens", 0) or 0
                tek["cw1h"] += ((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0)
                mdl = msg.get("model")
                if mdl and not mdl.startswith("<"):
                    tek["model"] = mdl
                tek["koraka"] += 1
                if ts:
                    tek["kraj"] = ts
                cont = msg.get("content")
                if isinstance(cont, list):
                    for b in cont:
                        if isinstance(b, dict) and b.get("type") == "tool_use":
                            tek["alati"].add(str(b.get("name") or "?"))
                            tek["poziva_alata"] += 1
    zatvori()
    return [s for s in segs if s["zahtjev"]]


def razred(s: dict) -> str:
    alati = s["alati"]
    istrazivanje = any(a.split("__")[0] in {x.split("__")[0] for x in ALATI_ISTRAZIVANJA} for a in alati)
    pisanje = bool(alati & ALATI_PISANJA)
    koraka, poziva, usd = s["koraka"], s["poziva_alata"], s["usd"]
    duljina = len(s["zahtjev"])

    # Trošak NIJE mjerilo složenosti: u dugoj sjednici i kratak odgovor plaća veliku
    # predmemoriju (mjereno: 6 koraka bez ijednog alata = 2,35 USD). Odlučuju koraci,
    # broj poziva alata i vrsta alata; USD ostaje samo u ispisu radi provjere.
    if koraka >= 60 or poziva >= 40 or (pisanje and koraka >= 30):
        return "S6"
    if istrazivanje and koraka >= 12:
        return "S5"
    if koraka >= 25 or poziva >= 15 or (pisanje and koraka >= 8):
        return "S4"
    if poziva >= 3 or koraka >= 6:
        return "S3"
    if koraka >= 2 or duljina >= 120:
        return "S2"
    return "S1"


def prikupi() -> list[dict]:
    out = []
    for f in uvoz.svi_transkripti():
        for s in segmenti_s_alatima(f):
            s["razred"] = razred(s)
            s["eur"] = CIJENE[s["razred"]]
            s["korisnik"] = korisnik(s["posiljatelj"])
            out.append(s)
    out.sort(key=lambda x: x["start"] or "")
    return out


def projekti_segmenata() -> tuple[dict[str, str], dict[str, str]]:
    """→ (`<session>#<n>` → projekt, `<session>` → projekt sjednice).

    Prvi je izravan pogodak (segment je postao zadatak i taj zadatak ima projekt), drugi je
    ono što se dade zaključiti o cijeloj sjednici — većina njezinih razvrstanih segmenata.
    """
    import sqlite3
    from collections import Counter
    po_segmentu: dict[str, str] = {}
    glasovi: dict[str, Counter] = defaultdict(Counter)
    try:
        con = sqlite3.connect(f"file:{uvoz.DB}?mode=ro", uri=True)
        for pid, opis in con.execute(
                "SELECT project_id, description FROM tasks WHERE description LIKE '%[uvoz:telegram segment=%'"):
            m = re.search(r"\[uvoz:telegram segment=([^\]]+)\]", opis or "")
            if m and pid:
                po_segmentu[m.group(1)] = pid
                glasovi[m.group(1).split("#")[0]][pid] += 1
        con.close()
    except Exception:
        pass
    po_sjednici = {sid: c.most_common(1)[0][0] for sid, c in glasovi.items()}
    return po_segmentu, po_sjednici


def nazivi_projekata() -> dict[str, str]:
    """`PRJ-041` → „MUSZG-WEB-PYTHON". Ključ sam po sebi ne kaže ništa (vlasnik, 04.09.2026.)."""
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{uvoz.DB}?mode=ro", uri=True)
        mapa = {i: n for i, n in con.execute("SELECT id, name FROM projects")}
        con.close()
        return mapa
    except Exception:
        return {}


def projekt_segmenta(s: dict, po_segmentu: dict[str, str], po_sjednici: dict[str, str]) -> str:
    """Projekt jednog upita — dokaz prije nagađanja.

    1. segment je postao zadatak i taj zadatak ima projekt → to je projekt;
    2. inače projekt sjednice (većina razvrstanih segmenata istog razgovora);
    3. inače ključne riječi iz samog upita (ista mapa kao uvoz);
    4. inače Pretinac. Bez ovoga je 866 od 1 342 upita ostajalo „nepripisano", pa se
       vrijednost nije mogla vidjeti na projektu.
    """
    kljuc = f"{s['session_id']}#{s['redni']}"
    if kljuc in po_segmentu:
        return po_segmentu[kljuc]
    if s["session_id"] in po_sjednici:
        return po_sjednici[s["session_id"]]
    return uvoz.projekt_iz_teksta(s["zahtjev"]) or "PRJ-033"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--po-projektu", action="store_true")
    ap.add_argument("--primjeri", action="store_true")
    a = ap.parse_args()

    segs = prikupi()
    po_korisniku: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for s in segs:
        po_korisniku[s["korisnik"]][s["razred"]] += 1

    if a.po_projektu:
        po_segmentu, po_sjednici = projekti_segmenata()
        po_pr: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for x in segs:
            po_pr[projekt_segmenta(x, po_segmentu, po_sjednici)][x["razred"]] += 1
        print(f"{'PROJEKT':18}{'UPITA':>7}{'EUR':>11}   razredi")
        for pid, v in sorted(po_pr.items(), key=lambda kv: -sum(CIJENE[r] * n for r, n in kv[1].items())):
            eur = sum(CIJENE[r] * n for r, n in v.items())
            razredi = " ".join(f"{r}:{n}" for r, n in sorted(v.items()))
            print(f"{pid:18}{sum(v.values()):>7}{eur:>11.2f}   {razredi}")
        return 0

    if a.json:
        red = {k: {"razredi": dict(v),
                   "upita": sum(v.values()),
                   "eur": round(sum(CIJENE[r] * n for r, n in v.items()), 2)}
               for k, v in po_korisniku.items()}
        po_segmentu, po_sjednici = projekti_segmenata()
        po_pr: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        # Vlasnik, 04.09.2026.: „kada otvorim projekt ne vidi se koliko je od ljudi tko radio."
        # Uz razrede se zato vodi i raspodjela po osobama — isti upiti, drugi rez.
        po_pr_kor: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"upita": 0, "eur": 0.0}))
        for x in segs:
            pid = projekt_segmenta(x, po_segmentu, po_sjednici)
            po_pr[pid][x["razred"]] += 1
            k = po_pr_kor[pid][x["korisnik"]]
            k["upita"] += 1
            k["eur"] = round(k["eur"] + x["eur"], 2)
        nazivi = nazivi_projekata()
        projekti = {pid: {"razredi": dict(v), "upita": sum(v.values()),
                          "eur": round(sum(CIJENE[r] * n for r, n in v.items()), 2),
                          "naziv": nazivi.get(pid, pid),
                          "poKorisniku": {k: dict(x) for k, x in po_pr_kor[pid].items()}}
                    for pid, v in po_pr.items()}
        print(json.dumps({"cjenik": CIJENE, "poKorisniku": red, "poProjektu": projekti,
                          "ukupnoEur": round(sum(x["eur"] for x in red.values()), 2),
                          "upita": len(segs),
                          "razdoblje": [segs[0]["start"][:10], segs[-1]["start"][:10]] if segs else None},
                         ensure_ascii=False, indent=1))
        return 0

    print(f"Upita ukupno: {len(segs)} · razdoblje {segs[0]['start'][:10]} … {segs[-1]['start'][:10]}\n")
    zaglavlje = f"{'KORISNIK':16}" + "".join(f"{r:>7}" for r in CIJENE) + f"{'UPITA':>8}{'EUR':>11}"
    print(zaglavlje)
    print("-" * len(zaglavlje))
    ukupno_eur = 0.0
    for k, v in sorted(po_korisniku.items(), key=lambda kv: -sum(CIJENE[r] * n for r, n in kv[1].items())):
        eur = sum(CIJENE[r] * n for r, n in v.items())
        ukupno_eur += eur
        print(f"{k:16}" + "".join(f"{v.get(r, 0):>7}" for r in CIJENE)
              + f"{sum(v.values()):>8}{eur:>11.2f}")
    print("-" * len(zaglavlje))
    svi = defaultdict(int)
    for v in po_korisniku.values():
        for r, n in v.items():
            svi[r] += n
    print(f"{'UKUPNO':16}" + "".join(f"{svi.get(r, 0):>7}" for r in CIJENE)
          + f"{len(segs):>8}{ukupno_eur:>11.2f}")

    print("\nRazredi (cijena × broj = iznos):")
    for r in CIJENE:
        n = svi.get(r, 0)
        print(f"  {r} {NAZIVI[r]:52} {CIJENE[r]:>6.2f} € × {n:>4} = {CIJENE[r]*n:>9.2f} €")

    if a.primjeri:
        print("\nPrimjeri po razredu:")
        for r in CIJENE:
            uzorak = [s for s in segs if s["razred"] == r][:3]
            print(f"\n  ── {r} ──")
            for s in uzorak:
                print(f"    [{s['koraka']:>3} koraka, {s['poziva_alata']:>3} alata, {s['usd']:.2f} USD] "
                      f"{s['korisnik']}: {s['zahtjev'][:80]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
