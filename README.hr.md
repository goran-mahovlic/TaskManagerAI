# TaskManagerAI

Upravitelj zadataka za rad s AI agentima: SQLite baza, web ploča i REST API na jednim vratima.
Pisan je za slučaj u kojem zadatke ne otvara i ne zatvara samo čovjek nego i programi — agenti
uzimaju zadatke, mijenjaju im stanje i ostavljaju bilješke, a čovjek to gleda na ploči.

Nastao je iz [Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md) Matheusa Baldissare — odatle
dolazi zamisao ploče na kojoj su zadatci obične datoteke koje uređuješ kako hoćeš. S vremenom je
prešao s datoteka na SQL, jer su zadatke počeli otvarati i zatvarati programi, a ne samo ljudi.

---

## Što dobiješ

| | |
|---|---|
| **Ploča** | Kanban s pregledom po stanju, prioritetu, nositelju i projektu |
| **REST API** | otvaranje, izmjena, pretraga i zaključivanje zadataka |
| **SQLite + WAL** | ploča čita dok agenti pišu, bez zaključavanja |
| **Automatsko izvršavanje** | zadatak prioriteta 1 okidač sam stavlja u red |
| **Projekti** | zadatci se grupiraju, svaki projekt ima svoju specifikaciju |
| **Ručna kočnica** | pauza globalno ili po zadatku, bez gubitka stanja |
| **Živa konzola** | tijek rada preko web utičnice, bez osvježavanja stranice |
| **Graf znanja** | bilješke i veze među njima, neobavezno uz semantičko pretraživanje |
| **Jezici sučelja** | hrvatski i engleski; svaki novi jezik je jedna JSON datoteka |
| **Vratar odluke** | zadatci s oznakom `needs-decision` čekaju čovjeka — ili model kojeg izabereš |
| **Vratari zatvaranja** | zadatak se zatvara na dokaz: completion-guard, strukturirani izlaz koraka (`REGOC-IZLAZ`), kritičar koji sam pokreće provjere — sve kreće u sjeni |
| **Parsiran rezultat** | agentov izvještaj razlaže poslužitelj: bedž suda, sklopive sekcije, „prikaži sirovo" — nikad kao HTML |
| **Procjena energije** | struja, CO₂ i voda uz trošak projekta, uvijek kao procjena s rasponom; koeficijenti su konfiguracija |
| **Dva RAG sustava** | ChromaDB, pgvector ili oba (za migraciju), upravljano s Config stranice; `pg` je opcijski |
| **Tijekovi rada** | posao za više struka ide po tijeku iz kataloga (11 tijekova), odluka bez modela, sve kreće u sjeni |
| **Config stranica** | pet skupina postavki, raspored kartica uređuješ jednim gumbom (✎ Uredi ↔ 💾 Spremi) |

Sve radi bez ijedne vanjske usluge. RAG (semantičko pretraživanje) je neobavezan dodatak.

---

## Značajke

Jedna rečenica po značajki, uz dokument koji je objašnjava do kraja.

**Rad agenata**

