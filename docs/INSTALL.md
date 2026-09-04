# Instalacija

## 1. Preduvjeti

**Obavezno:** [Bun](https://bun.sh) 1.1 ili noviji. SQLite je u njemu ugrađen, pa se ne
instalira zasebno.

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

**Neobavezno**, samo ako želiš semantičko pretraživanje znanja (RAG): ChromaDB i Ollama. Bez
njih sve ostalo radi normalno, a ploča na tim mjestima pokazuje da je značajka isključena.

## 2. Dohvat i priprema

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI
bash scripts/install.sh
```

Skripta provjeri (i po potrebi instalira) Bun, postavi ovisnosti, stvori bazu ako je nema i
na kraju **stvarno podigne poslužitelj** da potvrdi da instalacija radi. Ako više voliš ručno,
`bun install` i dalje radi.

**Bez pristupa internetu.** `zod` je obavezan (sheme se provjeravaju pri svakom zahtjevu), a
strojevi u zatvorenoj mreži ne dosežu npm — zato paket nosi vlastiti primjerak u
`vendor/zod.tgz`. Instalacija pokušava redom: npm → `vendor/zod.tgz` → već postojeća
instalacija na stroju, i staje s greškom ako ni jedno ne uspije.

**Malo diska.** Na stroju gdje ovisnosti već postoje uz drugu instalaciju:

```bash
bash scripts/install.sh --posudi     # node_modules = veze na postojeće; zod se ipak instalira
bash scripts/install.sh --bez-baze   # ne diraj postojeću bazu
```

## 3. Agenti i vještine (neobavezno, ali to je ono što ploču čini sustavom)

Paket ne nosi vještine ni alate — nosi popis agenata i zna odakle se vještine dohvaćaju:

```bash
bash scripts/install-agents.sh              # upiše zadani tim, ispiše koje vještine nedostaju
bash scripts/install-agents.sh --vjestine   # + dohvati PAI i instalira nedostajuće
```

Zadani tim su REGOČ, Kosjenka, Jelena, Malik, Manda, Dora, Gita, Grga i Potjeh. Vještine
(CORE, System, Development, TDD, DiagnosingBugs, OSINT, Recon, RedTeam, Council,
FirstPrinciples, Art, Excalidraw, AlgorithmicArt, FrontendDesign, Browser, GrillWithDocs,
CreateCLI, Agents) dolaze iz **[PAI](https://github.com/danielmiessler/PAI)**; dodatne se
mogu uzeti iz repozitorija zajednice (npr. [mattpocock/skills](https://github.com/mattpocock/skills))
ili napisati same.

Postojeći registar agenata se ne pregazi — dodaju se samo oni kojih nema, uz pričuvu.
Detalji: `docs/AGENTI.md`.

## 4. Baza

```bash
bun run init
```

Skripta pročita `db/schema.sql` i stvori bazu na `$HOME/.taskmanager/data/tasks.db`. Ispiše
koliko je tablica, kazala i okidača nastalo — očekuj **13 tablica i 5 okidača**.

Baza namjerno **nije** u repozitoriju: shema jest, podatci nisu. Skriptu smiješ pokrenuti i nad
postojećom bazom jer su sve naredbe u shemi „stvori ako ne postoji“; postojeći podatci ostaju.

Drugo mjesto za bazu:

```bash
TM_HOME=/var/lib/taskmanager bun run init
```

## 5. Pokretanje

```bash
bun run start
```

Ploča i API su na `http://localhost:17781`. Provjera da je živ:

```bash
curl http://localhost:17781/health
# {"status":"healthy","watcher":false,"clients":0,"timestamp":"..."}
```

## 5. Postavke

```bash
cp env.example .env
```

Popis varijabli je u `env.example` i u [README](../README.md#postavke). Ako radiš s vlastitim
timom, jedina postavka koja ti gotovo sigurno treba jest `TM_AGENTS`:

```bash
TM_AGENTS=ana,ivan,marko
```

Bez nje vrijedi ugrađeni popis imena i API će odbiti zadatak s nepoznatim nositeljem.

## 6. Trajni rad (systemd)

Za stroj koji treba držati ploču stalno uključenom:

```ini
# /etc/systemd/system/taskmanager.service
[Unit]
Description=TaskManagerAI
After=network.target

[Service]
Type=simple
User=taskmanager
WorkingDirectory=/opt/TaskManagerAI
Environment=TM_HOME=/var/lib/taskmanager
ExecStart=/usr/local/bin/bun src/TaskWebUI.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now taskmanager
sudo systemctl status taskmanager
```

Ako nemaš systemd, jednako dobro posluži `nohup bun src/TaskWebUI.ts &` ili pokretanje u
`tmux`/`screen` sjednici.

## 7. Pričuve

Baza je jedna datoteka, ali je u WAL načinu, pa je **ne kopiraj običnim `cp`** dok poslužitelj
radi — dobiješ nedovršeno stanje. Ispravno:

```bash
bun scripts/backup.ts                     # zapiše u $TM_HOME/backups/
TM_HOME=/var/lib/taskmanager bun scripts/backup.ts
```

Skripta koristi SQLite naredbu za sigurnosnu presliku, koja radi i dok se piše.

## 8. Nadogradnja

```bash
git pull
bun install
bun run init      # primijeni eventualne nove tablice ili okidače
sudo systemctl restart taskmanager
```

Korak s `init` je bezopasan i na nepromijenjenoj shemi — ako nema ničega novog, ništa se ne
dogodi.

## 9. Kad nešto ne radi

| Znak | Uzrok i rješenje |
|---|---|
| `Cannot find package 'zod'` | nisi pokrenuo `bun install` |
| `Validation failed … invalid_enum_value … assignee` | nositelj nije na popisu; postavi `TM_AGENTS` |
| `EADDRINUSE` | vrata su zauzeta; `TM_PORT=17800 bun run start` |
| ploča prazna, `/health` odgovara | baza je prazna — otvori prvi zadatak preko API-ja |
| `unable to open database file` | mapa iz `TM_HOME` ne postoji ili nema prava pisanja |
| `database is locked` | netko je bazu otvorio bez WAL-a; pokreni `bun run init` da ga vrati |
