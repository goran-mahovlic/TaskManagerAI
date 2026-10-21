#!/usr/bin/env bash
# instaliraj-pdf.sh — postavi naredbu `pdf` (md/tekst → PDF s hrvatskim slovima) na stroju.
#
# Povod (TASK-5360/5369): na node-A PDF iz vlastite reportlab skripte s Helveticom dao je
# „■vor" umjesto „čvor", a md2pdf glavnog sustava traži Chromium kojeg na čvoru nema. Naredba
# `pdf` ne treba preglednik: reportlab + ugrađen DejaVu Sans, a nakon izrade provjeri dijakritike.
#
#   bash scripts/instaliraj-pdf.sh           # venv + veza + proba
#   bash scripts/instaliraj-pdf.sh --suho    # samo izvijesti što fali, ništa ne mijenja
#
# Koraci: (1) python3, (2) font DejaVu Sans (Linux: fonts-dejavu-core; inače i na macOS-u
# službeno izdanje DejaVu 2.37 u korisničku mapu fontova, bez root-a i Homebrewa), (3) pdftotext
# (Linux: poppler-utils; neobavezan — bez njega provjera ide pypdf-om), (4) venv s reportlab + pypdf
# (--system-site-packages: ako ih sustav već ima, pip ne treba mrežu), (5) veza
# ~/.local/bin/pdf → scripts/pdf, (6) proba: PDF sa „č ć ž š đ" mora proći provjeru.
# Okolina: TM_PDF_VENV, TM_PDF_FONT_DIR (kao u scripts/pdf; i cilj preuzetog fonta),
# TM_PDF_DEJAVU_URL + TM_PDF_DEJAVU_SHA256 (zrcalo izdanja), TM_OS (Linux|Darwin; zadano uname -s),
# TM_PDF_PROBA_DIR (gdje proba ostaje; zadano privremena mapa u $TMPDIR koja se briše).
set -uo pipefail

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/instalacija/pip-u-venv.sh
. "$PAKET/scripts/instalacija/pip-u-venv.sh"
REPORTLAB_VERZIJA="4.4.4"
PYPDF_VERZIJA="6.1.1"
VENV="${TM_PDF_VENV:-$HOME/.local/share/regoc-pdf/venv}"
VEZA="$HOME/.local/bin/pdf"
OS="${TM_OS:-$(uname -s)}"
DEJAVU_URL="${TM_PDF_DEJAVU_URL:-https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2}"
DEJAVU_SHA256="${TM_PDF_DEJAVU_SHA256:-fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7}"
PDFTOTEXT="${TM_PDF_PDFTOTEXT:-pdftotext}"
if [ "$OS" = Darwin ]; then KORISNICKI_FONTOVI="$HOME/Library/Fonts"; else KORISNICKI_FONTOVI="$HOME/.local/share/fonts"; fi

SUHO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --suho)    SUHO=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Privremeno (QA K6 B7): proba i predmemorija fontconfiga (fc-match, reportlab → ~/.cache/fontconfig)
# ne smiju ostati u HOME-u — install.sh u manifest upisuje samo venv i vezu, pa bi
# `deinstaliraj --do-nule` ostavio ~/.cache, a ~/app/tmp/pdf-proba provjeri-cisto ne bi ni vidio.
# Mapa je u $TMPDIR i briše se na izlasku; TM_PDF_PROBA_DIR zadrži probu gdje želiš.
PRIVREMENO="$(mktemp -d "${TMPDIR:-/tmp}/instaliraj-pdf.XXXXXX")" || { echo "nema privremene mape (TMPDIR)" >&2; exit 1; }
trap 'rm -rf "$PRIVREMENO"' EXIT
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PRIVREMENO/cache}"

FALI=0
ok()   { echo "  ✅ $*"; }
fali() { echo "  ❌ $*"; FALI=1; }
upoz() { echo "  ⚠️  $*"; }
radi() { if [ "$SUHO" = 1 ]; then echo "  ⏭  (suho) $*"; else echo "  ▶ $*"; fi; }
# Upravitelj paketa sustava samo na Linuxu i samo bez lozinke (sudo -n) — na čvoru radi dok je
# sklopka allow_root uključena. Na macOS-u se ne zove ništa što traži root ili Homebrew.
apt_paket() {
  [ "$SUHO" = 1 ] && return 1
  [ "$OS" = Linux ] || return 1
  command -v apt-get >/dev/null || return 1
  if [ "$(id -u)" = 0 ]; then apt-get install -y -q "$1" >/dev/null 2>&1
  else sudo -n apt-get install -y -q "$1" >/dev/null 2>&1; fi
}

