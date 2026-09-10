# Agenti, vještine i alati

TaskManagerAI **namjerno ne nosi vještine ni alate**. Oni su tuđe djelo, mijenjaju se brže od
ploče i svaka bi ih kopija u ovom repozitoriju za mjesec dana činila zastarjelima. Paket nosi
samo **popis tko su agenti i što im treba**, a sve ostalo dohvaća iz izvora koji to održava.

| Što | Gdje živi | Kako doći |
|---|---|---|
| Ploča, baza, API | ovaj repozitorij | `bash scripts/install.sh` |
| Popis agenata (uloge, modeli, vještine) | `agents/regoc-tim.json` | `bash scripts/install-agents.sh` |
| Vještine i alati (CORE, System, TDD…) | [PAI](https://github.com/danielmiessler/PAI) | `bash scripts/install-agents.sh --vjestine` |
| Dodatne vještine zajednice | npr. [mattpocock/skills](https://github.com/mattpocock/skills) | `git clone` pa kopiraj u `~/.claude/skills/` |
| Dodatci Claude Codea | marketplace | `claude plugins install <ime>` |

---

## Zadani tim

Devet agenata iz `agents/regoc-tim.json`. Svaki je opis uloge — ime, model, stil, vještine i
vlastita RAG kolekcija — a ne program:

| Agent | Uloga | Model | Vještine |
|---|---|---|---|
| **REGOČ** | meta-koordinator, orkestrira ostale | opus | CORE, System, Agents |
| **Kosjenka** | arhitektica; plan prije koda | opus | CORE, Development, System, GrillWithDocs |
| **Jelena** | inženjerka; implementacija i popravci | opus | CORE, Development, CreateCLI, TDD, DiagnosingBugs |
| **Malik** | sigurnost; pregled i napadački pogled | opus | CORE, Recon, RedTeam, OSINT |
| **Manda** | istraživačica; izvori i sinteza | opus | CORE, OSINT, System |
| **Dora** | analitičarka; više perspektiva na istu odluku | opus | CORE, Council, FirstPrinciples |
| **Gita** | vizualni sadržaj | sonnet | Art, Excalidraw, AlgorithmicArt |
| **Grga** | dizajn sučelja | opus | FrontendDesign, Browser, Excalidraw |
| **Potjeh** | QA; provjerava tuđi rad | sonnet | CORE |

Uobičajen tok posla: **Kosjenka → Jelena → Potjeh → Malik**. Manda i Dora ulaze kad treba
istražiti ili odvagnuti odluku, Gita i Grga kad posao ima vizualni izlaz.

---

## Instalacija

```bash
bash scripts/install-agents.sh              # upiši agente, ispiši koje vještine nedostaju
bash scripts/install-agents.sh --vjestine   # + dohvati PAI i instaliraj nedostajuće
bash scripts/install-agents.sh --u ~/moj-registar.json
```

Skripta:

1. upiše agente u `$TM_AGENTS_REGISTRY` (zadano `~/.claude/regoc/REGOC_AGENTS.json`);
2. usporedi tražene vještine s onima u `~/.claude/skills` i ispiše što nedostaje;
3. uz `--vjestine` dohvati PAI (`git clone --depth 1`) i kopira samo ono čega nema.

**Postojeći registar se ne gazi.** Dodaju se samo agenti kojih nema; tuđe izmjene — drugi
model, vlastiti agent, isključeni agent — ostaju netaknute, a prije upisa se radi pričuva.
Instalacija ne smije obrisati nečiji rad.

Bez mreže skripta neće izmisliti vještine: reći će koje nedostaju i odakle ih uzeti.

---

## Kako dodati vlastitog agenta

Dopiši ga u registar (`$TM_AGENTS_REGISTRY`) uz iste ključeve:

```jsonc
"ivan": {
  "id": "ivan",
  "name": "Ivan",
  "role": "Data Engineer",
  "model": "sonnet",
  "skills": ["CORE", "Development"],
  "communication_style": "Kratko, s brojkama.",
  "description": "Cjevovodi podataka i izvještaji",
  "rag_collection": "agent_ivan"
}
```

Tri stvari koje su se kod nas pokazale bitnima:

1. **`assignee` je nalog, ne oznaka.** Čim zadatak dobije izvršitelja i status `pending`,
   sustav ga preuzima — pazi koga upisuješ.
2. **Identitet se šalje pri pokretanju.** Agent koji ne dobije ulogu i stil u prvoj poruci
   ponaša se kao generički pomoćnik, bez obzira na to što piše u registru.
3. **Vještinu treba imenovati u koraku posla.** Mjereno: od 11 poziva vještina u 124 sjednice
   svi su bili izričito naručeni — „koristi DiagnosingBugs" radi, „imaš vještine" ne radi.

---

## Vlastita vještina

Vještina je mapa s `SKILL.md`; ništa se ne registrira:

```
~/.claude/skills/MojaVjestina/
├── SKILL.md      # frontmatter `name` + `description` s okidačima („USE WHEN …")
├── Tools/        # neobavezno
└── references/   # neobavezno
```

Zatim je dopiši u `skills` polje agenta. Detaljnije o slaganju cijelog sustava —
znanje (RAG), ulazni kanali, kočnice — u `docs/SUSTAV.md`.

---

## Tijekovi rada (workflow)

Neki poslovi traže više od jednog izvršitelja. Katalog je u `agents/workflows.json`, a odluku
donosi `tools/odaberi_workflow.py` — **pri otvaranju zadatka**, deterministički:

```bash
python3 tools/odaberi_workflow.py --popis
python3 tools/odaberi_workflow.py --naslov "Ne radi prijava na stranicu" --tezina 40
```

| Tijek | Od težine | Koraci |
|---|---:|---|
| `implement-feature` | 36 | Kosjenka [GrillWithDocs] → Jelena [TDD] → Potjeh → Malik |
| `bug-fix` | 16 | Jelena [DiagnosingBugs] → Potjeh → Malik |
| `research` | 36 | Manda [Research] → Dora [FirstPrinciples] → Kosjenka |
| `security-audit` | 36 | Malik [RedTeam] → Potjeh → Kosjenka |
| `prijava-natjecaj` | 61 | Manda → Kosjenka [GrillWithDocs] → Jelena → Dora |

**Kako se odlučuje** (prvi uvjet koji se poklopi):

1. izričita oznaka `workflow:<id>` na zadatku,
2. oznaka `bez-workflowa` → nikad tijek,
3. okidač iz kataloga **uz uvjet da je težina ≥ `najmanja_tezina`**,
4. inače: bez tijeka, jedan izvršitelj.

Zadnje je pravilo najvažnije: **neodlučeno je uvijek „bez tijeka”**. Tijek od četiri koraka za
posao od deset minuta košta više nego što donosi, a promašeni tijek se plaća četiri puta.

Odluka je namjerno bez modela. Izbor se donosi pri svakom otvaranju zadatka, a klasifikator na
tako vrućem mjestu kod nas je već jednom promašio 92 % prometa; ovako je provjerljiv i
besplatan. Svaki korak **imenuje vještinu** koju izvršitelj mora upotrijebiti — inače je neće
ni dotaknuti.

---

## Alati

Katalog je u `agents/alati.json`; paket ih ne nosi, nego zna odakle dolaze i kako se provjeri
rade li:

```bash
bash scripts/install-agents.sh --alati                # što je instalirano, a što nedostaje
bash scripts/install-agents.sh --alati --instaliraj   # postavi nedostajuće (treba mrežu)
```

| Alat | Čemu služi | Odakle |
|---|---|---|
| **Serena MCP** | semantičko čitanje i uređivanje koda po simbolima umjesto grepanja po datotekama | `github.com/oraios/serena` (preko `uvx`) |
| **ChromaDB** | vektorska baza za RAG | `chromadb/chroma` (Docker) |
| **Ollama** | lokalni modeli i ugradnja teksta | službena instalacijska skripta s `ollama.com` |
| **Playwright** | provjera sučelja u pravom pregledniku (snimke, greške u konzoli) | `pip install playwright` + `playwright install chromium` |
| RAG alati, mjerenja | pregled i zaštita znanja; trošak i vrijednost rada | već u `tools/` ovog paketa |
| pcbparts, Espacenet | dijelovi za PCB, patenti EP/EU | vlastiti MCP poslužitelji (neobavezno) |

Točne naredbe za svaki alat stoje u `agents/alati.json` (`instalacija`, `registracija`,
`provjera`). Registracija MCP alata ide kroz `claude mcp add …`, a stanje se u Claude CLI-ju
vidi s `/mcp`.

**Serena** je izrijekom navedena jer je za rad na kodu najkorisnija: umjesto pretraživanja
teksta radi po simbolima preko jezičnog poslužitelja. Dodijeljena je Jeleni, Kosjenki i Maliku.
