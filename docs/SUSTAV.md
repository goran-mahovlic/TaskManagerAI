# Kako od TaskManagera složiti sustav kakav je REGOČ

TaskManagerAI je ploča i baza — sam po sebi ne radi ništa. Sustav u kojem se zadatci **sami
odrađuju** nastaje kad se uz njega postave još četiri stvari: agenti, znanje (RAG), ulazni
kanal i nadzor. Ovaj dokument opisuje kako to složiti, kojim redom i što se smije preskočiti.

Redoslijed nije proizvoljan: svaki sloj ovisi o prethodnome, a svaki se može ostaviti
isključen dok ne zatreba.

---

## Sloj 0 — Ploča i baza (obavezno)

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI
bash scripts/install.sh          # bun, ovisnosti (uklj. zod), baza, provjera
bun src/TaskWebUI.ts             # ploča na http://localhost:17781
```

Na stroju s malo diska, gdje ovisnosti već postoje uz drugu instalaciju:

```bash
bash scripts/install.sh --posudi   # node_modules postaje mapa veza; zod se ipak instalira
```

`zod` je jedina ovisnost koja se **ne posuđuje**: sheme se provjeravaju pri svakom zahtjevu i
bez njega poslužitelj ne prođe ni prvi uvoz.

Provjera da doista radi: `bash scripts/health.sh`.

---

## Sloj 1 — Agenti (izvršitelji)

Zadatak sam sebe ne odrađuje; netko ga mora preuzeti. U REGOČ-u je to popis imenovanih agenata
s ulogom, modelom i vlastitim znanjem — jedan JSON koji je **jedini izvor istine**:

```jsonc
// ~/.claude/regoc/REGOC_AGENTS.json
{
  "agents": {
    "jelena": {
      "id": "jelena", "name": "Jelena", "role": "Engineer", "model": "opus",
      "skills": ["CORE", "Development", "TDD", "DiagnosingBugs"],
      "tools": ["~/.claude/skills/CORE/Tools/rag-query.ts"],
      "context_file": "~/.claude/skills/Agents/EngineerContext.md",
      "communication_style": "Pragmatična implementacija, bez ukrasa."
    }
  }
}
```

Tri pravila naučena skupo:

1. **Ime agenta u zadatku pokreće posao.** Polje `assignee` nije oznaka nego nalog — čim
   zadatak dobije izvršitelja i status `pending`, sustav ga preuzima.
2. **Identitet se šalje pri pokretanju, ne pretpostavlja.** Agent koji ne dobije svoju ulogu,
   stil i putanje znanja u prvoj poruci ponaša se kao generički pomoćnik.
3. **Model se bira po težini posla, ne po agentu.** Isti agent smije voziti jeftin model za
   sitnicu i skup za zahvat. Smjer je samo nadolje: promašen jeftin pokušaj košta jedan
   ponovni krug, promašen skup košta bez gornje granice.

---

## Sloj 2 — Znanje (RAG)

Bez pamćenja svaki zadatak počinje od nule. Potrebni su ChromaDB (vektorska baza) i model za
ugradnju (mi koristimo Ollamu na zasebnom stroju):

```bash
# ChromaDB (poslužitelj)
docker run -d -p 18765:8000 -v chroma:/chroma/chroma chromadb/chroma

# Ollama (ugradnja + lokalni modeli)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
```

Postavke idu u `src/rag/memory-config.ts` (ili varijable okoline). Provjera:

```bash
bun src/TaskWebUI.ts &
curl "http://localhost:17781/api/rag/health"
```

**Što upisivati:** odluke, nalaze, pravila i opise pogrešaka — ne izlaze alata. Svaki zapis
mora nositi `project_id`, `tip` i `task_id` kad postoji; bez toga se za pola godine dobije
korpus koji se ne da presjeći s pločom (kod nas je 8 917 dokumenata imalo **nula** takvih
oznaka dok se to nije popravilo).

**Što zaštititi:** pravila, lekcije i opise pogrešaka. Alati:

```bash
python3 tools/rag_tipovi.py --primijeni   # upiše `tip_regoc` i `zasticeno`
python3 tools/rag_audit.py --pregled      # koliko čega ima i gdje nedostaje projekt
python3 tools/rag_archive.py --export X   # izvoz prije bilo kakvog uklanjanja
```

`rag_archive.py --drop` odbija ukloniti kolekciju koja sadrži zaštićene dokumente ili koja se
čita pri pokretanju sjednice. To nije uljudnost nego brana: čišćenje pokreće alat, a alat ne
zna što je vrijedno.

---

## Sloj 3 — Vještine (skillovi)

Vještina je mapa s `SKILL.md` u kojoj piše **kada** se koristi i **kako**:

```
~/.claude/skills/<ImeVjestine>/
├── SKILL.md          # obavezno: frontmatter `name` + `description` s okidačima
├── Tools/            # neobavezno: skripte koje vještina poziva
└── references/       # neobavezno: dokumenti koje čita po potrebi
```

```markdown
---
name: DiagnosingBugs
description: Disciplinirani šestofazni postupak otklanjanja kvarova. USE WHEN debugging,
  istraživanje kvara, zašto X pada, analiza uzroka.