echo "1) python3"
if command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
else
  fali "python3 >= 3.9"; exit 1
fi

echo "2) font DejaVu Sans"
nadi_font() {
  local mape
  if [ "$OS" = Darwin ]; then mape=("$HOME/Library/Fonts" /Library/Fonts)
  else mape=(/usr/share/fonts/truetype/dejavu /usr/share/fonts/dejavu /usr/share/fonts/TTF "$HOME/.local/share/fonts"); fi
  for m in ${TM_PDF_FONT_DIR:+"$TM_PDF_FONT_DIR"} "${mape[@]}"; do
    [ -f "$m/DejaVuSans.ttf" ] && { echo "$m/DejaVuSans.ttf"; return 0; }
  done
  [ "$OS" = Linux ] && command -v fc-match >/dev/null && fc-match -f '%{file}' "DejaVu Sans" 2>/dev/null | grep -q 'DejaVuSans.ttf$' \
    && { fc-match -f '%{file}' "DejaVu Sans"; return 0; }
  return 1
}
# Službeno izdanje DejaVu (provjeren sha256) u korisničku mapu fontova — bez root-a i Homebrewa.
preuzmi_font() {
  [ "$SUHO" = 1 ] && return 1
  local cilj="${TM_PDF_FONT_DIR:-$KORISNICKI_FONTOVI}" rad
  rad="$(mktemp -d "${TMPDIR:-$HOME}/dejavu.XXXXXX")" || return 1
  local bila=0; [ -d "$cilj" ] && bila=1
  if curl -fsSL -m 120 -o "$rad/dejavu.tar.bz2" "$DEJAVU_URL" \
     && [ "$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$rad/dejavu.tar.bz2")" = "$DEJAVU_SHA256" ] \
     && tar -xjf "$rad/dejavu.tar.bz2" -C "$rad" \
     && mkdir -p "$cilj"; then
    # TM_PDF_STVORENO: install.sh tu čita što je stvoreno (redak „put|vrsta") i upisuje u manifest,
    # da ih --do-nule obriše (K8 krug 1: ~/Library/Fonts/DejaVu*.ttf ostali su na Macu)
    [ "$bila" = 0 ] && [ -n "${TM_PDF_STVORENO:-}" ] && echo "$cilj|mapa-ako-prazna" >> "$TM_PDF_STVORENO"
    local n=0 f
    for f in "$rad"/dejavu-fonts-ttf-*/ttf/DejaVuSans.ttf "$rad"/dejavu-fonts-ttf-*/ttf/DejaVuSans-{Bold,Oblique,BoldOblique}.ttf \
             "$rad"/dejavu-fonts-ttf-*/ttf/DejaVuSansMono.ttf; do
      [ -f "$f" ] || continue
      local novi=1; [ -e "$cilj/$(basename "$f")" ] && novi=0
      cp "$f" "$cilj/" && n=$((n + 1)) || continue
      [ "$novi" = 1 ] && [ -n "${TM_PDF_STVORENO:-}" ] && echo "$cilj/$(basename "$f")|datoteka" >> "$TM_PDF_STVORENO"
    done
    rm -rf "$rad"; [ "$n" -gt 0 ]
  else
    rm -rf "$rad"; return 1
  fi
}
if F="$(nadi_font)"; then
  ok "$F"
else
  if [ "$OS" = Linux ]; then
    radi "apt install fonts-dejavu-core"
    apt_paket fonts-dejavu-core && F="$(nadi_font)"
  fi
  if [ -n "${F:-}" ]; then ok "$F"
  else
    radi "preuzimam DejaVu 2.37 u ${TM_PDF_FONT_DIR:-$KORISNICKI_FONTOVI} (bez root-a)"
    if preuzmi_font && F="$(nadi_font)"; then ok "$F"
    elif [ "$OS" = Linux ]; then fali "nema DejaVuSans.ttf — apt install fonts-dejavu-core (traži allow_root), preuzimanje ($DEJAVU_URL) nije uspjelo, ili TM_PDF_FONT_DIR=<mapa s DejaVuSans.ttf>"
    else fali "nema DejaVuSans.ttf — preuzimanje ($DEJAVU_URL → $KORISNICKI_FONTOVI) nije uspjelo (nema mreže?) ili TM_PDF_FONT_DIR=<mapa s DejaVuSans.ttf>"; fi
  fi
