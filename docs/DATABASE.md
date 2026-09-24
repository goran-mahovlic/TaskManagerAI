# Baza

Sve živi u jednoj SQLite datoteci. Nema poslužitelja baze, nema korisnika, nema lozinke — jedna
datoteka koju kopiraš i preselio si cijeli sustav.

## Gdje je i kako nastaje

| | |
|---|---|
| Zadana putanja | `$HOME/.taskmanager/data/tasks.db` |
| Premještanje | `TM_HOME` ili `TM_DB` |
| Nastanak | `bun run init` iz `db/schema.sql` |
| Način rada | WAL — ploča čita dok agenti pišu |

`db/schema.sql` je **jedini izvor istine o shemi**. Nije pisan rukom nego izvezen iz baze koja
radi u pogonu, pa opisuje stvarno stanje, a ne namjeru. Baza sama nije u repozitoriju.

Skripta `init` sigurna je za ponavljanje: sve su naredbe „stvori ako ne postoji“, pa se pokreće
i nakon `git pull` da pokupi nove tablice ili okidače.

## Tablice

**Jezgra**

| Tablica | Čemu služi |
|---|---|
| `tasks` | zadatci; 25 stupaca — stanje, prioritet, nositelj, ovisnosti, oznake, bilješke o napretku, zastavica pauze |
| `task_history` | tko je što promijenio i kada, redak po promjeni polja |
| `task_id_seq` | brojač za oznake `TASK-001`, `TASK-002` … |
| `execution_queue` | red zadataka koje sustav treba sam preuzeti |

**Projekti**

| Tablica | Čemu služi |
|---|---|
| `projects` | projekt kao okvir za zadatke, s voditeljem i stanjem |
| `project_agents` | tko radi na kojem projektu i u kojoj ulozi |
| `project_spec_history` | povijest specifikacija projekta i zadataka koji su iz njih nastali |
| `project_sequence` | brojač oznaka `PRJ-001` … |

**Znanje i troškovi**

| Tablica | Čemu služi |
|---|---|
| `knowledge` | bilješke, nalazi, naučene lekcije |
| `knowledge_relations` | veze među bilješkama, s težinom — graf, ne popis |
| `project_rag_entries` | poveznica bilješke na zapis u vanjskoj bazi ugradbi |
| `cost_log` | potrošnja po pozivu modela: žetoni, cijena, agent, zadatak |

**Postavke**

| Tablica | Čemu služi |
|---|---|
| `settings` | postavke TaskManagera, ključ → vrijednost, s `updated_by` i `updated_at`; prvi ključ je `agents.max_concurrent` (strop usporednih agenata, zadano 3) |
| `settings_history` | povijest promjena postavki: stara i nova vrijednost, tko (`changed_by`), odakle (`source`: `seed`, `config`, `api`) i kada |

Početnu vrijednost stropa upisuje `scripts/init-db.ts` (i sama ploča pri prvom otvaranju baze),
ne `schema.sql`: tako okolina `REGOC_MAX_AGENT_CONCURRENT` može poslužiti kao jednokratni
seed, a postojeća se vrijednost nikad ne prepisuje. Nečitljiva ili ručno pokvarena vrijednost
nikad ne znači „neograničeno" — čitač pada na zadnju dobru vrijednost, pa na okolinu, pa na 3,
i sve stišće u [1, 10].

Uz to postoje dva pogleda, `v_cost_log` i `v_projects_summary`, koji služe ploči za zbrojeve.

## Okidači — mjesto gdje se sustav sam pokreće

Ovih pet okidača razlog su zašto sve ne mora biti u programskom kodu.

| Okidač | Kada | Što napravi |
|---|---|---|
| `auto_queue_p1_tasks` | nakon unosa zadatka | prioritet 1 odmah ide u `execution_queue` |
| `auto_queue_p1_on_update` | nakon izmjene | zadatak podignut na prioritet 1 ide u red |
| `dequeue_on_complete` | nakon izmjene | završen zadatak izlazi iz reda |
| `tasks_updated_at` | nakon izmjene | osvježi vrijeme zadnje promjene |
| `projects_updated_at` | nakon izmjene | isto, za projekte |

Posljedica je važna: **dovoljno je otvoriti zadatak prioriteta 1** i on je u redu za izvršavanje.
Ne treba pozvati nikakav API osim onoga za otvaranje zadatka. Ako gradiš vlastitog agenta, nek
gleda `execution_queue` i posao će ti sam dolaziti.

## Stanja zadatka

```
pending  →  in_progress  →  completed
   ↓             ↓
cancelled     blocked
```

Prijelaz `pending → completed` **nije dopušten** izravno. Zadatak mora proći kroz `in_progress`,
inače se na ploči ne vidi tko je na čemu radio. To je namjerno ograničenje, ne propust.

Za privremeno zaustavljanje ne koristi se `cancelled` — to je konačno stanje iz kojega se ne
vraća. Postoji zastavica `paused`, koja stanje ne dira, pa se posao nastavi točno ondje gdje je
prekinut.

## Izmjena sheme

1. promijeni bazu koja ti radi (`ALTER TABLE`, novi okidač, što već treba);
2. izvezi shemu natrag u `db/schema.sql`;
3. commit — tako `schema.sql` uvijek opisuje ono što stvarno radi.

Izvoz:

```bash
sqlite3 "$HOME/.taskmanager/data/tasks.db" .schema > db/schema.sql
```

Ako nemaš `sqlite3`, isto radi i kratka Bun skripta koja pročita `sqlite_master`.

Redak s tablicom `sqlite_sequence` treba izbaciti iz izvoza — SQLite je stvara sam i odbija
naredbu koja je pokušava stvoriti.

## Pričuve

Vidi [INSTALL.md](INSTALL.md#9-pričuve). Ukratko: `bun scripts/backup.ts`, nikada `cp` dok
poslužitelj radi.

## Zašto je `cohere-ai` u ovisnostima (a nitko ga ne zove)

Kratko: **ne briši ga.** `cohere-ai` nije mrtav kod nego **posredna ovisnost o kojoj ovisi
izgradnja**: `chromadb` (neobavezna ovisnost za RAG) interno pokušava učitati `cohere-ai`
kao jednog od embedding-davatelja, i bez njegove prisutnosti `bun build` ne daje izlaz.

Nijedna datoteka u `src/` ga ne uvozi, pa svako buduće „čišćenje neiskorištenih paketa"
izgleda kao dobra ideja — a razbije izgradnju na način koji se vidi tek pri sljedećem
`bun build`. Isti komentar stoji i u `package.json` (`_komentar_cohere-ai`), da ga vidi i
onaj tko dođe do popisa ovisnosti prije nego do ove datoteke.

Podrijetlo nalaza: `docs/ROADMAP_SAMOSTALNOST.md` §4 (commit `36da968`, 09.09.2026.).