---

# Postupak
1. REPRODUCIRAJ …
```

Zadani tim i njegove vještine postavlja jedna naredba (detalji u `docs/AGENTI.md`):

```bash
bash scripts/install-agents.sh --vjestine
```

Instalacija dodatnih vještina — tri načina:

```bash
# 1) iz repozitorija zajednice
git clone https://github.com/mattpocock/skills ~/skills-izvor
cp -r ~/skills-izvor/skills/tdd ~/.claude/skills/TDD

# 2) preko upravitelja dodataka (Claude Code)
claude plugins install <ime>

# 3) vlastita vještina — samo mapa i SKILL.md, ništa se ne registrira
mkdir -p ~/.claude/skills/MojaVjestina && $EDITOR ~/.claude/skills/MojaVjestina/SKILL.md
```

Zatim je pridruži agentu (`skills` polje u registru iz sloja 1) i, ako sustav vodi kazalo,
osvježi ga.

**Naučeno mjerenjem:** agenti vještine gotovo nikad ne biraju sami. Od 11 poziva u 124 sjednice
svi su bili izričito naručeni. Ako korak posla treba vještinu, **imenuj je u opisu koraka** —
„koristi DiagnosingBugs" radi, „imaš na raspolaganju vještine" ne radi.

---

## Sloj 4 — Ulazni kanal

Zadatci moraju moći ući izvana. Kod nas su tri puta:

| Put | Kako radi | Kada |
|---|---|---|
| Ploča | ručno otvaranje zadatka | uvijek dostupno |
| REST | `POST /api/tasks` | skripte, drugi sustavi |
| Poruke (Telegram) | poruka → red → klasifikacija → zadatak | svakodnevni rad |

Za treći put vrijedi pravilo koje smo platili: **ako poruka ne postane zadatak, njezin rad ne
postoji.** Kod nas je 78 % potrošnje mjesecima bilo nevidljivo jer je razgovorni kanal
zaobilazio ploču. Kanal zato mora imati prekidač (isključeno / sjena / uključeno) i prag
ispod kojeg se pitanje samo odgovori, bez otvaranja zadatka.

---

## Sloj 5 — Nadzor i kočnice

Sustav koji sam sebi dodjeljuje posao mora imati gdje stati:

- **Ručna kočnica** — `POST /api/pause` zaustavlja svako novo pokretanje; po zadatku
  `POST /api/tasks/<ID>/pause`. Nikad ne zaustavljaj rad prelaskom u `cancelled` — to je
  terminalno stanje iz kojeg se zadatak ne vraća.
- **Prag potrošnje** — mjeri se udio iskorištene kvote i iznad praga autonomija prestaje sama
  vući posao (nalog čovjeka i dalje prolazi). Mjerilo mora biti **fail-closed**: kad mjerenje
  ne radi, vrata se zatvaraju, ne otvaraju.
- **Vratar dovršetka** — zadatak se ne smije zatvoriti bez dokaza. Naš `CompletionGuard`
  odbija `completed` s rezultatom kraćim od 40 znakova ili bez traga izvršenja; to je jedina
  brana protiv „gotovo je" koje nije gotovo.
- **Trošak i vrijednost** — `tools/run_tokens.py` i `/api/projects/trosak` pokazuju što je
  rad stajao, `tools/vrijednost_inputa.py` koliko je po cjeniku vrijedio. Dvije brojke, dva
  stupca, nikad zbrojene.

---

## Najmanji smislen skup

Ako se sve ostalo preskoči, ovo je najmanje što čini sustav, a ne samo popis zadataka:

1. ploča i baza (sloj 0),
2. jedan agent s jasnom ulogom (sloj 1),
3. vratar dovršetka (sloj 5),
4. jedan ulazni kanal osim ručnog (sloj 4).

RAG i vještine dodaj kad te prvi put zaboli što sustav ne pamti prošli tjedan.
