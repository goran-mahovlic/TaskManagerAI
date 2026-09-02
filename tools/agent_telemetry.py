#!/usr/bin/env python3
"""
agent_telemetry.py — telemetrija JEDNOG izvođenja zadatka iz Claude Code transkripta.

Kriška K1 iz ADR-TELEMETRIJA-ZADATKA (§10). Pokriva **mjere 1, 2, 3 i 5**:

    1  razlaganje trajanja      (ADR §4)  → `trajanje`
    2  latencija poziva modela  (ADR §5)  → `latencija_modela`
    3  histogram alata          (ADR §6)  → `alati`
    4  trenje R/F/P             (ADR §7)  → `trenje`
    5  udio predmemorije        (ADR §8.1)→ `tokeni`

MJERA 4 — TRENJE (kriška K2, ADR §7). Tri neovisna signala nad nizom poziva alata
u redoslijedu izdavanja:

    R  ponovljena ista naredba — isti potpis N× unutar prozora od W = 10 poziva
       (N ≥ 4 upozorenje, N ≥ 6 trenje)
    F  uzastopni neuspjeli izlaz — K uzastopnih `tool_result.is_error` (K ≥ 3 trenje),
       s podvrstom: hook_blokada / nepostojeci_put / izlazni_kod / neispravan_ulaz / ostalo
    P  vrtnja u petlji — k-gram (k ≤ 3) potpisa ponovljen uzastopno C× (C ≥ 3 trenje)

Potpis poziva (ADR §7.0) je `ime|sha1(…)[0:12]` — u zapis po shemi NIKAD ne ide doslovan
tekst naredbe. Skraćeni argument (do 60 znakova, s redakcijom tajni) postoji samo u ispisu
za čovjeka i u `--json --primjeri`, kao ODVOJEN objekt.

`izgubljeno_s` je gornja procjena: zbroj pripisanog vremena modela i alata za pozive iz
UNIJE označenih raspona (poziv označen s dva signala broji se jednom). Objavljuje se kao
„do X s" — dio toga rada je i koristan. Trenje je oznaka za pregled, nikad automatsko
zatvaranje ni kažnjavanje zadatka (ADR §7.4).

Bez transkripta `trenje` ostaje `null` — nedostajuća vrijednost je `null`, nikad 0 (ADR §9).

IZVOR ISTINE (ADR O3)
    transkript ~/.claude/projects/<projekt-slug>/<session_id>.jsonl
               (rezerva kad ga Claude Code obriše nakon ~30 dana: trajni arhiv
                ~/.claude/regoc/data/transkript_arhiv/**/<session_id>.jsonl.gz — T9)
        → vrijeme, latencija, alati, tokeni
    ~/.claude/regoc/data/run_log.jsonl
        → task_id, agent, ishod, exit_code, cost_usd, num_turns, duration_s
    ~/.claude/regoc/data/regoc.db (samo za čitanje)
        → tasks.project_id

TRI ODLUKE KOJE OVAJ ALAT PROVODI (ADR §3)
    O1  Jedan poziv modela = jedna grupa `assistant` redaka s istim `message.id`.
        Harness isti API odgovor piše kao više redaka i SVAKOM upiše puni `usage`;
        zbrajanje po retku prenapuhuje tokene ×2,01 (medijan, mjereno na 87 parova).
    O2  Vremenska os su samo `user` i `assistant` retci. `attachment` i `queue-operation`
        nose nekronološke oznake (32 inverzije na referentnom transkriptu).
    O3  Tokeni i vrijeme iz transkripta, trošak i ishod iz `run_log`; razlika se ne skriva
        nego zapisuje u `pomirenje` + zastavicu `run_log_podbacuje`.

MEMORIJA
    Transkript se čita STROGO redak po redak (`for line in fh`) i odmah svodi na sitan
    zapis događaja (vrijeme, `message.id`, imena alata, `usage`). Sadržaj poruka i
    rezultata alata se NE zadržava. Referentni transkript je 44 MB / 2 998 redaka, a
    vršna potrošnja alata mjeri se u stotinama kilobajta (`--mjeri-memoriju`).

UPORABA
    python3 tools/agent_telemetry.py --task TASK-3565
    python3 tools/agent_telemetry.py --session 2449014c-e0fa-4fc1-bf36-053fc23a326d --json
    python3 tools/agent_telemetry.py --transkript ~/.claude/projects/x/<sid>.jsonl
    python3 tools/agent_telemetry.py --zadnjih 3 --json          # zadnji retci run_log.jsonl
    python3 tools/agent_telemetry.py --task TASK-3565 --validiraj
    python3 tools/agent_telemetry.py --task TASK-3503 --json --primjeri   # trenje odvojeno
    python3 tools/agent_telemetry.py --zadnjih 5 --jsonl-out ~/.claude/regoc/data/task_telemetry.jsonl

    Sve vremenske oznake u izlazu su UTC sa sufiksom `Z` (ADR §9).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import gzip
import sqlite3
import statistics
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime, timezone
from glob import glob
from pathlib import Path
from typing import Iterator

SHEMA_ID = "regoc.telemetrija-zadatka/v1"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
RUN_LOG = Path.home() / ".claude" / "regoc" / "data" / "run_log.jsonl"
REGOC_DB = Path.home() / ".claude" / "regoc" / "data" / "regoc.db"
SHEMA_PUT = Path(__file__).resolve().parent.parent / "docs" / "schema" / "telemetrija-zadatka.schema.json"

# T9 (TASK-3574): Claude Code briše transkripte starije od ~30 dana, pa se telemetrija
# starijih zadataka više nije mogla ni izračunati ni provjeriti (nalaz C, T6 QA). Otkad
# postoji trajni arhiv, ŽIVI transkript je samo prvi izbor — ako ga nema, čita se
# arhivirana .gz inačica. Uvoz je mekan: alat radi i bez arhiva (samo bez tog izvora).
try:
    import transkript_arhiv as _arhiv
except ImportError:  # pragma: no cover
    _arhiv = None

# ADR §4.1: |rezija_s| do ove granice je zaokruživanje na milisekundu, ne kvar.
REZIJA_TOLERANCIJA_S = 1.0
# ADR O3: relativno odstupanje izlaznih tokena iznad kojega run_log smatramo manjkavim.
POMIRENJE_PRAG = 0.05


# ─────────────────────────────────────────────────────────────────────────────
# Sitne pomoćne funkcije
# ─────────────────────────────────────────────────────────────────────────────

def ts_to_epoch(iso: str) -> float | None:
    """ISO-8601 → sekunde. None ako oznaka nije čitljiva (redak se tada preskače)."""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError, TypeError):
        return None


def epoch_to_iso(epoch: float | None) -> str | None:
    """Sekunde → ISO-8601 UTC s milisekundama i sufiksom `Z` (ADR §9)."""
    if epoch is None:
        return None
    dt = datetime.fromtimestamp(epoch, timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def r3(x: float | None) -> float | None:
    return None if x is None else round(x, 3)


def r4(x: float | None) -> float | None:
    return None if x is None else round(x, 4)


def r6(x: float | None) -> float | None:
    return None if x is None else round(x, 6)


def udio(brojnik: float | None, nazivnik: float | None) -> float | None:
    """Udio 0..1; None kad nazivnik ne postoji ili je nula (ADR §9: nema lažnih nula)."""
    if not nazivnik:
        return None
    return r4(max(0.0, min(1.0, brojnik / nazivnik)))


def percentil(niz: list[float], p: float) -> float | None:
    """Metoda najbližeg ranga: indeks ceil(p·n) − 1 u uzlazno sortiranom nizu (ADR §5)."""
    if not niz:
        return None
    s = sorted(niz)
    return s[max(0, min(len(s) - 1, math.ceil(p * len(s)) - 1))]


# ─────────────────────────────────────────────────────────────────────────────
# MJERA 4 — trenje (ADR §7): potpis poziva, klasifikacija greške, signali R/F/P
# ─────────────────────────────────────────────────────────────────────────────

# ADR §7: pragovi izmjereni na 215 transkripata / 19 269 poziva alata (1. 9. 2026.).
PRAGOVI = {
    "R_prozor": 10,      # §7.1 klizni prozor u broju poziva alata
    "R_upozorenje": 4,   # §7.1 percentil 80
    "R_trenje": 6,       # §7.1 percentil 92
    "F_trenje": 3,       # §7.2 percentil 96
    "P_k_max": 3,        # §7.3 najdulji k-gram koji se traži
    "P_trenje": 3,       # §7.3 percentil 94
}
# Duljina skraćenog argumenta u ispisu za čovjeka (zapis po shemi nosi samo potpis).
KRATKI_MAX = 60
POTPIS_ULAZ_MAX = 500                     # ADR §7.0: rezanje kanonskog JSON-a
GRESKA_UZORAK_MAX = 4000                  # koliko teksta rezultata gledamo pri razvrstavanju

# Tajne se ne smiju naći ni u skraćenom argumentu (obrana u 3 sloja, L3).
_TAJNE = [
    re.compile(r"sk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{30,}"),                      # Telegram bot token
    re.compile(r"(?i)\b(token|secret|passwo?rd|api[_\-]?key|bearer)\b\s*[:=]\s*\S+"),
]


def redigiraj(tekst: str) -> str:
    for uzorak in _TAJNE:
        tekst = uzorak.sub("⟨tajna⟩", tekst)
    return tekst


def sazmi(tekst: str) -> str:
    """Sažimanje razmaka iz ADR §7.0 — višestruki razmaci/novi redci → jedan razmak."""
    return re.sub(r"\s+", " ", tekst).strip()


def skrati(tekst: str, n: int = KRATKI_MAX) -> str:
    tekst = redigiraj(sazmi(tekst))
    return tekst if len(tekst) <= n else tekst[: n - 1] + "…"


def skrati_put(put: str, n: int = KRATKI_MAX) -> str:
    """
    Putanje se režu po SREDINI, ne po repu: kod `Read`/`Edit` se dva poziva razlikuju
    upravo po završetku (`…/tools/a.py` vs `…/tools/b.py`), pa rezanje repa dva različita
    poziva prikaže kao isti.
    """
    put = redigiraj(sazmi(put))
    if len(put) <= n:
        return put
    rep = "/".join(put.split("/")[-2:])
    if len(rep) + 2 >= n:
        return "…" + put[-(n - 1):]
    glava = put[: n - len(rep) - 2]
    return f"{glava}…/{rep}"


def potpis_poziva(ime: str, unos) -> tuple[str, str]:
    """
    ADR §7.0. Vraća (potpis, skraćeni argument).

    potpis          = ime + "|" + sha1(…)[0:12]      → ide u zapis (nikad doslovan tekst)
    skraćeni argument                                 → ide SAMO u ispis za čovjeka
    """
    if not isinstance(unos, dict):
        unos = {}
    if ime == "Bash":
        sirovo = sazmi(str(unos.get("command") or ""))
        sjeme = sirovo
    elif ime in ("Read", "Write", "Edit", "NotebookEdit"):
        sirovo = str(unos.get("file_path") or unos.get("notebook_path") or "")
        sjeme = f"{ime}:{sirovo}"
        return (f"{ime}|{hashlib.sha1(sjeme.encode('utf-8', 'replace')).hexdigest()[:12]}",
                skrati_put(sirovo) or "(bez argumenta)")
    else:
        try:
            kan = json.dumps(unos, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            kan = str(unos)
        sirovo = kan[:POTPIS_ULAZ_MAX]
        sjeme = f"{ime}:{sirovo}"
    sazetak = hashlib.sha1(sjeme.encode("utf-8", "replace")).hexdigest()[:12]
    return (f"{ime}|{sazetak}", skrati(sirovo) or "(bez argumenta)")


# ADR §7.2 — podvrste neuspjeha se razlikuju jer traže različit popravak.
_PODVRSTE = (
    ("hook_blokada", re.compile(r"(PreToolUse|PostToolUse|UserPromptSubmit)[^\n]{0,80}?hook|"
                                r"operation blocked by hook", re.I)),
    ("nepostojeci_put", re.compile(r"File (does not exist|has not been read)|"
                                   r"No such file or directory|ENOENT", re.I)),
    ("neispravan_ulaz", re.compile(r"InputValidationError|invalid (input|argument|parameter)", re.I)),
    ("izlazni_kod", re.compile(r"Exit code\s*\d+|exited with (code|status)\s*\d+", re.I)),
)


def klasificiraj_gresku(tekst: str) -> str:
    """Iz teksta neuspjelog rezultata izvuci SAMO oznaku podvrste — tekst se ne pamti."""
    for oznaka, uzorak in _PODVRSTE:
        if uzorak.search(tekst):
            return oznaka
    return "ostalo"


def _tekst_rezultata(blok: dict) -> str:
    """Prvih GRESKA_UZORAK_MAX znakova rezultata, samo radi razvrstavanja podvrste."""
    sadrzaj = blok.get("content")
    if isinstance(sadrzaj, str):
        return sadrzaj[:GRESKA_UZORAK_MAX]
    if isinstance(sadrzaj, list):
        dijelovi = []
        for c in sadrzaj:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                dijelovi.append(c["text"])
            if sum(len(d) for d in dijelovi) > GRESKA_UZORAK_MAX:
                break
        return " ".join(dijelovi)[:GRESKA_UZORAK_MAX]
    return ""


def _signal_R(pozivi: list[dict], pr: dict) -> list[dict]:
    """ADR §7.1 — isti potpis N puta unutar kliznog prozora od W poziva."""
    W = pr["R_prozor"]
    po_potpisu: dict[str, list[int]] = defaultdict(list)
    for i, p in enumerate(pozivi):
        po_potpisu[p["potpis"]].append(i)

    dogadjaji = []
    for potpis, P in po_potpisu.items():
        if len(P) < pr["R_upozorenje"]:
            continue
        najbolji = (0, 0, 0)
        i = 0
        for j in range(len(P)):
            while P[j] - P[i] > W - 1:      # prozor je W UZASTOPNIH poziva
                i += 1
            if j - i + 1 > najbolji[0]:
                najbolji = (j - i + 1, P[i], P[j])
        N, od, do = najbolji
        razina = ("trenje" if N >= pr["R_trenje"]
                  else "upozorenje" if N >= pr["R_upozorenje"] else None)
        if not razina:
            continue
        p0 = pozivi[od]
        dogadjaji.append({
            "signal": "R", "razina": razina, "od_poziva": od, "do_poziva": do,
            "mjera": N, "potpis": potpis, "podvrsta": None,
            "opis": f"{p0['ime']}: isti potpis {N}× unutar {W} uzastopnih poziva",
            "_kratki": p0["kratki"], "_ime": p0["ime"],
        })
    return dogadjaji


def _signal_F(pozivi: list[dict], pr: dict) -> list[dict]:
    """ADR §7.2 — K uzastopnih poziva s tool_result.is_error === true."""
    dogadjaji = []
    i = 0
    while i < len(pozivi):
        if not pozivi[i]["greska"]:
            i += 1
            continue
        j = i
        while j + 1 < len(pozivi) and pozivi[j + 1]["greska"]:
            j += 1
        K = j - i + 1
        if K >= pr["F_trenje"]:
            podvrste = [pozivi[x]["podvrsta"] for x in range(i, j + 1) if pozivi[x]["podvrsta"]]
            glavna = max(set(podvrste), key=podvrste.count) if podvrste else "ostalo"
            dogadjaji.append({
                "signal": "F", "razina": "trenje", "od_poziva": i, "do_poziva": j,
                "mjera": K, "potpis": pozivi[i]["potpis"], "podvrsta": glavna,
                "opis": f"{K} uzastopna neuspjela poziva ({glavna})",
                "_kratki": pozivi[i]["kratki"], "_ime": pozivi[i]["ime"],
            })
        i = j + 1
    return dogadjaji


def _signal_P(pozivi: list[dict], pr: dict) -> list[dict]:
    """ADR §7.3 — k-gram (k ≤ P_k_max) koji se uzastopno ponavlja C puta."""
    niz = [p["potpis"] for p in pozivi]
    kandidati = []
    for k in range(2, pr["P_k_max"] + 1):
        i = 0
        while i + k <= len(niz):
            blok = niz[i:i + k]
            if len(set(blok)) == 1:
                # Degenerirani ciklus (A A A A…) je doslovno signal R, ne petlja: ADR §7.3
                # traži izmjenu poziva („A B A B A B"). Bez ovoga isti nalaz podigne ocjenu
                # dvaput (R i P) iako je riječ o jednom te istom ponašanju.
                i += 1
                continue
            C = 1
            while niz[i + C * k: i + (C + 1) * k] == blok:
                C += 1
            if C >= pr["P_trenje"]:
                kandidati.append({"k": k, "od": i, "do": i + C * k - 1, "C": C})
                i += C * k
            else:
                i += 1

    # Ciklus duljine 3 koji pokriva isti raspon kao ciklus duljine 2 nije nov nalaz.
    kandidati.sort(key=lambda c: (-(c["do"] - c["od"]), -c["C"], c["k"]))
    zadrzani: list[dict] = []
    for c in kandidati:
        if any(z["od"] <= c["od"] and c["do"] <= z["do"] for z in zadrzani):
            continue
        zadrzani.append(c)

    dogadjaji = []
    for c in sorted(zadrzani, key=lambda c: c["od"]):
        blok = niz[c["od"]: c["od"] + c["k"]]
        imena = [pozivi[c["od"] + x]["ime"] for x in range(c["k"])]
        dogadjaji.append({
            "signal": "P", "razina": "trenje", "od_poziva": c["od"], "do_poziva": c["do"],
            "mjera": c["C"], "potpis": " → ".join(blok), "podvrsta": None,
            "opis": f"ciklus od {c['k']} poziva ({' → '.join(imena)}) ponovljen {c['C']}×",
            "_kratki": " → ".join(pozivi[c["od"] + x]["kratki"] for x in range(c["k"])),
            "_ime": "+".join(dict.fromkeys(imena)),
        })
    return dogadjaji


def izracunaj_trenje(pozivi: list[dict], ukupno_s: float | None,
                     pragovi: dict | None = None) -> tuple[dict, list[dict]]:
    """
    MJERA 4 (ADR §7). Vraća (zapis po shemi, popis primjera za ispis).

    `pozivi` je niz poziva alata u REDOSLIJEDU IZDAVANJA, svaki:
        {ime, potpis, kratki, greska, podvrsta, model_s, alat_s}

    `izgubljeno_s` je GORNJA PROCJENA: zbroj pripisanog model_s + alat_s svih poziva
    koji padaju u UNIJU označenih raspona (poziv označen s dva signala broji se jednom).
    """
    pr = dict(PRAGOVI)
    if pragovi:
        pr.update(pragovi)

    dogadjaji = _signal_R(pozivi, pr) + _signal_F(pozivi, pr) + _signal_P(pozivi, pr)
    dogadjaji.sort(key=lambda d: (-d["mjera"], d["od_poziva"], d["signal"]))

    razine: dict[str, set[str]] = defaultdict(set)
    for d in dogadjaji:
        razine[d["signal"]].add(d["razina"])
    ocjena = sum(1 for sig, r in razine.items() if "trenje" in r)
    upozorenja = sum(1 for sig, r in razine.items() if "trenje" not in r and "upozorenje" in r)

    oznaceni: set[int] = set()
    for d in dogadjaji:
        oznaceni.update(range(d["od_poziva"], d["do_poziva"] + 1))
    izgubljeno = sum(pozivi[i]["model_s"] + pozivi[i]["alat_s"]
                     for i in oznaceni if i < len(pozivi))

    primjeri = [{
        "signal": d["signal"], "razina": d["razina"], "alat": d["_ime"],
        "argument": d["_kratki"], "puta": d["mjera"], "podvrsta": d["podvrsta"],
        "od_poziva": d["od_poziva"], "do_poziva": d["do_poziva"], "opis": d["opis"],
    } for d in dogadjaji[:5]]

    zapis = {
        "ocjena": ocjena,
        "upozorenja": upozorenja,
        "dogadjaji": [{x: d[x] for x in
                       ("signal", "razina", "od_poziva", "do_poziva",
                        "mjera", "potpis", "podvrsta", "opis")} for d in dogadjaji],
        "izgubljeno_s": r3(izgubljeno),
        "udio_izgubljenog": udio(izgubljeno, ukupno_s),
        "pragovi": pr,
    }
    return (zapis, primjeri)


# ─────────────────────────────────────────────────────────────────────────────
# Čitanje transkripta — strogo tokom (jedan redak u memoriji)
# ─────────────────────────────────────────────────────────────────────────────

class Dogadjaj:
    """Sitan sažetak jednog `user`/`assistant` retka. Sadržaj poruke se NE čuva."""

    __slots__ = ("idx", "ts", "vrsta", "msg_id", "model", "usage",
                 "tool_uses", "tool_results", "pravi_upit", "sidechain")

    def __init__(self, idx: int, ts: float, vrsta: str) -> None:
        self.idx = idx
        self.ts = ts
        self.vrsta = vrsta
        self.msg_id: str | None = None
        self.model: str | None = None
        self.usage: dict | None = None
        # (tool_use_id, ime, potpis, skraćeni argument) — ADR §7.0
        self.tool_uses: list[tuple[str, str, str, str]] = []
        # (tool_use_id, is_error, podvrsta|None) — ADR §7.2
        self.tool_results: list[tuple[str, bool, str | None]] = []
        self.pravi_upit = False
        self.sidechain = False


class Presjek:
    """Sve što se o transkriptu zapamti nakon jednog prolaza."""

    def __init__(self) -> None:
        self.redaka = 0
        self.dogadjaji: list[Dogadjaj] = []
        self.sidechain_dogadjaja = 0
        self.sintetickih = 0
        self.cwd: str | None = None
        self.git_grana: str | None = None
        self.verzija: str | None = None


def _otvori(path: Path):
    """Živ transkript (`.jsonl`) i arhivirani (`.jsonl.gz`) čitaju se istim putem."""
    if Path(path).suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return Path(path).open(encoding="utf-8", errors="replace")


def sesija_iz_putanje(path: Path) -> str:
    """`<sid>.jsonl` i `<sid>.jsonl.gz` (te `<sid>.v2.jsonl.gz`) daju isti `session_id`."""
    ime = Path(path).name
    for sufiks in (".jsonl.gz", ".jsonl"):
        if ime.endswith(sufiks):
            ime = ime[: -len(sufiks)]
            break
    osnova, _, zadnji = ime.rpartition(".")
    if osnova and zadnji.startswith("v") and zadnji[1:].isdigit():
        return osnova   # `<sid>.v2.jsonl.gz` — druga arhivirana inačica iste sesije
    return ime


def procitaj_transkript(path: Path) -> Presjek:
    """
    Jedan prolaz kroz JSONL. Čita se redak po redak; u memoriji ostaje samo sažetak
    (`Dogadjaj`), nikad tekst poruka, naredbi ni rezultata alata.
    """
    p = Presjek()
    with _otvori(path) as fh:
        for idx, line in enumerate(fh):
            p.redaka += 1
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except (ValueError, TypeError):
                continue

            p.cwd = p.cwd or rec.get("cwd")
            p.git_grana = p.git_grana or rec.get("gitBranch")
            p.verzija = p.verzija or rec.get("version")

            vrsta = rec.get("type")
            if vrsta not in ("user", "assistant"):     # ADR O2
                continue
            ts = ts_to_epoch(rec.get("timestamp") or "")
            if ts is None:
                continue

            d = Dogadjaj(idx, ts, vrsta)
            d.sidechain = bool(rec.get("isSidechain"))
            msg = rec.get("message") or {}
            content = msg.get("content")

            if vrsta == "assistant":
                d.msg_id = msg.get("id") or f"__redak{idx}"
                d.model = msg.get("model")
                d.usage = msg.get("usage") or None
                if isinstance(content, list):
                    for blok in content:
                        if isinstance(blok, dict) and blok.get("type") == "tool_use":
                            ime = blok.get("name") or "?"
                            potpis, kratki = potpis_poziva(ime, blok.get("input"))
                            d.tool_uses.append((blok.get("id") or f"__tu{idx}",
                                                ime, potpis, kratki))
                # `<synthetic>` su lokalne poruke harnessa (prekid, greška), ne API pozivi.
                if d.model and d.model.startswith("<"):
                    p.sintetickih += 1
                    d.msg_id = None
                    d.usage = None
                    d.tool_uses = []
            else:
                ima_rezultat = False
                if isinstance(content, list):
                    for blok in content:
                        if isinstance(blok, dict) and blok.get("type") == "tool_result":
                            ima_rezultat = True
                            je_greska = bool(blok.get("is_error"))
                            podvrsta = (klasificiraj_gresku(_tekst_rezultata(blok))
                                        if je_greska else None)
                            d.tool_results.append((blok.get("tool_use_id") or "?",
                                                   je_greska, podvrsta))
                # Pravi korisnički upit = `user` redak bez ijednog `tool_result` bloka (ADR §4.1/4).
                d.pravi_upit = not ima_rezultat

            if d.sidechain:
                p.sidechain_dogadjaja += 1     # ADR §4.4: podagenti se ne zbrajaju u glavni niz
                continue
            p.dogadjaji.append(d)
    return p


# ─────────────────────────────────────────────────────────────────────────────
# Mjere 1, 2, 3, 5
# ─────────────────────────────────────────────────────────────────────────────

def izracunaj(p: Presjek) -> dict:
    """Iz presjeka transkripta izračunaj mjere 1, 2, 3 i 5 (bez run_log konteksta)."""
    zastavice: list[str] = []

    # ADR O2: inverzija se traži u REDOSLIJEDU ZAPISA; ako je ima, zapisuje se
    # zastavica, a niz se stabilno sortira (ne „popravlja se" nego se označava).
    redom = p.dogadjaji
    if any(redom[i].ts > redom[i + 1].ts for i in range(len(redom) - 1)):
        zastavice.append("nemonotono_vrijeme")
    E = sorted(redom, key=lambda d: (d.ts, d.idx))
    if p.sidechain_dogadjaja:
        zastavice.append("ima_sidechain")
    if len(E) <= 1:
        zastavice.append("presesija_prekratka")

    # ── grupe poziva modela: message.id → (prvi, zadnji, redaka) ────────────
    grupe: "OrderedDict[str, dict]" = OrderedDict()
    for d in E:
        if d.vrsta != "assistant" or not d.msg_id:
            continue
        g = grupe.get(d.msg_id)
        if g is None:
            g = grupe[d.msg_id] = {"prvi": d.ts, "zadnji": d.ts, "redaka": 0,
                                   "usage": None, "model": None, "tool_uses": []}
        g["prvi"] = min(g["prvi"], d.ts)
        g["zadnji"] = max(g["zadnji"], d.ts)
        g["redaka"] += 1
        g["usage"] = g["usage"] or d.usage            # svi retci nose isti usage (O1)
        g["model"] = g["model"] or d.model
        g["tool_uses"].extend(d.tool_uses)

    # ── MJERA 2: latencija po pozivu; početak grupe = prethodni događaj ─────
    latencije: list[float] = []
    ttfb: list[float] = []
    strujanje: list[float] = []
    pocetak_grupe: dict[str, float] = {}
    latencija_grupe: dict[str, float] = {}
    prethodni: float | None = None
    vidjeno: set[str] = set()
    for d in E:
        if d.vrsta == "assistant" and d.msg_id:
            if d.msg_id in vidjeno:
                continue                              # isti API odgovor, drugi blok
            vidjeno.add(d.msg_id)
            g = grupe[d.msg_id]
            start = prethodni if prethodni is not None else g["prvi"]
            pocetak_grupe[d.msg_id] = start
            latencija_grupe[d.msg_id] = max(0.0, g["zadnji"] - start)
            latencije.append(max(0.0, g["zadnji"] - start))
            ttfb.append(max(0.0, g["prvi"] - start))
            strujanje.append(max(0.0, g["zadnji"] - g["prvi"]))
            prethodni = g["zadnji"]
        else:
            prethodni = d.ts

    # ── MJERA 3: alati ──────────────────────────────────────────────────────
    rezultat_ts: dict[str, float] = {}
    rezultat_greska: dict[str, bool] = {}
    rezultat_podvrsta: dict[str, str] = {}
    rezultata = 0
    for d in E:
        for tu_id, is_err, podvrsta in d.tool_results:
            rezultata += 1
            rezultat_ts[tu_id] = max(rezultat_ts.get(tu_id, d.ts), d.ts)
            rezultat_greska[tu_id] = rezultat_greska.get(tu_id, False) or is_err
            if podvrsta:
                rezultat_podvrsta[tu_id] = podvrsta

    hist: dict[str, dict] = defaultdict(
        lambda: {"poziva": 0, "neuspjelih": 0, "trajanja": []})
    poziva_alata = neuparenih = neuspjelih = 0
    serija = 0
    poziva_u_seriji_1 = 0
    alat_s = 0.0
    niz_poziva: list[dict] = []                          # ulaz u mjeru 4, redoslijed izdavanja
    for mid, g in grupe.items():
        pozivi = g["tool_uses"]
        if not pozivi:
            continue
        serija += 1
        izdano = g["zadnji"]
        vracanja = [rezultat_ts[tu_id] for tu_id, _, _, _ in pozivi if tu_id in rezultat_ts]
        potpuna = len(vracanja) == len(pozivi)
        trajanje_serije = max(0.0, max(vracanja) - izdano) if potpuna else 0.0
        if potpuna:
            alat_s += trajanje_serije                    # ADR §4.1/3
        else:
            neuparenih += len(pozivi) - len(vracanja)
        # Vrijeme serije se za mjeru 4 dijeli jednako na pozive koje je serija izdala;
        # zbroj po svim pozivima ostaje jednak trajanje.model_s + trajanje.alat_s.
        n = len(pozivi)
        po_pozivu_model = latencija_grupe.get(mid, 0.0) / n
        po_pozivu_alat = trajanje_serije / n
        for tu_id, ime, potpis, kratki in pozivi:
            poziva_alata += 1
            h = hist[ime]
            h["poziva"] += 1
            je_greska = bool(rezultat_greska.get(tu_id))
            if je_greska:                                # ADR §6.1/4: samo is_error
                h["neuspjelih"] += 1
                neuspjelih += 1
            niz_poziva.append({
                "ime": ime, "potpis": potpis, "kratki": kratki,
                "greska": je_greska, "podvrsta": rezultat_podvrsta.get(tu_id),
                "model_s": po_pozivu_model, "alat_s": po_pozivu_alat,
            })
            # Trajanje je pripisivo alatu SAMO kad je serija veličine 1 (ADR §6.2).
            if n == 1 and potpuna:
                poziva_u_seriji_1 += 1
                h["trajanja"].append(trajanje_serije)
    if neuparenih:
        zastavice.append("alat_bez_rezultata")

    histogram = []
    for ime, h in sorted(hist.items(), key=lambda kv: (-kv[1]["poziva"], kv[0])):
        tr = h["trajanja"]
        histogram.append({
            "ime": ime,
            "poziva": h["poziva"],
            "neuspjelih": h["neuspjelih"],
            "udio_poziva": udio(h["poziva"], poziva_alata),
            "trajanje_mjerljivo": bool(tr),
            "poziva_mjerenih": len(tr),
            "trajanje_zbroj_s": r3(sum(tr)) if tr else None,
            "trajanje_medijan_s": r3(statistics.median(tr)) if tr else None,
        })

    # ── MJERA 1: razlaganje trajanja ────────────────────────────────────────
    model_s = sum(latencije)
    cekanje_s = 0.0
    for i in range(1, len(E)):
        if E[i].vrsta == "user" and E[i].pravi_upit:
            cekanje_s += max(0.0, E[i].ts - E[i - 1].ts)
    ukupno_s = (E[-1].ts - E[0].ts) if len(E) > 1 else 0.0
    rezija_s = ukupno_s - model_s - alat_s - cekanje_s
    if rezija_s < -REZIJA_TOLERANCIJA_S:
        zastavice.append("negativna_rezija")

    # ── MJERA 4: trenje R/F/P (ADR §7) ──────────────────────────────────────
    trenje_zapis, trenje_primjeri = izracunaj_trenje(niz_poziva, ukupno_s)
    if trenje_zapis["ocjena"]:
        zastavice.append("trenje")

    # ── MJERA 5: tokeni i udio predmemorije (nad dedupliciranim pozivima) ───
    t_in = t_out = t_cr = t_cw = t_cw1h = 0
    t_think = 0
    ima_think = False
    modeli: set[str] = set()
    for g in grupe.values():
        u = g["usage"] or {}
        t_in += u.get("input_tokens") or 0
        t_out += u.get("output_tokens") or 0
        t_cr += u.get("cache_read_input_tokens") or 0
        t_cw += u.get("cache_creation_input_tokens") or 0
        t_cw1h += (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0
        det = u.get("output_tokens_details") or {}
        if "thinking_tokens" in det:
            ima_think = True
            t_think += det.get("thinking_tokens") or 0
        if g["model"]:
            modeli.add(g["model"])
    ulazni_kontekst = t_in + t_cr + t_cw
    poziva = len(grupe)

    return {
        "zastavice": zastavice,
        "modeli": sorted(modeli),
        "prozor_od": E[0].ts if E else None,
        "prozor_do": E[-1].ts if E else None,
        "dogadjaja": len(E),
        "trajanje": {
            "ukupno_s": r3(ukupno_s),
            "model_s": r3(model_s),
            "alat_s": r3(alat_s),
            "cekanje_covjeka_s": r3(cekanje_s),
            "rezija_s": r3(rezija_s),
            "rezija_pokretanja_s": None,             # popunjava se iz run_log
            "udio_model": udio(model_s, ukupno_s),
            "udio_alat": udio(alat_s, ukupno_s),
            "udio_cekanje_covjeka": udio(cekanje_s, ukupno_s),
            "udio_rezija": udio(max(0.0, rezija_s), ukupno_s),
        },
        "latencija_modela": {
            "poziva": poziva,
            "num_turns": None,                       # popunjava se iz run_log
            "prosjek_s": r3(sum(latencije) / len(latencije)) if latencije else None,
            "medijan_s": r3(statistics.median(latencije)) if latencije else None,
            "p95_s": r3(percentil(latencije, 0.95)),
            "najveca_s": r3(max(latencije)) if latencije else None,
            "zbroj_s": r3(model_s),
            "ttfb_medijan_s": r3(statistics.median(ttfb)) if ttfb else None,
            "strujanje_medijan_s": r3(statistics.median(strujanje)) if strujanje else None,
            "strujanje_zbroj_s": r3(sum(strujanje)) if strujanje else None,
        },
        # TASK-3569 (T5): sirove latencije po pozivu. Tjedni pregled iz njih računa
        # ISTINSKI skupni medijan/p95 (medijan medijana nije medijan). Privatni ključ
        # (`_`) — `bez_primjera()` ga skida, pa `--json`/`--jsonl-out` ostaju isti.
        "_latencije_s": [r3(x) for x in latencije],
        "alati": {
            "poziva": poziva_alata,
            "rezultata": rezultata,
            "neuparenih": neuparenih,
            "neuspjelih": neuspjelih,
            "udio_neuspjelih": udio(neuspjelih, poziva_alata),
            "serija": serija,
            "udio_poziva_u_seriji_1": udio(poziva_u_seriji_1, poziva_alata),
            "histogram": histogram,
        },
        "trenje": trenje_zapis,
        "trenje_primjeri": trenje_primjeri,
        "tokeni": {
            "ulaz": t_in,
            "izlaz": t_out,
            "kes_citanje": t_cr,
            "kes_pisanje": t_cw,
            "kes_pisanje_1h": t_cw1h,
            "misljenje": t_think if ima_think else None,
            "ulazni_kontekst": ulazni_kontekst,
            "udio_kesa": udio(t_cr, ulazni_kontekst),
            "udio_pisanja": udio(t_cw, ulazni_kontekst),
            "ulazni_kontekst_po_pozivu": r3(ulazni_kontekst / poziva) if poziva else None,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# run_log, regoc.db, pronalazak transkripta
# ─────────────────────────────────────────────────────────────────────────────

def ucitaj_run_log(path: Path = RUN_LOG) -> list[dict]:
    if not path.exists():
        return []
    redci = []
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                redci.append(json.loads(line))
            except (ValueError, TypeError):
                continue
    return redci


def project_id_za(task_id: str | None) -> str | None:
    """tasks.project_id iz regoc.db; baza se otvara SAMO za čitanje (WAL ostaje netaknut)."""
    if not task_id or not REGOC_DB.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{REGOC_DB}?mode=ro", uri=True)
        try:
            row = con.execute("SELECT project_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        finally:
            con.close()
        return row[0] if row else None
    except sqlite3.Error:
        return None


def nadji_transkript(session_id: str) -> Path | None:
    """
    Isti način pronalaska kao tools/run_tokens.py: glob po ~/.claude/projects.
    Ako živog transkripta nema (obrisan nakon ~30 dana), poseže u trajni arhiv (T9).
    """
    for name in glob(str(PROJECTS_DIR / "*" / f"{session_id}.jsonl")):
        return Path(name)
    for name in glob(str(PROJECTS_DIR / "**" / f"{session_id}.jsonl"), recursive=True):
        return Path(name)
    return nadji_u_arhivu(session_id)


def nadji_u_arhivu(session_id: str) -> Path | None:
    """Najnovija arhivirana inačica transkripta te sesije (ili None ako je nema)."""
    if _arhiv is None:
        return None
    try:
        return _arhiv.nadji_u_arhivu(session_id)
    except OSError:
        return None


def je_iz_arhiva(path: Path | None) -> bool:
    return path is not None and Path(path).suffix == ".gz"


def transkript_za_zadatak(task_id: str) -> Path | None:
    """Rezerva kad zadatka nema u run_log-u: traži TASK-#### u prvim retcima transkripta."""
    kandidati = sorted(glob(str(PROJECTS_DIR / "*" / "*.jsonl")),
                       key=lambda n: os.path.getmtime(n), reverse=True)
    if _arhiv is not None:
        # Arhiv se gleda TEK nakon živih: živ transkript je jeftiniji za čitanje.
        kandidati += [z["arhiv"] for z in reversed(_arhiv.ucitaj_indeks())
                      if os.path.exists(z.get("arhiv", ""))]
    for name in kandidati:
        try:
            with _otvori(Path(name)) as fh:
                for i, line in enumerate(fh):
                    if i > 40:
                        break
                    if task_id in line:
                        return Path(name)
        except OSError:
            continue
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Sastavljanje zapisa po shemi
# ─────────────────────────────────────────────────────────────────────────────

