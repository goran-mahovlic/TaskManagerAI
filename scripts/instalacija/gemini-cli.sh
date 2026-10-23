#!/usr/bin/env bash
# gemini-cli.sh — Gemini CLI bez Homebrewa i bez sudo-a (TASK-5733, iz TASK-5730).
#
#   bash scripts/instalacija/gemini-cli.sh [--suho]
#
# Isti put koji je na Macu napravljen ručno:
#   1. Node LTS (linija $TM_NODE_LINIJA, zadano v22) kao tarball u ~/.local/node, uz provjeru
#      SHA256 iz SHASUMS256.txt izdanja,
#   2. npm install -g --prefix ~/.local/node @google/gemini-cli,
#   3. poveznice ~/.local/bin/{node,gemini} → ~/.local/node/bin (usluga pod systemd/launchd
#      često nema ~/.local/node/bin u PATH-u; `gemini` ima shebang `env node`),
#   4. ~/.gemini/settings.json: selectedAuthType = gemini-api-key (ostali ključevi ostaju).
# Ključ (GEMINI_API_KEY) se NE upisuje ovdje — ide kroz Config → Tajne ili scripts/tajna.ts.
#
# Idempotentno: svaki dio prvo mjeri. Izlazni retci za install.sh:
#   PROMJENA                — nešto je napravljeno (ili bi bilo, uz --suho)
#   MANIFEST <put> <vrsta>  — stvoreno ovom instalacijom (za --do-nule)
#   UPOZORENJE <tekst>
# Okolina: TM_NODE_DIST (adresa izdanja, zadano https://nodejs.org/dist/latest-<linija>.x),
#          TM_INSTALL_OS / TM_INSTALL_ARCH (podmetanje platforme u testu).
# Piše se za bash 3.2 (macOS /bin/bash).
# Izlaz: 0 · 2 pogrešna uporaba · 3 nepodržana platforma · 4 mreža · 5 provjera/instalacija.
set -uo pipefail

SUHO=0
for a in "$@"; do
  case "$a" in
    --suho) SUHO=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "nepoznat argument: $a" >&2; exit 2 ;;
  esac
done

LINIJA="${TM_NODE_LINIJA:-v22}"
DIST="${TM_NODE_DIST:-https://nodejs.org/dist/latest-$LINIJA.x}"
NODE_DIR="$HOME/.local/node"
BIN_DIR="$HOME/.local/bin"
PAKET_NPM="@google/gemini-cli"
MIN_NODE=20   # @google/gemini-cli traži Node 20+

suho() { [ "$SUHO" = 1 ]; }
sha256() { (shasum -a 256 "$1" 2>/dev/null || sha256sum "$1") | cut -c1-64; }
dohvati() {
  local url="$1" cilj="$2" i
  for i in 1 2 3; do
    curl -fsSL --retry 0 --max-time 300 -o "$cilj" "$url" && return 0
    [ "$i" = 3 ] && break
    echo "    dohvat $url nije uspio (pokušaj $i/3) — čekam"; sleep $(( i * 5 ))
  done
  echo "    GREŠKA: $url nije dostupan nakon 3 pokušaja"; return 4
}

os="$(printf '%s' "${TM_INSTALL_OS:-$(uname -s)}" | tr 'A-Z' 'a-z')"
arch="${TM_INSTALL_ARCH:-$(uname -m)}"
case "$os" in darwin|linux) ;; *) echo "    GREŠKA: OS $os nije podržan"; exit 3 ;; esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "    GREŠKA: arhitektura $arch nije podržana"; exit 3 ;;
esac
PLATFORMA="$os-$arch"

# ── 1. Node ──────────────────────────────────────────────────────────────────
node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'; }
m="$( [ -x "$NODE_DIR/bin/node" ] && node_major "$NODE_DIR/bin/node" )"
if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE" ]; then
  echo "    node: $("$NODE_DIR/bin/node" --version) u $NODE_DIR (već postoji)"
elif suho; then
  echo "    (suho) preuzela bih $DIST/SHASUMS256.txt i node-$LINIJA.*-$PLATFORMA.tar.gz, provjerila SHA256 i raspakirala u $NODE_DIR"
  echo PROMJENA
