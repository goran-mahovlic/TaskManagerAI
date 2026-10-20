#!/usr/bin/env python3
"""pdf — markdown ili tekst u PDF s hrvatskim slovima, jednom naredbom, uz provjeru dijakritika.

    pdf izvjestaj.md -o /apsolutna/putanja/izvjestaj.pdf
    echo "Stanje čvora: sve radi." | pdf - -o /apsolutna/putanja/stanje.pdf

Zašto (TASK-5360): PDF iz vlastite reportlab skripte s Helveticom (WinAnsi, font nije ugrađen)
dao je u grupi „■vor" umjesto „čvor". Ovdje se DejaVu Sans UVIJEK ugrađuje, a nakon izrade se
tekst izvadi iz PDF-a (pdftotext, inače pypdf) i usporedi s izvorom: ako ijedno hrvatsko slovo
iz izvora fali ili se pojavi zamjenski znak (■, �), PDF se briše i naredba vraća 5 — pokvaren
dokument ne može otići u grupu. Bez preglednika (Chromium nije potreban).

Izlaz: JSON na stdout (`izlaz`, `stranica`, `dijakritike`, `fontovi_ugradeni`, `send_doc`).
Izlazni kodovi: 0 uspjeh, 2 krivi argumenti/ulaz, 3 nema fonta/knjižnice/alata za provjeru,
4 kvar izrade, 5 provjera dijakritika pala (PDF obrisan).

Okolina: TM_PDF_FONT_DIR (mapa s DejaVuSans.ttf; prva se gleda).

Izvor: TASK-5369 (inženjerka tima).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys

HR_SLOVA = "čćžšđČĆŽŠĐ"
ZAMJENSKI = "■�□"
MAPE_FONTOVA = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu",
                "/usr/share/fonts/TTF", "~/.local/share/fonts",
                "~/Library/Fonts", "/Library/Fonts"]  # macOS: korisnička mapa (instaliraj-pdf.sh)
DATOTEKE = {"TMSans": "DejaVuSans.ttf", "TMSans-Bold": "DejaVuSans-Bold.ttf",
            "TMSans-Italic": "DejaVuSans-Oblique.ttf", "TMSans-BoldItalic": "DejaVuSans-BoldOblique.ttf",
            "TMMono": "DejaVuSansMono.ttf"}

_OGRADA = re.compile(r"^\s*(```|~~~)")
_NASLOV = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_CRTA = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_STAVKA = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_RED_TABLICE = re.compile(r"^\s*\|(.*)\|\s*$")
_RAZDJELNIK_TABLICE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_CITAT = re.compile(r"^\s*>\s?(.*)$")


# ── provjera ──────────────────────────────────────────────────────────────────

def dijakritike(tekst: str) -> str:
    """Hrvatska slova s dijakritikom koja se pojavljuju u tekstu (sortirano, bez ponavljanja)."""
    return "".join(sorted(set(c for c in tekst if c in HR_SLOVA)))


def provjeri_tekst(izvor: str, izvadeno: str) -> dict:
    """Svako hrvatsko slovo iz izvora mora biti u izvađenom tekstu, bez zamjenskih znakova."""
    ocekivano = dijakritike(izvor)
    nadeno = dijakritike(izvadeno)
    nedostaje = "".join(c for c in ocekivano if c not in nadeno)
    zamjenski = sum(izvadeno.count(z) for z in ZAMJENSKI) - sum(izvor.count(z) for z in ZAMJENSKI)
    zamjenski = max(zamjenski, 0)
    return {"ok": not nedostaje and zamjenski == 0, "ocekivano": ocekivano, "nadeno": nadeno,
            "nedostaje": nedostaje, "zamjenski": zamjenski}


def izvuci_tekst(putanja: str) -> tuple[str, str]:
    """Tekst iz PDF-a: pdftotext (kao što bi provjerio čovjek), inače pypdf. (tekst, alat)."""
    if shutil.which("pdftotext"):
        r = subprocess.run(["pdftotext", "-enc", "UTF-8", putanja, "-"], capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout, "pdftotext"
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise RuntimeError("nema alata za provjeru teksta (pdftotext ni pypdf)") from e
    return "\n".join(s.extract_text() or "" for s in PdfReader(putanja).pages), "pypdf"


def fontovi_ugradeni(putanja: str) -> bool | None:
    """True ako je svaki font u PDF-u ugrađen (FontFile*), None ako se ne može provjeriti."""
    try:
        from pypdf import PdfReader
    except ImportError:
        if not shutil.which("pdffonts"):
            return None
        r = subprocess.run(["pdffonts", putanja], capture_output=True, text=True)
        redovi = r.stdout.splitlines()[2:]
        return bool(redovi) and all(" yes " in f" {x} " for x in redovi)

    def ugraden(f) -> bool:
        f = f.get_object()
        if "/DescendantFonts" in f:
            return all(ugraden(d) for d in f["/DescendantFonts"])
        fd = f.get("/FontDescriptor")
        fd = fd.get_object() if fd is not None else None
        return fd is not None and any(k in fd for k in ("/FontFile", "/FontFile2", "/FontFile3"))

    vidjeno = 0
    for s in PdfReader(putanja).pages:
        res = s.get("/Resources")
        fontovi = res.get_object().get("/Font") if res is not None else None
        if not fontovi:
            continue
        for f in fontovi.get_object().values():
            vidjeno += 1
            if not ugraden(f):
                return False
    return vidjeno > 0


# ── markdown ──────────────────────────────────────────────────────────────────

def inline(t: str) -> str:
    """Inline markdown → oznake reportlab Paragrapha (tekst se escapea)."""
    dijelovi = re.split(r"(`[^`]*`)", t)
    van = []
    for d in dijelovi:
        if d.startswith("`") and d.endswith("`") and len(d) >= 2:
            van.append(f'<font face="TMMono">{html.escape(d[1:-1], quote=False)}</font>')
            continue
        d = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", d)
        d = html.escape(d, quote=False)
        d = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", d)
        d = re.sub(r"__(.+?)__", r"<b>\1</b>", d)
        d = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", d)
        d = re.sub(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)", r"<i>\1</i>", d)
        van.append(d)
    return "".join(van)


def blokovi(md: str) -> list[tuple]:
    """Markdown → popis blokova: (naslov, razina, t) (odlomak, t) (stavka, t, razina, oznaka)
    (tablica, redovi) (kod, t) (citat, t) (crta,)."""
    van: list[tuple] = []
    odlomak: list[str] = []
    tablica: list[list[str]] = []
    kod: list[str] | None = None

    def zatvori():
        if odlomak:
            van.append(("odlomak", " ".join(odlomak)))
            odlomak.clear()
        if tablica:
            van.append(("tablica", [list(r) for r in tablica]))
            tablica.clear()

    for red in md.splitlines():
        if _OGRADA.match(red):
            if kod is None:
                zatvori()
                kod = []
            else:
                van.append(("kod", "\n".join(kod)))
                kod = None
            continue
        if kod is not None:
            kod.append(red)
            continue
        if not red.strip():
            zatvori()
            continue
        if _CRTA.match(red):
            zatvori()
            van.append(("crta",))
            continue
        m = _NASLOV.match(red)
        if m:
            zatvori()
            van.append(("naslov", len(m.group(1)), m.group(2)))
            continue
        if "|" in red and _RAZDJELNIK_TABLICE.match(red):
            continue
        m = _RED_TABLICE.match(red)
        if m:
            if odlomak:
                van.append(("odlomak", " ".join(odlomak)))
                odlomak.clear()
            tablica.append([c.strip() for c in m.group(1).split("|")])
            continue
        m = _STAVKA.match(red)
        if m:
            zatvori()
            oznaka = m.group(2) if m.group(2)[0].isdigit() else "•"
            van.append(("stavka", m.group(3), len(m.group(1).expandtabs(4)) // 2, oznaka))
            continue
        m = _CITAT.match(red)
        if m:
            zatvori()
            van.append(("citat", m.group(1)))
            continue
        if tablica:
            zatvori()
        odlomak.append(red.strip())
    if kod is not None:
        van.append(("kod", "\n".join(kod)))
    zatvori()
    return van


# ── izrada ────────────────────────────────────────────────────────────────────

def nadi_fontove() -> dict[str, str]:
    """Ime → putanja TTF-a. Obavezan je samo DejaVuSans.ttf; ostali padaju na njega."""
    mape = []
    if os.environ.get("TM_PDF_FONT_DIR"):
        mape.append(os.environ["TM_PDF_FONT_DIR"])
    if not os.environ.get("TM_PDF_SAMO_FONT_DIR"):
        if shutil.which("fc-match"):
            r = subprocess.run(["fc-match", "-f", "%{file}", "DejaVu Sans"], capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.endswith("DejaVuSans.ttf"):
                mape.append(os.path.dirname(r.stdout))
        mape += MAPE_FONTOVA
    van: dict[str, str] = {}
    for ime, dat in DATOTEKE.items():
        for m in mape:
            p = os.path.join(os.path.expanduser(m), dat)
            if os.path.isfile(p):
                van[ime] = p
                break
    if "TMSans" not in van:
        return {}
    van.setdefault("TMMono", van["TMSans"])
    return van


def izradi(izvor: str, izlaz: str, fontovi: dict[str, str], naslov: str, kao_md: bool) -> int:
    from reportlab import rl_config
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (HRFlowable, Paragraph, Preformatted, SimpleDocTemplate,
                                    Spacer, Table, TableStyle)
    from reportlab.lib.fonts import addMapping

    for ime, put in fontovi.items():
        pdfmetrics.registerFont(TTFont(ime, put))
    r, b = "TMSans", fontovi.get("TMSans-Bold") and "TMSans-Bold" or "TMSans"
    i = "TMSans-Italic" if "TMSans-Italic" in fontovi else r
    bi = "TMSans-BoldItalic" if "TMSans-BoldItalic" in fontovi else b
    for ime, deb, kos in ((r, 0, 0), (b, 1, 0), (i, 0, 1), (bi, 1, 1)):
        addMapping("TMSans", deb, kos, ime)
    # Bez ovoga platno uvijek doda neugrađenu Helveticu (WinAnsi) kao početni font — upravo
    # font iz TASK-5360; ovako su svi fontovi u PDF-u ugrađeni.
    rl_config.canvas_basefontname = r

    tijelo = ParagraphStyle("tijelo", fontName=r, bulletFontName=r, fontSize=10.5, leading=14, alignment=TA_LEFT,
                            spaceAfter=5)
    velicine = {1: 18, 2: 15, 3: 13, 4: 12, 5: 11, 6: 10.5}
    stil_kod = ParagraphStyle("kod", fontName="TMMono", fontSize=8.5, leading=11, backColor=colors.HexColor("#f2f2f2"),
                              borderPadding=4, spaceBefore=3, spaceAfter=7)
    stil_citat = ParagraphStyle("citat", parent=tijelo, leftIndent=10, textColor=colors.HexColor("#555555"))
    stil_celija = ParagraphStyle("celija", parent=tijelo, fontSize=9.5, leading=12, spaceAfter=0)

    elementi = []
    if not kao_md:
        for o in re.split(r"\n\s*\n", izvor):
            if o.strip():
                elementi.append(Paragraph(html.escape(o.strip(), quote=False).replace("\n", "<br/>"), tijelo))
    else:
        for bl in blokovi(izvor):
            v = bl[0]
            if v == "naslov":
                vel = velicine[bl[1]]
                st = ParagraphStyle(f"h{bl[1]}", fontName=b, fontSize=vel, leading=vel * 1.25,
                                    spaceBefore=8 if elementi else 0, spaceAfter=5)
                elementi.append(Paragraph(inline(bl[2]), st))
            elif v == "odlomak":
                elementi.append(Paragraph(inline(bl[1]), tijelo))
            elif v == "stavka":
                st = ParagraphStyle("st", parent=tijelo, leftIndent=14 + 12 * bl[2], bulletIndent=4 + 12 * bl[2],
                                    spaceAfter=2)
                elementi.append(Paragraph(inline(bl[1]), st, bulletText=bl[3]))
            elif v == "tablica":
                redovi = bl[1]
                n = max(len(x) for x in redovi)
                podaci = [[Paragraph(("<b>%s</b>" if k == 0 else "%s") % inline(c), stil_celija)
                           for c in x + [""] * (n - len(x))] for k, x in enumerate(redovi)]
                t = Table(podaci, repeatRows=1, hAlign="LEFT", colWidths=[(A4[0] - 36 * mm) / n] * n)
                t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), r),
                                       ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
                                       ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8e8e8")),
                                       ("VALIGN", (0, 0), (-1, -1), "TOP")]))
                elementi += [t, Spacer(1, 6)]
            elif v == "kod":
                elementi.append(Preformatted(bl[1], stil_kod))
            elif v == "citat":
                elementi.append(Paragraph(inline(bl[1]), stil_citat))
            elif v == "crta":
                elementi.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#999999"),
                                           spaceBefore=4, spaceAfter=6))
    if not elementi:
        return 0

    def podnozje(c, doc):
        c.saveState()
        c.setFont(r, 8)
        c.drawRightString(A4[0] - 18 * mm, 10 * mm, str(doc.page))
        c.restoreState()

    doc = SimpleDocTemplate(izlaz, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=16 * mm, bottomMargin=16 * mm, title=naslov, author="REGOČ")
    doc.build(elementi, onFirstPage=podnozje, onLaterPages=podnozje)
    return doc.page


def argumenti(argv=None):
    p = argparse.ArgumentParser(prog="pdf", description=__doc__.splitlines()[0])
    p.add_argument("ulaz", help="datoteka .md/.txt ili - za stdin")
    p.add_argument("-o", "--izlaz", required=True, help="apsolutna putanja .pdf")
    p.add_argument("--naslov", default="Izvještaj", help="naslov dokumenta i opis u oznaci za slanje")
    p.add_argument("--bez-md", action="store_true", help="ulaz je čisti tekst, ne markdown")
    return p.parse_args(argv)


def greska(poruka: str, kod: int) -> int:
    print(f"pdf: {poruka}", file=sys.stderr)
    return kod


def main(argv=None, stdin_tekst: str | None = None) -> int:
    a = argumenti(argv)
    izlaz = a.izlaz
    if not os.path.isabs(izlaz):
        return greska(f"izlaz mora biti apsolutna putanja (dobiveno: {izlaz})", 2)
    if os.path.splitext(izlaz)[1].lower() != ".pdf":
        return greska("izlaz mora završavati na .pdf", 2)
    if a.ulaz == "-":
        izvor = sys.stdin.read() if stdin_tekst is None else stdin_tekst
    elif not os.path.isfile(a.ulaz):
        return greska(f"ulaz ne postoji: {a.ulaz}", 2)
    else:
        with open(a.ulaz, encoding="utf-8") as f:
            izvor = f.read()
    if not izvor.strip():
        return greska("nema teksta", 2)

    fontovi = nadi_fontove()
    if not fontovi:
        return greska("nema fonta DejaVuSans.ttf (apt install fonts-dejavu-core ili TM_PDF_FONT_DIR) — "
                      "pokreni scripts/instaliraj-pdf.sh", 3)
    try:
        import reportlab  # noqa: F401
    except ImportError:
        return greska("nema knjižnice reportlab — pokreni scripts/instaliraj-pdf.sh", 3)

    os.makedirs(os.path.dirname(izlaz), exist_ok=True)
    privremeni = izlaz + ".tmp"
    try:
        stranica = izradi(izvor, privremeni, fontovi, a.naslov, not a.bez_md)
    except Exception as e:  # noqa: BLE001 — svaka greška izrade je izlaz 4, s porukom
        if os.path.exists(privremeni):
            os.unlink(privremeni)
        return greska(f"izrada nije uspjela: {e}", 4)
    if not stranica:
        return greska("nema teksta", 2)

    try:
        izvadeno, alat = izvuci_tekst(privremeni)
    except RuntimeError as e:
        os.unlink(privremeni)
        return greska(f"{e} — pokreni scripts/instaliraj-pdf.sh", 3)
    provjera = provjeri_tekst(izvor, izvadeno)
    provjera["alat"] = alat
    if not provjera["ok"]:
        os.unlink(privremeni)
        print(json.dumps({"izlaz": None, "dijakritike": provjera}, ensure_ascii=False))
        return greska(f"provjera dijakritika pala ({alat}): nedostaje „{provjera['nedostaje']}”, "
                      f"zamjenskih znakova {provjera['zamjenski']} — PDF obrisan", 5)
    os.replace(privremeni, izlaz)
    print(json.dumps({"izlaz": izlaz, "bajtova": os.path.getsize(izlaz), "stranica": stranica,
                      "font": fontovi["TMSans"], "fontovi_ugradeni": fontovi_ugradeni(izlaz),
                      "dijakritike": provjera, "send_doc": f"[[SEND_DOC: {izlaz} | {a.naslov}]]"},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
