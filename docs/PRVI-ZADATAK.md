# Prvi zadatak u petnaest minuta

*English version: [FIRST-TASK.md](FIRST-TASK.md).*

Najkraći put od svježeg klona do jednog zadatka koji agent preuzme, odradi u tvom
repozitoriju i zatvori s dokazom. Sedam koraka. Svaki završava provjerom koja kaže da je
uspio i imenuje pogrešku koju ljudi na tom koraku rade.

Ovo nije vodič za instalaciju. Za rad kao servis, sigurnosne kopije, nadogradnje i svaku
postavku vidi [INSTALL.md](INSTALL.md). Za ono što dolazi poslije prvog zadatka (znanje,
ulazni kanali, nadzor) vidi [SUSTAV.md](SUSTAV.md).

**Trebaš:** macOS ili Linux, [Bun](https://bun.sh) 1.1 ili noviji, prijavljen Claude Code
CLI (`claude --version` ispisuje inačicu) i git repozitorij u kojem agent treba raditi. Ploča
radi i s drugim CLI-jevima i s Ollamom; ovdje je Claude jer je zadani izvođač.

---

## 1. Pokreni ploču

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI
bun install
bun run init          # stvara ~/.taskmanager/data/tasks.db iz db/schema.sql
bun run start         # ploča + API na http://localhost:17781
```

**Provjera:** u drugom terminalu `bash scripts/health.sh` ispisuje `U redu.`, a
http://localhost:17781 pokazuje ploču.

**Zamka:** vrata 17781 su zauzeta. Postavi `TM_PORT` u `.env` (kopiraj `env.example`) i
pokreni ponovno. Ništa drugo iz `.env` za ovaj vodič ne treba.

## 2. Stvori projekt i daj mu radnu mapu

Na ploči: **Projekti → + Novi projekt**. Upiši ime i, u polje **Radna mapa**, apsolutnu
putanju repozitorija u kojem agent treba raditi. Spremi.

Ili kroz API:

```bash
curl -X POST http://localhost:17781/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Moja aplikacija","root_path":"/apsolutna/putanja/do/moje-aplikacije"}'
```

**Provjera:** projekt je na popisu s `PRJ-…` oznakom, a `GET /api/projects` pod `root_path`
pokazuje tvoju putanju.

**Zamka:** putanja mora biti apsolutna i mapa mora postojati; ploča nepostojeću odbija s
`root_path_missing`. Bez radne mape agent radi u mapi iz koje je pokrenut orkestrator, a to
rijetko kad želiš.

## 3. Dodaj zadatak

Na ploči: **Zadatci**, pa gumb **+** (novi zadatak), ili:

```bash
curl -X POST http://localhost:17781/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Dopiši CHANGELOG za zadnje izdanje",
    "description": "ŠTO: dodaj odjeljak za zadnju oznaku u CHANGELOG.md. ZAŠTO: izdanje je izašlo bez bilješki. DATOTEKE: CHANGELOG.md, git log. GOTOVO KAD: odjeljak navodi svaki commit od prethodne oznake i datoteka je u commitu.",
    "priority": 2,
    "assignee": "regoc",
    "projectId": "PRJ-001",
    "createdBy": "user"
  }'
```

Opis piši za nekoga tko repozitorij nikad nije vidio: što, zašto, koje datoteke i što znači
gotovo. Nositelj (`assignee`) je ime koje ćeš u koraku 4 upisati u registar. Prolazi svako
ime oblika `[a-z][a-z0-9_-]{0,31}`.

**Provjera:** zadatak je u stupcu **na čekanju** pod tvojim projektom.

**Zamka:** naslov bez opisa ploča odbija s `empty_or_fixture_task`. Pravilo je da bi zadatak
bez sadržaja poslao agenta na posao praznih ruku, pa ga ploča ne sprema.

## 4. Upiši agenta u registar

```bash
cp config/agents.example.json config/agents.json
```

Otvori `config/agents.json` i stavi `id` na nositelja iz koraka 3. `model` ostavi prazan
(zadani model CLI-ja), a `"keywords": ["*"]` zadrži da agent uzima sve.

**Provjera:**

```bash
bun scripts/orchestrator.ts --stanje
```

`greske` mora biti prazan popis.

**Zamka:** nositelj kojega nema u registru tihi je kvar cijele postave. Ploča zadatak prihvati,
orkestrator ga u svakom prolazu preskoči, a jedini trag je redak `nema agenta` u dnevniku.
Id-evi iz `config/agents.json` su popis dopuštenih nositelja.

## 5. Uključi orkestrator i dopusti agentu uređivanje datoteka

```bash
cp config/orchestrator.example.json config/orchestrator.json
```

Postavi `"enabled": true`. Zatim argumentima Claude izvođača dodaj ono što neinteraktivna
sesija treba da bi uređivala datoteke i javljala se ploči:

```json
"args": ["--print", "--output-format", "json",
         "--permission-mode", "acceptEdits",
         "--allowedTools", "Bash(curl:*),Bash(git:*)"]
