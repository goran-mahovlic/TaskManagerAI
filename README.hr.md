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

Sve radi bez ijedne vanjske usluge. RAG (semantičko pretraživanje) je neobavezan dodatak.

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
| **Postavke** | davatelji modela i prijava na njih, dežurni (rezervni) model, model za vratara odluke, jezik sučelja, način `PLAN`/`WORK` |

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
| [docs/JEZICI.md](docs/JEZICI.md) | jezici sučelja: odabir, dodavanje |
| [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md) | zadatci koji čekaju odluku; kad odlučuje model, i filtar rizika |
| [CONTRIBUTING.md](CONTRIBUTING.md) | git kuke, pravila za commitove, pokretanje testova |
| [REGOC/README.md](REGOC/README.md) | kako izgleda pravi sustav agenata izgrađen oko ovoga |

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
`noreply@anthropic.com`, kao i svaki commit čiji autor ili committer nije
`goran.mahovlic@gmail.com` (druga se adresa otvara izričito). Pojedinosti i pokretanje testova:
[CONTRIBUTING.md](CONTRIBUTING.md).

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
