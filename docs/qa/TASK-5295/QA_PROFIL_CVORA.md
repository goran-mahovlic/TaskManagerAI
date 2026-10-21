# QA — profil čvora: proba alata na node-A, suhi prolaz na node-B (ADR-0004 §10, P1–P4)

| | |
|---|---|
| **Zadatak** | TASK-5298 (Potjeh, QA) |
| **Datum** | 07.10.2026., oko 00:55–01:20 CEST |
| **Alat** | `scripts/profil-cvora.ts` iz `eff8a70` (TASK-5297, Jelena; spojeno u granu probe fast-forwardom) |
| **Profil** | `profili/upravitelj-cvora/profil.json` |
| **Način** | samo čitanje: `--ssh` (sakupljač ide SSH standardnim ulazom, na čvoru ne nastaje datoteka). Na node-A se ništa ne piše. Ploča i daemon nisu restartani. Tajne nisu unošene. |
| **Sirovi izlazi** | [`proba_TASK-5298/`](proba_TASK-5298/) |

## Sažetak

| # | Mjerilo (ADR-0004 §10) | Ishod | Ključni dokaz |
|---|---|---|---|
| **P1** | node-A: `provjeri` → izlaz 0 (ili samo stavke `covjek`) | ❌ **nije ispunjeno doslovno** — izlaz **1**: OK 93 · RAZLIKA 1. Razlika je stvarna i namjerna promjena na čvoru, a ne kvar alata. Uz nju ide nalaz N1. | `razgovor.botKanal.ukljucen` profil=`true` čvor=`false` (Malik, TASK-5291, 22:30:58Z: „uključuje vlasnik") |
| **P2** | node-B: `provjeri` + `primijeni --suho` ≈ §8 (63 + preduvjet → kod 3), otisak prije = poslije | ✅ izlaz **3** u oba, a svaki modul odgovara §8 (tablica niže). Otisak `f5cb881623fae8a0` = `f5cb881623fae8a0` (isti kao u §8) | `P2_B_provjeri.txt`, `P2_B_suho.txt`, `otisci.txt` |
| **P3** | nijedna tajna u izlazu oba prolaza; kanarinac po J4 | ✅ **0 tajni**. Usporedba sa **stvarnim** vrijednostima na oba čvora (cijela vrijednost i svaki 12-znakovni odsječak): node-A 12 vrijednosti, node-B 4. Jedini pogodak je lažno pozitivan: `TASK_MANAGER_API` je javni URL `http://127.0.0.1:…`. J4 kanarinac: 1 pass | `P3_A.txt`, `P3_B.txt`, `P3_A_tmapi.txt` |
| **P4** | `primijeni --pisi` na node-B tek uz vlasnikovo odobrenje i nakon §9 P1–P4 | ⏸ **OTVORENO — nije izvedeno.** U zadatku nema vlasnikova odobrenja, a §9 P1 nije ispunjen (`d6a79fc` nije u `main`) | `git merge-base --is-ancestor d6a79fc main` → ne; `P4_B_pisi_ssh_odbijeno.txt` (izlaz 4) |

Otisak node-A (`docs/qa/TASK-5295/otisak.sh`) prije = poslije = `6a7e6e36749d19d6`. Za node-B v. P2.

---

## P1 — node-A (`regoc@<node-A>`, kod `d0bfb147`)

```
bun scripts/profil-cvora.ts provjeri --ssh regoc@<node-A> --instanca ~/.claude/regoc/deploy/profili/node-A.instanca.env
→ exit=1
```
```
[paket] 10/10 OK
[okolina] 15/15 OK          TAJNA postoji TM_CREDENTIALS, TM_BOT_KANAL_TOKEN
[telegram] 22/22 OK         TAJNA postoji TELEGRAM_BOT_TOKEN
[razgovor] 13/13 OK
[glas] 3/3 OK
[memorija] 7/7 OK
[bot-kanal] 7/8 OK
  RAZLIKA razgovor.botKanal.ukljucen: profil=true čvor=false
[tunel-memorije] 1/1 OK
[capguard] 8/8 OK
[claude] 4/4 OK             TAJNA postoji claude-prijava
[upravitelj] 1/1 OK
[home] 1/1 OK
[rag] 1/1 OK
ZBROJ: OK 93 · RAZLIKA 1 · NEDOSTAJE 0 · TAJNA-NEDOSTAJE 0 · ČOVJEK 0 · PRESKOČENO 0 · PREDUVJET 0
```

`primijeni --suho` (isti čvor, samo čitanje): exit=1, `SUHO: primijenilo bi se 1 stavki`.

**Usporedba sa 73/73 iz §8:** alat provjerava **94** stavke (proba dizajna 73). Razlog je što alat
dodatno provjerava značajke koda (`paket` 10), vrata, unite i tajne imenom. Svih 73 vrijednosti
iz §8 je i dalje jednako, osim jedne koja se na čvoru promijenila **nakon** snimke profila:

`settings_history` na node-A (čitano `mode=ro`):
```
razgovor.botKanal.ukljucen  true   jelena-TASK-5290                                      2026-10-06T22:10:09Z
razgovor.botKanal.ukljucen  false  malik-TASK-5291 (sigurnosni pregled: uključuje vlasnik)  2026-10-06T22:30:58Z
```
Isto je izmjerila Jelena u J10 (`docs/qa/TASK-5297/README.md`). Zato P1 ne prolazi doslovno:
izlaz je 1, a ne 0, i razlika nije stavka `covjek`.

### Nalaz N1 — `primijeni --pisi` bi na node-A poništio sigurnosnu odluku (treba odluku vlasnika profila)

`primijeni --suho` na node-A javlja da bi **upisao `razgovor.botKanal.ukljucen=true`**. Prema
povijesti postavki, uključenje kanala bot↔bot je Malikovom odlukom (TASK-5291) ostavljeno
**Vlasniku**. ADR-0004 §5 pr. 7 („ovlast se ne podiže alatom") štiti samo `ovlasti=puno` i
capguard. Uključenje kanala ima istu narav (otvara ulaz koji izvršava tuđe poruke), ali ga
alat tretira kao običnu postavku vlasnika `paket`. Prijedlog za Kosjenku/Jelenu, a ne odluka QA-a:
* ili `botKanal.ukljucen` ide pod stavku `covjek` (kao `TM_RAZGOVOR_PUNO`), pa alat upisuje
  najviše `false` i javlja upozorenje,
* ili profil nosi `false`, a uključenje ostaje na kontrolnom popisu `PROFIL_CVORA_TAJNE.md`.

Do odluke: **`primijeni --pisi` na node-A se ne pokreće** (to je ionako izvan ovog zadatka).

## P2 — node-B (`regoc@<node-B> -p 2222`, kod `8d52710`)

Instanca je `profili/upravitelj-cvora/instanca.primjer.env`, ista kao u probi dizajna (§8).
Port se zadaje kao `ssh://regoc@<node-B>:2222`, jer alat nema zastavicu za port (v. N3).

```
T=/home/klaudio/app/tmp/TASK-5298; B=ssh://regoc@<node-B>:2222; I=profili/upravitelj-cvora/instanca.primjer.env
ssh $B bash -s < docs/qa/TASK-5295/otisak.sh                         → f5cb881623fae8a0   (prije)
bun scripts/profil-cvora.ts provjeri          --ssh $B --instanca $I → exit=3
bun scripts/profil-cvora.ts primijeni --suho  --ssh $B --instanca $I → exit=3, "SUHO: primijenilo bi se 28 stavki (ništa nije zapisano…)"
bun scripts/profil-cvora.ts provjeri --json   --ssh $B --instanca $I → exit=3
ssh $B bash -s < docs/qa/TASK-5295/otisak.sh                         → f5cb881623fae8a0   (poslije; = §8)
```
`ZBROJ: OK 25 · RAZLIKA 28 · NEDOSTAJE 15 · TAJNA-NEDOSTAJE 1 · ČOVJEK 2 · PRESKOČENO 9 · PREDUVJET 6`.
Izlaz `primijeni --suho` jednak je izlazu `provjeri` redak po redak, uz dodatni redak `SUHO:`
(`diff` → isto).

**Usklađivanje sa §8 (63 razlike), modul po modul:**

| §8 (`usporedba_nodeB.txt`) | Alat (`P2_B_provjeri.txt`) | Slaže se? |
|---|---|---|
| `telegram` 21 | `telegram` RAZLIKA 21 (+ TAJNA-NEDOSTAJE `TELEGRAM_BOT_TOKEN`) | ✅ 21 = 21 |
| `env` 9 | `okolina` RAZLIKA 2 + PRESKOČENO 7 („ovisi o praznoj varijabli instance", primjer ima prazne putanje) | ✅ 9 = 9 |
| `settings` memorija 6 | `memorija` NEDOSTAJE 6 | ✅ |
| `settings` razgovor.glas 2 | `glas` NEDOSTAJE 2 | ✅ |
| `settings` razgovor 13 | `razgovor` NEDOSTAJE 5 + UPOZORENJE 1 (`ovlasti`) + **OK 7** | ≈ — 7 ključeva alat računa kao OK jer je zadana vrijednost koda jednaka profilu, dok ih je proba dizajna brojala kao „nema retka" (v. N2) |
| `settings` razgovor.botKanal 8 | `bot-kanal` PRESKOČENO (`BOTKANAL_ADRESE` prazan u primjeru) | ≈ — po §4 pravilu modula, ispravno |
| `capguard` 2 | `capguard` RAZLIKA 2 (`allow_messaging`, `allow_root`) | ✅ |
| `claude` 2 | `claude` RAZLIKA 2 (hooks) + NEDOSTAJE kuka + ČOVJEK prijava | ✅ (+ podrobnije) |
| „preduvjet → kod 3" | `paket` PREDUVJET 6 (razgovor, kratki stil, privitci, bot↔bot, glas, capguard kartica) → **exit 3** | ✅ |
| — | `upravitelj` RAZLIKA 1 (nema `~/CLAUDE.md`), `tunel-memorije` NEDOSTAJE 1 | dodatno, u skladu s §1 (node-B nema ni jedno ni drugo) |

## P3 — tajne u izlazu

Svi izlazi oba prolaza spojeni su u jednu datoteku (`svi_izlazi.txt`, 30 771 B: P1 txt+json+suho,
P2 txt+json+suho, P4 odbijanje). Ta datoteka ide standardnim ulazom na **svaki čvor**, gdje
`p3_kanarinac.py` čita stvarne vrijednosti tajni (`TM_BOT_KANAL_TOKEN` iz `postavke.env`, sve
vrijednosti iz datoteke `TM_CREDENTIALS`, sva polja Claude prijave) i traži cijelu vrijednost i
**svaki 12-znakovni odsječak** (pravilo 2: „ni djelomično"). Skripta ispisuje samo ime i da/ne.

```
ssh regoc@<node-A> "python3 -c 'import base64;exec(base64.b64decode(\"$(base64 -w0 p3_kanarinac.py)\"))'" < svi_izlazi.txt
TM_BOT_KANAL_TOKEN: cijela=ne odsjecak12=ne
TM_CREDENTIALS:TELEGRAM_BOT_TOKEN: cijela=ne odsjecak12=ne
TM_CREDENTIALS:OPENROUTER_API_KEY / GEMINI_API_KEY / OLLAMA_HOST: cijela=ne odsjecak12=ne
TM_CREDENTIALS:TASK_MANAGER_API: cijela=ne odsjecak12=DA      ← lažno pozitivno, v. dolje
claude-prijava.claudeAiOauth.accessToken / refreshToken / scopes / rateLimitTier: cijela=ne odsjecak12=ne
TAJNI_PROVJERENO=12 POGODAKA=1

ssh ssh://regoc@<node-B>:2222 … < svi_izlazi.txt
TAJNI_PROVJERENO=4 POGODAKA=0          (node-B nema bot tokena, tajne kanala ni Claude prijave)

p3_tmapi.py na node-A: je_url=True lokalna_adresa=True pogodaka_odsjecaka=9 svi_pogoci_unutar_http_127_0_0_1=True
```
Pogodak `TASK_MANAGER_API` dolazi od toga što je vrijednost lokalni URL ploče, a izlaz s pravom
sadrži `memorija.url=http://127.0.0.1:17792`. Svih 9 odsječaka leži unutar `http://127.0.0.1:177…`.
To nije tajna, nego adresa koja je u datoteci vjerodajnica samo smještena.

Grep po obliku nad istom datotekom: Telegram token `\d{8,10}:[A-Za-z0-9_-]{30,}` → **0**;
`sk-ant-|sk-or-|AIza…` → **0**; hex ≥ 32 znaka → **0**. Tajne se pojavljuju samo kao
`TAJNA postoji …` / `TAJNA-NEDOSTAJE …` (17 redaka).

**Kanarinac po J4** (na živom čvoru se ne smije postaviti, jer bi to bilo pisanje i unos tajne):
```
bun test tests/profil-cvora.test.ts -t J4   → 1 pass, 0 fail
bun test tests/profil-cvora.test.ts         → 26 pass, 0 fail, 149 expect()
```

## P4 — `primijeni --pisi` na node-B: OTVORENO

Nije izvedeno. Uvjeti iz §10 nisu ispunjeni:

| Uvjet | Stanje 07.10. |
|---|---|
| Vlasnikovo izričito odobrenje u zadatku | **nema** (opis i bilješke TASK-5298 ga ne sadrže) |
| §9 P1 — `d6a79fc` u `main` | **ne** (`git merge-base --is-ancestor d6a79fc main` → ne). Na node-B to potvrđuje i izlaz 3 (6 značajki nedostaje) |
| §9 P2 — commiti s node-A preuzeti/odbačeni | nije provjereno u ovom zadatku (Vlasnikova odluka) |
| §9 P3 — disk node-B | **89 %, 2,0 GB slobodno** (nepromijenjeno) |
| §9 P4 — drugi bot i grupa za node-B | nema traga (node-B: `TAJNA-NEDOSTAJE TELEGRAM_BOT_TOKEN`) |

Zaštita alata provjerena je bez pisanja: `primijeni --pisi --ssh …` alat **odbija prije
sakupljanja** (`citajOpcije`) s izlazom 4:
```
ODBIJENO: --pisi preko --ssh je zabranjen: alat na tuđi čvor samo čita (ADR-0004 §5 pr. 4) — pokreni ga NA čvoru, uz odobrenje
```
Otisak node-B nakon toga je i dalje `f5cb881623fae8a0`.

## Ostali nalazi (za izvedbu, nisu blokirajući)

* **N2 — „OK" za ključ kojeg kod nema.** Na `8d52710` nema razgovornog modula, a 7 ključeva
  `razgovor.*` alat ipak računa kao OK. Uspoređuje ih sa zadanim vrijednostima **ovog** paketa
  (`RAZGOVOR_ZADANO`), a ne čvora. Ishod je ispravan jer izlaz 3 (PREDUVJET) svejedno zaustavlja
  primjenu. Ipak bi bilo jasnije da se ključevi modula bez značajke u kodu broje kao NEDOSTAJE
  ili PRESKOČENO.
* **N3 — nema zastavice za SSH port.** `--ssh` prima samo `korisnik@stroj`. Za node-B radi
  `ssh://regoc@<node-B>:2222` (OpenSSH URI), ali to nije dokumentirano u `--help` ni u §5.
* **N4 — testovi u svježem worktreeu.** `bun test tests/profil-cvora.test.ts` bez `node_modules`
  pada (`Cannot find package 'zod'`), dok `bun scripts/profil-cvora.ts` radi (bun pri pokretanju
  skripte sam instalira pakete). Potreban je `bun install --frozen-lockfile`, nakon kojeg 26/26 prolazi.
  Ako čvor nema `zod` i nema mreže, alat pokrenut **na čvoru** (§6 korak 5) mogao bi pasti. To
  treba provjeriti pri prvom `--pisi`.
* **Opaska:** `hostname` na oba čvora je `regocAI`. U izlazima se čvorovi zato razlikuju samo po
  SSH cilju. Ime čvora nije dio profila (`CVOR_IME` je u instanci).