- **Ručna kočnica — globalna i po zadatku.** `POST /api/pause` zaustavlja preuzimanje novog posla, a `POST /api/tasks/<ID>/pause` / `resume` zadržava jedan zadatak bez promjene stanja, pa se nastavlja točno ondje gdje je stao — [docs/API.md](docs/API.md) („Pauza”, „Globalna kočnica”), [docs/SUSTAV.md](docs/SUSTAV.md).
- **Strop usporednih agenata.** Koliko agenata smije raditi istodobno (1–10, zadano 3) postavka je na Config stranici ili `PUT /api/config/concurrency`; vrijedi za najviše 5 s, bez restarta, a svaka promjena ostaje u `settings_history` — [docs/API.md](docs/API.md) („Usporedni agenti”).
- **Uputa agentu u radu.** `POST /api/tasks/<ID>/uputa` (ili 📨 na kartici) dostavlja poruku u sesiju koja već radi, preko kuke, pa agent ne staje i ne gubi kontekst — [docs/UPUTE-AGENTU.md](docs/UPUTE-AGENTU.md).
- **Vrata autonomije.** Pragovi potrošnje sesije (70/85/95 %) i tjedna (90 %) na kojima autonomija usporava ili staje postavka su s klizačima na Config stranici ili `PUT /api/config/autonomy`; vrijede uživo, uz povijest u `settings_history` — [docs/API.md](docs/API.md) („Vrata autonomije”).
- **Odluka o pokretanju.** Zadatak s oznakom `needs-decision` čeka čovjeka ili model po izboru, iza determinističkog filtra rizika. Traka „Čeka odluku” dijeli ih u tri skupine (odlučuje model · čeka strojni okidač · čeka tebe) istim filtrom kojim radi odlučitelj — [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md).
- **Tijekovi rada.** Zadatak za više struka ide po tijeku iz `agents/workflows.json` (11 tijekova, među njima `dorada-isporuke` i `izrada-dokumenta`); odluka je deterministička, korak lanca ne dobiva vlastiti tijek, a prekidač `workflow-gate` ima tri razine i kreće u sjeni — [docs/AGENTI.md](docs/AGENTI.md) („Tijekovi rada”), [docs/CONFIG.md](docs/CONFIG.md) §3.
- **Ulazna vrata.** `POST /api/ingest` boduje svaku poruku težinom i po pragovima 16/36/81 odlučuje otvara li zadatak, ide li u puni lanac i traži li potvrdu plana; položaj `off`/`shadow`/`on` po izvoru — [docs/API.md](docs/API.md) („Ulaz”), [docs/CONFIG.md](docs/CONFIG.md) §5.
- **Zatvaranje kroz orkestrator.** `TaskCloser`, `SpawnFinalizer` i prekidač `spawnCloseGuard` (zadano isključen) ne daju agentu da sam zatvori zadatak dok njegov spawn drži najam; čovjek s ploče uvijek može pregaziti — [docs/INSTALL.md](docs/INSTALL.md) §5.2, [docs/API.md](docs/API.md).
- **Straža jeke i pretinac.** `DispatchGuard` ne da da dojava raspoređivača ili obavijest o životnom ciklusu agenta postane novi zadatak, a zadatak bez projekta pada u projekt-pretinac umjesto u `NULL` — [CHANGELOG.md](CHANGELOG.md), [docs/SUSTAV.md](docs/SUSTAV.md).

**Zatvaranje na dokaz**

- **Nezavisni kritičar (`CriticGate`).** Prije zatvaranja kritičar sam pokreće provjere nad onim što je agent ostavio na disku (L0/L1 za dokumente); svaki sud ide u `critic_gate.jsonl`, a `GET /api/critic/unverified` popisuje što nije moglo biti provjereno — [docs/API.md](docs/API.md) („Kritičar”), [docs/INSTALL.md](docs/INSTALL.md) §5.2.
- **Completion-guard i strukturirani izlaz koraka.** `completed` bez dokaza izvršenja biva uhvaćen, a blok `REGOC-IZLAZ` daje svakom izvještaju zatvoren rječnik dokaza; oboje kreće u sjeni — [docs/INSTALL.md](docs/INSTALL.md) §5.2.
- **Parsirani rezultat.** Agentov izvještaj poslužitelj razlaže u bedž presude i odjeljke (`resultParsed`), a ploča ga crta kroz `textContent`, nikad kao HTML — [docs/API.md](docs/API.md).
- **Dopušteni prijelazi stanja.** `pending→completed` se odbija s 409, a zatvoren ili otkazan zadatak može se ponovno otvoriti u `pending` — [docs/API.md](docs/API.md).

**Znanje, trošak i modeli**

