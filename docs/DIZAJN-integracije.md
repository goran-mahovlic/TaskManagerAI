# Dizajn — konfiguracija integracija: Nextcloud, e-pošta, GitLab, GitHub

| | |
|---|---|
| **Autorica** | Kosjenka (Architect), TASK-4799 (PRJ-048) |
| **Datum** | 10.09.2026. |
| **Polazište** | `docs/ROADMAP_SAMOSTALNOST.md` §2 |
| **Uzor** | `src/DezurniConfig.ts`, `src/TelegramConfig.ts`, `src/core/IngestConfig.ts` |
| **Uz** | `docs/adr/ADR-0001-orchestrator-core.md` (§5 zajednička pravila konfiguracije) |

---

## 0. Zatečeno stanje (izmjereno)

Provjereno u `~/.claude/regoc/tools/` i `~/app/regoc_system/integrations/`:

* **Nema nijednog modula** za Nextcloud WebDAV, IMAP/SMTP ni GitHub API. Postoje samo
  skripte pisane za jedan konkretan zadatak (`gitlab_api_audit.sh`, `gitlab_finish_4732.sh`)
  i `rclone_eu2026_*` (sinkronizacija jednog projekta).
* `TaskManagerSQL` ima polje `nextcloudFolder`, ali ono je **samo tekstualna etiketa** —
  nitko ništa ne čita ni ne piše na Nextcloud.
* `integrations/*/README.md` u privatnom repozitoriju navode **naše stvarne vrijednosti**
  (`regoc_ai@intergalaktik.hr`, `192.168.10.200`). Te se datoteke **ne smiju** kopirati u
  javni paket kakve jesu.

Dakle: piše se novo, a ne prenosi postojeće.

---

## 1. Zajednički obrazac (vrijedi za sva četiri modula)

Svaki modul je **jedna datoteka** `src/<Ime>Config.ts` s istim petorkom, doslovno kao
`TelegramConfig.ts`:

```ts
export const <IME>_CONFIG_PATH: string          // putanja, po pravilu iz §1.1
export interface <Ime>Postavke { … }            // oblik
export const ZADANE_POSTAVKE: <Ime>Postavke     // §1.2 — bez ijedne tajne i bez naših adresa
export const GRANICE = { … } as const           // duljine i rasponi
export function load<Ime>Config(path?): <Ime>Postavke & Record<string, unknown>
export function validate<Ime>Patch(tijelo: unknown): { ok, greske, zakrpa }
export function save<Ime>Config(zakrpa, path?): <Ime>Postavke & Record<string, unknown>
export async function probaj<Ime>(path?): Promise<{ ok: boolean; greska?: string; detalj?: … }>
```

Uz to tri rute u `TaskWebUI.ts` (isti oblik kao `/api/telegram/*`, redci 13292–13304):

```
GET  /api/<ime>/config   → { postavke, stanje, putanja, granice }
PUT  /api/<ime>/config   → { ok, postavke }        | 400 { error, greske }
POST /api/<ime>/proba    → { ok, greska?, detalj? } (uvijek HTTP 200 — ishod je podatak)
```

i jedna kartica na stranici Config (`renderTelegram` kao predložak, redci 7346–7455).

### 1.1 Gdje živi datoteka

**Ispravlja se nasljeđe.** `TelegramConfig.ts:23` i `DezurniConfig.ts:20` danas gađaju
`~/.claude/regoc/config/…` — to je naš raspored i ne postoji na tuđem stroju. Novi moduli
(i, po ADR-0001 O1.4, ta dva postojeća) koriste obrazac iz `IngestConfig.zadanaPutanja()`:

```
$TM_<IME>_CONFIG  →  $TM_HOME/config/<ime>.json  →  config/<ime>.json uz paket
```

### 1.2 Pravilo zadanih vrijednosti (ADR-0001 §5.1)

* `ukljucen: false` — **nijedna integracija se ne pali sama.**
* Svako polje koje bi bilo adresa, korisnik, mapa ili identitet: `''` ili `null`.
  **Nikad naša vrijednost.** Isti kvar koji je u živom daemonu upisao
  `http://192.168.10.4:11434` kao zadano (`RegocDaemon.ts:2565`) ne smije se ponoviti.
* Provjera odbija nepoznato polje imenom (tipfeler bi tiho stvorio mrtvu postavku — kvar
  koji je u REGOČ-u gutao `progress_notes`).

