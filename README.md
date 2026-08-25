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

Otvori `http://localhost:17781`.

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
| `TM_AGENTS` | ugrađeni popis | imena agenata koji smiju biti nositelji, odvojena zarezom |
| `TM_EXTERNAL_HOST` | `localhost` | ime poslužitelja koje se prikazuje u sučelju |
| `TM_CHROMA_HOST`, `TM_OLLAMA_URL` | — | uključuju RAG; bez njih je isključen |

**Vlastiti sastav tima** postavlja se ovako — `user` i `scheduler` uvijek se dodaju sami:

```bash
TM_AGENTS=ana,ivan,marko bun run start
```

---

## Dokumentacija

| Dokument | O čemu |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | instalacija korak po korak, servis, pričuve, nadogradnja |
| [docs/DATABASE.md](docs/DATABASE.md) | tablice, okidači, kako nastaje baza i kako se mijenja |
| [docs/API.md](docs/API.md) | svi krajevi API-ja s primjerima |
| [docs/TOOLS.md](docs/TOOLS.md) | skripte, konzola, periodički poslovi |
| [REGOC/README.md](REGOC/README.md) | kako izgleda pravi sustav agenata izgrađen oko ovoga |

Mapa `REGOC` opisuje sustav iz kojega je TaskManagerAI izvučen — višeagentnu orkestraciju s
Telegramom, glasom i lokalnim modelima. Nije potrebna za rad TaskManagera; služi kao primjer
dokle se s ovim alatom može otići.

---

## Zahvala i podrijetlo

Projekt počinje od **[Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md)** (autor
[Matheus Baldissara](https://github.com/BaldissaraMatheus), MIT). Odande je preuzeta osnovna
zamisao: ploča sa zadatcima koju možeš držati uz sebe, bez računa i bez usluge u oblaku.

Otkad su zadatke počeli otvarati i agenti, a ne samo ljudi, trebalo je ono što datoteke ne daju —
istodobno pisanje bez sudara, red za izvršavanje, povijest svake promjene i upit koji vrati sve
zadatke jednoga nositelja. Zato je pohrana prešla na SQLite, a s njom se promijenio i najveći dio
koda. Ideja je ostala.

## Licencija

MIT, ista kao u izvornom projektu. Autorska prava zadržavaju i Matheus Baldissara (Tasks.md,
2023.) i Goran Mahovlić (TaskManagerAI, 2026.). Puni tekst je u [LICENSE](LICENSE).
