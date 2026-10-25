#!/usr/bin/env bash
# instaliraj-glas.sh — postavi naredbu `glas` (tekst/md → mp3 hrvatskim glasom hr_regoc) na stroju,
# a uz --stt i lokalni glasovni servis (STT faster-whisper + TTS piper, 127.0.0.1:8899).
#
# Vlasnik, 08.10.2026.: govor se generira SKRIPTOM, ne da model piše riječ po riječ; čvor mora
# imati iste skripte i model kao glavni stroj (TASK-5340). Model je privatan i NIJE u gitu —
# donosi se uz `--model-izvor` (mapa s hr_regoc.onnx + .onnx.json) i provjerava sha256 iz
# tools/glas/hr_regoc.sha256. Tekstovi i skupovi za trening ne idu nikamo.
#
#   bash scripts/instaliraj-glas.sh --model-izvor ~/app/tmp/TASK-5340/model
#   bash scripts/instaliraj-glas.sh --engleski-izvor <mapa s en_*.onnx>   # TASK-5795: glas --jezik en
#   bash scripts/instaliraj-glas.sh --stt                                 # + servis regoc-voice (launchd/systemd)
#   bash scripts/instaliraj-glas.sh             # venv + veza; model već na mjestu
#   bash scripts/instaliraj-glas.sh --suho      # samo izvijesti što fali, ništa ne mijenja
#
# Koraci: (1) python + ffmpeg/espeak-ng (macOS: Homebrew, i kad je tuđi — preko sudo -u vlasnika),
# (2) venv s piper-tts (bez ensurepip-a: venv --without-pip i `pip --python`), (3) model u
# ~/.local/share/piper-voices + sha256, (3b) engleski glasovi + sha256 (tools/glas/glasovi-en.sha256),
# (4) veza ~/.local/bin/glas → scripts/glas, (5) proba: kratka rečenica u mp3 (HR, i EN ako ga ima),
# (6) uz --stt: faster-whisper u isti venv, model WHISPER_MODEL (zadano small) u lokalni cache,
# usluga `voice` (scripts/instalacija/servis.ts → hr.regoc.voice / regoc-voice) i proba /stt.
# Okolina: TM_GLAS_VENV, TM_GLAS_MODEL (kao u scripts/glas), TM_GLAS_PYTHON, WHISPER_MODEL,
# TM_OS (Linux|Darwin; zadano uname -s).
set -uo pipefail

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPER_VERZIJA="1.8.0"
WHISPER_VERZIJA="1.2.1"          # ista kao servis na node-A
AV_VERZIJA="18.0.0"              # PyAV ≥ 19 izbacio je open(metadata_errors=…) koji faster-whisper 1.2.1 zove → /stt HTTP 500
VENV="${TM_GLAS_VENV:-$HOME/.local/share/regoc-piper/venv}"
MODEL="${TM_GLAS_MODEL:-$HOME/.local/share/piper-voices/hr_regoc.onnx}"
SHA="$PAKET/tools/glas/hr_regoc.sha256"
SHA_EN="$PAKET/tools/glas/glasovi-en.sha256"
VEZA="$HOME/.local/bin/glas"
WHISPER="${WHISPER_MODEL:-small}"
VRATA="${REGOC_VOICE_PORT:-8899}"
OS_IME="${TM_OS:-$(uname -s)}"

SUHO=0
IZVOR=""
IZVOR_EN=""
STT=0
BREW=1
while [ $# -gt 0 ]; do
  case "$1" in
    --suho)           SUHO=1 ;;
    --model-izvor)    IZVOR="${2:-}"; shift ;;
    --engleski-izvor) IZVOR_EN="${2:-}"; shift ;;
    --stt)            STT=1 ;;
    --bez-brew)       BREW=0 ;;
    -h|--help)        sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done

FALI=0
ok()   { echo "  ✅ $*"; }
fali() { echo "  ❌ $*"; FALI=1; }
radi() { if [ "$SUHO" = 1 ]; then echo "  ⏭  (suho) $*"; else echo "  ▶ $*"; fi; }
# macOS nema sha256sum, a readlink bez -f do 12.3 — zbroj kroz shasum, putanja kroz python.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
stvarno() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null; }

