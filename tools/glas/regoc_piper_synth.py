#!/usr/bin/env python3
"""regoc_piper_synth.py — zadani muški glas REGOČ-a (Piper, lokalno, bez mreže).

Recept odobren 04.10.2026. (vlasnik):
  1. model K2 ep5306 (instaliran kao ~/.local/share/piper-voices/hr_regoc.onnx; u paketu se ne
     nalazi — scripts/instaliraj-glas.sh ga postavlja i provjerava sha256)
  2. length_scale 0.9 (10 % brže), noise_scale 0.6, noise_w 0.7
  3. deterministička normalizacija teksta (hr_normalize.py)           — prekidač --no-normalize
  4. fonemska priprema hr_accent.patch_piper_voice + lexicon_hr.json  — prekidač --no-phonemes
  + sinteza po rečenicama, digitalna tišina 0,35 s između rečenica i 0,8 s iza odlomka.

Tekst na stdin, WAV u --out, sažetak kao JSON na stdout. Za tekst/md → mp3 koristi `glas` (glas.py).
Pokretanje: <venv>/bin/python regoc_piper_synth.py --model M --out o.wav < tekst
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import wave

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)

from hr_normalize import normaliziraj, podijeli  # noqa: E402

# TASK-5340: hr_accent.py i lexicon_hr.json putuju s paketom, uz ovu skriptu.
HR_ACCENT_DIR = D


def argumenti(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--model", required=True)
    p.add_argument("--config", default=None, help="zadano: <model>.json")
    p.add_argument("--out", default=None)
    p.add_argument("--length-scale", type=float, default=0.9)
    p.add_argument("--noise-scale", type=float, default=0.6)
    p.add_argument("--noise-w", type=float, default=0.7)
    p.add_argument("--sentence-silence", type=float, default=0.35)
    p.add_argument("--paragraph-silence", type=float, default=0.8)
    p.add_argument("--no-normalize", dest="normalize", action="store_false")
    p.add_argument("--no-phonemes", dest="phonemes", action="store_false")
    p.add_argument("--hr-accent-dir", default=HR_ACCENT_DIR)
    p.add_argument("--lexicon", default=None, help="zadano: <hr-accent-dir>/lexicon_hr.json")
    p.add_argument("--dry-run", action="store_true", help="samo normalizacija i podjela, bez modela")
    p.add_argument("--fonemi-u-izlaz", action="store_true", help="dodaj IPA po rečenici u JSON")
    return p.parse_args(argv)


def main(argv=None) -> int:
    a = argumenti(argv)
    tekst = sys.stdin.read()
    odlomci = podijeli(normaliziraj(tekst) if a.normalize else tekst)
    sazetak = {"odlomci": odlomci, "recenica": sum(map(len, odlomci)),
               "normalizacija": a.normalize, "fonemi": a.phonemes,
               "length_scale": a.length_scale, "noise_scale": a.noise_scale, "noise_w": a.noise_w}
    if a.dry_run:
        print(json.dumps(sazetak, ensure_ascii=False))
        return 0
    if not odlomci:
        print("prazan tekst", file=sys.stderr)
        return 2
    if not a.out:
        print("--out je obavezan", file=sys.stderr)
        return 2

    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(a.model, config_path=a.config)
    if a.phonemes:
        sys.path.insert(0, a.hr_accent_dir)
        import hr_accent
        hr_accent.load_lexicon(a.lexicon or os.path.join(a.hr_accent_dir, "lexicon_hr.json"))
        hr_accent.patch_piper_voice(voice)

    cfg = SynthesisConfig(length_scale=a.length_scale, noise_scale=a.noise_scale, noise_w_scale=a.noise_w)
    sr = voice.config.sample_rate
    pcm = bytearray()
    ipa = []
    for odlomak in odlomci:
        for i, rec in enumerate(odlomak):
            if a.fonemi_u_izlaz:
                ipa.append(" ".join("".join(s) for s in voice.phonemize(rec)))
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                voice.synthesize_wav(rec, w, syn_config=cfg)
            buf.seek(0)
            with wave.open(buf) as w:
                pcm += w.readframes(w.getnframes())
            tisina = a.paragraph_silence if i == len(odlomak) - 1 else a.sentence_silence
            pcm += b"\x00\x00" * int(sr * tisina)

    with wave.open(a.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(pcm))

    sazetak["trajanje_s"] = round(len(pcm) / 2 / sr, 2)
    sazetak["sample_rate"] = sr
    if a.fonemi_u_izlaz:
        sazetak["ipa"] = ipa
    print(json.dumps(sazetak, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
