#!/usr/bin/env bash
# install-agents.sh — postavi zadani tim agenata (REGOČ) i provjeri njihove vještine.
#
# Goran, 04.09.2026.: „trebamo kao default nuditi opciju za instalaciju naših agenata …
# da se oni mogu automatski instalirati zajedno sa svojim skilovima i alatima. Mi ne bismo
# uključivali alate i skilove u task manager — ali možemo staviti link na PAI sistem."
#
# ŠTO OVA SKRIPTA RADI
#   1. upiše registar agenata (`agents/regoc-tim.json`) na mjesto gdje ga sustav čita,
#   2. provjeri koje vještine ti agenti traže i koje od njih na stroju nedostaju,
#   3. po želji dohvati PAI repozitorij i iz njega instalira vještine koje nedostaju.
#
# ŠTO NE RADI: ne nosi vještine ni alate u sebi. Paket ostaje ploča i baza; vještine su tuđe
# djelo i žive u svom repozitoriju, pa se odande i uzimaju.
#
#   bash scripts/install-agents.sh                 # upiši agente, ispiši što nedostaje
#   bash scripts/install-agents.sh --vjestine      # + dohvati PAI i instaliraj nedostajuće
#   bash scripts/install-agents.sh --u ~/moj.json  # upiši u drugu datoteku (ili TM_AGENTS_REGISTRY)
set -uo pipefail

KORIJEN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IZVOR="$KORIJEN/agents/regoc-tim.json"
# TM_AGENTS_REGISTRY, ne TM_AGENTS: `TM_AGENTS` je popis dopuštenih nositelja zadatka
# (docs/INSTALL.md §5.1), a ovo je PUTANJA do registra PAI agenata. Isto ime za dvije
# stvari bio je nalaz N1 iz docs/QA_E2E_SAMOSTALNOST_2026-09-10.md.
# Zadano isto mjesto koje ploča čita (konfigPutanja u src/core/paths.ts): $TM_HOME/config
# ako je TM_HOME zadan, inače config/ uz paket (TASK-5108).
if [ -n "${TM_HOME:-}" ]; then ZADANI_REGISTAR="$TM_HOME/config/REGOC_AGENTS.json"
else ZADANI_REGISTAR="$KORIJEN/config/REGOC_AGENTS.json"; fi
ODREDISTE="${TM_AGENTS_REGISTRY:-$ZADANI_REGISTAR}"
VJESTINE_DIR="${TM_SKILLS_DIR:-$HOME/.claude/skills}"
PAI_REPO="${PAI_REPO:-https://github.com/danielmiessler/PAI}"
PAI_KOPIJA="${PAI_KOPIJA:-$HOME/.cache/pai-izvor}"
INSTALIRAJ_VJESTINE=0
PRIKAZI_ALATE=0
INSTALIRAJ_ALATE=0

for a in "$@"; do
  case "$a" in
    --vjestine) INSTALIRAJ_VJESTINE=1 ;;
    --alati) PRIKAZI_ALATE=1 ;;
    --instaliraj) INSTALIRAJ_ALATE=1 ;;
    --u) shift; ODREDISTE="${1:-$ODREDISTE}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
  shift 2>/dev/null || true
done

[ -f "$IZVOR" ] || { echo "GREŠKA: nema $IZVOR"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "GREŠKA: treba python3"; exit 1; }

echo "Tim agenata: $IZVOR"
python3 - "$IZVOR" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k, a in d["agents"].items():
    print(f"  {k:10} {a.get('role','')[:26]:28} model={a.get('model','?'):7} "
          f"vještine: {', '.join(a.get('skills', [])) or '—'}")
PYEOF

# ── 1. Registar ───────────────────────────────────────────────────────────────
if [ -f "$ODREDISTE" ]; then
  # Postojeći registar se NE pregazi: dopune se samo agenti kojih nema. Tuđe izmjene
  # (drugi model, vlastiti agent) ostaju — instalacija ne smije brisati nečiji rad.
  PRICUVA="$ODREDISTE.pricuva-$(date +%Y%m%d_%H%M%S)"
  cp "$ODREDISTE" "$PRICUVA"
  python3 - "$IZVOR" "$ODREDISTE" <<'PYEOF'
import json, sys
novi = json.load(open(sys.argv[1], encoding="utf-8"))
try:
    stari = json.load(open(sys.argv[2], encoding="utf-8"))
except Exception:
    stari = {}
stari.setdefault("agents", {})
dodani = []
for k, a in novi["agents"].items():
    if k not in stari["agents"]:
        stari["agents"][k] = a
        dodani.append(k)
stari.setdefault("rag_collections", {})
for k, a in novi["agents"].items():
    stari["rag_collections"].setdefault(k, a.get("rag_collection", f"agent_{k}"))
json.dump(stari, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"  registar: {sys.argv[2]} — dodano {len(dodani)} "
      f"({', '.join(dodani) if dodani else 'ništa novo, postojeći ostaju netaknuti'})")
PYEOF
  echo "  pričuva: $PRICUVA"
else
  mkdir -p "$(dirname "$ODREDISTE")"
  cp "$IZVOR" "$ODREDISTE"
  echo "  registar: $ODREDISTE (novi)"
fi