echo "1) alati"
# Python za venv: TM_GLAS_PYTHON, pa python3 >= 3.10, pa uv-ov 3.13 (macOS ima sustavni 3.9, a
# onnxruntime za 3.9 više ne izlazi), pa python3 >= 3.9 kao prije.
PY="${TM_GLAS_PYTHON:-}"
UV="$(command -v uv || { [ -x "$HOME/.local/bin/uv" ] && echo "$HOME/.local/bin/uv"; })"
if [ -z "$PY" ] && command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then PY="$(command -v python3)"; fi
if [ -z "$PY" ] && [ -n "$UV" ]; then
  PY="$("$UV" python find 3.13 2>/dev/null)"
  if [ -z "$PY" ] && [ "$SUHO" = 0 ]; then "$UV" python install 3.13 >/dev/null 2>&1 && PY="$("$UV" python find 3.13 2>/dev/null)"; fi
fi
if [ -z "$PY" ] && command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then PY="$(command -v python3)"; fi
if [ -n "$PY" ] && "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  ok "python $("$PY" -c 'import platform; print(platform.python_version())') ($PY)"
else
  fali "python >= 3.9 (macOS: uv python install 3.13)"; exit 1
fi

# macOS (TASK-5795): ffmpeg i espeak-ng iz Homebrewa. Homebrew je često drugog korisnika
# (vlasnik /opt/homebrew) — tada se instalira kao on, preko sudo -n -u (korisnik usluge ga ima).
if [ "$OS_IME" = Darwin ]; then
  UPUTA_FFMPEG="brew install ffmpeg (Homebrew) ili statična binarka u ~/.local/bin (https://ffmpeg.org/download.html#build-mac)"
  FALE_BREW=()
  command -v "${TM_GLAS_FFMPEG:-ffmpeg}" >/dev/null || FALE_BREW+=(ffmpeg)
  command -v espeak-ng >/dev/null || FALE_BREW+=(espeak-ng)
  BREW_BIN="$(command -v brew || { [ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew; })"
  if [ "${#FALE_BREW[@]}" -gt 0 ] && [ "$BREW" = 1 ] && [ -n "$BREW_BIN" ]; then
    VLASNIK_BREW="$(stat -f %Su "$(dirname "$(dirname "$BREW_BIN")")" 2>/dev/null || echo "$USER")"
    radi "brew install ${FALE_BREW[*]} (Homebrew korisnika $VLASNIK_BREW)"
    if [ "$SUHO" = 0 ]; then
      if [ "$VLASNIK_BREW" = "$(id -un)" ]; then
        HOMEBREW_NO_AUTO_UPDATE=1 "$BREW_BIN" install "${FALE_BREW[@]}"
      elif sudo -n true 2>/dev/null; then
        # -i: okolina vlasnika (HOME, PATH); cd / jer vlasnik ne smije u dom korisnika usluge (0700).
        (cd / && sudo -n -u "$VLASNIK_BREW" -i env HOMEBREW_NO_AUTO_UPDATE=1 "$BREW_BIN" install "${FALE_BREW[@]}")
      else
        echo "  ℹ  Homebrew je korisnika $VLASNIK_BREW, a sudo -n nije dopušten — neka on pokrene: brew install ${FALE_BREW[*]}"
      fi
    fi
  fi
  PATH="$PATH:$(dirname "${BREW_BIN:-/opt/homebrew/bin/brew}")"
else
  UPUTA_FFMPEG="apt install ffmpeg"
fi
command -v "${TM_GLAS_FFMPEG:-ffmpeg}" >/dev/null && ok "ffmpeg" || fali "ffmpeg ($UPUTA_FFMPEG) — bez njega samo .wav"
if [ "$OS_IME" = Darwin ]; then
  command -v espeak-ng >/dev/null && ok "espeak-ng" || echo "  ℹ  espeak-ng nema (piper-tts nosi vlastiti; servis bez pipera pada na espeak-ng)"
fi

