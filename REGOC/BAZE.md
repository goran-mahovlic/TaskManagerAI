# Baze

[English](BAZE.en.md) · [Natrag na pregled](README.md)

Sustav ima tri SQLite zapisa s različitim životnim vijekom i jednu semantičku bazu znanja.
Nema poslužitelja baze, korisnika ni lozinke za SQLite dio: datoteke se kopiraju i sustav je
preseljen.

---

## Tri SQLite zapisa

| Zapis | Što drži | Tko piše | U paketu |
|---|---|---|---|
| **Zadatci i projekti** | zadatci, projekti, povijest svake promjene polja, povijest specifikacije, red izvršavanja, postavke i njihova povijest | ploča (jedini ulaz za stvaranje), orkestrator, alati | `$TM_HOME/data/tasks.db` (`TM_DB`), shema `db/schema.sql` |
| **Poruke** | red dolaznih i međuagentnih poruka, stanje osigurača | ulaz poruka, orkestrator | `messages.db` (`src/core/MessageQueue.ts`) |
| **Trošak** | jedan redak po pozivu modela: agent, zadatak, model, tokeni po razredu, cijena | izvođač nakon svakog spawna | tablica `cost_log` (`src/core/CostTracker.ts`) |

Zašto su poruke odvojene: red poruka je promet, a ne podatak o poslu. Brojač osigurača ili
nepročitana poruka ne smiju se miješati u bazu na kojoj se računa stanje posla. Trošak je u
paketu tablica u glavnoj datoteci (pripis projektu radi se spajanjem sa zadatkom, v.
[TROSAK_I_ENERGIJA.md](TROSAK_I_ENERGIJA.md)), ali je logički zaseban zapis: samo se dopisuje,
nikad ne mijenja.

`db/schema.sql` je jedini izvor istine o shemi — izvezen iz baze koja radi, ne pisan rukom.
`bun run init` je siguran za ponavljanje (`docs/DATABASE.md`).

---

## WAL i zašto se kopija radi s `VACUUM INTO`

Sve baze rade u načinu **WAL** (*write-ahead log*): ploča čita dok agenti pišu, bez
međusobnog čekanja. Uz to je `busy_timeout` 5 s, pa kratko zaključavanje ne znači pogrešku.

Posljedica WAL-a: dio zapisanih podataka stoji u pratećoj datoteci `-wal`, a ne u glavnoj.
**Obična kopija datoteke dok poslužitelj radi daje nedovršeno stanje** — glavna datoteka bez
zadnjih izmjena ili, gore, par datoteka iz dvaju različitih trenutaka.

SQLite za to ima naredbu `VACUUM INTO`: radi usred pisanja, daje dosljednu presliku jednog
trenutka i usput sažme datoteku.

```bash
bun scripts/backup.ts          # preslika u $TM_HOME/backups/, s vremenskom oznakom
```

Čuva se zadnjih 14 preslika (`TM_BACKUP_KEEP`). Nikad `cp` dok poslužitelj radi.

### Testovi ne smiju pisati u živu bazu

U izvornom sustavu testovi su bez izričite putanje pisali ispitne zadatke ravno u pogonsku
bazu. Ispitni zadatak s nositeljem orkestrator je shvatio kao pravi posao i pokrenuo tri skupe
sesije nad smećem (v. [LEKCIJE.md](LEKCIJE.md)). Otad postoji strukturna brana
(`src/core/LiveDbGuard.ts`): proces u ispitnom okruženju ne može otvoriti živu bazu za pisanje.
Izlaz za nuždu je izričit: `REGOC_ALLOW_LIVE_DB_IN_TEST`.

---

## Dva zapisa vremena, jedno pravilo poretka

U bazi postoje **dva oblika** vremenske oznake, jer ih pišu različiti putevi:

```
created_at    2026-08-28T11:07:02.561Z     (ISO, iz aplikacije)
updated_at    2026-08-28 11:07:02          (SQLite, iz okidača)
```

Oba nose isti sat — razlikuju se samo znakovi. Ali usporedba nizova na tome pada: `T` (0x54)
veći je od razmaka (0x20), pa bi unutar istog dana ISO zapis **uvijek** pobijedio bez obzira na
sat. Poredak „najnovije gore" tiho je lagao.

Rješenje je jedno pravilo na jednom mjestu (`src/core/ChronoOrder.ts`):

1. svaka se oznaka prije usporedbe svede na isti oblik;
2. vrijeme aktivnosti zadatka je vrijeme dovršenja za zatvorene, vrijeme zadnje promjene za
   ostale, a vrijeme nastanka kao rezerva — redak nikad ne ostane bez ključa;
3. kod izjednačenja odlučuje **brojčani** dio ID-a (kao niz, `TASK-999` je „veći" od
   `TASK-1000`);
4. isti poredak vrijedi za zadatke, projekte i padajuće izbornike.

Prije toga poredak se pisao na tri mjesta (sloj baze, projekti, JavaScript ploče) i razilazio
se. Jedno pravilo poretka znači jedan modul, ne tri usklađena.

---

## RAG — semantička baza znanja

Uz SQLite stoji baza ugradnji za pretraživanje po smislu: **ChromaDB** u paketu
(`src/rag/`, postavke u `src/rag/memory-config.ts` ili varijablama okoline). U izvornom sustavu
kao drugi pozadinski sustav postoji i **pgvector** (PostgreSQL), s istim sučeljem prema
agentima; ugradnje radi lokalni model.

### Vratar upisa: projekt i vrsta su obavezni

Upis bez `project_id` i bez vrste (`tip`) se **odbija**. Razlog je izmjeren: korpus od gotovo
9 000 dokumenata imao je **nula** takvih oznaka, pa se znanje nije dalo presjeći s pločom —
„što znamo o ovom projektu" nije imalo odgovor.

Druga pouka došla je odmah iza prve. Nakon uvođenja vratara pokrivenost novih upisa bila je
samo 10 %, jer je **90 % upisa radila automatika** (sažetak sjednice na kraju rada) izravno,
mimo vratara. Odluka:

- mjeri se pokrivenost **samo namjernih upisa** (čovjek ili agent svjesnom odlukom);
- automatski upisi označavaju se kao takvi i pripisuju projekt samo kad ga okolina zna — ne
  izmišljaju ga. Izmišljen projekt za 90 % korpusa zatrovao bi upravo presjek zbog kojeg je
  vratar uveden.

### Istraživanje mora završiti u RAG-u

Zadatak s oznakom `istrazivanje` ne prolazi u `completed` bez ID-a upisanog dokumenta u
rezultatu (`src/core/ResearchRagGate.ts`). Razlog: transkripti se čuvaju oko 30 dana, pa je
plaćeno istraživanje koje živi samo u razgovoru nestajalo — a isti se posao naručivao ponovno.
Ovaj vratar smije odmah uživo, jer nije heuristika: provjerava oznaku i doslovan ID.

### Zaštićene zbirke

Zbirke koje se čitaju pri pokretanju sjednice (sažetci prethodnih sjednica, naučene lekcije,
jezična referenca) ne smiju se isključiti iz pretrage ni obrisati bez izričite odluke.
`tools/rag_archive.py --drop` ih odbija ukloniti, a prije svakog uklanjanja radi se izvoz.
Čišćenje pokreće alat, a alat ne zna što je vrijedno.

Vidi i: [ARHITEKTURA.md](ARHITEKTURA.md) · [TROSAK_I_ENERGIJA.md](TROSAK_I_ENERGIJA.md)
