#!/usr/bin/env python3
"""Testovi za tools/tjedni_pregled.py (TASK-3569, kriška T5, mjera 6).

Pokretanje:  python3 -m pytest tools/test_tjedni_pregled.py -q

Testovi ne diraju živi keš niti živi run_log — svaki koji čita s diska dobiva
podmetnute putanje (`monkeypatch`) prema privremenom direktoriju.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_telemetry as at  # noqa: E402
import tjedni_pregled as tp  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Pomoćnici: sitni lažni zapis telemetrije (oblik `agent_telemetry.sastavi_zapis`)
# ─────────────────────────────────────────────────────────────────────────────

def zapis(task_id="TASK-1", project_id="PRJ-060", agent="jelena", usd=1.0,
          latencije=(1.0, 2.0, 3.0), tokeni=None, outcome="completed",
          transkript="/tmp/t.jsonl", alati=None, trenje_ocjena=0, izgubljeno=None):
    poziva = len(latencije)
    tok = tokeni if tokeni is not None else {
        "ulaz": 10, "izlaz": 100, "kes_citanje": 900, "kes_pisanje": 100,
        "ulazni_kontekst": 1010, "misljenje": None,
        "udio_kesa": 900 / 1010, "udio_pisanja": None,
        "ulazni_kontekst_po_pozivu": None, "kes_pisanje_1h": 100,
    }
    return {
        "zadatak": {"task_id": task_id, "project_id": project_id, "agent": agent,
                    "model": "claude-opus-5", "outcome": outcome, "exit_code": 0,
                    "run_log_ts": "2026-09-01T10:00:00Z", "run_log_duration_s": 100.0,
                    "vrsta": "agentski_spawn"},
        "sesija": {"session_id": "sid-" + task_id, "transkript_putanja": transkript,
                   "redaka": 10, "dogadjaja": 5, "prozor_od": None, "prozor_do": None,
                   "cwd": None, "git_grana": None, "ima_sidechain": False},
        "trajanje": {"ukupno_s": 100.0, "model_s": sum(latencije), "alat_s": 10.0,
                     "cekanje_covjeka_s": 0.0, "rezija_s": 0.0, "rezija_pokretanja_s": None,
                     "udio_model": None, "udio_alat": None,
                     "udio_cekanje_covjeka": None, "udio_rezija": None},
        "latencija_modela": {"poziva": poziva, "num_turns": poziva,
                             "prosjek_s": sum(latencije) / poziva if poziva else None,
                             "medijan_s": statistics.median(latencije) if latencije else None,
                             "p95_s": None, "najveca_s": max(latencije) if latencije else None,
                             "zbroj_s": sum(latencije),
                             "ttfb_medijan_s": None, "strujanje_medijan_s": None,
                             "strujanje_zbroj_s": None},
        "alati": alati if alati is not None else {
            "poziva": 4, "rezultata": 4, "neuparenih": 0, "neuspjelih": 1,
            "udio_neuspjelih": 0.25, "serija": 2, "udio_poziva_u_seriji_1": None,
            "histogram": [{"ime": "Bash", "poziva": 3, "neuspjelih": 1},
                          {"ime": "Read", "poziva": 1, "neuspjelih": 0}]},
        "trenje": {"ocjena": trenje_ocjena, "upozorenja": 0, "dogadjaji": [],
                   "izgubljeno_s": izgubljeno, "udio_izgubljenog": None,
                   "pragovi": dict(at.PRAGOVI)},
        "tokeni": tok,
        "trosak": {"usd": usd, "izvor": "cli" if usd is not None else None,
                   "usd_po_pozivu": None},
        "pomirenje": {}, "zastavice": [],
        "_latencije_s": list(latencije),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 1. agent_telemetry: privatni ključ `_latencije_s`
# ─────────────────────────────────────────────────────────────────────────────

def test_izracunaj_iznosi_sirove_latencije(tmp_path):
    """Bez sirovih latencija skupni medijan nije izračunljiv — zato ih tražimo."""
    t = tmp_path / "s.jsonl"
    redci = [
        {"type": "user", "timestamp": "2026-09-01T10:00:00.000Z",
         "message": {"content": "pozdrav"}},
        {"type": "assistant", "timestamp": "2026-09-01T10:00:05.000Z",
         "message": {"id": "m1", "model": "claude-opus-5", "content": [],
                     "usage": {"input_tokens": 1, "output_tokens": 2,
                               "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4}}},
    ]
    t.write_text("\n".join(json.dumps(r) for r in redci), encoding="utf-8")
    m = at.izracunaj(at.procitaj_transkript(t))
    assert m["_latencije_s"] == [5.0]
    assert m["latencija_modela"]["poziva"] == 1


def test_bez_primjera_skida_latencije():
    """`--json` i `--jsonl-out` moraju ostati bajt-za-bajt isti kao prije T5."""
    z = zapis()
    ocisceno = at.bez_primjera(z)
    assert "_latencije_s" not in ocisceno
    assert not any(k.startswith("_") for k in ocisceno)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Agregacija — provjerljivost i točnost
# ─────────────────────────────────────────────────────────────────────────────

def test_zbroj_troska_i_nazivnik():
    a = tp.agregiraj([zapis("TASK-1", usd=1.5), zapis("TASK-2", usd=2.5)])
    assert a["trosak"]["usd"] == 4.0
    assert a["trosak"]["iz_zadataka"] == 2
    assert a["zadataka"] == 2
    assert a["trosak"]["usd_po_zadatku"] == 2.0


def test_nazivnik_je_manji_kad_podatka_nema():
    """Zahtjev TASK-3569: uz svaku agregaciju stoji IZ KOLIKO je zadataka izračunata."""
    a = tp.agregiraj([zapis("TASK-1", usd=3.0), zapis("TASK-2", usd=None)])
    assert a["zadataka"] == 2
    assert a["trosak"]["usd"] == 3.0
    assert a["trosak"]["iz_zadataka"] == 1, "brojka smije doći samo sa svojim nazivnikom"


def test_bez_ijednog_podatka_je_null_a_ne_nula():
    """ADR §9: nedostajuća vrijednost je `null`. Nula bi lagala da smo izmjerili 0 $."""
    a = tp.agregiraj([zapis("TASK-1", usd=None), zapis("TASK-2", usd=None)])
    assert a["trosak"]["usd"] is None
    assert a["trosak"]["iz_zadataka"] == 0


def test_skupni_medijan_nije_medijan_medijana():
    """O1: zadatak s 1 sporim pozivom ne smije težiti kao zadatak sa 100 brzih."""
    a = tp.agregiraj([
        zapis("TASK-1", latencije=[1.0] * 100),
        zapis("TASK-2", latencije=[100.0]),
    ])
    assert a["latencija"]["iz_poziva"] == 101
    assert a["latencija"]["medijan_s"] == 1.0          # skupno
    medijan_medijana = statistics.median([1.0, 100.0])  # pogrešan način
    assert medijan_medijana == 50.5
    assert a["latencija"]["najveca_s"] == 100.0
    assert a["latencija"]["poziva_modela"] == 101


def test_prosjecna_latencija_je_tezinska():
    a = tp.agregiraj([zapis("TASK-1", latencije=[2.0, 4.0]), zapis("TASK-2", latencije=[12.0])])
    # (2+4+12) / 3 poziva = 6,0 s; nevagani prosjek prosjeka bio bi (3+12)/2 = 7,5 s
    assert a["latencija"]["prosjek_s"] == 6.0
    assert a["latencija"]["iz_zadataka"] == 2


def test_udio_kesa_je_omjer_zbrojeva_a_ne_prosjek_udjela():
    veliki = dict(zapis()["tokeni"], kes_citanje=990_000, ulazni_kontekst=1_000_000)
    mali = dict(zapis()["tokeni"], kes_citanje=0, ulazni_kontekst=1_000)
    a = tp.agregiraj([zapis("TASK-1", tokeni=veliki), zapis("TASK-2", tokeni=mali)])
    assert a["tokeni"]["udio_kesa"] == pytest.approx(990_000 / 1_001_000, rel=1e-3)
    assert a["tokeni"]["iz_zadataka"] == 2


def test_razlicitih_zadataka_odvojeno_od_izvodjenja():
    """O2: ponovni spawn istog zadatka je novo IZVOĐENJE, a ne novi zadatak."""
    a = tp.agregiraj([zapis("TASK-1", usd=1.0), zapis("TASK-1", usd=2.0)])
    assert a["zadataka"] == 2
    assert a["razlicitih_zadataka"] == 1
    assert a["trosak"]["usd"] == 3.0


def test_histogram_alata_top_5_i_zbroj():
    veliki = {"poziva": 10, "rezultata": 10, "neuparenih": 0, "neuspjelih": 2,
              "udio_neuspjelih": 0.2, "serija": 1, "udio_poziva_u_seriji_1": None,
              "histogram": [{"ime": n, "poziva": i + 1, "neuspjelih": 0}
                            for i, n in enumerate(["A", "B", "C", "D", "E", "F"])]}
    a = tp.agregiraj([zapis("TASK-1", alati=veliki)])
    assert len(a["alati"]["top"]) == tp.TOP_ALATA
    assert [t["ime"] for t in a["alati"]["top"]] == ["F", "E", "D", "C", "B"]
    assert a["alati"]["poziva"] == 10


def test_trenje_broji_samo_izmjerene():
    bez = zapis("TASK-2")
    bez["trenje"] = None                      # nema transkripta → mjera 4 nije mjerljiva
    a = tp.agregiraj([zapis("TASK-1", trenje_ocjena=2, izgubljeno=30.0), bez])
    assert a["trenje"]["zadataka_s_trenjem"] == 1
    assert a["trenje"]["iz_zadataka"] == 1
    assert a["trenje"]["izgubljeno_s"] == 30.0


def test_ishodi_se_prebrojavaju():
    a = tp.agregiraj([zapis("TASK-1", outcome="completed"),
                      zapis("TASK-2", outcome="failed"),
                      zapis("TASK-3", outcome="completed")])
    assert a["ishodi"] == {"completed": 2, "failed": 1}


# ─────────────────────────────────────────────────────────────────────────────
# 3. Najskuplji
# ─────────────────────────────────────────────────────────────────────────────

def test_najskupljih_je_poredak_po_trosku(monkeypatch):
    monkeypatch.setattr(tp, "naslovi_zadataka", lambda ids: {})
    z = [zapis(f"TASK-{i}", usd=float(i)) for i in range(1, 8)]
    top = tp.najskuplji(z, 5)
    assert [t["task_id"] for t in top] == ["TASK-7", "TASK-6", "TASK-5", "TASK-4", "TASK-3"]
    assert top[0]["trosak_usd"] == 7.0


def test_najskupljih_preskace_izvodjenja_bez_troska(monkeypatch):
    monkeypatch.setattr(tp, "naslovi_zadataka", lambda ids: {})
    top = tp.najskuplji([zapis("TASK-1", usd=None), zapis("TASK-2", usd=1.0)], 5)
    assert [t["task_id"] for t in top] == ["TASK-2"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Keš (O3)
# ─────────────────────────────────────────────────────────────────────────────

def test_otisak_se_mijenja_kad_transkript_naraste(tmp_path):
    t = tmp_path / "s.jsonl"
    t.write_text("a\n", encoding="utf-8")
    run = {"task_id": "TASK-1", "ts": "2026-09-01T10:00:00Z", "session_id": "sid"}
    prvi = tp.otisak(run, t)
    t.write_text("a\nb\nc\n", encoding="utf-8")
    assert tp.otisak(run, t) != prvi, "narastao transkript mora poništiti zapis u kešu"


def test_otisak_bez_transkripta_je_stabilan():
    run = {"task_id": "TASK-1", "ts": "2026-09-01T10:00:00Z", "session_id": None}
    assert tp.otisak(run, None) == tp.otisak(run, None)
    assert "bez-transkripta" in tp.otisak(run, None)


def test_kes_pisanje_i_citanje(tmp_path):
    put = tmp_path / "kes.jsonl"
    kes = {"k1": {"_otisak": "k1", "a": 1}, "k2": {"_otisak": "k2", "a": 2}}
    assert tp.spremi_kes(kes, put) is True
    assert tp.ucitaj_kes(put) == kes


def test_kes_preskace_pokvaren_redak(tmp_path):
    put = tmp_path / "kes.jsonl"
    put.write_text('{"_otisak":"ok","a":1}\nOVO NIJE JSON\n\n', encoding="utf-8")
    assert tp.ucitaj_kes(put) == {"ok": {"_otisak": "ok", "a": 1}}


def test_kes_ne_raste_preko_granice(tmp_path, monkeypatch):
    monkeypatch.setattr(tp, "KES_MAX", 3)
    put = tmp_path / "kes.jsonl"
    tp.spremi_kes({f"k{i}": {"_otisak": f"k{i}"} for i in range(10)}, put)
    assert len(tp.ucitaj_kes(put)) == 3


def test_kes_nepostojeceg_puta_je_prazan(tmp_path):
    assert tp.ucitaj_kes(tmp_path / "nema.jsonl") == {}


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cjelina — sastavi_pregled nad podmetnutim run_logom
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def lazni_run_log(tmp_path, monkeypatch):
    redci = [
        {"ts": "2026-08-30T10:00:00.000Z", "task_id": "TASK-A", "agent": "jelena",
         "model": "claude-opus-5", "exit_code": 0, "outcome": "completed", "duration_s": 100,
         "tokens": {"in": 1, "out": 2, "cache_r": 3, "cache_w": 4}, "cost_usd": 5.0,
         "cost_source": "cli", "session_id": None, "num_turns": 3, "source": "regoc-spawn"},
        {"ts": "2026-08-30T11:00:00.000Z", "task_id": "TASK-B", "agent": "malik",
         "model": "claude-opus-5", "exit_code": 0, "outcome": "failed", "duration_s": 50,
         "tokens": {"in": 1, "out": 2, "cache_r": 3, "cache_w": 4}, "cost_usd": 1.0,
         "cost_source": "cli", "session_id": None, "num_turns": 1, "source": "regoc-spawn"},
        {"ts": "2020-01-01T00:00:00.000Z", "task_id": "TASK-STARI", "agent": "dora",
         "outcome": "completed", "cost_usd": 999.0, "session_id": None},
    ]
    put = tmp_path / "run_log.jsonl"
    put.write_text("\n".join(json.dumps(r) for r in redci), encoding="utf-8")
    monkeypatch.setattr(at, "RUN_LOG", put)
    monkeypatch.setattr(at, "REGOC_DB", tmp_path / "nema.db")   # bez baze → project_id je None
    monkeypatch.setattr(tp, "KES_PUT", tmp_path / "kes.jsonl")
    # Uzak prozor: „danas" je fiksiran testom preko velikog --dana, pa umjesto toga
    # provjeravamo da stari redak (2020.) ispada.
    return put


def test_pregled_reze_razdoblje(lazni_run_log):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    assert p["ukupno"]["zadataka"] == 3          # 100 000 dana obuhvaća i onaj iz 2020.
    p7 = tp.sastavi_pregled(dana=7, koliko_najskupljih=5, koristi_kes=False)
    assert all(z["task_id"] != "TASK-STARI" for z in p7["najskuplji"])


def test_pregled_grupira_po_agentu(lazni_run_log):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    po_agentu = {a["agent"]: a for a in p["po_agentu"]}
    assert set(po_agentu) == {"jelena", "malik", "dora"}
    assert po_agentu["jelena"]["trosak"]["usd"] == 5.0
    assert po_agentu["jelena"]["trosak"]["iz_zadataka"] == 1


def test_pregled_zbroj_grupa_jednak_ukupnom(lazni_run_log):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    assert sum(a["zadataka"] for a in p["po_projektu"]) == p["ukupno"]["zadataka"]
    assert sum(a["zadataka"] for a in p["po_agentu"]) == p["ukupno"]["zadataka"]
    assert (sum(a["trosak"]["usd"] or 0 for a in p["po_agentu"])
            == pytest.approx(p["ukupno"]["trosak"]["usd"]))


def test_pregled_upozorava_na_izvodjenja_bez_sesije(lazni_run_log):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    assert p["izvor"]["bez_session_id"] == 3
    assert any("session_id" in w for w in p["upozorenja"])
    # bez transkripta nema latencije — ali nazivnik to kaže, a ne izmišljena nula
    assert p["ukupno"]["latencija"]["iz_zadataka"] == 0
    assert p["ukupno"]["latencija"]["medijan_s"] is None


def test_pregled_bez_projekta_ima_svoju_skupinu(lazni_run_log):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    assert [a["project_id"] for a in p["po_projektu"]] == [tp.BEZ_PROJEKTA]


def test_pregled_je_ispravan_json(lazni_run_log):
    p = tp.sastavi_pregled(dana=7, koliko_najskupljih=5, koristi_kes=False)
    assert json.loads(json.dumps(p, ensure_ascii=False))["shema"] == tp.SHEMA_ID


# ─────────────────────────────────────────────────────────────────────────────
# 6. Ispis za čovjeka ne smije pući
# ─────────────────────────────────────────────────────────────────────────────

def test_ispis_prezivljava_prazan_pregled(lazni_run_log, capsys):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    tp.ispisi(p)
    izlaz = capsys.readouterr().out
    assert "TJEDNI PREGLED POTROŠNJE" in izlaz
    assert "PO PROJEKTU" in izlaz and "PO AGENTU" in izlaz


def test_formatiranje_brojeva():
    assert tp.n(None) == "—"
    assert tp.n(1234567) == "1 234 567"
    assert tp.pos(None) == "—"
    assert tp.pos(0.985) == "98,5 %"
    assert tp.trajanje_txt(None) == "—"
    assert tp.trajanje_txt(45) == "45 s"
    assert tp.trajanje_txt(3661) == "1 h 1 min"


# ─────────────────────────────────────────────────────────────────────────────
# 7. Filtar po projektu (TASK-3572) — „Potrošnja projekta" na ploči
#
# Filtar mora rezati IZVOĐENJA prije izračuna, zadržati nazivnik prije reza i
# ne smije pretvoriti prazan rezultat u pad ni u izmišljenu nulu.
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def baza_s_projektima(tmp_path, monkeypatch):
    """Mala regoc.db: TASK-A → PRJ-1, TASK-B bez projekta, TASK-STARI → PRJ-2."""
    import sqlite3
    put = tmp_path / "regoc.db"
    con = sqlite3.connect(put)
    con.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, project_id TEXT)")
    con.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)")
    con.executemany("INSERT INTO tasks VALUES (?,?,?)", [
        ("TASK-A", "Prvi", "PRJ-1"),
        ("TASK-B", "Drugi", None),
        ("TASK-STARI", "Stari", "PRJ-2"),
    ])
    con.executemany("INSERT INTO projects VALUES (?,?)", [
        ("PRJ-1", "Telemetrija"), ("PRJ-2", "Nesto staro"),
    ])
    con.commit()
    con.close()
    monkeypatch.setattr(at, "REGOC_DB", put)
    return put


def test_projekti_zadataka_bez_baze_je_prazna_mapa(tmp_path, monkeypatch):
    monkeypatch.setattr(at, "REGOC_DB", tmp_path / "nema.db")
    assert tp.projekti_zadataka(["TASK-A"]) == {}


def test_projekti_zadataka_cita_skupno(lazni_run_log, baza_s_projektima):
    mapa = tp.projekti_zadataka(["TASK-A", "TASK-B", "TASK-NEMA-GA", None])
    # zadatak bez projekta i nepoznat zadatak NE ulaze u mapu
    assert mapa == {"TASK-A": "PRJ-1"}


def test_filtar_projekta_reze_izvodjenja(lazni_run_log, baza_s_projektima):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False,
                           projekt="PRJ-1")
    assert p["ukupno"]["zadataka"] == 1
    assert [a["project_id"] for a in p["po_projektu"]] == ["PRJ-1"]
    assert [a["agent"] for a in p["po_agentu"]] == ["jelena"]
    assert p["ukupno"]["trosak"]["usd"] == 5.0
    assert p["projekt"] == {"id": "PRJ-1", "naziv": "Telemetrija"}


def test_filtar_cuva_nazivnik_prije_reza(lazni_run_log, baza_s_projektima):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False,
                           projekt="PRJ-1")
    assert p["izvor"]["izvodjenja_u_razdoblju"] == 1
    assert p["izvor"]["izvodjenja_prije_filtra"] == 3
    assert p["izvor"]["projekt"] == "PRJ-1"


def test_bez_filtra_polje_projekt_je_null(lazni_run_log, baza_s_projektima):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    assert p["projekt"] is None
    assert p["izvor"]["projekt"] is None
    assert p["izvor"]["izvodjenja_prije_filtra"] == p["izvor"]["izvodjenja_u_razdoblju"] == 3


def test_filtar_bez_projekta_hvata_zadatke_bez_projekta(lazni_run_log, baza_s_projektima):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False,
                           projekt=tp.BEZ_PROJEKTA)
    assert p["ukupno"]["zadataka"] == 1
    assert [z["task_id"] for z in p["najskuplji"]] == ["TASK-B"]


def test_filtar_praznog_projekta_nije_pad_nego_upozorenje(lazni_run_log, baza_s_projektima):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False,
                           projekt="PRJ-NEMA")
    assert p["ukupno"]["zadataka"] == 0
    assert p["ukupno"]["trosak"]["usd"] is None          # nedostajuće je null, ne 0
    assert p["po_projektu"] == [] and p["najskuplji"] == []
    assert any("PRJ-NEMA" in w for w in p["upozorenja"])
    json.dumps(p, ensure_ascii=False)                     # i dalje ispravan JSON


def test_ispis_filtriranog_pregleda_navodi_projekt(lazni_run_log, baza_s_projektima, capsys):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False,
                           projekt="PRJ-1")
    tp.ispisi(p)
    izlaz = capsys.readouterr().out
    assert "PROJEKT PRJ-1" in izlaz
    assert "1 od 3 izvođenja" in izlaz


# ─────────────────────────────────────────────────────────────────────────────
# T9 (TASK-3574): izvođenje čiji je živi transkript obrisan čita se iz ARHIVA
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def arhivirano_izvodjenje(tmp_path, monkeypatch):
    """Transkript postoji SAMO u arhivu — točno stanje zadatka starijeg od 30 dana."""
    import transkript_arhiv as A

    projects = tmp_path / "projects" / "-home-klaudio"
    projects.mkdir(parents=True)
    ziv = projects / "sid-stari.jsonl"
    redci = [
        {"type": "user", "timestamp": "2026-07-28T23:37:09.000Z",
         "message": {"content": "kreni"}},
        {"type": "assistant", "timestamp": "2026-07-28T23:37:12.000Z",
         "message": {"id": "m1", "model": "claude-opus-5", "content": [],
                     "usage": {"input_tokens": 11, "output_tokens": 22}}},
    ]
    ziv.write_text("".join(json.dumps(r) + "\n" for r in redci), encoding="utf-8")

    arhiv, indeks = tmp_path / "arhiv", tmp_path / "arhiv" / "index.jsonl"
    izvj = A.arhiviraj(tmp_path / "projects", arhiv, indeks, min_slobodno_mb=0)
    assert izvj["novo"] == 1
    ziv.unlink()                                   # Claude Code počistio nakon ~30 dana

    run_log = tmp_path / "run_log.jsonl"
    run_log.write_text(json.dumps({
        "ts": "2026-07-28T23:37:09.731Z", "task_id": "TASK-3013", "agent": "jelena",
        "model": "claude-opus-5", "exit_code": 0, "outcome": "blocked", "duration_s": 618,
        "tokens": {"in": 11, "out": 22, "cache_r": 0, "cache_w": 0}, "cost_usd": 0.5,
        "cost_source": "cli", "session_id": "sid-stari", "num_turns": 1,
        "source": "regoc-spawn"}) + "\n", encoding="utf-8")

    monkeypatch.setattr(at, "RUN_LOG", run_log)
    monkeypatch.setattr(at, "REGOC_DB", tmp_path / "nema.db")
    monkeypatch.setattr(at, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(A, "INDEX_PUT", indeks)
    monkeypatch.setattr(tp, "KES_PUT", tmp_path / "kes.jsonl")
    return run_log


def test_pregled_cita_iz_arhiva_kad_zivog_transkripta_nema(arhivirano_izvodjenje):
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    izv = p["izvor"]
    assert izv["izgubljen_transkript"] == 0, "arhiv nije pogledan — nalaz C nije riješen"
    assert izv["s_transkriptom"] == 1 and izv["iz_arhiva"] == 1
    # mjere se stvarno izračunaju, ne ostaju null
    assert p["ukupno"]["tokeni"]["izlaz"] == 22
    assert any("ARHIVA" in u for u in p["upozorenja"])


def test_ispis_navodi_da_je_izvor_arhiv(arhivirano_izvodjenje, capsys):
    tp.ispisi(tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False))
    assert "iz arhiva 1" in capsys.readouterr().out


# ── M3/TASK-4625: tri stupca ishoda ─────────────────────────────────────────
# SSOT taksonomije je ~/.claude/regoc/RunOutcome.ts; python ga ne može uvesti, pa ovaj
# test brani da se dvije kopije ne raziđu. Istovjetna tvrdnja u TypeScriptu:
# ~/.claude/regoc/tests/run-outcome.test.ts → "outcomeColumn — četiri ishoda u tri stupca".

def test_stupac_ishoda_preslikava_cetiri_ishoda_u_tri_stupca():
    assert tp.stupac_ishoda("completed") == "completed"
    assert tp.stupac_ishoda("blocked_ok") == "blocked_ok"
    # tehnički zastoj (spawn/rezultat odbijen) i pad procesa dijele stupac — oba se
    # POPRAVLJAJU, za razliku od urednog zastoja
    assert tp.stupac_ishoda("blocked") == "failed"
    assert tp.stupac_ishoda("failed") == "failed"


def test_nepoznat_ishod_pada_u_failed_nikad_u_completed():
    for v in (None, "", "   ", "nesto-novo"):
        assert tp.stupac_ishoda(v) == "failed"


def test_stupci_ishoda_uvijek_daju_sva_tri_kljuca():
    assert tp.stupci_ishoda([]) == {"completed": 0, "blocked_ok": 0, "failed": 0}
    zapisi = [{"zadatak": {"outcome": o}} for o in
              ("completed", "completed", "blocked_ok", "blocked", "failed", None)]
    assert tp.stupci_ishoda(zapisi) == {"completed": 2, "blocked_ok": 1, "failed": 3}
    assert sum(tp.stupci_ishoda(zapisi).values()) == len(zapisi)


def test_sazetak_objavljuje_i_stupce_i_punu_racclambu(arhivirano_izvodjenje):
    """Zbroj stupaca mora biti jednak zbroju sirove raščlambe — inače brojka ne stoji."""
    p = tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False)
    u = p["ukupno"]
    assert set(u["ishodi_stupci"]) == {"completed", "blocked_ok", "failed"}
    assert sum(u["ishodi_stupci"].values()) == sum(u["ishodi"].values()) == u["zadataka"]
    # fixture ima jedno izvođenje s outcome="blocked" → tehnički zastoj, ne uredan
    assert u["ishodi_stupci"] == {"completed": 0, "blocked_ok": 0, "failed": 1}


def test_ispis_pokazuje_tri_stupca(arhivirano_izvodjenje, capsys):
    tp.ispisi(tp.sastavi_pregled(dana=100_000, koliko_najskupljih=5, koristi_kes=False))
    izlaz = capsys.readouterr().out
    assert "completed 0" in izlaz and "blocked_ok 0" in izlaz and "failed 1" in izlaz
    assert "raščlamba:" in izlaz


def test_otisak_kesa_ukljucuje_ishod_pa_preracun_nije_nevidljiv():
    """M3/TASK-4625: ispravak `outcome` MORA poništiti keširani zapis.

    Bez ovoga je preračun 14 redaka u `blocked_ok` (04.09.2026.) ostao nevidljiv:
    pregled je čitao 968 izvođenja iz keša i dalje javljao „blocked_ok 0".
    """
    prije = {"task_id": "TASK-1", "ts": "2026-08-01T10:00:00.000Z",
             "session_id": "sid", "outcome": "blocked"}
    poslije = dict(prije, outcome="blocked_ok")
    assert tp.otisak(prije, None) != tp.otisak(poslije, None)