# ── 1b. Tijekovi rada i alati ─────────────────────────────────────────────────
# Goran, 04.09.2026.: „htio bih da naši agenti koriste workflow po potrebi … isto tako, što je
# s alatima? Moramo imati popis alata dostupnih koji se onda mogu povući."
KATALOG_WF="$KORIJEN/agents/workflows.json"
KATALOG_ALATA="$KORIJEN/agents/alati.json"

if [ -f "$KATALOG_WF" ]; then
  echo
  echo "Tijekovi rada (agents/workflows.json) — odabir: python3 tools/odaberi_workflow.py --naslov '…'"
  python3 - "$KATALOG_WF" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for wid, w in d["workflows"].items():
    koraci = " → ".join(s["agent"] for s in w["koraci"])
    print(f"  {wid:20} od težine {w.get('najmanja_tezina', 0):>3}: {koraci}")
PYEOF
fi

if [ "$PRIKAZI_ALATE" = "1" ] && [ -f "$KATALOG_ALATA" ]; then
  echo
  echo "Alati (agents/alati.json) — paket ih ne nosi, samo zna odakle dolaze:"
  python3 - "$KATALOG_ALATA" "$INSTALIRAJ_ALATE" <<'PYEOF'
import json, shlex, subprocess, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
instaliraj = sys.argv[2] == "1"
for aid, a in d["alati"].items():
    provjera = a.get("provjera")
    ima = False
    if provjera:
        try:
            ima = subprocess.run(provjera, shell=True, capture_output=True,
                                 timeout=20).returncode == 0
        except Exception:
            ima = False
    oznaka = "✓" if ima else "—"
    print(f"  {oznaka} {a['naziv']:26} {a.get('vrsta',''):10} {a.get('svrha','')[:52]}")
    if not ima:
        print(f"      izvor:      {a.get('izvor','?')}")
        print(f"      instalacija: {a.get('instalacija','?')}")
        if instaliraj and a.get("vrsta") in ("mcp", "python", "posluzitelj"):
            print("      pokrećem…")
            try:
                r = subprocess.run(a["instalacija"], shell=True, capture_output=True, timeout=600)
                print("      " + ("u redu" if r.returncode == 0 else
                                  f"nije uspjelo: {r.stderr.decode()[-160:].strip()}"))
            except Exception as e:
                print(f"      nije uspjelo: {e}")
PYEOF
fi

# ── 2. Vještine — što nedostaje ───────────────────────────────────────────────
TRAZENE=$(python3 -c "
import json,sys
d=json.load(open('$IZVOR', encoding='utf-8'))
print(' '.join(d['_meta']['trazene_vjestine']))")

NEDOSTAJE=""
IMA=0
for v in $TRAZENE; do
  if [ -d "$VJESTINE_DIR/$v" ]; then IMA=$((IMA+1)); else NEDOSTAJE="$NEDOSTAJE $v"; fi
done
echo
echo "Vještine u $VJESTINE_DIR: $IMA od $(echo $TRAZENE | wc -w)"
if [ -z "${NEDOSTAJE// /}" ]; then
  echo "  sve tražene vještine postoje"
  exit 0
fi
echo "  nedostaje:$NEDOSTAJE"

if [ "$INSTALIRAJ_VJESTINE" = "0" ]; then
  cat <<TXT

Vještine nisu dio ovog paketa — dohvaćaju se iz izvora koji ih održava:

  PAI (osnovne vještine i alati):   $PAI_REPO
  Claude Code dodatci:              claude plugins install <ime>

Automatski (dohvat PAI-ja i kopiranje onoga što nedostaje):

  bash scripts/install-agents.sh --vjestine

TXT
  exit 0
fi

# ── 3. Dohvat PAI-ja i instalacija onoga što nedostaje ────────────────────────
echo
if [ -d "$PAI_KOPIJA/.git" ]; then
  echo "  osvježavam $PAI_KOPIJA"
  git -C "$PAI_KOPIJA" pull --quiet 2>/dev/null || echo "    (pull nije uspio — koristim zatečeno)"
else
  echo "  dohvaćam $PAI_REPO → $PAI_KOPIJA"
  git clone --depth 1 --quiet "$PAI_REPO" "$PAI_KOPIJA" 2>/dev/null \
    || { echo "  GREŠKA: dohvat nije uspio (nema mreže?). Vještine instaliraj ručno iz $PAI_REPO"; exit 1; }
fi

mkdir -p "$VJESTINE_DIR"
POSTAVLJENO=0
for v in $NEDOSTAJE; do
  # PAI drži vještine u `.claude/skills/<Ime>`; tražimo i varijantu bez točke radi
  # razlika među inačicama repozitorija.
  for kandidat in "$PAI_KOPIJA/.claude/skills/$v" "$PAI_KOPIJA/skills/$v"; do
    [ -d "$kandidat" ] || continue
    cp -r "$kandidat" "$VJESTINE_DIR/$v" && { echo "  + $v"; POSTAVLJENO=$((POSTAVLJENO+1)); }
    break
  done
done
echo "  instalirano: $POSTAVLJENO"

JOS=""
for v in $NEDOSTAJE; do [ -d "$VJESTINE_DIR/$v" ] || JOS="$JOS $v"; done
[ -z "${JOS// /}" ] || {
  echo "  i dalje nedostaje:$JOS"
  echo "  (te vještine nisu u PAI repozitoriju — potraži ih kod autora ili napiši vlastite,"
  echo "   v. docs/SUSTAV.md, sloj 3)"
}
