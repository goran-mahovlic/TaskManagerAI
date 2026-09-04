#!/usr/bin/env bash
# uskladi_s_regocem.sh — prenesi izmjene iz žive REGOČ instalacije u samostalni paket.
#
# Goran, 04.09.2026.: „nakon tih izmjena treba osvježiti samostalnu verziju i dodati joj
# sve te nove feature koje imamo."
#
# Paket se od žive instalacije razlikuje SAMO po putanjama uvoza: živi TaskWebUI uvozi
# module apsolutno (`/home/klaudio/.claude/regoc/X`), a paket relativno (`./core/X`).
# Zato se prijenos radi skriptom, a ne rukom — ručno prepisivanje je dosad značilo da
# paket zaostane za nekoliko mjeseci i da se razlika više ne da pregledati.
#
#   bash scripts/uskladi_s_regocem.sh            # prenesi i pokaži što se promijenilo
#   REGOC=/putanja bash scripts/uskladi_s_regocem.sh
set -uo pipefail

REGOC="${REGOC:-$HOME/.claude/regoc}"
IZVOR_UI="$REGOC/TaskManagerMD/src"
PAKET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Izvor: $REGOC"
echo "Paket: $PAKET"

# 1) Moduli poslužitelja (isti nazivi, relativni uvozi se prepisuju niže).
for f in TaskWebUI.ts RAGService.ts TaskTelemetry.ts TjedniPregled.ts Tecaj.ts \
         SessionUsage.ts DaemonLiveness.ts RAGProjectStats.ts; do
  [ -f "$IZVOR_UI/$f" ] || { echo "  preskačem $f (nema ga u izvoru)"; continue; }
  cp "$IZVOR_UI/$f" "$PAKET/src/$f"
  echo "  src/$f"
done

# 2) Jezgra (REGOČ moduli koje ploča uvozi).
for f in TaskManagerSQL ProjectManager MessageQueue PauseControl AutonomyQueue QuotaWakeup \
         UnverifiedReport CompletionGuard CostTracker DispatchGuard TaskFieldAliases \
         ChronoOrder LiveDbGuard TaskIdAllocator CriticGate ResearchRagGate; do
  [ -f "$REGOC/$f.ts" ] || continue
  cp "$REGOC/$f.ts" "$PAKET/src/core/$f.ts"
  echo "  src/core/$f.ts"
done

# 2b) RAG biblioteka (PAI): paket je nosi u `src/rag/` jer izvan REGOČ instalacije
#     `~/.claude/skills/...` ne postoji. Bez ovoga paket ostane na staroj inačici i
#     poslužitelj padne na prvom uvozu koji je u međuvremenu dodan.
mkdir -p "$PAKET/src/rag"
for f in rag-memory.ts memory-config.ts; do
  [ -f "$HOME/.claude/skills/CORE/Tools/lib/$f" ] || continue
  cp "$HOME/.claude/skills/CORE/Tools/lib/$f" "$PAKET/src/rag/$f"
  echo "  src/rag/$f"
done

# 3) Zod sheme.
mkdir -p "$PAKET/src/zod/schemas"
cp "$REGOC"/zod/schemas/*.ts "$PAKET/src/zod/schemas/" 2>/dev/null && echo "  src/zod/schemas/*"

# 4) Alati (python) — mjerenja i održavanje koje ploča poziva ili koje se vrti ručno.
mkdir -p "$PAKET/tools"
for f in tjedni_pregled.py agent_telemetry.py vrijednost_inputa.py uvoz_telegram_zadataka.py \
         rag_audit.py rag_tipovi.py rag_archive.py rag_izdvoji.py \
         razvrstaj_prijave.py razvrstaj_pretinac.py session_usage.py run_tokens.py; do
  [ -f "$HOME/app/regoc_system/tools/$f" ] || continue
  cp "$HOME/app/regoc_system/tools/$f" "$PAKET/tools/$f"
  echo "  tools/$f"
done

# 5) Uvozi: živa instalacija ih piše apsolutno (`/home/klaudio/.claude/regoc/X`) ili,
#    unutar same jezgre, relativno prema njoj (`./zod/schemas`). U paketu je raspored
#    drukčiji: ploča je u `src/`, jezgra u `src/core/`, sheme u `src/zod/schemas/`.
#    Prepisivanje radi python jer je pravila više nego što se dade čitljivo složiti sedom.
cd "$PAKET"
python3 - <<'PYEOF'
import glob
import re

REGOC = "/home/klaudio/.claude/regoc/"
# PAI biblioteke (RAG) žive izvan REGOČ mape; paket ih nosi u `src/rag/`.
SKILLS = "/home/klaudio/.claude/skills/CORE/Tools/lib/"

def prepisi(putanja: str, u_jezgri: bool) -> None:
    s = open(putanja, encoding="utf-8").read()
    izvorno = s
    zod = "../zod/schemas" if u_jezgri else "./zod/schemas"
    jezgra = "./" if u_jezgri else "./core/"
    s = s.replace(f"'{REGOC}zod/schemas'", f"'{zod}/index'")
    s = s.replace(f"'{REGOC}zod/schemas/", f"'{zod}/")
    s = s.replace(f"'{REGOC}security/AuditLogger'", f"'{jezgra}AuditLogger'")
    s = s.replace(f"'{REGOC}security/", f"'{jezgra}")
    s = s.replace(f"'{REGOC}", f"'{jezgra}")
    rag = "../rag/" if u_jezgri else "./rag/"
    s = s.replace(f"'{SKILLS}", f"'{rag}")
    if u_jezgri:
        # Unutar ~/.claude/regoc/ sheme su podmapa, u paketu su kat iznad jezgre.
        s = s.replace("'./zod/schemas'", "'../zod/schemas/index'")
        s = s.replace("'./zod/schemas/", "'../zod/schemas/")
    else:
        s = s.replace("'../../zod/schemas/", "'./zod/schemas/")
    if s != izvorno:
        open(putanja, "w", encoding="utf-8").write(s)
        print(f"  putanje: {putanja}")

for f in glob.glob("src/*.ts"):
    prepisi(f, u_jezgri=False)
for f in glob.glob("src/core/*.ts"):
    prepisi(f, u_jezgri=True)
PYEOF

echo
echo "Preostale apsolutne putanje na REGOČ (moraju biti samo zadane vrijednosti, ne uvozi):"
grep -rn "\.claude/regoc" src/*.ts src/core/*.ts 2>/dev/null | grep -v "^\s*//" | grep "import" | head -5 \
  || echo "  nema uvoza s apsolutnom putanjom — u redu"

echo
echo "Git status paketa:"
git status --short | head -20
