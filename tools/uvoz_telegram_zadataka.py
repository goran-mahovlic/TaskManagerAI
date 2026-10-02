#!/usr/bin/env python3
"""
uvoz_telegram_zadataka.py — retroaktivni uvoz Telegram zahtjeva u TaskManager.

ZAŠTO: poruke iz Telegrama izvršava `claude -p` izravno (telegram_agent.ts:728), pa
posao nikad ne postane zadatak — ni projekt ni trošak ne postoje na ploči. Ovaj alat
čita transkripte i za svaki ZAHTJEV upisuje zatvoren zadatak s IZVORNIM datumima i
zapisom u `cost_log`, tako da potrošnja po projektu i zadatku postane vidljiva.

JEDINICA UVOZA = SEGMENT, NE SJEDNICA
    Mjereno (04.09.2026., 806 telegramskih transkripata): 52 sjednice nose 97,8 %
    troška, a svaka pokriva CIJELI radni dan i 10–40 zasebnih zahtjeva. Uvoz po
    sjednici bi dao 52 zadatka naslovljena prvom porukom jutra — netočan naslov,
    netočan projekt i neupotrebljiv datum. Zato se transkript reže na segmente:
    jedan segment = jedna korisnikova poruka + sav rad do sljedeće poruke.
    Preostalih 754 transkripta traju ~2 s i imaju 1 korak (prekinuti pokušaji) —
    oni ne postaju zadatci.

ŠTO POSTAJE ZADATAK
    Segment s troškom >= --prag (zadano 0,50 USD) ILI segment koji je koristio alate.
    Ostatak (kratka pitanja i razgovor) ide u JEDAN zbirni zadatak po danu i grupi,
    da trošak ostane zbrojen, a ploča čitljiva.

PROJEKT
    1. pravila iz `uvoz-telegrama.json` (uzorak u tekstu segmenta → projekt),
    2. ako nema pogotka — projekt prethodnog segmenta iste sjednice („nastavi", „ok idemo"),
    3. inače zadani projekt grupe, odnosno pretinac PRJ-033.
    Izvor odluke se zapisuje u opis zadatka, pa je ispravak kasnije ciljan.

GRUPA
    Radni direktorij ne razlikuje grupe (797 od 800 sjednica ima isti `cwd`), ali
    biljeg `[OD: <ime>]` razlikuje: tko pripada kojoj grupi zadaje se u konfiguraciji
    (`grupe.<ime>.ljudi`); svi ostali su u zadanoj grupi.

TROŠAK
    Iste tarife kao tools/run_tokens.py, uz dedup po `message.id` (isti API odgovor
    stiže u više redaka; zbrajanje po retku udvostručuje iznos).

IDEMPOTENTNO: biljeg `[uvoz:telegram segment=<session>#<n>]` u opisu.

UPORABA
  python3 tools/uvoz_telegram_zadataka.py --proba [--detalji]
  python3 tools/uvoz_telegram_zadataka.py --upis [--od 2026-06-01] [--prag 0.5]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tm_putanje import TM_DB, konfig, stanje  # noqa: E402

HOME = Path.home()
PROJECTS_DIR = HOME / ".claude/projects"
DB = TM_DB
ARHIV = stanje("transkript_arhiv")


def sesija_id(path: Path) -> str:
    """Kanonski `session_id` — bez nastavka i BEZ oznake inačice arhiva (`.v2`).

    Arhiv čuva više inačica iste sjednice (`<sid>.jsonl.gz`, `<sid>.v2.jsonl.gz`). Ako se
    `.v2` ne svede na isti ključ, ista sjednica ulazi dvaput — izmjereno: sjednica od
    03.06. vrijedna 289,15 USD knjižena je dvaput (jednom kao živa, jednom kao `.v2`).
    """
    ime = path.name
    for nastavak in (".jsonl.gz", ".jsonl"):
        if ime.endswith(nastavak):
            ime = ime[: -len(nastavak)]
            break
    return re.sub(r"\.v\d+$", "", ime)


def otvori(path: Path):
    """Transkript može biti živ (.jsonl) ili arhiviran (.jsonl.gz) — čitaju se isto."""
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return path.open(encoding="utf-8", errors="replace")


def svi_transkripti() -> list[Path]:
    """Živi transkripti + arhivirani kojih VIŠE NEMA u živom skupu.

    Bez arhiva uvoz promašuje sve starije od ~30 dana: mjereno 04.09.2026., 92 sjednice
    postoje samo kao `.jsonl.gz` i nijedna nije bila u `cost_log`. Arhiv koji je samo
    preslika živog transkripta se preskače (inače bi se ista sjednica brojala dvaput).
    """
    zivi = {sesija_id(p): p for p in PROJECTS_DIR.glob("*/*.jsonl")}
    izbor: dict[str, Path] = dict(zivi)
    if ARHIV.exists():
        for g in ARHIV.rglob("*.jsonl.gz"):
            sid = sesija_id(g)
            if sid in zivi:
                continue                      # živi transkript ima prednost
            # Više inačica iste arhivirane sjednice → uzmi najveću (najpotpuniju).
            prije = izbor.get(sid)
            if prije is None or str(g) > str(prije):
                izbor[sid] = g
    return list(izbor.values())

TARIFE = {
    "opus":   {"in": 5.00, "out": 25.00, "cr": 0.50, "cw": 6.25, "cw1h": 10.00},
    "sonnet": {"in": 3.00, "out": 15.00, "cr": 0.30, "cw": 3.75, "cw1h":  6.00},
    "haiku":  {"in": 1.00, "out":  5.00, "cr": 0.10, "cw": 1.25, "cw1h":  2.00},
}


def obitelj(model: str) -> str:
    m = (model or "").lower()
    if "opus" in m or "fable" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    return "haiku"


def cijena(inp, out, cr, cw, model, cw1h=0) -> float:
    t = TARIFE[obitelj(model)]
    return (inp * t["in"] + out * t["out"] + cr * t["cr"]
            + max(0, cw - cw1h) * t["cw"] + cw1h * t["cw1h"]) / 1e6


# ── Projekti, grupe i ljudi su KONFIGURACIJA (TASK-5108) ────────────────────────────────
# Prije su ovdje bili nazivi naših projekata, imena naših ljudi i podjela na naše dvije
# Telegram grupe. To je podatak jedne instalacije, ne kod paketa: čita se iz
# `uvoz-telegrama.json` (TM_UVOZ_TELEGRAMA_CONFIG → $TM_HOME/config → config/ uz paket),
# primjer je `config/uvoz-telegrama.example.json`. Bez datoteke: nijedno pravilo, jedna
# grupa, sve ide u pretinac paketa (PRJ-033, v. INBOX_PROJECT_ID u TaskManagerSQL.ts).
ZADANI_PROJEKT = "PRJ-033"


def _ucitaj_konfiguraciju() -> dict:
    put = konfig("uvoz-telegrama.json", "TM_UVOZ_TELEGRAMA_CONFIG")
    try:
        return json.loads(put.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


_KONF = _ucitaj_konfiguraciju()
ZADANA_GRUPA: str = _KONF.get("zadanaGrupa") or "glavna"
#: {grupa: {ljudi: [ime…], zadaniProjekt: "PRJ-…"}}
GRUPE: dict = _KONF.get("grupe") or {}
#: Pravila po redu, prvo koje se poklopi odlučuje: {uzorak, projekt, osimGrupa?: [grupa…]}.
TEKST_PRAVILA: list[dict] = _KONF.get("pravila") or []
ZADANO_PO_GRUPI = {g: v["zadaniProjekt"] for g, v in GRUPE.items() if v.get("zadaniProjekt")}
#: Nadimak pošiljatelja (mala slova) → ime na računu; koristi ga tools/vrijednost_inputa.py.
KORISNICI: dict = _KONF.get("korisnici") or {}


def grupa_iz_posiljatelja(posiljatelj: str) -> str:
    ime = (posiljatelj or "").split("(")[0].strip().lower()
    for grupa, v in GRUPE.items():
        if ime in {str(x).lower() for x in v.get("ljudi") or []}:
            return grupa
    return ZADANA_GRUPA


BILJEG = re.compile(r"\[OD:\s*([^\]]*)\]")
KONTEKST = re.compile(r"\[PRETHODNI KONTEKST.*?\]\s*", re.DOTALL)


def ocisti(tekst: str) -> str:
    t = KONTEKST.sub("", tekst or "")
    t = BILJEG.sub("", t)
    t = re.sub(r"\?{2,}", "", t)
    t = re.sub(r"<[^>]{1,40}>", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def projekt_iz_teksta(tekst: str, grupa: str | None = None) -> str | None:
    """Prvo pravilo čiji se uzorak nađe u tekstu. `osimGrupa` isključuje pravilo u tim
    grupama — npr. u grupi u kojoj „modul" i „stranica" ne znače naš sustav; izričit
    spomen sustava se tada zadaje kao zasebno, ranije pravilo bez `osimGrupa`."""
    grupa = grupa or ZADANA_GRUPA
    t = (tekst or "").lower()
    for pravilo in TEKST_PRAVILA:
        if grupa in (pravilo.get("osimGrupa") or []):
            continue
        if re.search(pravilo["uzorak"], t, re.IGNORECASE):
            return pravilo["projekt"]
    return None


def segmenti_sjednice(path: Path) -> list[dict]:
    """Razreži transkript na segmente: jedna telegramska poruka + rad do sljedeće."""
    segs: list[dict] = []
    tek: dict | None = None
    vidjeni: set[str] = set()
    posiljatelj = None
    redni = 0

    def zatvori():
        nonlocal tek
        if tek and (tek["out"] or tek["cr"] or tek["cw"]):
            tek["usd"] = round(cijena(tek["in"], tek["out"], tek["cr"], tek["cw"],
                                      tek["model"], tek["cw1h"]), 4)
            segs.append(tek)
        tek = None

    try:
        fh = otvori(path)
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
                    m = BILJEG.search(blob)
                    posiljatelj = (m.group(1).strip() if m else posiljatelj or "?")
                    zadnji = blob.split("[OD: ")[-1]
                    zadnji = re.sub(r"^[^\]]*\]\s*", "", zadnji)
                    redni += 1
                    tek = {
                        "session_id": sesija_id(path), "redni": redni,
                        "posiljatelj": posiljatelj, "zahtjev": ocisti(zadnji)[:2000],
                        "start": ts, "kraj": ts, "in": 0, "out": 0, "cr": 0, "cw": 0,
                        "cw1h": 0, "model": "claude-opus-5", "modeli": set(),
                        "koraka": 0, "alat": False, "cwd": rec.get("cwd") or "",
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
                    tek["modeli"].add(mdl)
                    tek["model"] = mdl
                tek["koraka"] += 1
                if ts:
                    tek["kraj"] = ts
                cont = msg.get("content")
                if isinstance(cont, list) and any(isinstance(b, dict) and b.get("type") == "tool_use" for b in cont):
                    tek["alat"] = True
    zatvori()
    return [s for s in segs if s["zahtjev"]]


def naslov_iz(zahtjev: str, grupa: str) -> str:
    t = re.sub(r"^(ok[,.]?\s+|da[,.]?\s+|molim te\s+|hvala[,.]?\s+)", "", zahtjev, flags=re.I).strip()
    t = t.split("\n")[0]
    if len(t) > 96:
        t = t[:93].rsplit(" ", 1)[0] + "…"
    return f"[TG:{grupa}] {t or 'Telegram zahtjev'}"


RUN_LOG = Path(os.environ.get("TM_RUN_LOG") or stanje("run_log.jsonl"))


def trosak_transkripta(path: Path) -> dict | None:
    """Ukupan trošak JEDNOG transkripta (dedup po `message.id`) + je li agentski spawn."""
    inp = out = cr = cw = cw1h = 0
    seen: set[str] = set()
    model = "claude-opus-5"
    prva_ts = None
    ima_task = False
    uvod: list[str] = []          # prve korisničke poruke — jedini trag o temi sjednice
    try:
        fh = otvori(path)
    except OSError:
        return None
    with fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except (ValueError, TypeError):
                continue
            if rec.get("timestamp") and prva_ts is None:
                prva_ts = rec["timestamp"]
            if not ima_task and rec.get("type") == "user":
                c = (rec.get("message") or {}).get("content")
                blob = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)
                if re.search(r"TASK-\d+", blob or ""):
                    ima_task = True
                if len(uvod) < 4:
                    t = ocisti(blob)
                    if t:
                        uvod.append(t[:600])
            if rec.get("type") == "assistant":
                msg = rec.get("message") or {}
                mid = msg.get("id")
                if mid:
                    if mid in seen:
                        continue
                    seen.add(mid)
                u = msg.get("usage") or {}
                inp += u.get("input_tokens", 0) or 0
                out += u.get("output_tokens", 0) or 0
                cr += u.get("cache_read_input_tokens", 0) or 0
                cw += u.get("cache_creation_input_tokens", 0) or 0
                cw1h += ((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0) or 0)
                m = msg.get("model")
                if m and not m.startswith("<"):
                    model = m
    if not prva_ts or (out == 0 and cr == 0 and cw == 0):
        return None
    return {"session_id": sesija_id(path), "start": prva_ts, "model": model, "ima_task": ima_task,
            "uvod": " ".join(uvod),
            "in": inp, "out": out, "cr": cr, "cw": cw,
            "usd": round(cijena(inp, out, cr, cw, model, cw1h), 4)}


def uvezi_ostatak(samo_proba: bool) -> int:
    """Sve što je potrošeno, a nije ni na jednom zadatku — zbirno po danu.

    Vlasnik, 04.09.2026.: „sve mora biti uključeno". Segmentni uvoz hvata telegramske
    zahtjeve od 13.07. (otkad transkript nosi biljeg `[OD: …]`), a agentski spawnovi su
    ionako u `cost_log`. Ostaje treći dio: sjednice bez ijednog zadatka (starije
    telegramske bez biljega i lokalne konzolne) i dijelovi sjednica PRIJE prve poruke.

    Dvostrukog brojanja nema jer se od ukupnog troška transkripta oduzme ono što je za
    tu istu sjednicu već zapisano u `cost_log` (uvoz ondje upisuje `session_id`).
    """
    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row
    vec_upisano: dict[str, float] = {}
    for r in con.execute("SELECT session_id, SUM(cost_usd) s FROM cost_log WHERE session_id IS NOT NULL GROUP BY session_id"):
        vec_upisano[r["session_id"]] = r["s"] or 0.0
    # Projekt sjednice: ako su segmenti te iste sjednice već razvrstani, ostatak ide onamo.
    # Bez toga bi se 645 USD zauvijek zadržalo u Pretincu kao „nerazvrstano" (vlasnik, 04.09.).
    projekt_sesije: dict[str, Counter] = defaultdict(Counter)
    for r in con.execute("SELECT project_id, description FROM tasks WHERE description LIKE '%[uvoz:telegram segment=%'"):
        m = re.search(r"\[uvoz:telegram segment=([0-9a-f-]+)#", r["description"] or "")
        if m and r["project_id"]:
            projekt_sesije[m.group(1)][r["project_id"]] += 1

    postojeci_dani = set()
    for r in con.execute("SELECT description FROM tasks WHERE description LIKE '%[uvoz:ostatak dan=%'"):
        for m in re.finditer(r"\[uvoz:ostatak dan=([0-9-]+)\]", r["description"] or ""):
            postojeci_dani.add(m.group(1))

    po_danu: dict[str, dict] = {}
    for f in svi_transkripti():
        t = trosak_transkripta(f)
        if not t:
            continue
        # Agentski spawn se NE prepoznaje po spomenu „TASK-…" u prompti (i glavna sjednica
        # ga spominje), nego po tome što je njegov `session_id` već uknjižen u `cost_log`
        # (SpawnTelemetry ga ondje upisuje: 1458 od 1476 zapisa). Oduzimanje po sjednici je
        # zato dovoljno i za spawnove i za djelomično uvezene sjednice.
        ostatak = t["usd"] - vec_upisano.get(t["session_id"], 0.0)
        if ostatak <= 0.01:
            continue
        dan = t["start"][:10]
        glasovi = projekt_sesije.get(t["session_id"])
        if glasovi:
            pid = glasovi.most_common(1)[0][0]
        else:
            # Nema uvezenih segmenata za tu sjednicu (npr. imenovane agentske sjednice iz
            # arhiva, `agent-a7…`): tada odlučuje SADRŽAJ prvih poruka. Bez ovoga je
            # 96,78 USD rada na MUSZG-u završilo u Pretincu kao „bez projekta".
            # Sadržaj odlučuje samo kad ga ima dovoljno: sjednica od dvije sekunde s jednim
            # korakom nosi previše malo teksta da bi pogodak bio dokaz, a ne nagađanje.
            dovoljno_traga = t["usd"] >= 0.50 or len(t.get("uvod", "")) >= 400
            pid = (projekt_iz_teksta(t.get("uvod", "")) if dovoljno_traga else None) or ZADANI_PROJEKT
        kljuc = f"{dan}|{pid}"
        if kljuc in postojeci_dani or dan in postojeci_dani:
            continue
        z = po_danu.setdefault(kljuc, {"usd": 0.0, "sjednica": 0, "in": 0, "out": 0, "cr": 0, "cw": 0,
                                       "start": t["start"], "kraj": t["start"], "model": t["model"],
                                       "dan": dan, "pid": pid})
        udio = ostatak / t["usd"] if t["usd"] else 0
        z["usd"] += ostatak
        z["sjednica"] += 1
        for k in ("in", "out", "cr", "cw"):
            z[k] += int(t[k] * udio)
        z["start"] = min(z["start"], t["start"])
        z["kraj"] = max(z["kraj"], t["start"])

    uk = sum(v["usd"] for v in po_danu.values())
    print(f"Dana s neuknjiženim troškom: {len(po_danu)} | sjednica: {sum(v['sjednica'] for v in po_danu.values())} "
          f"| ukupno {uk:.2f} USD")
    for kljuc in sorted(po_danu, key=lambda k: -po_danu[k]["usd"])[:12]:
        v = po_danu[kljuc]
        print(f"  {v['dan']}  {v['pid']:14} {v['usd']:8.2f} USD  ({v['sjednica']} sjednica)")
    if len(po_danu) > 10:
        print(f"  … i još {len(po_danu)-10} dana")
    if samo_proba or not po_danu:
        con.close()
        return 0

    pricuva = DB.with_name(f"regoc.db.pricuva-ostatak-{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    shutil.copy2(DB, pricuva)
    print(f"Pričuva baze: {pricuva}")
    n = 0
    with con:
        for kljuc, v in sorted(po_danu.items()):
            dan, pid = v["dan"], v["pid"]
            red = con.execute("SELECT next_id FROM task_id_seq WHERE key='task'").fetchone()
            tid = f"TASK-{red['next_id']}"
            con.execute("UPDATE task_id_seq SET next_id = next_id + 1, updated_at = CURRENT_TIMESTAMP WHERE key='task'")
            opis = ("## Neuknjižena potrošnja — zbirno po danu\n\n"
                    f"Dan: {dan} · sjednica: {v['sjednica']} · trošak {v['usd']:.2f} USD.\n\n"
                    "Rad koji nije bio vezan ni uz jedan zadatak: telegramske sjednice starije od "
                    "13.07.2026. (transkript tada još nije nosio biljeg `[OD: …]`, pa se izvor poruke ne "
                    "može dokazati), lokalne konzolne sjednice i dijelovi sjednica prije prve poruke. "
                    "Uvezeno da zbroj na ploči odgovara stvarnoj potrošnji; naslov i projekt se ne "
                    "izmišljaju — zadatak stoji u Pretincu dok se ne razvrsta.\n\n"
                    f"[uvoz:ostatak dan={dan}|{pid}]")
            con.execute(
                """INSERT INTO tasks (id,title,description,status,priority,assignee,created_at,updated_at,
                                      created_by,blocked_by,project_id,progress_percent,progress_notes,tags,
                                      result_summary,blocks,started_at,completed_at,blocked_reason,paused)
                   VALUES (?,?,?,'completed',3,'regoc',?,?,'uvoz','[]',?,100,'[]',?,?,'[]',?,?,'',0)""",
                (tid, f"[zbirno] Sjednice bez zadatka — {dan} ({v['sjednica']})", opis,
                 v["start"], v["kraj"], pid,
                 json.dumps(["uvoz-ostatak"] + (["nerazvrstano"] if pid == ZADANI_PROJEKT else []), ensure_ascii=False),
                 f"Zbirno uvezena neuknjižena potrošnja: {v['usd']:.2f} USD iz {v['sjednica']} sjednica.",
                 v["start"], v["kraj"]))
            con.execute(
                """INSERT INTO cost_log (id,timestamp,agent_id,task_id,model,input_tokens,output_tokens,
                                         cost_usd,cache_read_tokens,cache_write_tokens,session_id,turns,project_id)
                   VALUES (?,?,'regoc',?,?,?,?,?,?,?,NULL,?,?)""",
                (str(uuid.uuid4()), v["kraj"], tid, v["model"], v["in"], v["out"], round(v["usd"], 4),
                 v["cr"], v["cw"], v["sjednica"], pid))
            n += 1
    con.close()
    print(f"Upisano zbirnih zadataka: {n}")
    return 0


def dopuni_run_log() -> int:
    """Uvezeni zadatci moraju biti vidljivi i u kartici „Potrošnja".

    Kartica čita `data/run_log.jsonl` (preko tools/tjedni_pregled.py), a ne `cost_log`,
    pa uvoz koji piše samo u bazu ondje ostaje nevidljiv. Ovdje se za svaki uvezeni
    zadatak dopisuje jedan redak izvođenja.

    `session_id` se namjerno NE upisuje: više uvezenih zadataka dijeli isti transkript
    (jedan po segmentu), pa bi telemetrija za svaki od njih pročitala CIJELU sjednicu i
    višestruko prebrojala tokene. Bez `session_id` alat uzima `cost_usd` iz retka i
    uredno prijavljuje da za ta izvođenja nema transkripta.
    """
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    postojeci = set()
    if RUN_LOG.exists():
        with RUN_LOG.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if r.get("source") == "telegram-uvoz":
                    postojeci.add(r.get("task_id"))
    redci = con.execute("""
        SELECT c.task_id, c.timestamp, c.model, c.input_tokens, c.output_tokens,
               c.cache_read_tokens, c.cache_write_tokens, c.cost_usd, c.turns,
               t.created_at, t.completed_at
          FROM cost_log c JOIN tasks t ON t.id = c.task_id
         WHERE t.created_by = 'telegram'
    """).fetchall()
    con.close()
    n = 0
    with RUN_LOG.open("a", encoding="utf-8") as fh:
        for r in redci:
            if r["task_id"] in postojeci:
                continue
            trajanje = 0
            try:
                a1 = datetime.fromisoformat((r["created_at"] or "").replace("Z", "+00:00"))
                a2 = datetime.fromisoformat((r["completed_at"] or "").replace("Z", "+00:00"))
                trajanje = max(0, int((a2 - a1).total_seconds()))
            except (ValueError, TypeError):
                trajanje = 0
            fh.write(json.dumps({
                "ts": r["timestamp"], "task_id": r["task_id"], "agent": "regoc",
                "model": r["model"], "exit_code": 0, "outcome": "completed",
                "duration_s": trajanje,
                "tokens": {"in": r["input_tokens"], "out": r["output_tokens"],
                           "cache_r": r["cache_read_tokens"], "cache_w": r["cache_write_tokens"]},
                "cost_usd": r["cost_usd"], "cost_source": "transkript-segment",
                "session_id": None, "num_turns": r["turns"], "telemetry": "uvoz",
                "provider": "anthropic", "source": "telegram-uvoz",
                "note": "naknadni uvoz telegramskog zahtjeva; trošak izračunat po segmentu transkripta",
            }, ensure_ascii=False) + "\n")
            n += 1
    print(f"Dopisano u run_log.jsonl: {n} redaka (preskočeno {len(postojeci)} već upisanih)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--proba", action="store_true")
    ap.add_argument("--upis", action="store_true")
    ap.add_argument("--od", default=None)
    ap.add_argument("--prag", type=float, default=0.50)
    ap.add_argument("--detalji", action="store_true")
    ap.add_argument("--ostatak", action="store_true",
                    help="uvezi i sav preostali trosak transkripata (sjednice bez zadatka) zbirno po danu")
    ap.add_argument("--dopuni-run-log", action="store_true",
                    help="dopisi uvezene zadatke u data/run_log.jsonl (izvor kartice Potrosnja)")
    a = ap.parse_args()
    if a.ostatak:
        return uvezi_ostatak(a.proba)
    if a.dopuni_run_log:
        return dopuni_run_log()
    if not a.proba and not a.upis:
        ap.error("odaberi --proba, --upis ili --dopuni-run-log")

    od = datetime.fromisoformat(a.od).replace(tzinfo=timezone.utc) if a.od else None

    svi: list[dict] = []
    for f in svi_transkripti():
        segs = segmenti_sjednice(f)
        zadnji_projekt = None
        zadnji_posiljatelj = None
        for s in segs:
            if od and s["start"] and datetime.fromisoformat(s["start"].replace("Z", "+00:00")) < od:
                continue
            s["grupa"] = grupa_iz_posiljatelja(s["posiljatelj"])
            pid = projekt_iz_teksta(s["zahtjev"], s["grupa"])
            # Nasljeđivanje vrijedi samo unutar istog sugovornika: „nastavi" od drugog korisnika
            # ne smije pokupiti projekt vlasnikove prethodne poruke.
            isti = (s["posiljatelj"] == zadnji_posiljatelj)
            if pid:
                s["projekt"], s["izvor"] = pid, "tekst"
                zadnji_projekt = pid
            elif zadnji_projekt and isti:
                s["projekt"], s["izvor"] = zadnji_projekt, "nastavak"
            else:
                s["projekt"], s["izvor"] = ZADANO_PO_GRUPI.get(s["grupa"], ZADANI_PROJEKT), "grupa"
                zadnji_projekt = s["projekt"]
            zadnji_posiljatelj = s["posiljatelj"]
            svi.append(s)
    svi.sort(key=lambda x: x["start"] or "")

    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row
    vec = set()
    for r in con.execute("SELECT description FROM tasks WHERE description LIKE '%[uvoz:telegram %'"):
        for m in re.finditer(r"\[uvoz:telegram (?:segment|zbir)=([^\]]+)\]", r["description"] or ""):
            vec.add(m.group(1))

    zadatci = [s for s in svi if (s["usd"] >= a.prag or s["alat"]) and f"{s['session_id']}#{s['redni']}" not in vec]
    ostatak = [s for s in svi if not (s["usd"] >= a.prag or s["alat"])]

    zbirni: dict[tuple, dict] = {}
    for s in ostatak:
        kljuc = (s["start"][:10], s["grupa"], s["projekt"])
        z = zbirni.setdefault(kljuc, {"n": 0, "usd": 0.0, "in": 0, "out": 0, "cr": 0, "cw": 0,
                                      "start": s["start"], "kraj": s["kraj"], "primjeri": []})
        z["n"] += 1
        for k in ("usd", "in", "out", "cr", "cw"):
            z[k] += s[k]
        z["kraj"] = max(z["kraj"], s["kraj"])
        if len(z["primjeri"]) < 6:
            z["primjeri"].append(s["zahtjev"][:120])
    zbirni = {k: v for k, v in zbirni.items() if f"{k[0]}|{k[1]}|{k[2]}" not in vec}

    po_projektu = defaultdict(lambda: [0, 0.0])
    for s in zadatci:
        po_projektu[s["projekt"]][0] += 1
        po_projektu[s["projekt"]][1] += s["usd"]
    for (dan, grupa, pid), z in zbirni.items():
        po_projektu[pid][0] += 1
        po_projektu[pid][1] += z["usd"]

    print(f"Segmenata ukupno: {len(svi)} | zadataka: {len(zadatci)} | zbirnih (razgovor): {len(zbirni)} "
          f"od {len(ostatak)} kratkih segmenata")
    if svi:
        print(f"Razdoblje: {svi[0]['start'][:10]} … {svi[-1]['start'][:10]}")
    uk = sum(s["usd"] for s in zadatci) + sum(z["usd"] for z in zbirni.values())
    print(f"Trošak koji ulazi na ploču: {uk:.2f} USD\n")
    print(f"{'PROJEKT':16}{'ZADATAKA':>9}{'USD':>12}")
    for pid, (n, usd) in sorted(po_projektu.items(), key=lambda x: -x[1][1]):
        print(f"{pid:16}{n:>9}{usd:>12.2f}")
    pg = defaultdict(lambda: [0, 0.0])
    for s in zadatci:
        pg[s["grupa"]][0] += 1
        pg[s["grupa"]][1] += s["usd"]
    print(f"\n{'GRUPA':16}{'ZADATAKA':>9}{'USD':>12}")
    for g, (n, usd) in sorted(pg.items(), key=lambda x: -x[1][1]):
        print(f"{g:16}{n:>9}{usd:>12.2f}")
    izv = defaultdict(int)
    for s in zadatci:
        izv[s["izvor"]] += 1
    print("\nIzvor projekta:", dict(izv))

    if a.detalji:
        print("\n— najskuplji zadatci —")
        for s in sorted(zadatci, key=lambda x: -x["usd"])[:20]:
            print(f"  {s['start'][:16]} {s['projekt']:12} {s['usd']:7.2f} USD  {naslov_iz(s['zahtjev'], s['grupa'])[:82]}")

    if a.proba:
        con.close()
        return 0

    pricuva = DB.with_name(f"regoc.db.pricuva-uvoz-{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    shutil.copy2(DB, pricuva)
    print(f"\nPričuva baze: {pricuva}")

    def novi_id() -> str:
        red = con.execute("SELECT next_id FROM task_id_seq WHERE key='task'").fetchone()
        con.execute("UPDATE task_id_seq SET next_id = next_id + 1, updated_at = CURRENT_TIMESTAMP WHERE key='task'")
        return f"TASK-{red['next_id']}"

    def upisi(tid, naslov, opis, projekt, start, kraj, oznake, sazetak, model, tok, session, koraka):
        con.execute(
            """INSERT INTO tasks (id,title,description,status,priority,assignee,created_at,updated_at,
                                  created_by,blocked_by,project_id,progress_percent,progress_notes,tags,
                                  result_summary,blocks,started_at,completed_at,blocked_reason,paused)
               VALUES (?,?,?,'completed',3,'regoc',?,?,'telegram','[]',?,100,'[]',?,?,'[]',?,?,'',0)""",
            (tid, naslov, opis, start, kraj, projekt, json.dumps(oznake, ensure_ascii=False),
             sazetak, start, kraj))
        con.execute(
            """INSERT INTO cost_log (id,timestamp,agent_id,task_id,model,input_tokens,output_tokens,
                                     cost_usd,cache_read_tokens,cache_write_tokens,session_id,turns,project_id)
               VALUES (?,?,'regoc',?,?,?,?,?,?,?,?,?,?)""",
            (str(uuid.uuid4()), kraj, tid, model, tok["in"], tok["out"], tok["usd"],
             tok["cr"], tok["cw"], session, koraka, projekt))

    n1 = n2 = 0
    with con:
        for s in zadatci:
            tid = novi_id()
            opis = (
                f"## Uvezeno iz Telegrama ({s['grupa']}), pošiljatelj: {s['posiljatelj']}\n\n"
                f"**Zahtjev:** {s['zahtjev'][:1500]}\n\n"
                f"**Mjereno:** {s['koraka']} koraka, {'koristio alate' if s['alat'] else 'bez alata'}, "
                f"model {', '.join(sorted(s['modeli'])) or s['model']}, {s['usd']:.2f} USD "
                f"(ulaz {s['in']}, izlaz {s['out']}, keš čitanje {s['cr']}, keš upis {s['cw']})\n"
                f"**Projekt određen po:** {s['izvor']}\n\n"
                f"[uvoz:telegram segment={s['session_id']}#{s['redni']}]"
            )
            oznake = ["uvoz-telegram", f"grupa:{s['grupa']}"]
            if not s["alat"]:
                oznake.append("bez-alata")
            upisi(tid, naslov_iz(s["zahtjev"], s["grupa"]), opis, s["projekt"], s["start"], s["kraj"],
                  oznake, f"Uvezeno naknadno iz transkripta; trošak {s['usd']:.2f} USD.",
                  s["model"], s, s["session_id"], s["koraka"])
            n1 += 1
        for (dan, grupa, pid), z in zbirni.items():
            tid = novi_id()
            naslov = f"[TG:{grupa}] Kratki upiti i razgovor — {dan} ({z['n']} poruka)"
            opis = ("## Zbirno uvezeno iz Telegrama\n\n"
                    f"Dan: {dan} · grupa: {grupa} · poruka: {z['n']} · trošak {z['usd']:.2f} USD.\n"
                    "Kratki upiti bez uporabe alata; uvezeni zbirno da trošak bude zbrojen, a ploča čitljiva.\n\n"
                    "**Primjeri:**\n" + "\n".join(f"- {p}" for p in z["primjeri"]) +
                    f"\n\n[uvoz:telegram zbir={dan}|{grupa}|{pid}]")
            upisi(tid, naslov, opis, pid, z["start"], z["kraj"],
                  ["uvoz-telegram", f"grupa:{grupa}", "razgovor"],
                  f"Zbirni uvoz {z['n']} kratkih poruka; trošak {z['usd']:.2f} USD.",
                  "claude-opus-5", z, f"zbir-{dan}", z["n"])
            n2 += 1
    con.close()
    print(f"Upisano: {n1} zadataka + {n2} zbirnih (i {n1+n2} zapisa u cost_log)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
