# Alati

Sve što dolazi uz sustav i sve što ti treba da ga držiš u pogonu.

## Skripte

| Naredba | Što radi | Kada |
|---|---|---|
| `bun run init` | stvara ili nadograđuje bazu iz `db/schema.sql` | prva instalacija i nakon svakog `git pull` |
| `bun run start` | pokreće ploču i API | svakodnevno |
| `bun run health` | provjerava odgovara li poslužitelj i broji zadatke | nadzor, prije i poslije nadogradnje |
| `bun scripts/backup.ts` | sigurnosna preslika baze | dnevno, periodičkim poslom |
| `bun test` | testovi | prije izmjene koda |
| `python3 tools/dezurni.py` | CLI za postavke i probu dežurnog (rezervnog) modela — vidi [API.md](API.md#dežurni-rezervni-model) | kad se konfigurira izvan ploče, npr. sa stroja bez preglednika |

Svaka skripta poštuje `TM_HOME`, `TM_DB` i `TM_PORT`, pa se bez problema drži više odvojenih
instanci na istom stroju:

```bash
TM_HOME=~/tm-posao   TM_PORT=17781 bun run start &
TM_HOME=~/tm-privatno TM_PORT=17782 bun run start &
```

## Periodički poslovi (cron)

Sustav **ne traži** nijedan periodički posao — ploča, API i okidači u bazi rade sami. Dva su
ipak preporučena.

```cron
# Dnevna preslika baze u 3:30, zadnjih 14 komada
30 3 * * *  cd /opt/TaskManagerAI && TM_HOME=/var/lib/taskmanager /usr/local/bin/bun scripts/backup.ts >> /var/log/tm-backup.log 2>&1

# Provjera svakih 10 minuta; ako ne odgovara, systemd ga podigne
*/10 * * * * cd /opt/TaskManagerAI && /usr/bin/env bash scripts/health.sh >/dev/null 2>&1 || systemctl restart taskmanager
```

Broj presliku koje se čuvaju postavlja se s `TM_BACKUP_KEEP` (zadano 14).

Ako ne koristiš cron, oba posla jednako dobro odradi systemd mjerač vremena ili bilo koji
raspoređivač koji već imaš.

## Web konzola

Ploča ima ugrađenu konzolu koja preko web utičnice (`/stream`) uživo pokazuje što se događa:
promjene zadataka, poruke među agentima, zapise iz dnevnika. Ne treba osvježavati stranicu.

Konzola može i **pokrenuti naredbu** na stroju (`POST /api/konzola/exec`). To je korisno kad
ploču koristiš kao upravljačku ploču vlastitog sustava, ali znači da vrata ne smiju biti
dostupna izvan tvoje mreže. Vidi upozorenje u [API.md](API.md#konzola).

## Vlastiti agent

Za pisanje agenta ne treba nikakva knjižnica — dovoljan je HTTP. Dva su načina:

**Povlačenje.** Agent svakih nekoliko sekunda pita `GET /api/tasks?status=pending`, uzme
zadatak, prebaci ga u `in_progress`, odradi i zatvori. Primjer je u
[API.md](API.md#primjer-agent-koji-sam-uzima-posao).

**Red za izvršavanje.** Otvoriš zadatak s `priority: 1`, okidač u bazi ga sam stavi u
`execution_queue`, a agent gleda samo taj red. Manje prometa i jasnija namjera: prioritet 1
znači „ovo se radi odmah“.

## Što NIJE uključeno

Da ne bude nesporazuma — ovo je upravitelj zadataka, ne cijeli sustav agenata. Ne dolaze:

- pokretanje modela ni poziv prema njima;
- most prema Telegramu, glasu ili bilo kojem drugom kanalu;
- raspoređivač koji sam odlučuje što je sljedeće.

Sve se to gradi **oko** njega. Kako to izgleda u praksi opisano je u
[REGOC/README.md](../REGOC/README.md). Iznimka koju vrijedi znati: **ploča ima gotove krajeve
za dežurni (rezervni) model i za slikovni servis Gita** ([API.md](API.md#dežurni-rezervni-model),
[API.md](API.md#gita-slike)) — kod je u paketu, ali dežurni pretpostavlja `~/.claude/regoc/`
raspored datoteka, a Gita pretpostavlja servis na `localhost:8889`. Bez njih ti krajevi javljaju
čitljivu grešku, ne padaju ploču.