def sastavi_zapis(run: dict | None, transkript: Path | None,
                  runova_na_sesiji: int = 1) -> dict:
    """Jedan zapis telemetrije = jedno izvođenje (run_log redak + njegov transkript)."""
    zastavice: list[str] = []
    task_id = (run or {}).get("task_id")
    session_id = (run or {}).get("session_id") or (
        sesija_iz_putanje(transkript) if transkript else None)

    if transkript is None or not transkript.exists():
        m = None
        zastavice.append("bez_transkripta")
    else:
        # Vidljivo je da brojka NE dolazi iz živog transkripta nego iz arhiva (T9) —
        # izvor mjere se ne skriva, kao ni kod pomirenja s run_logom (ADR O3).
        if je_iz_arhiva(transkript):
            zastavice.append("transkript_iz_arhiva")
        presjek = procitaj_transkript(transkript)
        m = izracunaj(presjek)
        zastavice.extend(m["zastavice"])

    if runova_na_sesiji > 1:
        zastavice.append("vise_runova_na_istoj_sesiji")

    run_ts = (run or {}).get("ts")
    run_dur = (run or {}).get("duration_s")
    rl_tokens = ((run or {}).get("tokens") or {})

    if m:
        trajanje = dict(m["trajanje"])
        latencija = dict(m["latencija_modela"])
        alati = dict(m["alati"])
        trenje = dict(m["trenje"])
        trenje_primjeri = list(m["trenje_primjeri"])
        tokeni = dict(m["tokeni"])
        if run_dur is not None and trajanje["ukupno_s"] is not None:
            trajanje["rezija_pokretanja_s"] = r3(run_dur - trajanje["ukupno_s"])
        latencija["num_turns"] = (run or {}).get("num_turns")
        prozor_od, prozor_do = m["prozor_od"], m["prozor_do"]
        model = (m["modeli"] or [None])[0] or (run or {}).get("model")
        # Transkript koji seže bitno izvan prozora izvođenja (dijeljena interaktivna sesija).
        run_epoch = ts_to_epoch(run_ts) if run_ts else None
        if run_epoch and prozor_do and (prozor_do > run_epoch + 60 or
                                        (run_dur and prozor_od < run_epoch - run_dur - 60)):
            zastavice.append("transkript_izvan_prozora")
    else:
        prazno_traj = dict.fromkeys(
            ["ukupno_s", "model_s", "alat_s", "cekanje_covjeka_s", "rezija_s",
             "rezija_pokretanja_s", "udio_model", "udio_alat",
             "udio_cekanje_covjeka", "udio_rezija"])
        trajanje = prazno_traj
        latencija = dict.fromkeys(
            ["poziva", "num_turns", "prosjek_s", "medijan_s", "p95_s", "najveca_s",
             "zbroj_s", "ttfb_medijan_s", "strujanje_medijan_s", "strujanje_zbroj_s"])
        latencija["num_turns"] = (run or {}).get("num_turns")
        alati = {"poziva": None, "rezultata": None, "neuparenih": None, "neuspjelih": None,
                 "udio_neuspjelih": None, "serija": None,
                 "udio_poziva_u_seriji_1": None, "histogram": []}
        trenje = None                     # bez transkripta nema iz čega mjeriti (ADR §9)
        trenje_primjeri = []
        tokeni = dict.fromkeys(
            ["ulaz", "izlaz", "kes_citanje", "kes_pisanje", "kes_pisanje_1h", "misljenje",
             "ulazni_kontekst", "udio_kesa", "udio_pisanja", "ulazni_kontekst_po_pozivu"])
        prozor_od = prozor_do = None
        model = (run or {}).get("model")
        presjek = None

    # ── pomirenje transkript ↔ run_log (ADR O3) ─────────────────────────────
    rl_out = rl_tokens.get("out")
    tr_out = tokeni.get("izlaz")
    odstupanje = None
    if rl_out is not None and tr_out:
        odstupanje = round((tr_out - rl_out) / tr_out, 6)
        if abs(odstupanje) > POMIRENJE_PRAG:
            zastavice.append("run_log_podbacuje")
    poklapa = bool(run) and m is not None and all([
        rl_tokens.get("in") == tokeni.get("ulaz"),
        rl_tokens.get("out") == tokeni.get("izlaz"),
        rl_tokens.get("cache_r") == tokeni.get("kes_citanje"),
        rl_tokens.get("cache_w") == tokeni.get("kes_pisanje"),
    ])

    poziva = latencija.get("poziva")
    cost = (run or {}).get("cost_usd")
    izvor = (run or {}).get("source")
    if izvor == "regoc-spawn":
        vrsta = "agentski_spawn"
    elif m and presjek is not None:
        pravih = sum(1 for d in presjek.dogadjaji if d.vrsta == "user" and d.pravi_upit)
        vrsta = "interaktivna" if pravih > 1 else "agentski_spawn"
    else:
        vrsta = "interaktivna"

    return {
        "shema": SHEMA_ID,
        "zapisano_ts": epoch_to_iso(datetime.now(timezone.utc).timestamp()),
        "zadatak": {
            "task_id": task_id,
            "project_id": project_id_za(task_id),
            "agent": (run or {}).get("agent"),
            "model": model,
            "outcome": (run or {}).get("outcome"),
            "exit_code": (run or {}).get("exit_code"),
            "run_log_ts": run_ts,
            "run_log_duration_s": r3(float(run_dur)) if run_dur is not None else None,
            "vrsta": vrsta,
        },
        "sesija": {
            "session_id": session_id,
            "transkript_putanja": str(transkript) if transkript else None,
            "redaka": presjek.redaka if presjek else None,
            "dogadjaja": m["dogadjaja"] if m else None,
            "prozor_od": epoch_to_iso(prozor_od),
            "prozor_do": epoch_to_iso(prozor_do),
            "cwd": presjek.cwd if presjek else None,
            "git_grana": presjek.git_grana if presjek else None,
            "ima_sidechain": bool(presjek.sidechain_dogadjaja) if presjek else False,
        },
        "trajanje": trajanje,
        "latencija_modela": latencija,
        "alati": alati,
        "trenje": trenje,
        "tokeni": tokeni,
        "trosak": {
            "usd": r6(cost) if cost is not None else None,
            "izvor": (run or {}).get("cost_source"),
            "usd_po_pozivu": r6(cost / poziva) if (cost is not None and poziva) else None,
        },
        "pomirenje": {
            "run_log_izlaz": rl_out,
            "transkript_izlaz": tr_out,
            "odstupanje_udio": odstupanje,
            "poklapa_se": poklapa,
        },
        "zastavice": sorted(set(zastavice)),
        # Primjeri (skraćeni argument) su ISPIS ZA ČOVJEKA, ne dio zapisa po shemi:
        # shema §trenje.potpis izrijekom zabranjuje doslovan tekst naredbe u zapisu.
        # `main()` ih skida prije `--json`/`--jsonl-out`, a `--primjeri` ih ispisuje odvojeno.
        "_trenje_primjeri": trenje_primjeri,
        # TASK-3569 (T5): za skupne percentile u tjednom pregledu; skida ga `bez_primjera()`.
        "_latencije_s": (m.get("_latencije_s") or []) if m else [],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Minimalni validator JSON Scheme (bez vanjskih ovisnosti)
# ─────────────────────────────────────────────────────────────────────────────

def _tipovi_ok(vrijednost, tip) -> bool:
    tipovi = tip if isinstance(tip, list) else [tip]
    for t in tipovi:
        if t == "null" and vrijednost is None:
            return True
        if t == "boolean" and isinstance(vrijednost, bool):
            return True
        if t == "integer" and isinstance(vrijednost, int) and not isinstance(vrijednost, bool):
            return True
        if t == "number" and isinstance(vrijednost, (int, float)) and not isinstance(vrijednost, bool):
            return True
        if t == "string" and isinstance(vrijednost, str):
            return True
        if t == "array" and isinstance(vrijednost, list):
            return True
        if t == "object" and isinstance(vrijednost, dict):
            return True
    return False


def validiraj(instanca, shema: dict, korijen: dict | None = None, put: str = "$") -> list[str]:
    """Podskup JSON Scheme 2020-12 dovoljan za našu shemu: $ref, type, const, enum,
    required, properties, additionalProperties, items, minimum/maximum, pattern."""
    import re as _re
    korijen = korijen or shema
    greske: list[str] = []

    if "$ref" in shema:
        cilj = korijen
        for dio in shema["$ref"].lstrip("#/").split("/"):
            cilj = cilj.get(dio, {})
        return validiraj(instanca, cilj, korijen, put)

    if "const" in shema and instanca != shema["const"]:
        greske.append(f"{put}: očekivano {shema['const']!r}, dobiveno {instanca!r}")
    if "enum" in shema and instanca not in shema["enum"]:
        greske.append(f"{put}: {instanca!r} nije u enum {shema['enum']}")
    if "type" in shema and not _tipovi_ok(instanca, shema["type"]):
        greske.append(f"{put}: tip {type(instanca).__name__} ≠ {shema['type']}")
        return greske
    if isinstance(instanca, (int, float)) and not isinstance(instanca, bool):
        if "minimum" in shema and instanca < shema["minimum"]:
            greske.append(f"{put}: {instanca} < minimum {shema['minimum']}")
        if "maximum" in shema and instanca > shema["maximum"]:
            greske.append(f"{put}: {instanca} > maximum {shema['maximum']}")
    if isinstance(instanca, str) and "pattern" in shema:
        if not _re.search(shema["pattern"], instanca):
            greske.append(f"{put}: ne odgovara uzorku {shema['pattern']}")
    if isinstance(instanca, dict):
        for obavezno in shema.get("required", []):
            if obavezno not in instanca:
                greske.append(f"{put}: nedostaje obavezno polje {obavezno!r}")
        props = shema.get("properties", {})
        for k, v in instanca.items():
            if k in props:
                greske.extend(validiraj(v, props[k], korijen, f"{put}.{k}"))
            elif shema.get("additionalProperties") is False:
                greske.append(f"{put}: nedopušteno polje {k!r}")
    if isinstance(instanca, list) and "items" in shema:
        for i, el in enumerate(instanca):
            greske.extend(validiraj(el, shema["items"], korijen, f"{put}[{i}]"))
    return greske


def validiraj_zapis(zapis: dict) -> tuple[list[str], list[str]]:
    """Vraća (greške, napomene). `trenje: null` znači da transkripta nema (ADR §9)."""
    if not SHEMA_PUT.exists():
        return ([f"shema nije pronađena: {SHEMA_PUT}"], [])
    shema = json.loads(SHEMA_PUT.read_text(encoding="utf-8"))
    kopija = bez_primjera(zapis)
    napomene = []
    if kopija.get("trenje") is None:
        kopija["trenje"] = {
            "ocjena": 0, "upozorenja": 0, "dogadjaji": [],
            "izgubljeno_s": None, "udio_izgubljenog": None, "pragovi": dict(PRAGOVI),
        }
        napomene.append("polje `trenje` je null (nema transkripta, mjera 4 se nema iz čega "
                        "izračunati) — pri provjeri zamijenjeno praznim okvirom")
    return (validiraj(kopija, shema), napomene)


def bez_primjera(zapis: dict) -> dict:
    """Zapis bez pomoćnog polja `_trenje_primjeri` — točno ono što ide u JSON/JSONL."""
    return {k: v for k, v in zapis.items() if not k.startswith("_")}


# ─────────────────────────────────────────────────────────────────────────────
# Ispis za čovjeka
# ─────────────────────────────────────────────────────────────────────────────

def k(n) -> str:
    if n is None:
        return "-"
    if n >= 1_000_000:
        return f"{n / 1e6:.2f}M"
    if n >= 1_000:
        return f"{n / 1e3:.0f}k"
    return str(n)


def s(x) -> str:
    return "-" if x is None else f"{x:.1f}"


def pos(x) -> str:
    return "-" if x is None else f"{100 * x:.1f} %"


ZNAK_SIGNALA = {"R": "R ponovljena naredba", "F": "F neuspjeli izlaz", "P": "P vrtnja u petlji"}


def ispisi_trenje(z: dict) -> None:
    """MJERA 4 — brojke + do 5 najgorih primjera (skraćeni argument + koliko puta)."""
    tn = z.get("trenje")
    print(f"\n MJERA 4 — trenje (R/F/P)")
    if tn is None:
        print("   nema transkripta — mjera se nema iz čega izračunati (null, ne nula)")
        return
    pr = tn["pragovi"]
    print(f"   ocjena {tn['ocjena']}/3 signala iznad praga · upozorenja {tn['upozorenja']}"
          f" · označenih raspona {len(tn['dogadjaji'])}"
          f" · izgubljeno do {s(tn['izgubljeno_s'])} s ({pos(tn['udio_izgubljenog'])})")
    po_signalu = {sig: [d for d in tn["dogadjaji"] if d["signal"] == sig] for sig in "RFP"}
    for sig in "RFP":
        dd = po_signalu[sig]
        naj = max((d["mjera"] for d in dd), default=0)
        prag = {"R": pr["R_trenje"], "F": pr["F_trenje"], "P": pr["P_trenje"]}[sig]
        stanje = ("TRENJE" if any(d["razina"] == "trenje" for d in dd)
                  else "upozorenje" if dd else "uredno")
        print(f"   {ZNAK_SIGNALA[sig]:<22} najveće {naj:>3} (prag {prag})"
              f" · raspona {len(dd):>3}  → {stanje}")
    primjeri = z.get("_trenje_primjeri") or []
    if not primjeri:
        print("   (nema označenih raspona — nema primjera)")
        return
    print(f"   najgorih {len(primjeri)}:")
    for i, pr_ in enumerate(primjeri, 1):
        dodatak = f" [{pr_['podvrsta']}]" if pr_.get("podvrsta") else ""
        print(f"    {i}. {pr_['signal']} ×{pr_['puta']:<3} {pr_['razina']:<11}"
              f" pozivi {pr_['od_poziva']}–{pr_['do_poziva']}  {pr_['alat']}{dodatak}")
        print(f"       {pr_['argument']}")


def ispisi(z: dict) -> None:
    zd, se, tr, la, al, tk = (z["zadatak"], z["sesija"], z["trajanje"],
                              z["latencija_modela"], z["alati"], z["tokeni"])
    print(f"\n{'═' * 78}")
    print(f" {zd['task_id'] or '(bez zadatka)'} · {zd['agent'] or '?'} · {zd['model'] or '?'}"
          f" · {zd['outcome'] or '?'} · {zd['vrsta']}")
    print(f" projekt {zd['project_id'] or '-'} · sesija {(se['session_id'] or '?')[:8]}"
          f" · {se['redaka'] or 0} redaka / {se['dogadjaja'] or 0} događaja")
    print(f"{'═' * 78}")

    print(f"\n MJERA 1 — razlaganje trajanja (ukupno {s(tr['ukupno_s'])} s)")
    for oznaka, polje, udio_polje in (("model    ", "model_s", "udio_model"),
                                      ("alati    ", "alat_s", "udio_alat"),
                                      ("čovjek   ", "cekanje_covjeka_s", "udio_cekanje_covjeka"),
                                      ("režija   ", "rezija_s", "udio_rezija")):
        sirina = int(round(40 * (tr[udio_polje] or 0)))
        print(f"   {oznaka} {s(tr[polje]):>10} s  {pos(tr[udio_polje]):>8}  {'█' * sirina}")
    if tr["rezija_pokretanja_s"] is not None:
        print(f"   režija pokretanja (izvan transkripta): {s(tr['rezija_pokretanja_s'])} s")

    print(f"\n MJERA 2 — latencija modela")
    print(f"   poziva {la['poziva']} (num_turns {la['num_turns']}) · prosjek {s(la['prosjek_s'])} s"
          f" · medijan {s(la['medijan_s'])} s · p95 {s(la['p95_s'])} s · najveća {s(la['najveca_s'])} s")
    print(f"   TTFB medijan {s(la['ttfb_medijan_s'])} s · strujanje medijan {s(la['strujanje_medijan_s'])} s"
          f" (zbroj {s(la['strujanje_zbroj_s'])} s)")

    print(f"\n MJERA 3 — alati: {al['poziva']} poziva / {al['rezultata']} rezultata"
          f" · neuparenih {al['neuparenih']} · neuspjelih {al['neuspjelih']} ({pos(al['udio_neuspjelih'])})")
    for h in al["histogram"][:5]:
        med = f"medijan {s(h['trajanje_medijan_s'])} s (n={h['poziva_mjerenih']})" if h["trajanje_mjerljivo"] else "trajanje nemjerljivo"
        print(f"   {h['ime']:<14}{h['poziva']:>5}  {pos(h['udio_poziva']):>7}  greške {h['neuspjelih']:>3}  {med}")
    ostatak = al["histogram"][5:]
    if ostatak:
        print(f"   {'ostalo':<14}{sum(h['poziva'] for h in ostatak):>5}  ({len(ostatak)} alata)")

    ispisi_trenje(z)

    print(f"\n MJERA 5 — tokeni i predmemorija")
    print(f"   ulaz {k(tk['ulaz'])} · izlaz {k(tk['izlaz'])} · keš R {k(tk['kes_citanje'])}"
          f" · keš W {k(tk['kes_pisanje'])} (1h {k(tk['kes_pisanje_1h'])})")
    print(f"   ulazni kontekst {k(tk['ulazni_kontekst'])} · UDIO KEŠA {pos(tk['udio_kesa'])}"
          f" · udio pisanja {pos(tk['udio_pisanja'])} · {k(tk['ulazni_kontekst_po_pozivu'])} tok./poziv")

    pm = z["pomirenje"]
    print(f"\n trošak {z['trosak']['usd'] or '-'} USD ({z['trosak']['izvor'] or '-'})"
          f" · pomirenje run_log {k(pm['run_log_izlaz'])} ↔ transkript {k(pm['transkript_izlaz'])}"
          f" · {'poklapa se' if pm['poklapa_se'] else 'razlika ' + (f'{100 * pm['odstupanje_udio']:.2f} %' if pm['odstupanje_udio'] is not None else '?')}")
    if z["zastavice"]:
        print(f" ZASTAVICE: {', '.join(z['zastavice'])}")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def odaberi_mete(args) -> list[tuple[dict | None, Path | None, int]]:
    """→ [(run_log redak ili None, putanja transkripta ili None, broj runova na sesiji)]"""
    run_log = ucitaj_run_log()
    po_sesiji: dict[str, int] = defaultdict(int)
    for r in run_log:
        if r.get("session_id"):
            po_sesiji[r["session_id"]] += 1

    mete: list[tuple[dict | None, Path | None, int]] = []

    for put in args.transkript or []:
        p = Path(os.path.expanduser(put))
        run = next((r for r in reversed(run_log) if r.get("session_id") == p.stem), None)
        mete.append((run, p, po_sesiji.get(p.stem, 1)))

    for sid in args.session or []:
        run = next((r for r in reversed(run_log) if r.get("session_id") == sid), None)
        mete.append((run, nadji_transkript(sid), po_sesiji.get(sid, 1)))

    for task in args.task or []:
        runovi = [r for r in run_log if r.get("task_id") == task]
        if runovi:
            for run in runovi:
                sid = run.get("session_id")
                mete.append((run, nadji_transkript(sid) if sid else None,
                             po_sesiji.get(sid, 1)))
        else:
            p = transkript_za_zadatak(task)
            mete.append(({"task_id": task}, p, 1))

    if args.zadnjih:
        for run in [r for r in run_log if r.get("session_id")][-args.zadnjih:]:
            sid = run["session_id"]
            mete.append((run, nadji_transkript(sid), po_sesiji.get(sid, 1)))

    return mete


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task", action="append", help="TASK-#### (može više puta)")
    ap.add_argument("--session", action="append", help="session_id (može više puta)")
    ap.add_argument("--transkript", action="append", help="Izravna putanja do .jsonl transkripta")
    ap.add_argument("--zadnjih", type=int, help="Zadnjih N izvođenja iz run_log.jsonl")
    ap.add_argument("--json", action="store_true", help="JSON na stdout (jedan objekt ili niz)")
    ap.add_argument("--jsonl-out", help="Dopiši zapise u JSONL (npr. data/task_telemetry.jsonl)")
    ap.add_argument("--validiraj", action="store_true",
                    help="Provjeri zapise protiv docs/schema/telemetrija-zadatka.schema.json")
    ap.add_argument("--mjeri-memoriju", action="store_true",
                    help="Ispiši vršnu potrošnju memorije alata (dokaz da se transkript ne učitava cijeli)")
    ap.add_argument("--primjeri", action="store_true",
                    help="Uz --json ispiši i primjere trenja (skraćeni argument) kao ODVOJEN objekt; "
                         "u zapis po shemi ne idu jer shema zabranjuje doslovan tekst naredbe")
    args = ap.parse_args()

    if args.mjeri_memoriju:
        import tracemalloc
        tracemalloc.start()

    mete = odaberi_mete(args)
    if not mete:
        ap.error("navedi barem jedno: --task, --session, --transkript ili --zadnjih")

    zapisi = [sastavi_zapis(run, put, n) for run, put, n in mete]

    if args.jsonl_out:
        izlaz = Path(os.path.expanduser(args.jsonl_out))
        izlaz.parent.mkdir(parents=True, exist_ok=True)
        with izlaz.open("a", encoding="utf-8") as fh:
            for z in zapisi:
                fh.write(json.dumps(bez_primjera(z), ensure_ascii=False) + "\n")

    if args.json:
        cisti = [bez_primjera(z) for z in zapisi]
        json.dump(cisti[0] if len(cisti) == 1 else cisti, sys.stdout,
                  ensure_ascii=False, indent=2)
        print()
        if args.primjeri:
            uz = [{"task_id": z["zadatak"]["task_id"],
                   "session_id": z["sesija"]["session_id"],
                   "trenje_primjeri": z.get("_trenje_primjeri") or []} for z in zapisi]
            json.dump(uz[0] if len(uz) == 1 else uz, sys.stdout, ensure_ascii=False, indent=2)
            print()
    else:
        for z in zapisi:
            ispisi(z)

    if args.validiraj:
        print(f"\n{'─' * 78}\n PROVJERA PROTIV SHEME ({SHEMA_PUT.name})")
        ukupno_gresaka = 0
        for z in zapisi:
            greske, napomene = validiraj_zapis(z)
            ukupno_gresaka += len(greske)
            oznaka = z["zadatak"]["task_id"] or (z["sesija"]["session_id"] or "?")[:8]
            print(f"   {oznaka}: {'VALJANO' if not greske else str(len(greske)) + ' GREŠAKA'}")
            for g in greske:
                print(f"      ✗ {g}")
            for n in napomene:
                print(f"      · {n}")
        print(f"   ukupno: {len(zapisi)} zapisa, {ukupno_gresaka} grešaka")

    if args.mjeri_memoriju:
        import tracemalloc
        trenutno, vrh = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        najveci = max((Path(p).stat().st_size for _, p, _ in mete
                       if p and Path(p).exists()), default=0)
        print(f"\n MEMORIJA: vrh {vrh / 1e6:.1f} MB · najveći obrađeni transkript"
              f" {najveci / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
