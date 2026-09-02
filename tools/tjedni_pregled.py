#!/usr/bin/env python3
"""tjedni_pregled.py — MJERA 6: tjedni pregled potrošnje po projektu i po agentu.

Kriška T5 uz ISTRAZIVANJE_AGENTSIGHT_2026-09-01.md §7 (tablica šest mjera, redak 6:
„Tjedni pregled po projektu i agentu — danas trošak znamo po zadatku, ne po projektu").

IZVOR ISTINE — ništa se ovdje ne izmišlja i ne duplicira:

    ~/.claude/regoc/data/run_log.jsonl      → koja su se izvođenja dogodila
                                              (task_id, agent, model, outcome, exit_code,
                                               duration_s, tokens{}, cost_usd, session_id)
    ~/.claude/projects/**/<session_id>.jsonl → NAŠI transkripti: vrijeme, latencija po
                                              pozivu modela, pozivi alata, `usage` polja
    ~/.claude/regoc/data/transkript_arhiv/  → arhiv istih transkripata (.jsonl.gz) —
                                              čita se kad je živi obrisan (T9/TASK-3574)
    ~/.claude/regoc/data/regoc.db (ro)      → tasks.project_id i projects.name

Veza zadatak ↔ transkript ide preko `session_id`, točno kao u `agent_telemetry.py`.
Sam izračun po jednom izvođenju NE pišemo ponovo — zovemo `agent_telemetry.sastavi_zapis()`
(kriške T2/T3). Ovaj alat je zbrajalo iznad njega.

PROVJERLJIVOST (zahtjev zadatka TASK-3569)
    Uz SVAKU agregaciju ide `iz_zadataka` — iz koliko je izvođenja izračunata — i to
    zasebno po mjeri, jer se nazivnici razlikuju:
        `trosak.iz_zadataka`      — koliko ih uopće ima `cost_usd`
        `latencija.iz_zadataka`   — koliko ih ima transkript s barem jednim pozivom modela
        `iz_arhiva`               — koliko ih je čitano iz arhiva umjesto iz živog transkripta
        `tokeni.iz_zadataka`      — koliko ih ima izmjeren ulazni kontekst
    Nijedna brojka se ne prikazuje bez svog nazivnika. Nedostajuća vrijednost je `null`,
    nikad 0 (ADR-TELEMETRIJA-ZADATKA §9).

TRI ODLUKE KOJE OVAJ ALAT PROVODI

    O1  MEDIJAN MEDIJANA NIJE MEDIJAN. Skupni medijan i p95 latencije računaju se iz
        SIROVIH latencija svih poziva modela u razdoblju (`_latencije_s`), a ne iz
        po-zadatak sažetaka. Prosjek je `zbroj_s / poziva` (težinski, egzaktan).

    O2  ZBRAJA SE PO IZVOĐENJU, NE PO ZADATKU. Jedan `task_id` može imati više redaka u
        `run_log.jsonl` (ponovni spawn). `zadataka` je broj izvođenja, a `razlicitih_zadataka`
        broj različitih `task_id` — oba se objavljuju da razlika ne bude skrivena.

    O3  KEŠ SE VEZUJE UZ OTISAK TRANSKRIPTA (veličina + mtime). Transkript koji je narastao
        ili nestao poništava svoj zapis u kešu; keš nikad ne može prikazati stariju brojku
        od datoteke na disku.

UPORABA
    python3 tools/tjedni_pregled.py                      # zadnjih 7 dana, ispis za čovjeka
    python3 tools/tjedni_pregled.py --dana 14 --json
    python3 tools/tjedni_pregled.py --bez-kesa --json    # puni ponovni izračun
    python3 tools/tjedni_pregled.py --najskupljih 10
    python3 tools/tjedni_pregled.py --projekt PRJ-060 --dana 30 --json   # samo taj projekt

Sve vremenske oznake u izlazu su UTC sa sufiksom `Z`.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_telemetry as at  # noqa: E402  (isti direktorij; SSOT za izračun po zadatku)

SHEMA_ID = "regoc.tjedni-pregled/v1"
KES_PUT = Path.home() / ".claude" / "regoc" / "data" / "tjedni_pregled_kes.jsonl"
KES_MAX = 2000
# Koliko svježe izračunatih zapisa smije proći prije nego keš ode na disk. Bez međuspremanja
# prolaz koji pozivatelj ubije na roku ne ostavi ništa (v. petlju u `zapisi_u_razdoblju`).
KES_SPREMI_SVAKIH = 25
BEZ_PROJEKTA = "(bez projekta)"
ZADANO_DANA = 7
ZADANO_NAJSKUPLJIH = 5
# „Svo vrijeme" na ploči je konačan broj dana, ne beskonačnost: run_log počinje
# 2026-07-28, a transkripti se čuvaju ~30 dana, pa 3650 pouzdano obuhvaća sve.
DANA_MAX = 3650
TOP_ALATA = 5


# ─────────────────────────────────────────────────────────────────────────────
# Keš po izvođenju
# ─────────────────────────────────────────────────────────────────────────────

def otisak(run: dict, put: Path | None) -> str:
    """Ključ keša: izvođenje + stanje transkripta na disku (O3)."""
    if put is not None and put.exists():
        st = put.stat()
        trag = f"{st.st_size}:{int(st.st_mtime)}"
    else:
        trag = "bez-transkripta"
    return "|".join([
        str(run.get("task_id")), str(run.get("ts")), str(run.get("session_id")), trag,
    ])


def ucitaj_kes(put: Path = KES_PUT) -> dict[str, dict]:
    if not put.exists():
        return {}
    kes: dict[str, dict] = {}
    try:
        with put.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    z = json.loads(line)
                except (ValueError, TypeError):
                    continue
                k = z.get("_otisak")
                if k:
                    kes[k] = z
    except OSError:
        return {}
    return kes


def spremi_kes(kes: dict[str, dict], put: Path = KES_PUT) -> bool:
    """Atomski prepis (tmp + rename) — poluispisan keš je gori od nikakvog."""
    stavke = list(kes.values())[-KES_MAX:]
    tmp = put.with_suffix(put.suffix + ".tmp")
    try:
        put.parent.mkdir(parents=True, exist_ok=True)
        with tmp.open("w", encoding="utf-8") as fh:
            for z in stavke:
                fh.write(json.dumps(z, ensure_ascii=False) + "\n")
        os.replace(tmp, put)
        return True
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Nazivi projekata (regoc.db, samo za čitanje)
# ─────────────────────────────────────────────────────────────────────────────

def nazivi_projekata() -> dict[str, str]:
    if not at.REGOC_DB.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{at.REGOC_DB}?mode=ro", uri=True)
        try:
            return {r[0]: r[1] for r in con.execute("SELECT id, name FROM projects")}
        finally:
            con.close()
    except sqlite3.Error:
        return {}


def projekti_zadataka(ids: list[str]) -> dict[str, str]:
    """task_id → tasks.project_id, JEDNIM upitom (filtar po projektu, TASK-3572).

    `agent_telemetry.project_id_za()` otvara bazu po zadatku; za filtriranje cijelog
    razdoblja to bi bilo N otvaranja veze prije nego išta izračunamo, pa se ovdje
    čita skupno. Zadatak kojeg nema u bazi izostaje iz mape — pozivatelj ga tada
    tretira kao „bez projekta", a ne kao pripadnika filtriranog projekta.
    """
    if not ids or not at.REGOC_DB.exists():
        return {}
    jedinstveni = sorted({i for i in ids if i})
    out: dict[str, str] = {}
    try:
        con = sqlite3.connect(f"file:{at.REGOC_DB}?mode=ro", uri=True)
        try:
            for poc in range(0, len(jedinstveni), 400):
                dio = jedinstveni[poc:poc + 400]
                upitnici = ",".join("?" * len(dio))
                red = con.execute(
                    f"SELECT id, project_id FROM tasks WHERE id IN ({upitnici})", dio)
                for tid, pid in red:
                    if pid:
                        out[tid] = pid
        finally:
            con.close()
    except sqlite3.Error:
        return {}
    return out


def naslovi_zadataka(ids: list[str]) -> dict[str, str]:
    if not ids or not at.REGOC_DB.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{at.REGOC_DB}?mode=ro", uri=True)
        try:
            upitnici = ",".join("?" * len(ids))
            red = con.execute(f"SELECT id, title FROM tasks WHERE id IN ({upitnici})", ids)
            return {r[0]: r[1] for r in red}
        finally:
            con.close()
    except sqlite3.Error:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# Skupljanje zapisa u razdoblju
# ─────────────────────────────────────────────────────────────────────────────

def zapisi_u_razdoblju(dana: int, koristi_kes: bool = True,
                       projekt: str | None = None) -> tuple[list[dict], dict]:
    """→ (zapisi telemetrije, meta o izvoru). Zapis = izlaz `agent_telemetry.sastavi_zapis`.

    `projekt` (npr. „PRJ-060" ili `BEZ_PROJEKTA`) sužava razdoblje na izvođenja tog
    projekta. Filtar se primjenjuje PRIJE `sastavi_zapis`, jer je izračun po izvođenju
    najskuplji korak; propušteno izvođenje ne smije se ni računati ni ući u keš-brojke.
    """
    sad = datetime.now(timezone.utc)
    od = sad - timedelta(days=dana)
    od_iso = od.isoformat().replace("+00:00", "Z")

    # Putanja se prosljeđuje IZRIJEKOM: `ucitaj_run_log` ima zadanu vrijednost
    # izračunatu pri uvozu, pa je podmetanje `at.RUN_LOG` inače bez učinka (testovi).
    svi = at.ucitaj_run_log(at.RUN_LOG)
    u_razdoblju = [r for r in svi if (r.get("ts") or "") >= od_iso]
    prije_filtra = len(u_razdoblju)

    if projekt:
        mapa = projekti_zadataka([r.get("task_id") for r in u_razdoblju])
        u_razdoblju = [r for r in u_razdoblju
                       if (mapa.get(r.get("task_id")) or BEZ_PROJEKTA) == projekt]

    po_sesiji: dict[str, int] = defaultdict(int)
    for r in svi:
        if r.get("session_id"):
            po_sesiji[r["session_id"]] += 1

    kes = ucitaj_kes() if koristi_kes else {}
    novi_kes: dict[str, dict] = dict(kes)
    zapisi: list[dict] = []
    iz_kesa = 0
    izracunato = 0
    # Dva različita razloga za „nema transkripta"; ne smiju se zbrojiti dvaput.
    izgubljen_transkript = 0

    for run in u_razdoblju:
        sid = run.get("session_id")
        put = at.nadji_transkript(sid) if sid else None
        if sid and put is None:
            izgubljen_transkript += 1
        kljuc = otisak(run, put)
        z = kes.get(kljuc)
        if z is not None:
            iz_kesa += 1
        else:
            z = at.sastavi_zapis(run, put, po_sesiji.get(sid or "", 1))
            z = {k: v for k, v in z.items() if k != "_trenje_primjeri"}
            z["_otisak"] = kljuc
            novi_kes[kljuc] = z
            izracunato += 1
            # Keš se prije spremao TEK na kraju. Kad pozivatelj ima rok (ploča ga ubija
            # nakon PREGLED_TIMEOUT_MS), hladan prolaz preko roka nije ostavljao NIŠTA —
            # sljedeći pokušaj kretao je od istih zatečenih ključeva i opet bio ubijen.
            # Zaglavljeni krug: „Potrošnja" je zauvijek stajala na „računa se"
            # (mjereno 02.09.2026.: 724 izvođenja u 24 h, 117 ključeva u kešu,
            # 0,15 s po zapisu ≈ 1,8 min > 90 s roka). Sada svaki prolaz ostavlja trag,
            # pa se izračun dovrši kroz nekoliko pokušaja i sam se izliječi.
            if izracunato % KES_SPREMI_SVAKIH == 0:
                spremi_kes(novi_kes)
        zapisi.append(z)

    kes_spremljen = False
    if koristi_kes and izracunato and izracunato % KES_SPREMI_SVAKIH != 0:
        # Ostatak koji nije pao na među iz petlje.
        kes_spremljen = spremi_kes(novi_kes)
    elif koristi_kes and izracunato:
        kes_spremljen = True

    meta = {
        "run_log": str(at.RUN_LOG),
        "run_log_redaka_ukupno": len(svi),
        "izvodjenja_u_razdoblju": len(u_razdoblju),
        # Nazivnik ostaje vidljiv i kad filtar reže: koliko ih je razdoblje imalo
        # prije filtriranja po projektu (bez filtra je isti broj).
        "izvodjenja_prije_filtra": prije_filtra,
        "projekt": projekt,
        "bez_session_id": sum(1 for r in u_razdoblju if not r.get("session_id")),
        "s_transkriptom": sum(1 for z in zapisi if z["sesija"]["transkript_putanja"]),
        # T9: koliko ih je spašeno iz arhiva — bez njega bi to bila „izgubljen_transkript".
        "iz_arhiva": sum(1 for z in zapisi
                         if str(z["sesija"]["transkript_putanja"] or "").endswith(".gz")),
        "izgubljen_transkript": izgubljen_transkript,
        "iz_kesa": iz_kesa,
        "izracunato_sada": izracunato,
        "kes_put": str(KES_PUT),
        "kes_spremljen": kes_spremljen,
    }
    return zapisi, meta


# ─────────────────────────────────────────────────────────────────────────────
# Agregacija
# ─────────────────────────────────────────────────────────────────────────────

def _zbroj(vrijednosti: list) -> tuple[float | None, int]:
    """→ (zbroj, iz koliko zapisa). Bez ijednog podatka zbroj je `null`, ne 0 (ADR §9)."""
    imaju = [v for v in vrijednosti if isinstance(v, (int, float))]
    if not imaju:
        return (None, 0)
    return (sum(imaju), len(imaju))


def agregiraj(zapisi: list[dict]) -> dict:
    """Jedna skupina (svi / jedan projekt / jedan agent) → brojke s nazivnicima."""
    n = len(zapisi)

    # ── trošak ────────────────────────────────────────────────────────────
    trosak_v = [(z.get("trosak") or {}).get("usd") for z in zapisi]
    trosak_usd, trosak_n = _zbroj(trosak_v)
    izvori = Counter((z.get("trosak") or {}).get("izvor") for z in zapisi
                     if (z.get("trosak") or {}).get("usd") is not None)

    # ── tokeni ────────────────────────────────────────────────────────────
    def tok(polje: str) -> tuple[float | None, int]:
        return _zbroj([(z.get("tokeni") or {}).get(polje) for z in zapisi])

    t_ulaz, _ = tok("ulaz")
    t_izlaz, _ = tok("izlaz")
    t_kes_r, _ = tok("kes_citanje")
    t_kes_w, _ = tok("kes_pisanje")
    t_kontekst, tokeni_n = tok("ulazni_kontekst")
    t_misljenje, _ = tok("misljenje")
    udio_kesa = at.udio(t_kes_r, t_kontekst) if t_kontekst else None

    # ── latencija: skupno iz SIROVIH poziva (O1) ──────────────────────────
    sirove: list[float] = []
    lat_n = 0
    poziva_modela = 0
    for z in zapisi:
        niz = z.get("_latencije_s") or []
        if niz:
            sirove.extend(float(x) for x in niz if isinstance(x, (int, float)))
            lat_n += 1
        p = (z.get("latencija_modela") or {}).get("poziva")
        if isinstance(p, int):
            poziva_modela += p
    lat_zbroj, _ = _zbroj([(z.get("latencija_modela") or {}).get("zbroj_s") for z in zapisi])

    latencija = {
        "poziva_modela": poziva_modela,
        "prosjek_s": at.r3(lat_zbroj / poziva_modela) if (lat_zbroj and poziva_modela) else None,
        "medijan_s": at.r3(statistics.median(sirove)) if sirove else None,
        "p95_s": at.r3(at.percentil(sirove, 0.95)) if sirove else None,
        "najveca_s": at.r3(max(sirove)) if sirove else None,
        "zbroj_s": at.r3(lat_zbroj) if lat_zbroj is not None else None,
        "iz_zadataka": lat_n,
        "iz_poziva": len(sirove),
    }

    # ── trajanje ──────────────────────────────────────────────────────────
    tr_uk, trajanje_n = _zbroj([(z.get("trajanje") or {}).get("ukupno_s") for z in zapisi])
    tr_model, _ = _zbroj([(z.get("trajanje") or {}).get("model_s") for z in zapisi])
    tr_alat, _ = _zbroj([(z.get("trajanje") or {}).get("alat_s") for z in zapisi])

    # ── alati ─────────────────────────────────────────────────────────────
    alat_poziva, alati_n = _zbroj([(z.get("alati") or {}).get("poziva") for z in zapisi])
    alat_neuspjelih, _ = _zbroj([(z.get("alati") or {}).get("neuspjelih") for z in zapisi])
    hist: Counter = Counter()
    hist_greske: Counter = Counter()
    for z in zapisi:
        for h in (z.get("alati") or {}).get("histogram") or []:
            hist[h.get("ime")] += h.get("poziva") or 0
            hist_greske[h.get("ime")] += h.get("neuspjelih") or 0
    top = [{"ime": ime, "poziva": br, "neuspjelih": hist_greske.get(ime, 0),
            "udio_poziva": at.udio(br, alat_poziva)}
           for ime, br in hist.most_common(TOP_ALATA)]

    # ── trenje (mjera 4) ──────────────────────────────────────────────────
    s_trenjem = sum(1 for z in zapisi if ((z.get("trenje") or {}).get("ocjena") or 0) > 0)
    trenje_mjereno = sum(1 for z in zapisi if z.get("trenje") is not None)
    izgubljeno, _ = _zbroj([(z.get("trenje") or {}).get("izgubljeno_s") for z in zapisi])

    return {
        "zadataka": n,
        "razlicitih_zadataka": len({(z.get("zadatak") or {}).get("task_id") for z in zapisi}
                                   - {None}),
        "s_transkriptom": sum(1 for z in zapisi if z["sesija"]["transkript_putanja"]),
        "iz_arhiva": sum(1 for z in zapisi
                         if str(z["sesija"]["transkript_putanja"] or "").endswith(".gz")),
        "ishodi": dict(Counter((z.get("zadatak") or {}).get("outcome") or "(nepoznat)"
                               for z in zapisi).most_common()),
        "trosak": {
            "usd": at.r6(trosak_usd) if trosak_usd is not None else None,
            "iz_zadataka": trosak_n,
            "usd_po_zadatku": at.r6(trosak_usd / trosak_n) if (trosak_usd and trosak_n) else None,
            "izvori": dict(izvori.most_common()),
        },
        "tokeni": {
            "ulaz": t_ulaz, "izlaz": t_izlaz,
            "kes_citanje": t_kes_r, "kes_pisanje": t_kes_w,
            "ulazni_kontekst": t_kontekst, "misljenje": t_misljenje,
            "udio_kesa": udio_kesa,
            "iz_zadataka": tokeni_n,
        },
        "latencija": latencija,
        "trajanje": {
            "ukupno_s": at.r3(tr_uk) if tr_uk is not None else None,
            "model_s": at.r3(tr_model) if tr_model is not None else None,
            "alat_s": at.r3(tr_alat) if tr_alat is not None else None,
            "udio_model": at.udio(tr_model, tr_uk),
            "udio_alat": at.udio(tr_alat, tr_uk),
            "iz_zadataka": trajanje_n,
        },
        "alati": {
            "poziva": alat_poziva, "neuspjelih": alat_neuspjelih,
            "udio_neuspjelih": at.udio(alat_neuspjelih, alat_poziva),
            "top": top,
            "iz_zadataka": alati_n,
        },
        "trenje": {
            "zadataka_s_trenjem": s_trenjem,
            "izgubljeno_s": at.r3(izgubljeno) if izgubljeno is not None else None,
            "iz_zadataka": trenje_mjereno,
        },
    }


def najskuplji(zapisi: list[dict], koliko: int) -> list[dict]:
    """Pet (ili N) najskupljih IZVOĐENJA po `cost_usd`; bez troška se ne rangira."""
    s_troskom = [z for z in zapisi if isinstance((z.get("trosak") or {}).get("usd"), (int, float))]
    s_troskom.sort(key=lambda z: z["trosak"]["usd"], reverse=True)
    izabrani = s_troskom[:koliko]
    naslovi = naslovi_zadataka([(z.get("zadatak") or {}).get("task_id") for z in izabrani
                                if (z.get("zadatak") or {}).get("task_id")])
    out = []
    for z in izabrani:
        zad, lat, tok = z.get("zadatak") or {}, z.get("latencija_modela") or {}, z.get("tokeni") or {}
        out.append({
            "task_id": zad.get("task_id"),
            "naslov": naslovi.get(zad.get("task_id")),
            "project_id": zad.get("project_id"),
            "agent": zad.get("agent"),
            "model": zad.get("model"),
            "outcome": zad.get("outcome"),
            "pokrenuto_ts": zad.get("run_log_ts"),
            "trosak_usd": z["trosak"]["usd"],
            "trajanje_s": zad.get("run_log_duration_s"),
            "poziva_modela": lat.get("poziva"),
            "prosjek_latencije_s": lat.get("prosjek_s"),
            "ulazni_kontekst": tok.get("ulazni_kontekst"),
            "udio_kesa": tok.get("udio_kesa"),
            "session_id": (z.get("sesija") or {}).get("session_id"),
        })
    return out


def sastavi_pregled(dana: int = ZADANO_DANA, koliko_najskupljih: int = ZADANO_NAJSKUPLJIH,
                    koristi_kes: bool = True, projekt: str | None = None) -> dict:
    zapisi, meta = zapisi_u_razdoblju(dana, koristi_kes, projekt)
    sad = datetime.now(timezone.utc)

    po_projektu: dict[str, list[dict]] = defaultdict(list)
    po_agentu: dict[str, list[dict]] = defaultdict(list)
    for z in zapisi:
        zad = z.get("zadatak") or {}
        po_projektu[zad.get("project_id") or BEZ_PROJEKTA].append(z)
        po_agentu[zad.get("agent") or "(bez agenta)"].append(z)

    imena = nazivi_projekata()

    def poredaj(skupine: dict[str, list[dict]], kljuc_ime: str) -> list[dict]:
        redci = []
        for kljuc, grupa in skupine.items():
            a = agregiraj(grupa)
            a[kljuc_ime] = kljuc
            if kljuc_ime == "project_id":
                a["naziv"] = imena.get(kljuc)
            redci.append(a)
        # Najskuplji na vrh; skupine bez troška idu na dno, ali se NE izostavljaju.
        redci.sort(key=lambda a: (a["trosak"]["usd"] or -1, a["zadataka"]), reverse=True)
        return redci

    upozorenja = []
    if meta["bez_session_id"]:
        upozorenja.append(
            f"{meta['bez_session_id']} izvođenja nema `session_id` — za njih nema transkripta, "
            f"pa u latenciju, alate i udio keša NE ulaze (trošak i ishod ulaze).")
    if meta["izgubljen_transkript"]:
        upozorenja.append(
            f"{meta['izgubljen_transkript']} izvođenja ima `session_id`, ali transkript nije "
            f"pronađen ni u ~/.claude/projects ni u arhivu "
            f"(nastalo prije arhiviranja ili na drugoj mašini).")
    if meta.get("iz_arhiva"):
        upozorenja.append(
            f"{meta['iz_arhiva']} izvođenja čitano je iz ARHIVA (.jsonl.gz) jer živog "
            f"transkripta više nema — brojke su jednake, izvor je drugi (T9).")
    bez_troska = sum(1 for z in zapisi if (z.get("trosak") or {}).get("usd") is None)
    if bez_troska:
        upozorenja.append(f"{bez_troska} izvođenja nema `cost_usd` u run_log.jsonl.")
    if projekt and not zapisi:
        upozorenja.append(
            f"Projekt {projekt} nema nijedno izvođenje u zadnjih {dana} dana "
            f"(razdoblje ih ukupno ima {meta['izvodjenja_prije_filtra']}).")

    return {
        "shema": SHEMA_ID,
        "zapisano_ts": at.epoch_to_iso(sad.timestamp()),
        "razdoblje": {
            "dana": dana,
            "od": at.epoch_to_iso((sad - timedelta(days=dana)).timestamp()),
            "do": at.epoch_to_iso(sad.timestamp()),
        },
        "projekt": ({"id": projekt, "naziv": imena.get(projekt)} if projekt else None),
        "izvor": meta,
        "ukupno": agregiraj(zapisi),
        "po_projektu": poredaj(po_projektu, "project_id"),
        "po_agentu": poredaj(po_agentu, "agent"),
        "najskuplji": najskuplji(zapisi, koliko_najskupljih),
        "upozorenja": upozorenja,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Ispis za čovjeka
# ─────────────────────────────────────────────────────────────────────────────

def n(x, jedinica: str = "") -> str:
    if x is None:
        return "—"
    if isinstance(x, float) and not x.is_integer():
        t = f"{x:,.2f}".replace(",", " ").replace(".", ",")
    else:
        t = f"{int(x):,}".replace(",", " ")
    return t + jedinica


def pos(x) -> str:
    return "—" if x is None else f"{x * 100:.1f} %".replace(".", ",")


def trajanje_txt(sek) -> str:
    if sek is None:
        return "—"
    sek = int(sek)
    h, m, s = sek // 3600, (sek % 3600) // 60, sek % 60
    if h:
        return f"{h} h {m} min"
    if m:
        return f"{m} min {s} s"
    return f"{s} s"


def ispisi(p: dict) -> None:
    r, izv = p["razdoblje"], p["izvor"]
    pr = p.get("projekt")
    filtar = f" — PROJEKT {pr['id']}" + (f" ({pr['naziv']})" if pr.get("naziv") else "") if pr else ""
    print(f"\nTJEDNI PREGLED POTROŠNJE{filtar} — zadnjih {r['dana']} dana "
          f"({r['od'][:10]} → {r['do'][:10]})")
    print("─" * 78)
    if pr:
        print(f"filtar: samo projekt {pr['id']} — {izv['izvodjenja_u_razdoblju']} od "
              f"{izv['izvodjenja_prije_filtra']} izvođenja u razdoblju")
    iz_arh = f" (iz arhiva {izv['iz_arhiva']})" if izv.get("iz_arhiva") else ""
    print(f"izvor: {izv['run_log']} · {izv['izvodjenja_u_razdoblju']} izvođenja u razdoblju "
          f"(od {izv['run_log_redaka_ukupno']} ukupno) · s transkriptom "
          f"{izv['s_transkriptom']}{iz_arh} · iz keša {izv['iz_kesa']}, izračunato sada "
          f"{izv['izracunato_sada']}")

    u = p["ukupno"]
    print(f"\nUKUPNO — {u['zadataka']} izvođenja "
          f"({u['razlicitih_zadataka']} različitih zadataka)")
    print(f"  trošak            {n(u['trosak']['usd'])} $   (iz {u['trosak']['iz_zadataka']} "
          f"izvođenja · {n(u['trosak']['usd_po_zadatku'])} $ po izvođenju)")
    print(f"  tokeni            ulaz {n(u['tokeni']['ulaz'])} · izlaz {n(u['tokeni']['izlaz'])} "
          f"· ulazni kontekst {n(u['tokeni']['ulazni_kontekst'])}   "
          f"(iz {u['tokeni']['iz_zadataka']})")
    print(f"  udio keša         {pos(u['tokeni']['udio_kesa'])}   "
          f"(iz {u['tokeni']['iz_zadataka']} izvođenja)")
    lat = u["latencija"]
    print(f"  latencija modela  prosjek {n(lat['prosjek_s'])} s · medijan {n(lat['medijan_s'])} s "
          f"· p95 {n(lat['p95_s'])} s · najveća {n(lat['najveca_s'])} s")
    print(f"                    (iz {lat['iz_zadataka']} izvođenja, "
          f"{n(lat['iz_poziva'])} poziva modela)")
    tj = u["trajanje"]
    print(f"  trajanje          {trajanje_txt(tj['ukupno_s'])} — model {pos(tj['udio_model'])} "
          f"· alati {pos(tj['udio_alat'])}   (iz {tj['iz_zadataka']})")
    al = u["alati"]
    vrh = " · ".join(f"{t['ime']} {n(t['poziva'])}" for t in al["top"]) or "—"
    print(f"  alati             {n(al['poziva'])} poziva, neuspjelih {n(al['neuspjelih'])} "
          f"({pos(al['udio_neuspjelih'])})   (iz {al['iz_zadataka']})")
    print(f"                    {vrh}")
    tr = u["trenje"]
    print(f"  trenje            {tr['zadataka_s_trenjem']} izvođenja s trenjem "
          f"(mjereno na {tr['iz_zadataka']}) · izgubljeno do {trajanje_txt(tr['izgubljeno_s'])}")
    print(f"  ishodi            " + " · ".join(f"{k} {v}" for k, v in u["ishodi"].items()))

    for naslov, kljuc, redci in (("PO PROJEKTU", "project_id", p["po_projektu"]),
                                 ("PO AGENTU", "agent", p["po_agentu"])):
        print(f"\n{naslov}")
        print(f"  {'ključ':<12} {'izvođ.':>6} {'trošak $':>10} {'ulazni kontekst':>16} "
              f"{'keš':>7} {'lat. ⌀':>8} {'poziva':>8}")
        print("  " + "─" * 74)
        for a in redci:
            ime = a[kljuc]
            if kljuc == "project_id" and a.get("naziv"):
                ime = f"{ime}"
            print(f"  {str(ime):<12} {a['zadataka']:>6} "
                  f"{n(a['trosak']['usd']):>10} {n(a['tokeni']['ulazni_kontekst']):>16} "
                  f"{pos(a['tokeni']['udio_kesa']):>7} "
                  f"{n(a['latencija']['prosjek_s']):>8} {n(a['latencija']['poziva_modela']):>8}")
            print(f"  {'':<12} └ trošak iz {a['trosak']['iz_zadataka']} · tokeni iz "
                  f"{a['tokeni']['iz_zadataka']} · latencija iz {a['latencija']['iz_zadataka']}"
                  + (f" · {a['naziv']}" if kljuc == "project_id" and a.get("naziv") else ""))

    print(f"\nNAJSKUPLJIH {len(p['najskuplji'])}")
    for i, z in enumerate(p["najskuplji"], 1):
        print(f"  {i}. {z['task_id']} · {z['agent']} · {z['project_id'] or BEZ_PROJEKTA} · "
              f"{n(z['trosak_usd'])} $ · {trajanje_txt(z['trajanje_s'])} · "
              f"{n(z['poziva_modela'])} poziva · keš {pos(z['udio_kesa'])}")
        if z["naslov"]:
            print(f"     {z['naslov'][:88]}")

    if p["upozorenja"]:
        print("\nUPOZORENJA")
        for w in p["upozorenja"]:
            print(f"  • {w}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dana", type=int, default=ZADANO_DANA,
                    help=f"Veličina prozora u danima (zadano {ZADANO_DANA})")
    ap.add_argument("--najskupljih", type=int, default=ZADANO_NAJSKUPLJIH,
                    help=f"Koliko najskupljih izvođenja (zadano {ZADANO_NAJSKUPLJIH})")
    ap.add_argument("--projekt", default=None,
                    help=f"Samo izvođenja tog projekta (npr. PRJ-060; "
                         f"'{BEZ_PROJEKTA}' za zadatke bez projekta)")
    ap.add_argument("--json", action="store_true", help="JSON na stdout")
    ap.add_argument("--bez-kesa", action="store_true", dest="bez_kesa",
                    help="Preračunaj sve iz transkripata, ne diraj keš")
    args = ap.parse_args()

    if args.dana < 1 or args.dana > DANA_MAX:
        print(f"greška: --dana mora biti između 1 i {DANA_MAX}", file=sys.stderr)
        sys.exit(2)
    if args.najskupljih < 1 or args.najskupljih > 100:
        print("greška: --najskupljih mora biti između 1 i 100", file=sys.stderr)
        sys.exit(2)

    pregled = sastavi_pregled(args.dana, args.najskupljih, koristi_kes=not args.bez_kesa,
                              projekt=args.projekt)
    if args.json:
        print(json.dumps(pregled, ensure_ascii=False))
    else:
        ispisi(pregled)


if __name__ == "__main__":
    main()
