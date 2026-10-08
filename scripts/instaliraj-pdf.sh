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
# Koraci: (1) python3, (2) font DejaVu Sans (fonts-dejavu-core), (3) pdftotext (poppler-utils;
# neobavezan — bez njega provjera ide pypdf-om), (4) venv s reportlab + pypdf
# (--system-site-packages: ako ih sustav već ima, pip ne treba mrežu), (5) veza
# ~/.local/bin/pdf → scripts/pdf, (6) proba: PDF sa „č ć ž š đ" mora proći provjeru.
# Okolina: TM_PDF_VENV, TM_PDF_FONT_DIR (kao u scripts/pdf).
set -uo pipefail

PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTLAB_VERZIJA="4.4.4"
PYPDF_VERZIJA="6.1.1"
VENV="${TM_PDF_VENV:-$HOME/.local/share/regoc-pdf/venv}"
VEZA="$HOME/.local/bin/pdf"

SUHO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --suho)    SUHO=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done

FALI=0
ok()   { echo "  ✅ $*"; }
fali() { echo "  ❌ $*"; FALI=1; }
upoz() { echo "  ⚠️  $*"; }
radi() { if [ "$SUHO" = 1 ]; then echo "  ⏭  (suho) $*"; else echo "  ▶ $*"; fi; }
# apt samo bez lozinke (sudo -n) — na čvoru radi dok je sklopka allow_root uključena.
apt_paket() {
  [ "$SUHO" = 1 ] && return 1
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
  for m in ${TM_PDF_FONT_DIR:+"$TM_PDF_FONT_DIR"} /usr/share/fonts/truetype/dejavu /usr/share/fonts/dejavu \
           /usr/share/fonts/TTF "$HOME/.local/share/fonts"; do
    [ -f "$m/DejaVuSans.ttf" ] && { echo "$m/DejaVuSans.ttf"; return 0; }
  done
  command -v fc-match >/dev/null && fc-match -f '%{file}' "DejaVu Sans" 2>/dev/null | grep -q 'DejaVuSans.ttf$' \
    && { fc-match -f '%{file}' "DejaVu Sans"; return 0; }
  return 1
}
if F="$(nadi_font)"; then
  ok "$F"
else
  radi "apt install fonts-dejavu-core"
  if apt_paket fonts-dejavu-core && F="$(nadi_font)"; then ok "$F"
  else fali "nema DejaVuSans.ttf — apt install fonts-dejavu-core (traži allow_root) ili TM_PDF_FONT_DIR=<mapa s DejaVuSans.ttf>"; fi
fi

echo "3) pdftotext (provjera kao kod čovjeka)"
if command -v pdftotext >/dev/null; then
  ok "$(command -v pdftotext)"
else
  radi "apt install poppler-utils"
  if apt_paket poppler-utils && command -v pdftotext >/dev/null; then ok "pdftotext instaliran"
  else upoz "nema pdftotext (poppler-utils) — provjera dijakritika ide pypdf-om"; fi
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
      # Debian bez ensurepip-a: pip sustava instalira u venv (isto kao instaliraj-glas.sh).
      python3 -m pip --python "$VENV/bin/python" install -q "${NEDOSTAJE[@]}" \
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
  PROBA_DIR="$HOME/app/tmp/pdf-proba"
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