- **RAG s dva pozadinska sustava.** ChromaDB, pgvector ili oba (`dual`, za migraciju), s prebacivanjem i migracijom po zbirkama na **Config → RAG Backend**; `pg` je neobavezna ovisnost, a lozinka nikad ne izlazi kroz API — [docs/INSTALL.md](docs/INSTALL.md) §5.3, [docs/API.md](docs/API.md).
- **Procjena energije.** Struja, CO₂ i voda uz trošak projekta, uvijek kao procjena s rasponom; koeficijenti su u `config/energija.json` — [docs/INSTALL.md](docs/INSTALL.md) §5.2, [docs/DATABASE.md](docs/DATABASE.md).
- **Postavke modela.** `models/model-config.json` se zapisuje atomno, s revizijskim tragom, a oznaka dugog konteksta `[1m]` je dopuštena — [docs/API.md](docs/API.md) („Modeli i davatelji”).
- **Konzola.** Uživo tok događaja preko web utičnice i, po želji, pokretanje naredbe — [docs/TOOLS.md](docs/TOOLS.md).
- **Config stranica i uređivač rasporeda.** Pet skupina (strop i vrata autonomije, agenti i modeli, integracije, RAG, sustav); kartice se premještaju unutar skupine i mijenjaju veličinu jednim gumbom ✎ Uredi raspored ↔ 💾 Spremi raspored, a vrijednosti postavki su za to vrijeme zaključane — [docs/CONFIG.md](docs/CONFIG.md), [docs/API.md](docs/API.md) („Raspored Config stranice”).
- **Ploča na mobitelu.** `GET /api/tasks?view=board` šalje samo polja kartice i brojače sa poslužitelja, odgovori idu komprimirani, a živa veza se sama obnavlja — [docs/API.md](docs/API.md) („Prikaz ploče”).
- **Provjerena prazna instalacija.** init → poslužitelj → ploča 200 → `POST`/`GET` zadatka → okidač prioriteta 1, zapisano u [docs/QA_SVJEZA_INSTALACIJA_2026-10-02.md](docs/QA_SVJEZA_INSTALACIJA_2026-10-02.md).
- **Kako se oko nje gradi cijeli sustav agenata.** Agenti, znanje, ulazni kanal i nadzor, sloj po sloj — [docs/SUSTAV.md](docs/SUSTAV.md), [docs/AGENTI.md](docs/AGENTI.md), [docs/INTEGRACIJE.md](docs/INTEGRACIJE.md), [REGOC/README.md](REGOC/README.md).

---

## Brzi početak