### 1.3 Tajne

**Lozinke, tokeni i ključevi ne idu u JSON.** JSON nosi **ime varijable okoline**, isti
zapis kao `model-config.json` (`apiKey: "env:VAR"`) koji `DezurniConfig.imaKljuc()` već
čita — a taj namjerno provjerava **samo postojanje** i vrijednost nikad ne vraća.

```jsonc
"lozinkaEnv": "NEXTCLOUD_APP_PASSWORD"   // ✅ ime varijable
"lozinka": "…"                            // ❌ nikad
```

`GET /api/<ime>/config` vraća **stanje**, ne vrijednost:

```jsonc
"stanje": { "tajnaPostavljena": true, "spreman": false, "zastoKey": "int_zasto_treba_kljuc" }
```

`zastoKey` + `zastoVars` (a ne gotova hrvatska rečenica) — jer ploču se prevodi
(`locales/hr.json`, `en.json`); isto rješenje kao `DezurniConfig.DavateljDezurnog.zastoKey`.

Ako korisnik ipak upiše tajnu kroz ploču, ona ide u `$TM_HOME/config/credentials.env`
s pravima **0600**, a JSON i dalje nosi samo ime varijable. `.gitignore` mora pokrivati
`config/*.json` **i** `config/credentials.env` za sve nove module.

### 1.4 „Probaj konekciju" — obrana od SSRF-a

Svaka proba šalje zahtjev na **adresu koju je upisao korisnik**. To je klasičan SSRF
(poslužitelj kao posrednik prema unutarnjoj mreži), pa je zajednička provjera obavezna i
živi u jednom modulu, `src/core/ProbeGuard.ts`:

1. Shema je `https` (za `http` traži izričit `dopustiHttp: true` u postavkama).
2. Odbij `file:`, `gopher:`, `ftp:`, preusmjeravanja izvan izvornog hosta
   (`redirect: 'manual'`), i odgovore veće od 64 KB.
3. Rok **10 s**, najviše 1 proba u 5 s po modulu (anti-skener).
4. Proba vraća `{ ok, greska, detalj }` gdje je `detalj` **sažetak** (HTTP kod, trajanje,
   naziv poslužitelja), nikad sirovo tijelo odgovora — inače „Probaj" postaje čitač
   unutarnjih stranica.
5. Zapis u dnevnik ide **bez** tajne i bez punog URL-a s korisničkim imenom.