echo "2) venv s piper-tts ($VENV)"
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import piper' 2>/dev/null; then
  ok "piper-tts $("$VENV/bin/python" -c 'from importlib.metadata import version; print(version("piper-tts"))')"
else
  radi "stvaram venv i instaliram piper-tts==$PIPER_VERZIJA"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VENV")"
    if "$PY" -m venv "$VENV" >/dev/null 2>&1 && [ -x "$VENV/bin/pip" ]; then
      "$VENV/bin/pip" install -q "piper-tts==$PIPER_VERZIJA" || { fali "pip install piper-tts"; exit 1; }
    else
      # Debian bez python3-venv/ensurepip: prazan venv, pip sustava instalira u njega.
      rm -rf "$VENV"
      "$PY" -m venv --without-pip "$VENV" || { fali "$PY -m venv"; exit 1; }
      "$PY" -m pip --python "$VENV/bin/python" install -q "piper-tts==$PIPER_VERZIJA" \
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
  if [ "$(sha256 "$MODEL")" = "$OCEKIVANO_ONNX" ] && [ "$(sha256 "$MODEL.json")" = "$OCEKIVANO_JSON" ]; then
    ok "sha256 odgovara (K2 ep5306)"
  else
    fali "sha256 modela ne odgovara $SHA — krivi ili oštećeni model"
  fi
else
  fali "nema modela — pokreni ponovno uz --model-izvor <mapa s hr_regoc.onnx>"
fi

echo "3b) engleski glasovi ($MAPA_MODELA, $(basename "$SHA_EN"))"
if [ -n "$IZVOR_EN" ]; then
  [ -d "$IZVOR_EN" ] || { fali "nema mape $IZVOR_EN"; exit 1; }
  for ime in $(awk '$2 ~ /\.onnx$/ {sub(/\.onnx$/, "", $2); print $2}' "$SHA_EN"); do
    [ -f "$IZVOR_EN/$ime.onnx" ] && [ -f "$IZVOR_EN/$ime.onnx.json" ] || continue
    radi "kopiram $ime"
    if [ "$SUHO" = 0 ]; then
      mkdir -p "$MAPA_MODELA"
      cp "$IZVOR_EN/$ime.onnx" "$IZVOR_EN/$ime.onnx.json" "$MAPA_MODELA/"
    fi
  done
fi
EN_IMA=0
for ime in $(awk '$2 ~ /\.onnx$/ {sub(/\.onnx$/, "", $2); print $2}' "$SHA_EN"); do
  [ -f "$MAPA_MODELA/$ime.onnx" ] || continue
  o="$(awk -v f="$ime.onnx" '$2==f{print $1}' "$SHA_EN")"; j="$(awk -v f="$ime.onnx.json" '$2==f{print $1}' "$SHA_EN")"
  if [ "$(sha256 "$MAPA_MODELA/$ime.onnx")" = "$o" ] && [ -f "$MAPA_MODELA/$ime.onnx.json" ] && [ "$(sha256 "$MAPA_MODELA/$ime.onnx.json")" = "$j" ]; then
    ok "$ime (sha256 odgovara)"; EN_IMA=1
  else
    fali "$ime: sha256 ne odgovara $SHA_EN"
  fi
done
[ "$EN_IMA" = 1 ] || echo "  ℹ  engleskog glasa nema — glas --jezik en traži --engleski-izvor <mapa>"

echo "4) naredba ($VEZA)"
if [ "$(stvarno "$VEZA")" = "$(stvarno "$PAKET/scripts/glas")" ]; then
  ok "glas → $PAKET/scripts/glas"
else
  radi "veza $VEZA → $PAKET/scripts/glas"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VEZA")" && ln -sfn "$PAKET/scripts/glas" "$VEZA" && ok "veza postavljena"
  fi
fi

echo "5) proba"
PROBA_DIR="$HOME/app/tmp/glas-proba"
if [ "$SUHO" = 1 ] || [ "$FALI" = 1 ]; then
  echo "  ⏭  preskočeno ($([ "$SUHO" = 1 ] && echo suho || echo 'nešto fali'))"
