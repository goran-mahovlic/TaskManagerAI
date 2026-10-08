"""Testovi naredbe `glas` (TASK-5340): tekst/md → mp3 hr_regoc glasom, jednom naredbom.

Govor generira SKRIPTA (normalizacija + Piper), ne model riječ po riječ. Testovi bez modela
provjeravaju pripremu teksta i ugovor naredbe; sinteza se preskače ako modela nema.
Pokretanje: <venv>/bin/python -m pytest tools/glas/tests -q
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, D)

from glas import md_u_govor  # noqa: E402

SKRIPTA = os.path.join(D, "glas.py")
OMOTAC = os.path.join(os.path.dirname(os.path.dirname(D)), "scripts", "glas")
MODEL = os.path.expanduser(os.environ.get("TM_GLAS_MODEL", "~/.local/share/piper-voices/hr_regoc.onnx"))
treba_model = pytest.mark.skipif(not os.path.exists(MODEL) or not shutil.which("ffmpeg"),
                                 reason="nema hr_regoc.onnx ili ffmpeg")


def pokreni(*args, ulaz=None):
    return subprocess.run([sys.executable, SKRIPTA, *args], input=ulaz, capture_output=True,
                          text=True, timeout=300)


# ── priprema markdowna ────────────────────────────────────────────────────────

def test_naslovi_i_naglasci_ostaju_samo_tekst():
    assert md_u_govor("## Stanje čvora\n**Sve** radi _uredno_") == "Stanje čvora.\n\nSve radi uredno."


def test_stavke_popisa_postaju_recenice():
    assert md_u_govor("- prvo\n* drugo\n1. treće") == "prvo.\ndrugo.\ntreće."


def test_blok_koda_se_ne_cita_a_ugradeni_kod_ostaje_rijec():
    t = md_u_govor("Pokreni `glas` ovako:\n```bash\nglas a.md -o /x.mp3\n```\nKraj")
    assert "-o" not in t and "```" not in t
    assert t == "Pokreni glas ovako.\n\nKraj."


def test_poveznica_cita_samo_naziv():
    assert md_u_govor("Vidi [ploču](http://127.0.0.1:17781/x).") == "Vidi ploču."


def test_tablica_cita_redove_bez_razdjelnika():
    t = md_u_govor("| Zadatak | Stanje |\n|---|:---:|\n| TASK-12 | gotov |")
    assert t == "Zadatak, Stanje.\nTASK-12, gotov."


def test_emoji_i_crte_se_ne_izgovaraju():
    assert md_u_govor("✅ Gotovo 🔊\n\n---\n\nDalje") == "Gotovo.\n\nDalje."


def test_odlomci_ostaju_odvojeni_za_dulju_tisinu():
    assert md_u_govor("Prvi red\nnastavak\n\nDrugi odlomak.") == "Prvi red nastavak.\n\nDrugi odlomak."


# ── ugovor naredbe ────────────────────────────────────────────────────────────

def test_izlaz_mora_biti_apsolutna_putanja(tmp_path):
    ulaz = tmp_path / "a.md"
    ulaz.write_text("Dobar dan.")
    r = pokreni(str(ulaz), "-o", "relativno.mp3")
    assert r.returncode == 2 and "apsolutn" in r.stderr


def test_izlaz_mora_biti_mp3_ili_wav(tmp_path):
    ulaz = tmp_path / "a.md"
    ulaz.write_text("Dobar dan.")
    r = pokreni(str(ulaz), "-o", str(tmp_path / "a.txt"))
    assert r.returncode == 2 and ".mp3" in r.stderr


def test_nepostojeci_ulaz_je_jasna_greska(tmp_path):
    r = pokreni(str(tmp_path / "nema.md"), "-o", str(tmp_path / "a.mp3"))
    assert r.returncode == 2 and "ne postoji" in r.stderr


def test_bez_modela_javlja_kako_ga_instalirati(tmp_path):
    ulaz = tmp_path / "a.md"
    ulaz.write_text("Dobar dan.")
    r = pokreni(str(ulaz), "-o", str(tmp_path / "a.mp3"), "--model", str(tmp_path / "nema.onnx"))
    assert r.returncode == 3 and "instaliraj-glas.sh" in r.stderr


def test_suho_ispisuje_ono_sto_bi_se_izgovorilo(tmp_path):
    r = pokreni("-", "-o", str(tmp_path / "a.mp3"), "--suho", ulaz="# Izvještaj\n- TASK-7 gotov 15.10.")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["odlomci"] == [["Izvještaj."], ["zadatak sedam gotov petnaesti listopada."]]
    assert not (tmp_path / "a.mp3").exists()


def test_omotac_postoji_i_izvrsiv():
    assert os.access(OMOTAC, os.X_OK)


@treba_model
def test_md_u_mp3_jednom_naredbom(tmp_path):
    ulaz = tmp_path / "izvjestaj.md"
    ulaz.write_text("# Izvještaj\n\n- Ploča radi.\n- Dva zadatka su gotova.\n")
    izlaz = tmp_path / "izvjestaj.mp3"
    r = pokreni(str(ulaz), "-o", str(izlaz))
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["izlaz"] == str(izlaz) and izlaz.stat().st_size > 1000
    assert out["send_doc"] == f"[[SEND_DOC: {izlaz} | Audio izvještaj]]"
    assert out["length_scale"] == 0.9 and out["noise_scale"] == 0.6 and out["noise_w"] == 0.7
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration",
                        "-of", "json", str(izlaz)], capture_output=True, text=True)
    info = json.loads(p.stdout)
    assert info["streams"][0]["codec_name"] == "mp3"
    assert float(info["format"]["duration"]) > 1.5
    assert not list(tmp_path.glob("*.wav")), "privremeni WAV ostao"
