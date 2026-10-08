"""Testovi naredbe `pdf` (TASK-5369): markdown/tekst → PDF s ugrađenim DejaVu fontom, uz
provjeru dijakritika izvađenim tekstom (pdftotext, inače pypdf).

Uzrok (TASK-5360): PDF iz vlastite reportlab skripte s Helveticom (WinAnsi, neugrađen) dao je
„■vor" umjesto „čvor". Ovdje se font ugrađuje, a naredba ne javlja uspjeh dok izvađeni tekst
ne sadrži svako hrvatsko slovo iz izvora.
Pokretanje: python3 -m pytest tools/pdf/tests -q
"""
import json
import os
import subprocess
import sys

import pytest

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, D)

import pdf  # noqa: E402

SKRIPTA = os.path.join(D, "pdf.py")
OMOTAC = os.path.join(os.path.dirname(os.path.dirname(D)), "scripts", "pdf")
HR = "Čvor čvor Ćup ćup Žaba žaba Šuma šuma Đak đak"


def pokreni(*args, ulaz=None, env=None):
    return subprocess.run([sys.executable, SKRIPTA, *args], input=ulaz, capture_output=True,
                          text=True, timeout=120, env={**os.environ, **(env or {})})


# ── provjera dijakritika (čista funkcija) ─────────────────────────────────────

def test_dijakritike_izvora_su_skup_slova():
    assert pdf.dijakritike("čvor i Đak, čvor") == "čĐ"


def test_provjera_prolazi_kad_su_sva_slova_izvucena():
    p = pdf.provjeri_tekst(HR, "Izvještaj — " + HR)
    assert p["ok"] and p["nedostaje"] == "" and p["zamjenski"] == 0


def test_provjera_pada_na_slucaj_iz_task_5360():
    p = pdf.provjeri_tekst("Izvještaj o nedavnom radu — čvor node-A", "Izvještaj o nedavnom radu — ■vor node-A")
    assert not p["ok"] and "č" in p["nedostaje"] and p["zamjenski"] == 1


def test_provjera_pada_na_zamjenski_znak_i_bez_dijakritika():
    assert not pdf.provjeri_tekst("abc", "a�c")["ok"]


# ── markdown u elemente ───────────────────────────────────────────────────────

def test_inline_oznake_postaju_reportlab_oznake_i_escapeaju_html():
    assert pdf.inline("**čvor** i *žaba* `x<y` & [ploča](http://a)") == \
        "<b>čvor</b> i <i>žaba</i> <font face=\"TMMono\">x&lt;y</font> &amp; ploča"


def test_blokovi_markdowna():
    b = pdf.blokovi("# Naslov\n\nPrvi red\nnastavak\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nkod  x\n```\n")
    vrste = [x[0] for x in b]
    assert vrste == ["naslov", "odlomak", "stavka", "stavka", "tablica", "kod"]
    assert b[0][1:] == (1, "Naslov") and b[1][1] == "Prvi red nastavak"
    assert b[4][1] == [["A", "B"], ["1", "2"]] and b[5][1] == "kod  x"


# ── ugovor naredbe ────────────────────────────────────────────────────────────

def test_izlaz_mora_biti_apsolutna_putanja_pdf(tmp_path):
    (tmp_path / "a.md").write_text("Dobar dan.")
    r = pokreni(str(tmp_path / "a.md"), "-o", "rel.pdf")
    assert r.returncode == 2 and "apsolutn" in r.stderr
    r = pokreni(str(tmp_path / "a.md"), "-o", str(tmp_path / "a.txt"))
    assert r.returncode == 2 and ".pdf" in r.stderr


def test_nepostojeci_ulaz(tmp_path):
    r = pokreni(str(tmp_path / "nema.md"), "-o", str(tmp_path / "a.pdf"))
    assert r.returncode == 2 and "ne postoji" in r.stderr


def test_bez_fonta_javlja_kako_ga_instalirati(tmp_path):
    r = pokreni("-", "-o", str(tmp_path / "a.pdf"), ulaz="čvor",
                env={"TM_PDF_FONT_DIR": str(tmp_path / "nema"), "TM_PDF_SAMO_FONT_DIR": "1"})
    assert r.returncode == 3 and "instaliraj-pdf.sh" in r.stderr
    assert not (tmp_path / "a.pdf").exists()


def test_omotac_postoji_i_izvrsiv():
    assert os.access(OMOTAC, os.X_OK)


def test_md_u_pdf_s_hrvatskim_slovima(tmp_path):
    ulaz = tmp_path / "izvjestaj.md"
    ulaz.write_text("# Izvještaj o nedavnom radu — čvor node-A\n\n"
                    f"**{HR}**\n\n- stavka đ\n- *Šaban*\n\n| Zadatak | Stanje |\n|---|---|\n| TASK-1 | završen |\n\n"
                    "```\nčvor = 1\n```\n")
    izlaz = tmp_path / "izvjestaj.pdf"
    r = pokreni(str(ulaz), "-o", str(izlaz), "--naslov", "Izvještaj")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["izlaz"] == str(izlaz) and izlaz.stat().st_size > 1000
    assert out["dijakritike"]["ok"] is True and out["dijakritike"]["nedostaje"] == ""
    assert set("čćžšđČĆŽŠĐ") <= set(out["dijakritike"]["ocekivano"])
    assert out["fontovi_ugradeni"] is True
    assert out["send_doc"] == f"[[SEND_DOC: {izlaz} | Izvještaj]]"
    tekst = pdf.izvuci_tekst(str(izlaz))[0]
    assert "čvor" in tekst and "■" not in tekst and "Đak" in tekst


def test_neuspjela_provjera_brise_pdf_i_vraca_5(tmp_path, monkeypatch):
    izlaz = tmp_path / "a.pdf"
    monkeypatch.setattr(pdf, "izvuci_tekst", lambda p: ("■vor", "lažni"))
    kod = pdf.main(["-", "-o", str(izlaz)], stdin_tekst="čvor")
    assert kod == 5 and not izlaz.exists()


def test_regresija_helvetica_kao_make_pdf_pada_provjeru(tmp_path):
    """Točno PDF iz TASK-5360: reportlab platno, Helvetica, bez ugrađenog fonta → „■vor"."""
    from reportlab.pdfgen import canvas
    put = str(tmp_path / "helvetica.pdf")
    izvor = "Izvještaj o nedavnom radu — čvor node-A"
    c = canvas.Canvas(put)
    c.setFont("Helvetica", 12)
    c.drawString(50, 800, izvor)
    c.save()
    tekst, _ = pdf.izvuci_tekst(put)
    p = pdf.provjeri_tekst(izvor, tekst)
    assert not p["ok"] and "č" in p["nedostaje"]
    assert pdf.fontovi_ugradeni(put) is False
