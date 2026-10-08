#!/usr/bin/env bash
# instaliraj-glas.sh — postavi naredbu `glas` (tekst/md → mp3 hrvatskim glasom hr_regoc) na stroju.
#
# Vlasnik, 08.10.2026.: govor se generira SKRIPTOM, ne da model piše riječ po riječ; čvor mora
# imati iste skripte i model kao glavni stroj (TASK-5340). Model je privatan i NIJE u gitu —
# donosi se uz `--model-izvor` (mapa s hr_regoc.onnx + .onnx.json) i provjerava sha256 iz
# tools/glas/hr_regoc.sha256. Tekstovi i skupovi za trening ne idu nikamo.
#
#   bash scripts/instaliraj-glas.sh --model-izvor ~/app/tmp/TASK-5340/model
#   bash scripts/instaliraj-glas.sh             # venv + veza; model već na mjestu
#   bash scripts/instaliraj-glas.sh --suho      # samo izvijesti što fali, ništa ne mijenja
#
# Koraci: (1) python3 + ffmpeg, (2) venv s piper-tts (bez ensurepip-a: venv --without-pip
# i `pip --python`), (3) model u ~/.local/share/piper-voices + sha256, (4) veza
# ~/.local/bin/glas → scripts/glas, (5) proba: kratka rečenica u mp3.
# Okolina: TM_GLAS_VENV, TM_GLAS_MODEL (kao u scripts/glas).
set -uo pipefail

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPER_VERZIJA="1.8.0"
VENV="${TM_GLAS_VENV:-$HOME/.local/share/regoc-piper/venv}"
MODEL="${TM_GLAS_MODEL:-$HOME/.local/share/piper-voices/hr_regoc.onnx}"
SHA="$PAKET/tools/glas/hr_regoc.sha256"
VEZA="$HOME/.local/bin/glas"

SUHO=0
IZVOR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --suho)        SUHO=1 ;;
    --model-izvor) IZVOR="${2:-}"; shift ;;
    -h|--help)     sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done

FALI=0
ok()   { echo "  ✅ $*"; }
fali() { echo "  ❌ $*"; FALI=1; }
radi() { if [ "$SUHO" = 1 ]; then echo "  ⏭  (suho) $*"; else echo "  ▶ $*"; fi; }

echo "1) alati"
if command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
else
  fali "python3 >= 3.9"; exit 1
fi
command -v ffmpeg >/dev/null && ok "ffmpeg" || fali "ffmpeg (apt install ffmpeg) — bez njega samo .wav"

echo "2) venv s piper-tts ($VENV)"
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import piper' 2>/dev/null; then
  ok "piper-tts $("$VENV/bin/python" -c 'from importlib.metadata import version; print(version("piper-tts"))')"
else
  radi "stvaram venv i instaliram piper-tts==$PIPER_VERZIJA"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VENV")"
    if python3 -m venv "$VENV" 2>/dev/null && [ -x "$VENV/bin/pip" ]; then
      "$VENV/bin/pip" install -q "piper-tts==$PIPER_VERZIJA" || { fali "pip install piper-tts"; exit 1; }
    else
      # Debian bez python3-venv/ensurepip: prazan venv, pip sustava instalira u njega.
      rm -rf "$VENV"
      python3 -m venv --without-pip "$VENV" || { fali "python3 -m venv"; exit 1; }
      python3 -m pip --python "$VENV/bin/python" install -q "piper-tts==$PIPER_VERZIJA" \
        || { fali "pip --python $VENV/bin/python install piper-tts"; exit 1; }
    fi
    "$VENV/bin/python" -c 'import piper' && ok "piper-tts instaliran" || { fali "import piper"; exit 1; }
  fi
fi

echo "3) model ($MODEL)"
MAPA_MODELA="$(dirname "$MODEL")"
if [ -n "$IZVOR" ]; then
  if [ ! -f "$IZVOR/hr_regoc.onnx" ] || [ ! -f "$IZVOR/hr_regoc.onnx.json" ]; then
    fali "u $IZVOR nema hr_regoc.onnx + hr_regoc.onnx.json"; exit 1
  fi
  radi "kopiram model iz $IZVOR"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$MAPA_MODELA"
    cp "$IZVOR/hr_regoc.onnx" "$MODEL" && cp "$IZVOR/hr_regoc.onnx.json" "$MODEL.json"
  fi
fi
if [ -f "$MODEL" ] && [ -f "$MODEL.json" ]; then
  # Kontrolni zbroj se provjerava pod kanonskim imenima, bez obzira na TM_GLAS_MODEL.
  OCEKIVANO_ONNX="$(awk '$2=="hr_regoc.onnx"{print $1}' "$SHA")"
  OCEKIVANO_JSON="$(awk '$2=="hr_regoc.onnx.json"{print $1}' "$SHA")"
  if [ "$(sha256sum "$MODEL" | cut -d' ' -f1)" = "$OCEKIVANO_ONNX" ] \
     && [ "$(sha256sum "$MODEL.json" | cut -d' ' -f1)" = "$OCEKIVANO_JSON" ]; then
    ok "sha256 odgovara (K2 ep5306)"
  else
    fali "sha256 modela ne odgovara $SHA — krivi ili oštećeni model"
  fi
else
  fali "nema modela — pokreni ponovno uz --model-izvor <mapa s hr_regoc.onnx>"
fi

echo "4) naredba ($VEZA)"
if [ "$(readlink -f "$VEZA" 2>/dev/null)" = "$PAKET/scripts/glas" ]; then
  ok "glas → $PAKET/scripts/glas"
else
  radi "veza $VEZA → $PAKET/scripts/glas"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VEZA")" && ln -sfn "$PAKET/scripts/glas" "$VEZA" && ok "veza postavljena"
  fi
fi

echo "5) proba"
if [ "$SUHO" = 1 ] || [ "$FALI" = 1 ]; then
  echo "  ⏭  preskočeno ($([ "$SUHO" = 1 ] && echo suho || echo 'nešto fali'))"
else
  PROBA_DIR="$HOME/app/tmp/glas-proba"
  mkdir -p "$PROBA_DIR"
  if echo "Glas radi. Ovo je proba." | "$PAKET/scripts/glas" - -o "$PROBA_DIR/proba.mp3" >"$PROBA_DIR/proba.json"; then
    ok "$PROBA_DIR/proba.mp3 ($(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["trajanje_s"])' "$PROBA_DIR/proba.json") s)"
  else
    fali "proba nije uspjela"
  fi
fi

[ "$FALI" = 0 ] && echo "GLAS SPREMAN" || echo "GLAS NIJE SPREMAN"
exit "$FALI"