fi

echo "3) pdftotext (provjera kao kod čovjeka)"
if command -v "$PDFTOTEXT" >/dev/null; then
  ok "$(command -v "$PDFTOTEXT")"
elif [ "$OS" = Linux ]; then
  radi "apt install poppler-utils"
  if apt_paket poppler-utils && command -v "$PDFTOTEXT" >/dev/null; then ok "pdftotext instaliran"
  else upoz "nema pdftotext (poppler-utils) — provjera dijakritika ide pypdf-om"; fi
else
  # macOS nema poppler, a Homebrew se ne dira (nije nužno korisnikov) — pypdf je dovoljan.
  upoz "nema pdftotext — provjera dijakritika ide pypdf-om (neobavezno: brew install poppler, samo ako je Homebrew tvoj)"
fi

echo "4) venv s reportlab + pypdf ($VENV)"
uvozi() { "$VENV/bin/python" -c 'import reportlab, pypdf' 2>/dev/null; }
if [ -x "$VENV/bin/python" ] && uvozi; then
  ok "reportlab $("$VENV/bin/python" -c 'import reportlab; print(reportlab.Version)'), pypdf $("$VENV/bin/python" -c 'import pypdf; print(pypdf.__version__)')"
else
  radi "stvaram venv (--system-site-packages) i po potrebi instaliram reportlab==$REPORTLAB_VERZIJA pypdf==$PYPDF_VERZIJA"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VENV")"
    [ -x "$VENV/bin/python" ] || python3 -m venv --system-site-packages --without-pip "$VENV" \
      || { fali "python3 -m venv"; exit 1; }
    NEDOSTAJE=()
    "$VENV/bin/python" -c 'import reportlab' 2>/dev/null || NEDOSTAJE+=("reportlab==$REPORTLAB_VERZIJA")
    "$VENV/bin/python" -c 'import pypdf' 2>/dev/null || NEDOSTAJE+=("pypdf==$PYPDF_VERZIJA")
    if [ "${#NEDOSTAJE[@]}" -gt 0 ]; then
      pip_u_venv "$VENV" "${NEDOSTAJE[@]}" \
        || fali "pip install ${NEDOSTAJE[*]} (nema mreže? uključi allow_internet ili instaliraj python3-reportlab python3-pypdf)"
    fi
    uvozi && ok "reportlab + pypdf dostupni" || { fali "import reportlab, pypdf"; exit 1; }
  fi
fi

echo "5) naredba ($VEZA)"
if [ "$(readlink -f "$VEZA" 2>/dev/null)" = "$PAKET/scripts/pdf" ]; then
  ok "pdf → $PAKET/scripts/pdf"
else
  radi "veza $VEZA → $PAKET/scripts/pdf"
  if [ "$SUHO" = 0 ]; then
    mkdir -p "$(dirname "$VEZA")" && ln -sfn "$PAKET/scripts/pdf" "$VEZA" && ok "veza postavljena"
  fi
fi

echo "6) proba"
if [ "$SUHO" = 1 ] || [ "$FALI" = 1 ]; then
  echo "  ⏭  preskočeno ($([ "$SUHO" = 1 ] && echo suho || echo 'nešto fali'))"
else
  PROBA_DIR="${TM_PDF_PROBA_DIR:-$PRIVREMENO/pdf-proba}"
  mkdir -p "$PROBA_DIR"
  if printf '# Proba čvora\n\nČ ć Ž š Đ — čvor, ćup, žaba, šuma, đak.\n' \
       | TM_PDF_VENV="$VENV" "$PAKET/scripts/pdf" - -o "$PROBA_DIR/proba.pdf" --naslov "Proba" >"$PROBA_DIR/proba.json"; then
    ok "$PROBA_DIR/proba.pdf ($(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["dijakritike"]; print("dijakritike", d["nadeno"], "provjerio", d["alat"])' "$PROBA_DIR/proba.json"))"
  else
    fali "proba nije uspjela"
  fi
fi

[ "$FALI" = 0 ] && echo "PDF SPREMAN" || echo "PDF NIJE SPREMAN"
exit "$FALI"
