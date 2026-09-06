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

# 1b) Rječnici sučelja. Bez njih paket pokaže samo ključeve, pa idu uz TaskWebUI.ts.
#     Postojeći `config/jezik.json` se NE prepisuje — to je izbor instalacije, ne kod.
mkdir -p "$PAKET/locales" "$PAKET/config"
for f in "$REGOC/TaskManagerMD/locales/"*.json; do
  [ -e "$f" ] || continue
  cp "$f" "$PAKET/locales/$(basename "$f")"
  echo "  locales/$(basename "$f")"
done
[ -f "$PAKET/config/jezik.json" ] || echo '{"zadani":"en"}' > "$PAKET/config/jezik.json"

# 1c) Alati koje ploča poziva kao vanjske procese (odlučitelj, dežurni).
mkdir -p "$PAKET/tools"
for f in odlucitelj.py dezurni.py; do
  for izvor in "$HOME/app/regoc_system/tools/$f" "$REGOC/tools/$f"; do
    [ -f "$izvor" ] || continue
    cp "$izvor" "$PAKET/tools/$f"; echo "  tools/$f"; break
  done
done

# 1d) VLASTITO U PAKETU. Ove datoteke nastale su ovdje (U6/TASK-4266) i u živoj
#     instalaciji ih nema ili ondje imaju putanje na `~/.claude/regoc`. Otkrivanje po
#     uvozima ih ne bi ni našlo, ali `IngestGateConfig.ts` bi se vratio kroz uvoz iz
#     prekopiranog `TaskWebUI.ts` — a on nosi putanju koja izvan REGOČ stroja ne postoji.
VLASTITO_U_PAKETU="src/core/Ingest.ts src/core/IngestConfig.ts src/core/IngestTemplate.ts src/core/Rjecnici.ts"

# 2) Jezgra: moduli se OTKRIVAJU iz uvoza, ne održavaju ručnim popisom.
#
#    Ručni popis je 04.09.2026. slomio paket: agent je u živu instalaciju dodao
#    `TaskCreateBreaker`, skripta ga nije poznavala, i paket se prestao pokretati s
#    „Cannot find module". Sada se prolazi kroz uvoze, pa i kroz uvoze tih modula
#    (tranzitivno) — novi modul se povuče sam.
python3 - "$REGOC" "$PAKET" <<'PY'
import pathlib, re, shutil, sys

regoc, paket = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
(paket / "src/core").mkdir(parents=True, exist_ok=True)
UI = regoc / "TaskManagerMD/src"

# Tri oblika uvoza koja se pojavljuju: './core/X', './X' (uz ploču) i puna REGOČ putanja.
#
# Ime modula smije nositi PODMAPU ('models/ClassifierModel', 'types/task-types').
# 05.09.2026.: bez toga je paket prestao graditi — živi TaskWebUI uvezao je
# `~/.claude/regoc/models/ClassifierModel`, otkrivanje ga nije vidjelo (uzorak je tražio
# samo ravna imena), pa je `bun build` pao na „Could not resolve". Isti razred kvara koji
# je 04.09. napravio `TaskCreateBreaker`, samo kat dublje.
UVOZ = re.compile(r"""from\s+['"](?:\./core/|\./|[^'"]*\.claude/regoc/)([A-Za-z0-9_][A-Za-z0-9_./-]*)['"]""")

def uvozi(tekst):
    return set(UVOZ.findall(tekst))

def nadji(ime):
    """Modul može živjeti uz ploču ili u korijenu REGOČ instalacije."""
    for kandidat in (UI / f"{ime}.ts", regoc / f"{ime}.ts"):
        if kandidat.exists():
            return kandidat
    return None

red, vidjeni, preneseno = set(), set(), []
for f in (paket / "src").glob("*.ts"):
    red |= uvozi(f.read_text(encoding="utf-8", errors="replace"))

while red:
    ime = red.pop()
    if ime in vidjeni:
        continue
    vidjeni.add(ime)
    # Zod sheme imaju vlastiti korak (3) i vlastito mjesto (`src/zod/schemas`);
    # bez ovoga ih otkrivanje kopira i u `src/core/zod/` kao mrtav drugi primjerak.
    if ime.startswith(("zod/", "rag/")):
        continue
    izvor = nadji(ime)
    if not izvor:
        continue
    tekst = izvor.read_text(encoding="utf-8", errors="replace")
    # Modul uz ploču ostaje uz ploču; ostalo ide u jezgru. Podmapa se čuva.
    uz_plocu = str(izvor).startswith(str(UI) + "/")
    cilj = (paket / "src" / f"{ime}.ts") if uz_plocu else (paket / "src/core" / f"{ime}.ts")
    cilj.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(izvor, cilj)
    preneseno.append(str(cilj.relative_to(paket)))
    red |= uvozi(tekst) - vidjeni

for put in sorted(preneseno):
    print(f"  {put}")
print(f"  ({len(preneseno)} modula otkriveno iz uvoza)")
PY

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
import os
import re

REGOC = "/home/klaudio/.claude/regoc/"
# PAI biblioteke (RAG) žive izvan REGOČ mape; paket ih nosi u `src/rag/`.
SKILLS = "/home/klaudio/.claude/skills/CORE/Tools/lib/"