else
  mkdir -p "$PROBA_DIR"
  if echo "Glas radi. Ovo je proba." | "$PAKET/scripts/glas" - -o "$PROBA_DIR/proba.mp3" >"$PROBA_DIR/proba.json"; then
    ok "$PROBA_DIR/proba.mp3 ($("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["trajanje_s"])' "$PROBA_DIR/proba.json") s)"
  else
    fali "proba nije uspjela"
  fi
  if [ "$EN_IMA" = 1 ]; then
    if echo "The voice works. This is a test." | "$PAKET/scripts/glas" - -o "$PROBA_DIR/proba-en.mp3" --jezik en >"$PROBA_DIR/proba-en.json"; then
      ok "$PROBA_DIR/proba-en.mp3 (en)"
    else
      fali "proba na engleskom nije uspjela"
    fi
  fi
fi

if [ "$STT" = 1 ]; then
  echo "6) STT i servis glasa (faster-whisper $WHISPER_VERZIJA, model $WHISPER, 127.0.0.1:$VRATA)"
  if "$VENV/bin/python" -c 'import faster_whisper' 2>/dev/null \
     && [ "$("$VENV/bin/python" -c 'import av; print(av.__version__)' 2>/dev/null)" = "$AV_VERZIJA" ]; then
    ok "faster-whisper $("$VENV/bin/python" -c 'from importlib.metadata import version; print(version("faster-whisper"))'), av $AV_VERZIJA"
  else
    radi "pip install faster-whisper==$WHISPER_VERZIJA av==$AV_VERZIJA u $VENV"
    if [ "$SUHO" = 0 ]; then
      { [ -x "$VENV/bin/pip" ] && "$VENV/bin/pip" install -q "faster-whisper==$WHISPER_VERZIJA" "av==$AV_VERZIJA"; } \
        || "$PY" -m pip --python "$VENV/bin/python" install -q "faster-whisper==$WHISPER_VERZIJA" "av==$AV_VERZIJA" \
        || { fali "pip install faster-whisper"; exit 1; }
    fi
  fi
  # Servis učitava model OFFLINE (HF_HUB_OFFLINE=1) — ovdje se skine jednom u lokalni cache.
  radi "model $WHISPER u lokalni cache (jednom, s mreže)"
  if [ "$SUHO" = 0 ]; then
    HF_HUB_OFFLINE=0 "$VENV/bin/python" -c 'import sys; from faster_whisper import WhisperModel; WhisperModel(sys.argv[1], device="cpu", compute_type="int8")' "$WHISPER" \
      && ok "model $WHISPER spreman" || { fali "skidanje modela $WHISPER"; exit 1; }
  fi
  radi "usluga voice (scripts/instalacija/servis.ts primijeni --ime voice)"
  if [ "$SUHO" = 0 ]; then
    BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
    (cd "$PAKET" && TM_GLAS_VENV="$VENV" "$BUN" scripts/instalacija/servis.ts primijeni --ime voice) | sed 's/^/  /' \
      || { fali "usluga voice nije postavljena"; exit 7; }
    for _ in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$VRATA/health" >/dev/null 2>&1 && break; sleep 2; done
    if H="$(curl -fsS -m 3 "http://127.0.0.1:$VRATA/health")"; then
      ok "servis: $H"
      if [ -f "$PROBA_DIR/proba.mp3" ]; then
        "${TM_GLAS_FFMPEG:-ffmpeg}" -y -loglevel error -i "$PROBA_DIR/proba.mp3" -c:a libopus -b:a 32k "$PROBA_DIR/proba.ogg" \
          && T="$(curl -fsS -m 120 -X POST -H 'Content-Type: audio/ogg' --data-binary @"$PROBA_DIR/proba.ogg" "http://127.0.0.1:$VRATA/stt")" \
          && ok "/stt: $T" || fali "/stt proba nije uspjela"
      fi
    else
      fali "servis ne odgovara na 127.0.0.1:$VRATA/health (zapis: \$TM_HOME/log/voice.log)"
    fi
  fi
fi

[ "$FALI" = 0 ] && echo "GLAS SPREMAN" || echo "GLAS NIJE SPREMAN"
exit "$FALI"