Treba ti [Bun](https://bun.sh) 1.1 ili noviji. Ništa drugo.

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI

bun install          # ovisnosti
bun run init         # stvara bazu iz db/schema.sql
bun run start        # pokreće ploču i API
```

Otvori `http://localhost:17781`. Ploča ima sedam kartica:

| Kartica | Što je na njoj |
|---|---|
| **Zadatci** | kanban ploča — po stanju, prioritetu, nositelju, projektu |
| **Projekti** | popis projekata, svaki sa svojom specifikacijom |
| **RAG** | pretraga po znanju, ako je uključena |
| **Konzola** | živi tijek događaja, mjesto za poruku agentu i (neobavezno) pokretanje naredbe |
| **Potrošnja** | trošak po zadatku i projektu, tjedni pregled, vrijednost upita naspram troška |
| **Stanje** | stanje servisa, potrošnja žetona, red za izvršavanje, ručna kočnica |
| **Postavke** | pet skupina: strop usporednih agenata i vrata autonomije, agenti i modeli, integracije i ulazna vrata, RAG, sustav; raspored kartica uređuješ gumbom ✎ Uredi raspored ([docs/CONFIG.md](docs/CONFIG.md)) |

Prvi zadatak preko API-ja:

```bash
curl -X POST http://localhost:17781/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Prvi zadatak","priority":2,"assignee":"user","createdBy":"user"}'
```

---

## Postavke

Sve je neobavezno; bez ijedne postavke radi na zadanim vrijednostima. Kopiraj `env.example` u
`.env` i promijeni što treba.

| Varijabla | Zadano | Čemu služi |
|---|---|---|
| `TM_PORT` | `17781` | vrata poslužitelja |
| `TM_HOME` | `$HOME/.taskmanager` | mapa s bazom i radnim datotekama |
| `TM_DB` | `$TM_HOME/data/tasks.db` | putanja do baze, ako je držiš drugdje |
| `TM_AGENTS` | — | imena agenata koji smiju biti nositelji, odvojena zarezom |
| `TM_AGENTS_CONFIG` | `config/agents.json` | registar agenata; njegovi `id`-evi su ujedno dopušteni nositelji |
| `TM_EXTERNAL_HOST` | `localhost` | ime poslužitelja koje se prikazuje u sučelju |
| `TM_LANG` | `hr` | zadani jezik sučelja (`en`, `hr`, ili bilo koja datoteka u `locales/`) |
| `TM_CHROMA_HOST`, `TM_OLLAMA_URL` | — | uključuju RAG; bez njih je isključen |
| `TM_PGVECTOR_HOST`, `_PORT`, `_DATABASE`, `_USER` | — | pgvector (sva četiri, ili `config/rag-backend.json`) |
| `TM_PGVECTOR_PASSWORD` | — | lozinka za pgvector — samo ovdje ili u datoteci tajni, nikad u JSON-u |
| `TM_BOARD_URL` | — | poveznica na ploču u izvještajima; bez nje se redak izostavlja |
| `TM_FEATURES_FILE`, `TM_CRITIC_CONFIG`, `TM_ENERGIJA_CONFIG` | `config/*.json` | prekidači, kritičar i koeficijenti energije (INSTALL.md §5.2) |

**Vlastiti sastav tima** postavlja se ovako — `user` i `scheduler` uvijek se dodaju sami:

```bash
TM_AGENTS=ana,ivan,marko bun run start
```

Isto vrijedi za `id`-eve iz `config/agents.json` (registar orkestratora): dva izvora se
zbrajaju, pa isti tim ne treba upisivati dvaput. Postaviš li oba, vrijedi unija.
Bez ijednog od njih popis nije zatvoren — prolazi svako ispravno ime
(`[a-z][a-z0-9_-]{0,31}`). Ugrađenog popisa imena nema.

---

## Jezik sučelja

Ploča dolazi s hrvatskim i engleskim. Odaberi jedan u izborniku u zaglavlju; izbor pamti
preglednik. Za jezik koji svi vide prije nego što išta izaberu, koristi `TM_LANG` ili
`config/jezik.json`.

Dodavanje jezika ne treba nikakav kod. Kopiraj postojeću datoteku u `locales/`, prevedi
vrijednosti — nikad ključeve — i jezik se pojavi u izborniku nakon idućeg pokretanja:

```bash
cp locales/en.json locales/de.json
$EDITOR locales/de.json          # prevedi samo vrijednosti
TM_LANG=de bun run start
```

Ključ bez prijevoda pada na engleski, pa je i djelomičan prijevod upotrebljiv. Naslovi zadataka,
opisi i bilješke se **nikad** ne prevode: to su tvoji podatci, ne sučelje.

---

## Odluka o pokretanju

Zadatak s oznakom `needs-decision` svaka automatika ostavlja na miru dok ga netko ne otključa.
Ploča ih skuplja u traku iznad stupaca, s poljem za odluku i gumbom **Nastavi**; ono što upišeš
ostaje uz zadatak.

To prosuđivanje možeš prepustiti i modelu — bilo kojem davatelju iz `models/model-config.json`,
od lokalnog Ollama modela do OpenRoutera ili Anthropica. Prvo prolazi odredišni filtar koji
sve što dira novac, brisanje, tajne, vanjski učinak ili nejasan opis vraća izravno tebi; model
vidi samo ostatak i ne može nadglasati filtar.

Ta podjela je namjerna. Mjereno na malom lokalnom modelu, kad je sam prosuđivao rizik, na 6 od 7
rizičnih zadataka odgovorio je „kreni" — svaki put uvjerljivo obrazloženo. S filtrom: 7 od 7
točno.

Pojedinosti, davatelji i postavke: [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md).

---

## Dokumentacija

| Dokument | O čemu |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | instalacija korak po korak, servis, pričuve, nadogradnja |
| [docs/DATABASE.md](docs/DATABASE.md) | tablice, okidači, kako nastaje baza i kako se mijenja |
| [docs/API.md](docs/API.md) | svi krajevi API-ja s primjerima |
| [docs/TOOLS.md](docs/TOOLS.md) | skripte, konzola, periodički poslovi |
| [CHANGELOG.md](CHANGELOG.md) | što se promijenilo i zašto, najnovije prvo |
| [docs/JEZICI.md](docs/JEZICI.md) | jezici sučelja: odabir, dodavanje |
| [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md) | zadatci koji čekaju odluku; kad odlučuje model, i filtar rizika |
| [docs/UPUTE-AGENTU.md](docs/UPUTE-AGENTU.md) | slanje upute agentu koji već radi (API, kuka, fail-open) |
| [docs/SUSTAV.md](docs/SUSTAV.md) | kako od ploče složiti sustav koji sam radi, sloj po sloj: agenti, RAG, vještine, ulaz, kočnice |
| [docs/AGENTI.md](docs/AGENTI.md) | registar agenata, vještine i alati — što paket nosi, a što dohvaća |
| [docs/INTEGRACIJE.md](docs/INTEGRACIJE.md) | integracije Nextcloud, e-pošta, GitLab i GitHub |
| [docs/CONFIG.md](docs/CONFIG.md) | Config stranica: skupine i kartice, uređivač rasporeda, prekidači (workflow-gate, ingest-gate…), tijekovi, ulazna vrata, dojava pri završetku |
| [docs/POGON_I_PAKET.md](docs/POGON_I_PAKET.md) | što je od novosti izvornog sustava ušlo u paket, a što nije — s naredbom za provjeru svake stavke |
| [docs/adr/](docs/adr/) | arhitekturne odluke paketa |
| [CONTRIBUTING.md](CONTRIBUTING.md) | git kuke, pravila za commitove, pokretanje testova |
| [REGOC/README.md](REGOC/README.md) | kako izgleda stvaran sustav agenata izgrađen oko ovoga — po temama (arhitektura, uloge, životni ciklus zadatka, pravila isporuke, vrata i kočnice, baze, trošak i energija, lekcije, složi svoj) |

Mapa `REGOC` opisuje sustav iz kojega je TaskManagerAI izvučen: tim agenata s vlastitim ulogama i
modelima, demon koji radi u pozadini, sjednice koje preživljavaju prekid, kočnice autonomije,
usmjeravanje poruka, glas i lokalne modele. Nije potrebna za rad TaskManagera; služi kao prikaz
dokle se s ovim alatom može otići i što se pritom naučilo. Sam REGOČ počiva na
[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI).

---

## Doprinos

Nakon kloniranja uputi git na kuke iz repozitorija — `.git/hooks` ne putuje s klonom:

```bash
git config core.hooksPath .githooks
```

`.githooks/commit-msg` odbija svaki commit čija poruka nosi `Co-Authored-By: … Claude` ili
`noreply@anthropic.com`, a — kad popišeš dopuštene identitete s
`git config taskmanagerai.dopusteniAutori "ti@example.com"` — i svaki commit čiji autor ili
committer nije na tom popisu. Pojedinosti i pokretanje testova: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Zahvala i podrijetlo

Upravitelj zadataka počinje od **[Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md)** (autor
[Matheus Baldissara](https://github.com/BaldissaraMatheus), MIT). Odande je preuzeta osnovna
zamisao: ploča sa zadatcima koju možeš držati uz sebe, bez računa i bez usluge u oblaku.

Sustav koji je oko njega izrastao počinje od **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**
(autor [Daniel Miessler](https://github.com/danielmiessler), MIT) — odatle dolaze vještine, kuke,
učitavanje konteksta pri pokretanju i zamisao da pomoćnik bude infrastruktura koju držiš kod
sebe, a ne usluga na koju se prijaviš. Opisano je u [REGOC/README.md](REGOC/README.md).

Otkad su zadatke počeli otvarati i agenti, a ne samo ljudi, trebalo je ono što datoteke ne daju —
istodobno pisanje bez sudara, red za izvršavanje, povijest svake promjene i upit koji vrati sve
zadatke jednoga nositelja. Zato je pohrana prešla na SQLite, a s njom se promijenio i najveći dio
koda. Ideja je ostala.

## Licencija

MIT, ista kao u izvornom projektu. Autorska prava zadržavaju i Matheus Baldissara (Tasks.md,
2023.) i Goran Mahovlić (TaskManagerAI, 2026.). Puni tekst je u [LICENSE](LICENSE).

## Agenti i vještine

Paket namjerno **ne nosi vještine ni alate** — oni žive u [PAI](https://github.com/danielmiessler/PAI)
i drugim repozitorijima koji ih održavaju. Ovdje je samo popis tko su agenti i što im treba:

```bash
bash scripts/install-agents.sh --vjestine   # zadani tim + dohvat vještina iz PAI-ja
```

Zadani tim: REGOČ, Kosjenka, Jelena, Malik, Manda, Dora, Gita, Grga, Potjeh (`docs/AGENTI.md`).

## Dalje od ploče

`docs/SUSTAV.md` opisuje kako se od ovog paketa slaže sustav u kojem se zadatci sami odrađuju:
agenti i njihov registar, znanje (RAG) i njegova zaštita, instalacija dodatnih vještina, ulazni
kanali te kočnice i vratar dovršetka — redom, sa što se smije preskočiti i zašto.
