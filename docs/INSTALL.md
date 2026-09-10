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

## 5.1. Postavke

```bash
cp env.example .env
```

Popis varijabli je u `env.example` i u [README](../README.md#postavke). Ako radiš s vlastitim
timom, jedina postavka koja ti gotovo sigurno treba jest `TM_AGENTS`:

```bash
TM_AGENTS=ana,ivan,marko
```

Bez nje vrijedi ugrađeni popis imena i API će odbiti zadatak s nepoznatim nositeljem.

## 6. Sloj 1 — pokreni orkestrator (neobavezno)

Dosad si dobio **ploču**: zadatke, projekte, API i vratare. Orkestrator je sloj koji **sam
uzima zadatke s ploče i pokreće agenta na njima**. Svježa instalacija ga **ne pali sama** —
paket koji bez pitanja počne trošiti tvoj model nije usluga nego iznenađenje.

Tri koraka, i nijedan ne traži uređivanje koda (dizajn: `docs/adr/ADR-0001-orchestrator-core.md`):

```bash
# 1. Tko su tvoji agenti (bez ovoga orkestrator radi, ali ništa ne pokreće — i to kaže)
cp config/agents.example.json config/agents.json
$EDITOR config/agents.json        # id, uloga, model, keywords ('*' = catch-all)

# 2. Kako se model uopće pokreće i što smije
cp config/orchestrator.example.json config/orchestrator.json
$EDITOR config/orchestrator.json  # enabled: true, executors, spawn.maxConcurrent

# 3. Provjeri što je podešeno, pa pokreni
bun scripts/orchestrator.ts --stanje    # popis onoga što nedostaje, izlazni kod 1 ako fali
bun scripts/orchestrator.ts --jednom    # točno jedan prolaz — ispis što bi se dogodilo
bun scripts/orchestrator.ts             # petlja
```

**Imena agenata moraju se poklapati s `TM_AGENTS`** (§5.1). `id` iz `agents.json` ploča
provjerava kao nositelja zadatka; ako ga ondje nema, `POST /api/tasks` vraća
`Invalid enum value` i orkestrator nema što pokrenuti. Dvije istine o tome tko postoji su
najčešći kvar pri prvom postavljanju.

**Izvođač (`executors`) je podatak, ne kod.** Paket isporučuje dvije izvedbe:

| `kind` | za koga | što treba upisati |
|---|---|---|
| `cli` | bilo koji CLI koji već imaš (`claude`, `gemini`, vlastita skripta) | `command`, `args`, `promptChannel` (`arg`/`stdin`/`file`) |
| `http` | Ollama ili bilo koji OpenAI-kompatibilan poslužitelj | `baseUrl`, `path`, `apiKeyEnv` (IME varijable, ne ključ) |

**Ništa o tvojoj infrastrukturi nije upisano u paket.** Rečenice koje agent treba vidjeti
(adresa Ollame, adresa RAG-a, gdje su podatci) upisuješ u `prompt.systemFacts` — na ploči,
kartica **Orkestrator**, ili izravno u `orchestrator.json`. Prazan popis je ispravno
zatečeno stanje.

**Čistači kreću u sjeni.** `watchdog.*.mode` je zadano `shadow`: sud o zaglavljenom zadatku
se zapisuje, ali se ništa ne dira. Prebaci na `live` tek kad u dnevniku (`$TM_HOME/data/orchestrator.log`)
vidiš da su nalazi točni — čistač koji pogriješi ubija tuđi rad, a to se vidi tek poslije.

Za trajni rad vrijedi ista `systemd` datoteka kao za ploču, samo s
`ExecStart=/usr/local/bin/bun scripts/orchestrator.ts`.

## 7. Integracije: Nextcloud, e-pošta, GitLab, GitHub, Telegram (neobavezno)

Sve četiri se podešavaju **s ploče** (Config → Integracije) ili u `config/<ime>.json`.
Zajedničko pravilo: **tajne ne idu u JSON** — ondje stoji samo IME varijable okoline.
Detaljne upute, uključujući kako prijaviti **vlastiti** `gh` / `glab` nalog, su u
[docs/INTEGRACIJE.md](INTEGRACIJE.md).

Telegram ima i **ulazni** smjer (poruka → zadatak). Pali se odvojeno od obavijesti:

```bash
# u procesu ploče (zadano): uključi Config → Telegram → Ulaz
# ili kao zaseban proces:
bun scripts/telegram-poller.ts --proba    # koliko poruka čeka i iz kojih chatova
bun scripts/telegram-poller.ts            # petlja
```

Oba načina drži ista datoteka-brava, pa se ne mogu pokrenuti zajedno — dva pollera s istim
bot tokenom međusobno si kradu poruke i gubitak je nevidljiv.

## 8. Trajni rad (systemd)

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

## 9. Pričuve

Baza je jedna datoteka, ali je u WAL načinu, pa je **ne kopiraj običnim `cp`** dok poslužitelj
radi — dobiješ nedovršeno stanje. Ispravno:

```bash
bun scripts/backup.ts                     # zapiše u $TM_HOME/backups/
TM_HOME=/var/lib/taskmanager bun scripts/backup.ts
```

Skripta koristi SQLite naredbu za sigurnosnu presliku, koja radi i dok se piše.

## 10. Nadogradnja

```bash
git pull
bun install
bun run init      # primijeni eventualne nove tablice ili okidače
sudo systemctl restart taskmanager
```

Korak s `init` je bezopasan i na nepromijenjenoj shemi — ako nema ničega novog, ništa se ne
dogodi.

## 11. Kad nešto ne radi

| Znak | Uzrok i rješenje |
|---|---|
| `Cannot find package 'zod'` | nisi pokrenuo `bun install` |
| `Validation failed … invalid_enum_value … assignee` | nositelj nije na popisu; postavi `TM_AGENTS` |
| `EADDRINUSE` | vrata su zauzeta; `TM_PORT=17800 bun run start` |
| ploča prazna, `/health` odgovara | baza je prazna — otvori prvi zadatak preko API-ja |
| `unable to open database file` | mapa iz `TM_HOME` ne postoji ili nema prava pisanja |
| `database is locked` | netko je bazu otvorio bez WAL-a; pokreni `bun run init` da ga vrati |

## Pristup izvana (i zašto zna vratiti „Forbidden")

Ploča odbija zahtjeve čije `Host` zaglavlje ne prepoznaje — odgovori s
**`403 Forbidden - Host not allowed`**. Sama zna svoje ime i adrese svojih sučelja, ali to
nije dovoljno kad se do nje dolazi preko adrese koju stroj **ne vidi**:

- virtualni stroj iza NAT-a: iznutra se javlja kao `10.0.2.15`, a dostupan je na
  adresi domaćina preko preusmjerenja vrata;
- obrnuti posrednik ili tunel (Tailscale, nginx) koji prosljeđuje drugo ime;
- pristup preko DNS imena koje stroj ne poznaje.

Rješenje je nabrojati imena:

```bash
cp config/postavke.env.primjer config/postavke.env
$EDITOR config/postavke.env      # TM_ALLOWED_HOSTS=10.0.0.5,taskmanager.lokalno
bash scripts/start.sh            # ispisuje koja su imena dopuštena
```

Za zatvoren LAN postoji i `TM_ALLOW_PRIVATE_HOSTS=1` (propušta svaku privatnu IPv4 adresu);
ne koristiti na stroju izloženom internetu.