else
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tm-node-XXXXXX")" || exit 5
  trap 'rm -rf "$tmp"' EXIT
  dohvati "$DIST/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || exit 4
  red="$(grep -E "  node-v[0-9.]+-$PLATFORMA\.tar\.gz\$" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$red" ] || { echo "    GREŠKA: u SHASUMS256.txt nema tarballa za $PLATFORMA"; exit 5; }
  ocekivano="${red%%  *}"; ime="${red##*  }"
  dohvati "$DIST/$ime" "$tmp/$ime" || exit 4
  dobiveno="$(sha256 "$tmp/$ime")"
  if [ "$dobiveno" != "$ocekivano" ]; then
    echo "    GREŠKA: SHA256 $ime se ne slaže (očekivano $ocekivano, dobiveno $dobiveno) — ništa nije raspakirano"; exit 5
  fi
  echo "    SHA256 $ime ✓"
  mkdir -p "$tmp/x" && tar -xzf "$tmp/$ime" -C "$tmp/x" || { echo "    GREŠKA: raspakiravanje $ime"; exit 5; }
  izvor="$tmp/x/${ime%.tar.gz}"
  [ -x "$izvor/bin/node" ] || { echo "    GREŠKA: u $ime nema bin/node"; exit 5; }
  if [ -e "$NODE_DIR" ]; then
    # Stari ili polomljeni Node se ne briše — ostaje uz oznaku vremena.
    staro="$NODE_DIR.staro-$(date '+%Y%m%d-%H%M%S')"
    mv "$NODE_DIR" "$staro" && echo "UPOZORENJE stari $NODE_DIR premješten u $staro"
  fi
  mkdir -p "$(dirname "$NODE_DIR")" && mv "$izvor" "$NODE_DIR" || { echo "    GREŠKA: premještanje u $NODE_DIR"; exit 5; }
  echo "    node: $("$NODE_DIR/bin/node" --version) u $NODE_DIR"
  echo "MANIFEST $NODE_DIR mapa"
  echo PROMJENA
fi

# ── 2. @google/gemini-cli ───────────────────────────────────────────────────
if [ -x "$NODE_DIR/bin/gemini" ]; then
  echo "    gemini: $NODE_DIR/bin/gemini (već postoji)"
elif suho; then
  echo "    (suho) npm install -g --prefix $NODE_DIR $PAKET_NPM"
  echo PROMJENA
else
  echo "    ▶ npm install -g --prefix $NODE_DIR $PAKET_NPM"
  PATH="$NODE_DIR/bin:$PATH" "$NODE_DIR/bin/npm" install -g --prefix "$NODE_DIR" "$PAKET_NPM" 2>&1 | tail -5 | sed 's/^/      /'
  [ -x "$NODE_DIR/bin/gemini" ] || { echo "    GREŠKA: gemini se nije instalirao u $NODE_DIR/bin"; exit 5; }
  echo "    gemini: $NODE_DIR/bin/gemini"
  echo PROMJENA
fi

# ── 3. poveznice u ~/.local/bin ─────────────────────────────────────────────
for b in node gemini; do
  cilj="$BIN_DIR/$b"; izvor="$NODE_DIR/bin/$b"
  if [ -L "$cilj" ] && [ "$(readlink "$cilj")" = "$izvor" ]; then
    echo "    $cilj → $izvor (isto)"
  elif [ -e "$cilj" ] || [ -L "$cilj" ]; then
    # Tuđa datoteka se ne prepisuje; gemini se svejedno nalazi u ~/.local/node/bin.
    echo "UPOZORENJE $cilj već postoji i nije poveznica na $izvor — ostavljen"
  elif suho; then
    echo "    (suho) ln -s $izvor $cilj"
    echo PROMJENA
  else
    mkdir -p "$BIN_DIR" && ln -s "$izvor" "$cilj" || { echo "    GREŠKA: poveznica $cilj"; exit 5; }
    echo "    $cilj → $izvor"
    echo "MANIFEST $cilj datoteka"
    echo PROMJENA
  fi
done

# ── 4. ~/.gemini/settings.json: autentikacija API ključem ───────────────────
SET="$HOME/.gemini/settings.json"
if [ -f "$SET" ] && grep -q '"selectedAuthType"[[:space:]]*:[[:space:]]*"gemini-api-key"' "$SET"; then
  echo "    $SET: selectedAuthType=gemini-api-key (isto)"
elif suho; then
  echo "    (suho) upisala bih selectedAuthType=gemini-api-key u $SET (ostali ključevi ostaju)"
  echo PROMJENA
else
  novo=0; [ -e "$SET" ] || novo=1
  mkdir -p "$(dirname "$SET")"
  # Spajanje JSON-a Node-om koji je upravo instaliran (na svježem Macu python3 ne mora postojati).
  "$NODE_DIR/bin/node" -e '
    const fs = require("fs"), p = process.argv[1]
    let s = {}
    if (fs.existsSync(p)) { try { s = JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { console.error("    GREŠKA: " + p + " nije ispravan JSON"); process.exit(5) } }
    s.selectedAuthType = "gemini-api-key"
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
  ' "$SET" || exit 5
  echo "    $SET: selectedAuthType=gemini-api-key"
  [ "$novo" = 1 ] && echo "MANIFEST $SET datoteka"
  echo PROMJENA
fi
exit 0