Odluku o zabrani privatnih raspona (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`)
**ne** donosim jednostrano: kućni Nextcloud i lokalni GitLab su upravo tamo. Zato je to
postavka `dopustiPrivatneMreze` (zadano `true`, uz vidljivo upozorenje na kartici), a ne
tvrda zabrana koja bi cijelu značajku učinila beskorisnom za samostalno hostanje.
Malik ovo mora pregledati prije javnog pusha.

---

## 2. Nextcloud — `src/NextcloudConfig.ts`

**Protokol:** WebDAV (`PROPFIND`, `MKCOL`, `PUT`) + OCS Share API. Bez vanjskih knjižnica —
izravni `fetch`, isto kao `TelegramConfig.posaljiTelegramPoruku()`.

```ts
export interface NextcloudPostavke {
  ukljucen: boolean
  baseUrl: string          // '' — npr. https://oblak.primjer.hr
  korisnik: string         // ''
  lozinkaEnv: string       // 'NEXTCLOUD_APP_PASSWORD' — IME varijable (§1.3)
  korijenskaMapa: string   // '' — npr. 'TaskManager'
  mapaPoProjektu: boolean  // true — <korijen>/<Projekt>/
  dopustiHttp: boolean     // false
  dopustiPrivatneMreze: boolean // true (§1.4)
}
```

**Granice:** `baseUrl` ≤ 200 i mora proći `ProbeGuard`; `korijenskaMapa` bez `..`, bez
vodeće `/`, bez `\`, ≤ 100 (obrana od izlaska iz mape).

**Proba:** `PROPFIND` `Depth: 0` na `{baseUrl}/remote.php/dav/files/{korisnik}/` →
`207 Multi-Status` = radi. Poruke po ishodu: `401` → „korisnik ili lozinka aplikacije nisu
točni"; `404` → „adresa nije Nextcloud ili korisnik ne postoji"; mreža → „poslužitelj nije
dostupan".

**Što ovo omogućuje (a što danas ne postoji):** polje `nextcloudFolder` na zadatku prestaje
biti etiketa. Prvi korisnik je `createProjectWorkflow` (koji već vraća
`result.nextcloud?.folder_path`, `TaskWebUI.ts:4651`, ali danas bez ijedne implementacije
iza sebe).

**Opseg:** modul isporučuje `osiguraj Mapu(putanja)` i `postaviDatoteku(putanja, sadržaj)`.
Sinkronizacija u oba smjera **nije** u opsegu — to je `rclone`, ne naš posao.

---

## 3. E-pošta — `src/EmailConfig.ts`

Jedini modul koji traži vanjsku knjižnicu, i to samo za primanje.

```ts
export interface EmailPostavke {
  ukljucen: boolean
  smjer: 'izlaz' | 'ulaz' | 'oba'   // 'izlaz'
  smtp: { host: string; port: number; tls: boolean; korisnik: string; lozinkaEnv: string; posiljatelj: string }
  imap: { host: string; port: number; tls: boolean; korisnik: string; lozinkaEnv: string;
          mapa: string;               // 'INBOX'
          filtar: string;             // '' — npr. 'To: zadaci@…' ili 'Subject: [TASK]'
          intervalSek: number;        // 60
          oznaciProcitano: boolean }  // true
  primatelji: string[]                 // [] — kamo idu obavijesti
}
```

**Izlaz (SMTP)** — obavijest o zadatku, isti pozivatelj kao `obavijestiZadatak()` u
`TelegramConfig.ts`. Bun nema ugrađen SMTP klijent; **preporuka: `nodemailer` kao
`optionalDependencies`** (isti obrazac kao `chromadb`/`ollama` u `package.json`) — bez njega
kartica jasno kaže „za e-poštu instaliraj `bun add nodemailer`", a ostatak paketa radi.

**Ulaz (IMAP)** — poller po uzoru na Telegram poller (`docs/DIZAJN-telegram-poller.md`):
svaka nova poruka koja prođe filtar postaje jedan `POST /api/ingest` s
`source: 'email'`, `externalId: <Message-ID>`, `replyTo: <From>`, `text: <tijelo>`,
`senderName: <ime>`. **Nikakva klasifikacija u pollleru** — `Ingest.ts` to već radi.

**Proba:** SMTP → `EHLO` + `AUTH`, bez slanja poruke (`smjer: 'ulaz'` preskače);
IMAP → `LOGIN` + `SELECT <mapa>` pa odmah `LOGOUT`, vraća broj neprocitanih.

**Sigurnosna napomena za Malika:** `filtar` je jedino polje koje bez provjere pušta
korisnikov niz u IMAP naredbu → mora se odbiti sve s `\r`, `\n` i `"` (CRLF injection).

---

## 4. GitLab — `src/GitLabConfig.ts`

**Nije novi HTTP klijent.** GitLab ima službeni `glab` CLI koji sam čuva prijavu — dakle
„donesi svoj nalog" je već riješeno. Modul radi dvoje: pamti **koji projekt** i **kako se
zove udaljeni poslužitelj**, te provjerava da prijava postoji.

```ts
export interface GitLabPostavke {
  ukljucen: boolean
  nacin: 'cli' | 'api'     // 'cli'
  host: string             // '' — npr. gitlab.com ili gitlab.tvrtka.hr
  projekt: string          // '' — 'grupa/repozitorij'
  tokenEnv: string         // 'GITLAB_TOKEN' — koristi se SAMO uz nacin:'api'
  otvarajIssue: boolean    // false — zadatak s oznakom `gitlab` → issue
  zatvarajIssue: boolean   // false — completed → zatvori issue
  oznakaSinkro: string     // 'gitlab'
}
```

**Proba:**
* `nacin: 'cli'` → `glab auth status` (exit 0 = prijavljen) pa `glab api projects/:id`;
  ako `glab` nije na `PATH`-u, poruka je uputa za instalaciju, ne greška.
* `nacin: 'api'` → `GET {host}/api/v4/projects/{urlencode(projekt)}` s
  `PRIVATE-TOKEN` iz `tokenEnv`, kroz `ProbeGuard`.

**Opseg:** samo issue (otvori / zatvori / komentiraj). **Git operacije nisu u opsegu** —
za njih već postoji `src/core/GitCommitGate.ts` i korisnikov vlastiti `git`.

---

## 5. GitHub — `src/GitHubConfig.ts`

Isto kao GitLab, s `gh` CLI-jem. `gh` sam čuva prijavu (`gh auth login`), pa je paket
zapravo **već spreman** i treba mu dokumentacija, ne kod (nalaz `ROADMAP` §2 potvrđen).

```ts
export interface GitHubPostavke {
  ukljucen: boolean
  nacin: 'cli' | 'api'     // 'cli'
  repo: string             // '' — 'vlasnik/repozitorij'
  tokenEnv: string         // 'GITHUB_TOKEN' — samo uz nacin:'api'
  otvarajIssue: boolean    // false
  zatvarajIssue: boolean   // false
  oznakaSinkro: string     // 'github'
}
```

**Proba:** `gh auth status` → `gh repo view {repo} --json name` (`nacin: 'cli'`), odnosno
`GET https://api.github.com/repos/{repo}` (`nacin: 'api'`).

**Zajedničko s GitLabom:** oba dijele `src/core/IssueSync.ts` — jedan modul s dvije tanke
izvedbe. Dvije odvojene preslike iste logike bile bi četvrta i peta preslika pravila, a
memorija sustava već bilježi kvar „pravila žive u 9 preslika".

---

## 6. Ploča: gdje stoje četiri nove kartice

Config stranica danas ima kartice Dežurni, Telegram, Ulazna vrata, Modeli. Četiri nove
kartice = osam ukupno, što je granica preglednosti (`ROADMAP` §6.5 to i predviđa).

**Prijedlog za Grgu:** nova skupina **„Integracije"** s jednim retkom po integraciji
(ikona · naziv · značka stanja · gumb „Podesi") koja se otvara u ploču s detaljima.
Značka ima tri stanja i dolazi izravno iz `stanje`:

| Značka | Uvjet |
|---|---|
| ⚪ isključeno | `ukljucen === false` |
| 🟡 nepotpuno | `ukljucen && !spreman` (fali adresa ili tajna — tekst iz `zastoKey`) |
| 🟢 radi | `ukljucen && spreman` **i** zadnja proba prošla |

Zadnji ishod probe pamti se u `$TM_HOME/data/integracije.json`
(`{ "<ime>": { "ts": …, "ok": …, "greska": … } }`) — inače značka nakon osvježavanja
stranice laže („spreman" ≠ „provjereno"). To je ista razlika koju ADR-0001 §5.1 traži
između „konfigurirano" i „radi".

---

## 7. Testovi (uvjet gotovosti za Jelenu)

Po modulu, isti oblik kao `tests/ingest.test.ts`:

1. `load*` bez datoteke → `ZADANE_POSTAVKE`, i **nijedno polje nije naša vrijednost**
   (izričita tvrdnja: nema `192.168.`, nema `@intergalaktik`, nema `/home/klaudio`).
2. `validate*Patch` odbija nepoznato polje **imenom** i vraća popis dopuštenih.
3. `validate*Patch` odbija `baseUrl` koji nije `http(s)`, i `..` u nazivu mape.
4. `save*` → `load*` vraća zapisano; nepoznata polja iz datoteke se **čuvaju**.
5. `GET /api/<ime>/config` **nikad** ne vraća vrijednost tajne (tvrdnja nad cijelim tijelom
   odgovora, ne samo nad poljem).
6. `ProbeGuard` odbija `file://`, preusmjeravanje na drugi host i odgovor > 64 KB.

---

## 8. Redoslijed

| # | Sadržaj | Zašto tim redom |
|---|---|---|
| 1 | `src/core/ProbeGuard.ts` + testovi | četiri modula ga dijele; napisan poslije = četiri preslike |
| 2 | Nextcloud | jedini s jasnim korisnikom u paketu (`createProjectWorkflow`) |
| 3 | GitHub + `IssueSync` | najmanje koda (`gh` postoji), dokazuje obrazac |
| 4 | GitLab | druga izvedba istog `IssueSync` |
| 5 | E-pošta (izlaz) | traži `optionalDependencies` |
| 6 | E-pošta (ulaz, IMAP poller) | ovisi o pollerskom obrascu iz `DIZAJN-telegram-poller.md` |

Prije koraka 1 mora biti gotov **ADR-0001 O1** (brana protiv naših vrijednosti). Inače
četiri nova modula nastaju u repozitoriju u kojem se to još ne mjeri.
