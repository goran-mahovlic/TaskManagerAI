"""Testovi sintetizatora zadanog muškog glasa (K2 ep5306 kao hr_regoc).

Pravi model: ~/.local/share/piper-voices/hr_regoc.onnx — test se preskače ako ga nema.
"""
import json
import os
import subprocess
import sys
import wave

import pytest

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKRIPTA = os.path.join(D, "regoc_piper_synth.py")
PY = sys.executable
MODEL = os.path.expanduser(os.environ.get("TM_GLAS_MODEL", "~/.local/share/piper-voices/hr_regoc.onnx"))
treba_model = pytest.mark.skipif(not os.path.exists(MODEL), reason="nema hr_regoc.onnx")


def pokreni(tekst, *args):
    r = subprocess.run([PY, SKRIPTA, *args], input=tekst, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_suho_pokretanje_normalizira_i_dijeli_bez_modela():
    out = pokreni("Rok je 15.10. za 8 kartica. Hvala!\n\nNovi odlomak", "--dry-run", "--model", "/nema.onnx")
    assert out["odlomci"] == [["Rok je petnaesti listopada za osam kartica.", "Hvala!"], ["Novi odlomak."]]
    assert out["normalizacija"] is True and out["fonemi"] is True  # zadano UKLJUČENO


def test_prekidac_normalizacije():
    out = pokreni("Imamo 8 kartica.", "--dry-run", "--no-normalize", "--model", "/nema.onnx")
    assert out["odlomci"] == [["Imamo 8 kartica."]]
    assert out["normalizacija"] is False


def _tisine(putanja, prag_s):
    """Broj nizova digitalne tišine (točno nula) duljih od prag_s."""
    with wave.open(putanja) as w:
        sr = w.getframerate()
        okviri = w.readframes(w.getnframes())
    uzorci = memoryview(okviri).cast("h")
    nizovi, duljina = 0, 0
    for u in uzorci:
        if u == 0:
            duljina += 1
        else:
            if duljina >= prag_s * sr:
                nizovi += 1
            duljina = 0
    if duljina >= prag_s * sr:
        nizovi += 1
    return nizovi, sr


@treba_model
def test_sinteza_po_recenicama_s_digitalnom_tisinom(tmp_path):
    wav = str(tmp_path / "o.wav")
    out = pokreni("Prva rečenica. Druga rečenica.\n\nTreća u odlomku.", "--model", MODEL, "--out", wav)
    assert out["recenica"] == 3
    assert out["length_scale"] == 0.9 and out["noise_scale"] == 0.6 and out["noise_w"] == 0.7
    # 0,35 s iza 1. rečenice, 0,8 s iza odlomka i iza zadnje rečenice
    dugih, sr = _tisine(wav, 0.79)
    kratkih, _ = _tisine(wav, 0.34)
    assert dugih >= 2
    assert kratkih >= 3
    assert sr == 22050
    assert out["trajanje_s"] > 2.0


@treba_model
def test_fonemska_priprema_mijenja_foneme(tmp_path):
    s = pokreni("Deborah vodi aplikacije.", "--model", MODEL, "--out", str(tmp_path / "b.wav"), "--fonemi-u-izlaz")
    bez = pokreni("Deborah vodi aplikacije.", "--model", MODEL, "--out", str(tmp_path / "a.wav"),
                  "--no-phonemes", "--fonemi-u-izlaz")
    assert s["fonemi"] is True and bez["fonemi"] is False
    assert s["ipa"] != bez["ipa"]
    assert "aplɪkˈætsɪje" in s["ipa"][0]