def prefiks(od_mape: str, do_mape: str) -> str:
    """Relativni prefiks s trailing '/' — './' za istu mapu, '../' za kat iznad."""
    rel = os.path.relpath(do_mape, od_mape).rstrip("/")
    if rel == ".":
        return "./"
    # Bez vodećeg './' bun uvoz čita kao naziv paketa ("Maybe you need to bun install").
    return (rel if rel.startswith("..") else "./" + rel) + "/"


def prepisi(putanja: str) -> None:
    """Uvozi se preračunavaju iz DUBINE datoteke, ne iz zastavice `u_jezgri`.

    Modul smije živjeti u podmapi (`src/core/models/…`), pa fiksna dva slučaja
    („uz ploču" / „u jezgri") nisu dovoljna — prefiks se računa relativno.
    """
    mapa = os.path.dirname(putanja) or "."
    u_jezgri = putanja.startswith("src/core/")
    jezgra = prefiks(mapa, "src/core")          # kamo idu moduli iz korijena REGOČ-a
    zod = prefiks(mapa, "src/zod/schemas").rstrip("/")
    rag = prefiks(mapa, "src/rag")

    s = open(putanja, encoding="utf-8").read()
    izvorno = s
    s = s.replace(f"'{REGOC}zod/schemas'", f"'{zod}/index'")
    s = s.replace(f"'{REGOC}zod/schemas/", f"'{zod}/")
    s = s.replace(f"'{REGOC}security/AuditLogger'", f"'{jezgra}AuditLogger'")
    s = s.replace(f"'{REGOC}security/", f"'{jezgra}")
    s = s.replace(f"'{REGOC}", f"'{jezgra}")
    s = s.replace(f"'{SKILLS}", f"'{rag}")
    if u_jezgri:
        # Unutar ~/.claude/regoc/ sheme su podmapa, u paketu su izvan jezgre.
        s = s.replace("'./zod/schemas'", f"'{zod}/index'")
        s = s.replace("'./zod/schemas/", f"'{zod}/")
    else:
        s = s.replace("'../../zod/schemas/", f"'{zod}/")
    if s != izvorno:
        open(putanja, "w", encoding="utf-8").write(s)
        print(f"  putanje: {putanja}")


# Podmape ulaze u obradu (`**`) — inače novi `src/core/models/*.ts` ostane s
# apsolutnom REGOČ putanjom i paket padne izvan ovog stroja.
for f in sorted(glob.glob("src/**/*.ts", recursive=True)):
    if f.startswith(("src/zod/", "src/rag/")):
        continue        # tuđe biblioteke se prenose doslovno
    prepisi(f)
PYEOF

# 6) U6/TASK-4266: pet datoteka koje prijenos DONOSI CIJELE nose i izmjene kojih u
#    živoj instalaciji nema — rutu `POST /api/ingest` i razrješenje putanja preko
#    `TM_DB`/`TM_HOME` (bez njega paket ne radi izvan REGOČ stroja). Zato se zakrpa
#    vraća, i to glasno: tiho izgubljena ruta bila bi kvar koji se primijeti tek kad
#    pozivatelj dobije 404.
echo
if grep -q "'/api/ingest'" src/TaskWebUI.ts 2>/dev/null; then
  echo "U6: ruta POST /api/ingest već je u prenesenoj datoteci — zakrpa nije potrebna"
elif [ -f scripts/zakrpe/u6-ingest.patch ]; then
  if patch -p1 --forward --silent --no-backup-if-mismatch < scripts/zakrpe/u6-ingest.patch \
     || git apply --3way scripts/zakrpe/u6-ingest.patch 2>/dev/null; then
    echo "U6: zakrpa vraćena (scripts/zakrpe/u6-ingest.patch)"
    rm -f src/IngestGateConfig.ts   # paket koristi src/core/IngestConfig.ts
    find src -name '*.orig' -o -name '*.rej' | while read -r r; do echo "  ostatak: $r"; done
  else
    echo "!! U6 ZAKRPA NIJE PROŠLA: scripts/zakrpe/u6-ingest.patch"
    echo "   POST /api/ingest i TM_HOME putanje NISU u prenesenim datotekama."
    echo "   Vrati ručno (docs/API.md, odjeljak „Ulaz\") pa osvježi zakrpu:"
    echo "     git diff <zadnji-cisti-commit> -- src/TaskWebUI.ts src/core/TaskManagerSQL.ts \\"
    echo "        src/core/ProjectManager.ts src/core/CostTracker.ts src/core/MessageQueue.ts \\"
    echo "        > scripts/zakrpe/u6-ingest.patch"
  fi
fi

# 7) Vlastite datoteke paketa ne smiju ostati pregažene starijom inačicom.
for f in $VLASTITO_U_PAKETU; do
  [ -f "$f" ] || echo "  !! NEDOSTAJE $f (vlastito u paketu — vrati iz gita)"
done

echo
echo "Preostale apsolutne putanje na REGOČ (moraju biti samo zadane vrijednosti, ne uvozi):"
grep -rn "\.claude/regoc" src/*.ts src/core/*.ts 2>/dev/null | grep -v "^\s*//" | grep "import" | head -5 \
  || echo "  nema uvoza s apsolutnom putanjom — u redu"

echo
echo "Git status paketa:"
git status --short | head -20