```

**Provjera:** `bun scripts/orchestrator.ts --stanje` kaže `"ukljucen": true` i
`"spreman": true`.

**Zamka:** print način ne može te pitati za dopuštenje, pa je sve što nije unaprijed
dopušteno odbijeno. Gornje zastavice pokrivaju uređivanje datoteka, poziv ploči i commit.
Budući da agent radi u tvom repozitoriju, vrijedi i popis dopuštenja iz njegova
`.claude/settings.json`. Ako vještine tog repozitorija pokreću skripte (Python, pokretač
testova), dopusti ih ondje — inače će agent javiti da je odbijen i raditi ručno.

## 6. Pokreni jedan prolaz

```bash
bun scripts/orchestrator.ts --jednom     # točno jedan prolaz
```

Zadatak prelazi u **u radu**, a u tvom repozitoriju kreće proces `claude` s tekstom zadatka
kao promptom. Za trajni rad pokreni petlju, u vlastitom terminalu, dok ploča radi:

```bash
bun scripts/orchestrator.ts
```

**Ne iz Konzole na ploči.** Kartica Konzola može pokrenuti `bun` u WORK načinu, ali svaku
naredbu ubija nakon 30 sekundi, a prolaz čeka da agent završi. Petlju jednom pokreni kao
servis; nakon toga sve ostalo ide s ploče
([INSTALL.md §6](INSTALL.md#6-sloj-1--pokreni-orkestrator-neobavezno)).

**Provjera:** na ploči **Status** pokazuje živ spawn. `ps -ef | grep "claude --print"`
pokazuje proces, a njegov radni direktorij je tvoja radna mapa.

**Zamka:** print način šuti do kraja; dok agent radi, ploči ništa ne stiže. Da vidiš što
misli, otvori najnoviji transkript pod `~/.claude/projects/`, u mapi nazvanoj po putanji
tvog repozitorija. Druga zamka: Ctrl+Z u terminalu orkestratora zaustavlja i orkestrator i
agenta, a zadatak ostaje u radu zauvijek. `fg` ga nastavlja.

## 7. Pusti ga da završi

Agent zadatak zatvara sam, kroz API, sa sažetkom rezultata koji sadrži dokaz: pokrenute
naredbe i njihov izlaz, promijenjene datoteke, commit. Sažetak koji kaže samo „gotovo"
vratar dovršetka odbija.

**Provjera:** zadatak prelazi u **gotovo**, a sažetak se čita kao izvještaj koji možeš
provjeriti. Ako agent nije mogao dovršiti, zadatak je **blokiran** s razlogom.

**Zamka:** ako agentov proces završi bez upisa na ploču, orkestrator ishod zabilježi, ali
zadatak ostavi otvoren — dovršetak smije tvrditi samo onaj tko je radio. S ploče vrati
zadatak na čekanje (reclaim), popravi što dnevnik pokazuje i pokreni novi prolaz.

---

## Što sad imaš

Ploču, jedan projekt vezan uz repozitorij, jednog agenta i orkestrator koji zadatke na
čekanju pretvara u rad u tom repozitoriju. Dalje:

- Više projekata u raznim mapama: jedan orkestrator opslužuje sve. Ne pokreći po jedan
  orkestrator po mapi — natjecali bi se za iste zadatke.
- Čistači zaglavljenih zadataka kreću u sjeni; [INSTALL.md §6](INSTALL.md#6-sloj-1--pokreni-orkestrator-neobavezno)
  kaže kad ih pustiti uživo.
- Svaki kraj API-ja iz ovog vodiča, s primjerima: [API.md](API.md).
- Od ploče do sustava koji radi sam, sloj po sloj: [SUSTAV.md](SUSTAV.md).

---

## Za agenta

Ako si agent i čitaš ovo jer te prompt ovamo uputio, ovo ploča očekuje od tebe. Protokol
već imaš u promptu; ovo je pozadina iza njega.

- **Radiš u radnoj mapi projekta.** Tvoj je proces ondje pokrenut i prompt je imenuje.
  Repozitorij ne traži drugdje.
- **Prvo označi u radu, na kraju zatvori s dokazom.** Ploča `completed` prima samo uz
  sažetak koji netko može provjeriti: naredbe i izlaz, promijenjene datoteke, commit.
  „Gotovo" samo po sebi je odbijeno.
- **Blokirano je valjan ishod.** Nedostaje li alat, dopuštenje ili kontekst, postavi
  `blocked` s razlogom. Ne zatvaraj kao gotovo i ne zaobilazi odbijenu naredbu
  izmišljanjem njezina rezultata.
- **Dopuštenja su odlučena unaprijed.** Korisnika ne možeš pitati. Ako je naredba odbijena,
  reci to u rezultatu i nastavi s onim što smiješ.
- **Tvoje pamćenje završava s ovim pokretanjem.** Sljedeći zadatak kreće u svježoj sesiji.
  Sve što idućem agentu treba mora biti u rezultatu zadatka, repozitoriju ili commitu, ne u
  tvojoj glavi.
- **Završi retkom statusa** koji prompt traži. Orkestrator ishod čita iz njega.
