#!/bin/bash
# pg0-openssl.sh INSTALACIJA [--suho] — PostgreSQL iz pg0 na macOS-u bez Homebrewova OpenSSL-a.
#
# pg0 0.15.2 na macOS-u raspakira PostgreSQL (theseus-rs postgresql-binaries) vezan uz Homebrewov
# OpenSSL: bin/postgres i lib/libpq.5.dylib traže /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib
# (izmjereno na Mac čvoru, K8 krug 1: dyld „Library not loaded", K2.18-baze-pgvector izlaz 6).
# Homebrew na čvoru nije obavezan ni nužno korisnikov, a DYLD_* okolina ne pomaže jer initdb zove
# `postgres -V` kroz /bin/sh, kojem SIP briše DYLD_* varijable.
#
# Zato instalacija postaje samostalna:
#   1. libssl.3.dylib i libcrypto.3.dylib (OpenSSL 3.5.8, delocirane: libssl → @loader_path/libcrypto)
#      iz javnog wheela psycopg-binary s PyPI-ja, uz pinan sha256 → INSTALACIJA/lib,
#   2. reference na …/opt/openssl@3/lib (arm64 /opt/homebrew, Intel /usr/local) → @loader_path,
#   3. ad-hoc potpis promijenjenih datoteka (arm64 ne pokreće Mach-O s pokvarenim potpisom),
#   4. proba: bin/postgres --version.
# Diraju se samo datoteke s vanjskom referencom; drugo pokretanje ispiše ISTO.
#
# Izlaz: 0 (zadnji redak ISTO | PROMIJENJENO) · 2 uporaba · 4 mreža · 5 ostalo.
# Za testove: TM_PG0_OPENSSL_URL, TM_PG0_OPENSSL_SHA256.
set -uo pipefail

INST="${1:-}"; SUHO=0; [ "${2:-}" = --suho ] && SUHO=1
if [ -z "$INST" ] || [ ! -d "$INST/bin" ] || [ ! -d "$INST/lib" ]; then
  echo "uporaba: pg0-openssl.sh INSTALACIJA [--suho]   (INSTALACIJA = …/.pg0/installation/<verzija>)" >&2; exit 2
fi
INST="${INST%/}"

PSYCOPG_VERZIJA="3.3.6"
case "$(uname -m)" in
  arm64)  URL="https://files.pythonhosted.org/packages/0a/b9/4283b785339e8e2318d03048994b093d650ea6289fabaa806b765dc0d449/psycopg_binary-3.3.6-cp313-cp313-macosx_11_0_arm64.whl"
          SHA="373704aea331d3f3e3402c125a1543f5875e2986ebb54f97d1647942161f803f" ;;
  x86_64) URL="https://files.pythonhosted.org/packages/b4/c3/c072584b69ad44a747b448cfc9766fecb8aae56e372a017e2ef668790057/psycopg_binary-3.3.6-cp313-cp313-macosx_10_13_x86_64.whl"
          SHA="5ad8f35e67cc16d1fad1fa8c88972dc9b3a3141ea67897399904edab96a301b6" ;;
  *)      URL=""; SHA="" ;;
esac
URL="${TM_PG0_OPENSSL_URL:-$URL}"; SHA="${TM_PG0_OPENSSL_SHA256:-$SHA}"
LIBS=(libssl.3.dylib libcrypto.3.dylib)
PREFIKSI=(/opt/homebrew /usr/local)

# Mach-O datoteke koje traže OpenSSL izvan instalacije
VEZANE=()
while IFS= read -r -d '' f; do
  otool -L "$f" 2>/dev/null | grep -Eq '^[[:space:]]+(/opt/homebrew|/usr/local)/opt/openssl@3/lib/lib(ssl|crypto)\.3\.dylib ' && VEZANE+=("$f")
done < <(find "$INST/bin" "$INST/lib" -type f ! -name '*.a' -print0)

if [ "${#VEZANE[@]}" = 0 ]; then echo "  nijedna binarka ne traži vanjski OpenSSL"; echo ISTO; exit 0; fi
echo "  vanjski OpenSSL traži ${#VEZANE[@]} datoteka (npr. ${VEZANE[0]#"$INST"/})"
if [ "$SUHO" = 1 ]; then
  echo "  (suho) libssl/libcrypto iz psycopg-binary $PSYCOPG_VERZIJA → $INST/lib, reference → @loader_path, codesign -s -"
  echo PROMIJENJENO; exit 0
fi

ima_lib() { [ -f "$INST/lib/libssl.3.dylib" ] && [ -f "$INST/lib/libcrypto.3.dylib" ]; }
if ! ima_lib; then
  [ -n "$URL" ] || { echo "  GREŠKA: nema izvora OpenSSL-a za arhitekturu $(uname -m)"; exit 5; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pg0-openssl.XXXXXX")" || exit 5
  trap 'rm -rf "$tmp"' EXIT
  for i in 1 2 3; do
    curl -fsSL --max-time 120 -o "$tmp/w.whl" "$URL" && break
    [ "$i" = 3 ] && { echo "  GREŠKA: $URL nije dostupan nakon 3 pokušaja"; exit 4; }
    echo "  dohvat $URL nije uspio (pokušaj $i/3) — čekam"; sleep $(( i == 1 ? 5 : 15 ))
  done
  ima="$( (shasum -a 256 "$tmp/w.whl" 2>/dev/null || sha256sum "$tmp/w.whl") | cut -c1-64)"
  [ "$ima" = "$SHA" ] || { echo "  GREŠKA: sha256 wheela je $ima, očekivan $SHA — ništa nije promijenjeno"; exit 5; }
  unzip -j -o -q "$tmp/w.whl" "${LIBS[@]/#/psycopg_binary/.dylibs/}" -d "$tmp/lib" \
    || { echo "  GREŠKA: u wheelu nema ${LIBS[*]}"; exit 5; }
  for l in "${LIBS[@]}"; do cp "$tmp/lib/$l" "$INST/lib/$l" && chmod 755 "$INST/lib/$l" || exit 5; done
  echo "  ${LIBS[*]} (psycopg-binary $PSYCOPG_VERZIJA, sha256 provjeren) → $INST/lib"
fi

for f in "${VEZANE[@]}"; do
  # bin/x → @loader_path/../lib, lib/x → @loader_path, lib/a/x → @loader_path/../../lib …
  rel="${f#"$INST"/}"; dir="${rel%/*}"
  if [ "$dir" = lib ]; then cilj="@loader_path"
  else gore=""; d="$dir"; while [ -n "$d" ]; do gore="$gore../"; case "$d" in */*) d="${d%/*}" ;; *) d="" ;; esac; done; cilj="@loader_path/${gore}lib"; fi
  promjene=()
  for p in "${PREFIKSI[@]}"; do for l in "${LIBS[@]}"; do promjene+=(-change "$p/opt/openssl@3/lib/$l" "$cilj/$l"); done; done
  install_name_tool "${promjene[@]}" "$f" 2>/dev/null || { echo "  GREŠKA: install_name_tool $rel"; exit 5; }
  codesign --force -s - "$f" >/dev/null 2>&1 || { echo "  GREŠKA: codesign $rel"; exit 5; }
  echo "  $rel → $cilj"
done

"$INST/bin/postgres" --version >/dev/null 2>&1 || { echo "  GREŠKA: $INST/bin/postgres se ni nakon popravka ne pokreće"; exit 5; }
echo "  $("$INST/bin/postgres" --version) radi bez Homebrewa"
echo PROMIJENJENO
