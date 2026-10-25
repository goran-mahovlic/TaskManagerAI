#!/usr/bin/env python3
"""glas — tekst ili markdown u mp3 zadanim hrvatskim glasom (hr_regoc), jednom naredbom.

    glas izvjestaj.md -o /apsolutna/putanja/izvjestaj.mp3
    echo "Dobar dan." | glas - -o /apsolutna/putanja/pozdrav.mp3
    echo "Good afternoon." | glas - -o /apsolutna/putanja/en.mp3 --jezik en   # TASK-5795
    glas --glasovi                                                            # popis glasova

Govor generira SKRIPTA, ne jezični model: markdown se ovdje svede na izgovorljive rečenice,
regoc_piper_synth.py ih normalizira (brojke, nadnevci, oznake), fonemski pripremi (hr_accent)
i sintetizira po odobrenom receptu, a ffmpeg spremi mp3. Model riječi ne bira — samo pokrene
naredbu i datoteku pošalje (u Telegram: zaseban redak oznake iz polja `send_doc` izlaza).

Izlaz: JSON na stdout (`izlaz`, `trajanje_s`, `recenica`, recept, `send_doc`).
Izlazni kodovi: 0 uspjeh, 2 krivi argumenti/ulaz, 3 nema modela, 4 kvar sinteze ili ffmpega.

Izvor: TASK-5340 (inženjerka tima).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata

D = os.path.dirname(os.path.abspath(__file__))
SINTEZA = os.path.join(D, "regoc_piper_synth.py")
ZADANI_MODEL = "~/.local/share/piper-voices/hr_regoc.onnx"
# TASK-5795: engleski glas iz iste mape (Piper, izmjereno u TASK-5438: RTF 0,23, WER 2,4 %).
ZADANI_GLAS = {"hr": "hr_regoc", "en": "en_GB-alan-medium"}
# Piperove zadane vrijednosti za glas bez hrvatskog recepta.
PIPER_ZADANO = {"length_scale": 1.0, "noise_scale": 0.667, "noise_w": 0.8}

_OGRADA = re.compile(r"^\s*(```|~~~)")
_NASLOV = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_CRTA = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_STAVKA = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$")
_RED_TABLICE = re.compile(r"^\s*\|(.*)\|\s*$")
_RAZDJELNIK_TABLICE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_CITAT = re.compile(r"^\s*>\s?")
_SLIKA_ILI_POVEZNICA = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_KOD = re.compile(r"`([^`]*)`")
_NAGLASAK = [re.compile(r"\*\*(.+?)\*\*"), re.compile(r"__(.+?)__"),
             re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])"),
             re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)")]
_KRAJ_RECENICE = ".!?…"


def _bez_simbola(t: str) -> str:
    """Emoji i ostali simboli se ne izgovaraju (espeak bi ih čitao imenom ili preskočio)."""
    return "".join(c for c in t if unicodedata.category(c) not in ("So", "Sk", "Cs", "Co")
                   and c not in "‍️︎")


def _cisti(t: str) -> str:
    t = _SLIKA_ILI_POVEZNICA.sub(r"\1", t)
    t = _KOD.sub(r"\1", t)
    for n in _NAGLASAK:
        t = n.sub(r"\1", t)
    return re.sub(r"\s+", " ", _bez_simbola(t)).strip()


def _zatvori(t: str) -> str:
    t = t.rstrip(" :;,–-")
    if not t:
        return ""
    return t if t[-1] in _KRAJ_RECENICE else t + "."


def md_u_govor(md: str) -> str:
    """Markdown → izgovorljiv tekst: odlomci odvojeni praznim retkom, stavke svaka u svom retku."""
    odlomci: list[list[str]] = []
    jedinice: list[str] = []
    tekuci: list[str] = []
    u_kodu = False

    def zavrsi_recenicu():
        if tekuci:
            r = _zatvori(_cisti(" ".join(tekuci)))
            if r:
                jedinice.append(r)
            tekuci.clear()

    def zavrsi_odlomak():
        zavrsi_recenicu()
        if jedinice:
            odlomci.append(list(jedinice))
            jedinice.clear()

    def jedinica(t: str):
        zavrsi_recenicu()
        r = _zatvori(_cisti(t))
        if r:
            jedinice.append(r)

    for red in md.splitlines():
        if _OGRADA.match(red):
            u_kodu = not u_kodu
            zavrsi_odlomak()
            continue
        if u_kodu:
            continue
        if not red.strip() or _CRTA.match(red):
            zavrsi_odlomak()
            continue
        red = _CITAT.sub("", red)
        m = _NASLOV.match(red)
        if m:
            zavrsi_odlomak()
            jedinica(m.group(1))
            zavrsi_odlomak()
            continue
        if _RAZDJELNIK_TABLICE.match(red) and "|" in red:
            continue
        m = _RED_TABLICE.match(red)
        if m:
            celije = [_cisti(c) for c in m.group(1).split("|")]
            jedinica(", ".join(c for c in celije if c))
            continue
        m = _STAVKA.match(red)
        if m:
            jedinica(m.group(1))
            continue
        tekuci.append(red.strip())
    zavrsi_odlomak()
    return "\n\n".join("\n".join(o) for o in odlomci)


def glasovi_u_mapi(mapa: str) -> list[str]:
    """Imena glasova (model .onnx uz .onnx.json) u mapi modela."""
    if not os.path.isdir(mapa):
        return []
    return sorted(f[:-5] for f in os.listdir(mapa)
                  if f.endswith(".onnx") and os.path.isfile(os.path.join(mapa, f + ".json")))


def odaberi_model(jezik: str, glas: str | None, hr_model: str) -> dict:
    """Model za jezik/glas iz mape hrvatskog modela. Hrvatski recept (normalizacija, naglasci,
    prozodija K2) vrijedi samo za hrvatski; ime glasa je ime datoteke, bez putanje."""
    mapa = os.path.dirname(os.path.expanduser(hr_model))
    ime = glas or ZADANI_GLAS[jezik]
    if not re.fullmatch(r"[\w.-]{1,100}", ime) or ime.startswith("."):
        raise ValueError(f"nepoznat glas: {ime} (ime bez putanje)")
    if jezik == "hr" and not glas:
        model = os.path.expanduser(hr_model)
    else:
        model = os.path.join(mapa, ime + ".onnx")
    return {"model": model, "recept_hr": jezik == "hr"}


def argumenti(argv=None):
    p = argparse.ArgumentParser(prog="glas", description=__doc__.splitlines()[0])
    p.add_argument("ulaz", nargs="?", help="datoteka .md/.txt ili - za stdin")
    p.add_argument("-o", "--izlaz", help="apsolutna putanja .mp3 (ili .wav)")
    p.add_argument("--jezik", default="hr", help="hr (zadano, hr_regoc) ili en (en_GB-alan-medium)")
    p.add_argument("--glas", default=None, help="ime glasa iz mape modela (v. --glasovi)")
    p.add_argument("--glasovi", action="store_true", help="ispiši glasove u mapi modela i izađi")
    p.add_argument("--model", default=os.environ.get("TM_GLAS_MODEL", ZADANI_MODEL))
    p.add_argument("--opis", default="Audio izvještaj", help="opis u oznaci za slanje")
    p.add_argument("--bez-md", action="store_true", help="ulaz je čisti tekst, ne markdown")
    p.add_argument("--suho", action="store_true", help="samo ispiši što bi se izgovorilo, bez modela")
    return p.parse_args(argv)


def greska(poruka: str, kod: int) -> int:
    print(f"glas: {poruka}", file=sys.stderr)
    return kod


def main(argv=None) -> int:
    a = argumenti(argv)
    if a.glasovi:
        mapa = os.path.dirname(os.path.expanduser(a.model))
        print(json.dumps({"mapa": mapa, "glasovi": glasovi_u_mapi(mapa), "zadano": ZADANI_GLAS}, ensure_ascii=False))
        return 0
    if a.jezik not in ZADANI_GLAS:
        return greska(f"jezik mora biti {' ili '.join(ZADANI_GLAS)} (dobiveno: {a.jezik})", 2)
    if not a.ulaz or not a.izlaz:
        return greska("trebaju ulaz i -o <izlaz>", 2)
    try:
        izbor = odaberi_model(a.jezik, a.glas, a.model)
    except ValueError as e:
        return greska(str(e), 2)
    izlaz = a.izlaz
    if not os.path.isabs(izlaz):
        return greska(f"izlaz mora biti apsolutna putanja (dobiveno: {izlaz})", 2)
    nastavak = os.path.splitext(izlaz)[1].lower()
    if nastavak not in (".mp3", ".wav"):
        return greska("izlaz mora završavati na .mp3 ili .wav", 2)
    if a.ulaz == "-":
        izvor = sys.stdin.read()
    elif not os.path.isfile(a.ulaz):
        return greska(f"ulaz ne postoji: {a.ulaz}", 2)
    else:
        with open(a.ulaz, encoding="utf-8") as f:
            izvor = f.read()
    tekst = izvor if a.bez_md else md_u_govor(izvor)
    if not tekst.strip():
        return greska("nema teksta za izgovor", 2)

    model = izbor["model"]
    # Bez hrvatskog recepta: bez hr normalizacije i naglasaka, Piperova zadana prozodija.
    dodatno = [] if izbor["recept_hr"] else [
        "--no-normalize", "--no-phonemes",
        "--length-scale", str(PIPER_ZADANO["length_scale"]),
        "--noise-scale", str(PIPER_ZADANO["noise_scale"]), "--noise-w", str(PIPER_ZADANO["noise_w"])]
    if a.suho:
        r = subprocess.run([sys.executable, SINTEZA, "--model", model, "--dry-run", *dodatno],
                           input=tekst, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        return 0 if r.returncode == 0 else greska(r.stderr.strip(), 4)
    if not os.path.isfile(model):
        return greska(f"nema modela {model} — pokreni scripts/instaliraj-glas.sh"
                      + (" --engleski-izvor <mapa>" if a.jezik == "en" else ""), 3)
    if nastavak == ".mp3" and not shutil.which("ffmpeg"):
        return greska("nema ffmpeg-a (potreban za mp3)", 4)

    mapa = os.path.dirname(izlaz)
    os.makedirs(mapa, exist_ok=True)
    fd, wav = tempfile.mkstemp(prefix=".glas-", suffix=".wav", dir=mapa)
    os.close(fd)
    try:
        r = subprocess.run([sys.executable, SINTEZA, "--model", model, "--out", wav, *dodatno],
                           input=tekst, capture_output=True, text=True)
        if r.returncode != 0:
            return greska(f"sinteza nije uspjela: {r.stderr.strip()[-400:]}", 4)
        sazetak = json.loads(r.stdout)
        if nastavak == ".mp3":
            f = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav,
                                "-codec:a", "libmp3lame", "-q:a", "4", izlaz],
                               capture_output=True, text=True)
            if f.returncode != 0:
                return greska(f"ffmpeg nije uspio: {f.stderr.strip()[-400:]}", 4)
        else:
            os.replace(wav, izlaz)
    finally:
        if os.path.exists(wav):
            os.unlink(wav)

    sazetak.pop("odlomci", None)
    sazetak.update({"izlaz": izlaz, "bajtova": os.path.getsize(izlaz), "model": model, "jezik": a.jezik,
                    "send_doc": f"[[SEND_DOC: {izlaz} | {a.opis}]]"})
    print(json.dumps(sazetak, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
