# ADR-0007 — Upis tajni kroz ploču: samo-za-pisanje, potvrda vlasnika, jedno spremište

| | |
|---|---|
| **Stanje** | Prihvaćeno (dizajn i model prijetnje, bez koda). Izvedba: Jelena (§11). Proba: Potjeh (§11). Pregled izvedbe: Malik. **Dopuna TASK-5357** (Jelena, 08.10.2026.): §4.2a primatelj koda iz profila čvora, §4.3 privatni LAN zadano dopušten — čeka Malikov pregled |
| **Datum** | 08.10.2026. |
| **Autor** | Malik (Security), TASK-5342 (PRJ-048) |
| **Nalog** | Goran, grupa node-A, 08.10.2026.: u TaskManageru mora postojati upis lozinke/tajne koja se zapisuje na disk u spremište tajni čvora. Upis lozinke za mail na node-A tražio je prijavu na računalo, a to nije prihvatljivo. Upis ide kroz TaskManager i mora biti siguran. Vrijedi za **sve** TaskManagere: glavni, node-A, node-B i paket TaskManagerAI |
| **Nadograđuje** | `src/LoginCreds.ts` (TASK-4796), `core/ConfigModul.ts → zapisiTajnu/procitajTajnu/tajnaPostavljena`, `docs/PROFIL_CVORA_TAJNE.md`, ADR-0004 (profil čvora), ADR-0002 §7.1 (ovlasti razgovora) |
| **Pravila** | CLAUDE.md pr. 19 (tajne lokalno; Goranov upis na samom čvoru je nalog), TASK-3043 (tajna nikad u transkript), TASK-3686/4722 (preglednik ne smije nuditi spremanje), TASK-5333 (CORS brana) |
| **Mjerenja** | PoC u radnoj mapi zadatka (`poc.ts`, izvan repozitorija), §1.3 |

> Dokument je u javnom repozitoriju. Ne navodi nijednu vrijednost tajne, adresu ni chat ID.

---

## 1. Stanje (izmjereno 08.10.2026., samo čitanje + PoC u izoliranoj mapi)

### 1.1 Što već postoji

Postoje **tri** pisača spremišta i **pet** čitača. Nijedan par ne dijeli format.

| Mjesto | Uloga | Primjedba |
|---|---|---|
| `ConfigModul.zapisiTajnu` | pisač (Telegram token, `saveTelegramConfig`) | provjerava ime (`^[A-Z][A-Z0-9_]{1,63}$`) i odbija `\r\n`. Zapis ide kroz `tmp` pa `rename`, s pravima 0600. Ime `tmp` je `<spremište>.tmp-<pid>`, pa dva istodobna upisa iz istog procesa dijele datoteku. Nema zaključavanja: dva procesa (ploča i CLI) gube upis jedan drugome |
| `TaskWebUI.handleLoginApikey` (`POST /api/providers/login/apikey`) | pisač (ključevi davatelja) | **ne** odbija `\n` unutar ključa (`key.trim()` reže samo rubove). `writeFileSync` piše izravno, bez `tmp`+`rename`. Ime se ugrađuje u RegExp bez escapea. Ime je stalno, pa ovo zasad nije iskoristivo |
| `LoginCreds.ukloniKljucIzDatoteke` | brisač (odjava) | miče cijeli redak. Dobro, i to ostaje. Piše izravno, bez `tmp`+`rename` |
| `ConfigModul.procitajTajnu` / `tajnaPostavljena` | čitač u procesu | **`process.env` ima prednost pred datotekom**. Nova vrijednost u datoteci ne vrijedi dok okolina procesa nosi isto ime (§7.1). Vrijednost se `trim`-a i skidaju joj se rubni navodnici |
| `LoginCreds.kljucPrisutan`, `odluciteljDavatelji` | mjerilo „postoji“ | regex `^IME=.+` i `^IME=\S`. Ne poznaju `export` ni navodnike |
| petlja maila (glavni stroj) | čitač: **`set -a; . spremište`** u svakom krugu | spremište se **izvršava kao ljuska** (§1.3) |
| `secret_probe.py` (glavni stroj) | otisak: SHA-256 prefiks | zaseban Python parser |

Ploča **nema prijavu**. Sluša na `0.0.0.0`. Propušta je `isHostAllowed` (Host s popisa ili, uz
`TM_ALLOW_PRIVATE_HOSTS=1`, bilo koja privatna IPv4) i `corsOdluka` (strani `Origin` ne smije
mijenjati, a zahtjev **bez** `Origin`, npr. `curl`, prolazi). Agent na čvoru radi kao isti korisnik
i ima `curl` na `localhost`.

### 1.2 Zašto Goran danas mora na stroj

Za mail (`SMTP_PASSWORD` / `IMAP_PASSWORD`, `EmailConfig.lozinkaEnv`), Nextcloud, GitHub/GitLab
token i lozinku pgvectora ploča pokazuje samo **ime** varijable i „postavljeno/nije“. Polja za
vrijednost nema. Jedini upisi kroz ploču su ključ davatelja (Gemini, OpenRouter) i token
Telegrama. Sve ostalo traži ljusku na stroju.

### 1.3 Nalaz N1 (VISOK) — vrijednost tajne postaje naredba

Spremište je redak `IME=vrijednost` bez navodnika, a bar jedan potrošač ga učita s `. spremište`.
Zato je **vrijednost izvršni kod ljuske**: `$(…)`, `` `…` `` i `;` u vrijednosti izvrše se pri
svakom učitavanju.

PoC (izolirana mapa, pravi `zapisiTajnu` iz paketa):

```
zapis: {"ok":true}                              # zapisiTajnu('EMAIL_PASSWORD', 'tajna$(touch …/RCE_MARKER)')
procitajTajnu vraca isti niz: true
( set -a; . poc_store.env; set +a )
-rw-rw-r-- … RCE_MARKER                          # datoteka je nastala → naredba je izvršena
600 poc_store.env
```

**Lanac na glavnom stroju (pročitan iz koda, NE iskorišten na živom):**
1. `POST /api/providers/login/apikey` piše `IME=<ključ>` u glavno spremište, bez prijave, bez
   provjere retka i bez navodnika.
2. Petlja maila radi i u svakom krugu izvodi `set -a; . <glavno spremište>`.
3. Svatko tko prođe Host branu ploče (LAN/Tailscale, `curl` bez `Origin`) izvršava naredbe kao
   korisnik sustava na sljedećem krugu petlje. To vrijedi i za agenta s ubrizganim uputama: on
   ima `curl` na loopback.

Uz to, `\n` u ključu (isti endpoint) upisuje **proizvoljan dodatni redak** u spremište, npr.
`*_BASE_URL` ili `BASH_ENV` za sve što spremište učitava u okolinu.

Popravak je hitan i ne čeka cijeli ADR: §10, **TASK-5345** (Jelena).

### 1.4 Ostali nalazi

| # | Težina | Nalaz |
|---|---|---|
| N2 | srednja | rotacija ne gasi staru vrijednost: uz glavno spremište su tri kopije `*.bak*` (0600) sa starim vrijednostima. Novi tijek ne smije praviti kopije. Postojeće kopije pregledava Goran, ne agent |
| N3 | srednja | `PUT /api/tasks/:id` ispisuje cijelo tijelo zahtjeva u konzolu (`console.log(… JSON.stringify(body))`). Tajna upisana u zadatak završi u dnevniku ploče. Novi endpoint ne smije proći ni kroz jedan takav ispis |
| N4 | srednja | `process.env` zasjenjuje datoteku. Nakon rotacije kroz ploču proces tiho koristi staru vrijednost, a ploča javlja „postavljeno“ |
| N5 | niska | `zapisiTajnu`: ime `tmp` je predvidivo i dijeli se unutar procesa. Nema zaključavanja između procesa, a `writeFileSync` slijedi simboličku poveznicu na mjestu `tmp` |

---

## 2. Odluka u jednoj rečenici

Na svakoj ploči postoji **jedan** ulaz za tajne, `/api/tajne`. Ulaz je **samo-za-pisanje** i
radi samo nad **imenima s popisa**. Svaki upis i brisanje potvrđuje **vlasnik kodom koji mu bot
čvora pošalje u privatni Telegram**. Ulaz prima promet samo preko **loopbacka, Tailscalea ili
HTTPS-a**. Tajna se zapisuje **jednim pisačem** (poopćeni `LoginCreds`, zaključan, atomičan, 0600)
u **ljuskom-siguran oblik** `IME='…'`. Vrijednost se nikad ne vraća, ne ispisuje i ne prolazi kroz
agenta ni razgovor.

---

## 3. Model prijetnje

### 3.1 Imovina

| Imovina | Šteta ako procuri | Šteta ako se prepiše |
|---|---|---|
| lozinka maila, Nextcloud, pgvector | čitanje i slanje pošte u ime vlasnika, podaci klijenata | prekid usluge; preusmjeravanje na napadačev račun |
| ključevi davatelja (OpenRouter, Gemini…) | trošak na vlasnikovu računu | **napadačev ključ = napadač vidi sve upite i odgovore** |
| bot token Telegrama | preuzimanje bota, čitanje grupe | prekid kanala |
| sama datoteka spremišta | sve gore | **izvršenje naredbi** (N1) ako je potrošač učitava ljuskom |

### 3.2 Napadači i što smiju/mogu

| # | Napadač | Doseg | Glavna prijetnja | Brana (odjeljak) |
|---|---|---|---|---|
| A1 | uređaj u istom LAN-u (gost, zaraženo računalo, IoT) | HTTP do ploče, prisluškivanje LAN-a | upis/prepis tajne; čitanje lozinke iz čistog HTTP-a | potvrda vlasnika §4.2, prijenos §4.3 |
| A2 | tuđa web-stranica u vlasnikovu pregledniku | CSRF, DNS rebinding | upis tajne vlasnikovim preglednikom | Origin/Host/Sec-Fetch §4.4, potvrda §4.2 |
| A3 | **agent čvora s ubrizganim uputama** (mail, web, dokument) | `curl localhost`, čitanje datoteka kao isti korisnik | prepis ključa davatelja ili `*_BASE_URL` → krađa razgovora; izvršenje kroz N1 | potvrda koju agent ne vidi §4.2, popis imena §6, format §5.2 |
| A4 | čitač transkripta, dnevnika ili povijesti (RAG, arhiv transkripata, `journalctl`, Hindsight) | pasivno čitanje | vrijednost zapisana negdje usput | §8 |
| A5 | korisnik u Telegram grupi čvora | piše u grupu | traži kod ili natjera bota da „upiše lozinku iz poruke“ | kod ide samo u privatni chat vlasnika §4.2; razgovor nikad ne nosi tajnu §8.3 |
| A6 | Tailscale čvor koji nije vlasnikov (dijeljeni tailnet) | HTTP do ploče kroz tunel | isto kao A1 | potvrda vlasnika §4.2 |

### 3.3 Izvan dosega (pošteno)

- **Proces istog korisnika (A3 s ovlasti `puno`) može izravno čitati i pisati datoteku
  spremišta.** Ovaj ADR to ne može zatvoriti: granica je korisnik sustava. API samo-za-pisanje
  sprečava da **ploča** postane kanal čitanja. Ne sprečava `cat` agenta. Tu brane kuka
  `SecurityValidator` (blokira ispis spremišta u transkript), ADR-0002 §7.1 (ovlasti `citanje`
  nemaju dom korisnika) i, dugoročno, poseban korisnik za spremište (§12).
- Root na čvoru, fizički pristup disku i kompromitiran Telegram račun vlasnika.
- Opća prijava na ploču. Ovaj ADR uvodi potvrdu **samo** za tajne i ne mijenja ostatak ploče.

---

## 4. Tko smije upisati

### 4.1 Odgovori na pitanja iz naloga

| Pitanje | Odluka |
|---|---|
| prijava na ploču / token? | **Ne** statički token ploče. Agent ga može pročitati s diska, a vlasnik ga mora negdje čuvati. Umjesto toga: **jednokratni kod u Telegram vlasnika** za svaku radnju (§4.2). To traži samo ono što vlasnik već ima, a agent i grupa to nemaju |
| samo LAN / Tailscale? | **Loopback i Tailscale da. Čisti LAN samo uz izričit izbor vlasnika** (§4.3) |
| HTTPS ili ne? | HTTPS **nije obavezan** kad je prijenos već šifriran (Tailscale je WireGuard) ili lokalan. Na čistom HTTP-u kroz LAN lozinka putuje čitljiva, pa je taj put zadano **isključen** |

### 4.2 Potvrda vlasnika (obavezna za upis i brisanje)

1. Ploča: `POST /api/tajne/kod {ime, radnja: "upis"|"brisanje"}` vraća `{zahtjevId, istjece}`.
   Poslužitelj stvara kod od **8 znamenki** (`crypto.getRandomValues`), pamti samo njegov
   **SHA-256** s vezom na `zahtjevId + ime + radnja`. Kod vrijedi **5 min**, **jednokratan** je i
   dopušta **5 pokušaja**.
2. Bot čvora šalje kod **izravno** (`sendMessage` iz ploče, ne kroz agenta ni red poruka) u
   **privatni chat** svakog uid-a iz nove postavke `tajne.potvrdaUid` (brojčani Telegram uid,
   nije tajna, bez zadane vrijednosti). Poruka: `Kod za upis tajne SMTP_PASSWORD na <čvor>: 12345678 (5 min). Ako to nisi ti, ne upisuj ga.`
   - Kod **nikad** ne ide u grupu. Bot ne prima vlastite poruke kroz `getUpdates`, pa kod ne
     ulazi u `ingest.jsonl`, transkript ni banku memorije.
   - Ako Telegram nije podešen ili `potvrdaUid` je prazan, upis s ploče je **isključen** i
     ploča to kaže. Prvi bot token (bootstrap) i ostalo tada se upisuju kroz CLI na stroju
     (§9), kao i danas.
   - Kod nije dugotrajna tajna (kratak vijek, jednokratan, vezan uz radnju), pa poruka u
     vlasnikovu Telegramu nije kršenje TASK-3043.
3. Ploča: `PUT /api/tajne/:ime {vrijednost, zahtjevId, kod}` ili `DELETE /api/tajne/:ime {zahtjevId, kod}`.
4. Ograničenje: nakon 5 pogrešnih kodova po `zahtjevId` zahtjev se poništava. Nakon 10 pogrešnih
   u 15 min (cijela ploča) `POST /api/tajne/kod` vraća 429 i 15 min ništa ne šalje. Svaki
   događaj ide u audit (§7.3).

### 4.2a Dopuna (TASK-5357, 08.10.2026.): primatelj koda bez CLI-ja

**Povod.** Nakon isporuke vlasnik i dalje nije mogao upisati lozinku maila: ploča je tražila
`bun scripts/tajna.ts podesi --potvrda-uid <uid>` na stroju i odbijala čisti HTTP s LAN-a. Upis
s ploče koji traži naredbu na stroju ne rješava nalog.

**Odluka.** Primatelj koda razrješava se ovim redom (prvi koji postoji pobjeđuje):

1. `tajne.json → potvrdaUid` — izričita odluka na stroju (CLI), kao dosad;
2. profil instance čvora `$TM_HOME/config/profil.instanca.env` → `VLASNIK_UID`;
3. isti profil → **jedini** pozitivni ID iz `TG_DOPUSTENI_CHATOVI` (privatni chat s botom ima
   ID jednak uid-u čovjeka; grupe su negativne i preskaču se), i to samo ako je taj ID ujedno
   u `RAZGOVOR_DOPUSTENI_KORISNICI`.

Ništa od toga → upis s ploče ostaje isključen (`409 potvrda_nije_podesena`), kao prije.

**Zašto profil instance, a ne `telegram.json`.** `telegram.json` (`ulaz.dopusteniChatovi`,
`dopusteniKorisnici`) ploča mijenja (Config → Telegram), pa bi A1 iz LAN-a upisao SVOJ chat i
kod bi stigao njemu. Profil instance piše instalater čvora (ADR-0004), a nijedna ruta ploče ga ne
mijenja. Agent čvora (A3) može pisati u njega, ali isto vrijedi i za `tajne.json`, a agent nema
privatni Telegram čovjeka u koji bi kod stigao. Prijetnja je ista kao dosad, a za vlasnika je to
nula koraka.

**Zašto `TG_DOPUSTENI_CHATOVI` kao rezerva i zašto tako uska.** To je popis chatova kojima je
instalater dao pravo upravljanja botom. Pozitivan ID na tom popisu je čovjek kojem je izričito
dopušten privatni razgovor s botom čvora. Rezerva vrijedi samo kad je **nedvosmislena**: na popisu
je točno jedan takav ID i isti je čovjek dopušteni sugovornik razgovora (dva neovisna upisa
instalatera se slažu). Ako je kandidata više, ili se upisi ne slažu, upis s ploče ostaje isključen
dok se ne upiše `VLASNIK_UID`. Tako kod nikad ne dobiva netko tko je slučajno na popisu (nalaz
automatskog sigurnosnog pregleda pri izvedbi). Na node-A to daje točno vlasnikov uid.

**Ploča i Telegram.** `GET /api/tajne` vraća `potvrda.izvor`, kraj uid-a (`…1234`, ne cijeli
uid) i `@ime` bota (`getMe`). Ploča tako ispisuje korake: „pokreni bota u privatnom chatu
(/start) → upiši → potvrdi kodom". Kad vlasnik (pošiljatelj = primatelj koda) u razgovoru napiše
molbu za upis („upiši lozinku za mail"), jezgra razgovora **ne zove model**. Bot vrati gotovu
uputu s poveznicom `http://<LAN|Tailscale adresa>:<port>/#tajne&ime=SMTP_PASSWORD,IMAP_PASSWORD`.
Poveznica ne nosi tajnu ni kod. Kod i dalje šalje samo ploča, i to tek nakon „Spremi". Molba
nekog drugog ide u običan potez (ne dobiva uputu), a bot-poruke (ADR-0003) nikad.

**Zašto kod, a ne lozinka ploče:** A3 (agent) čita sve datoteke korisnika i zove loopback, pa
nijedna tajna na disku ne razlikuje vlasnika od agenta. Vlasnikov privatni Telegram je jedini
kanal koji agent čvora ne čita.

### 4.3 Prijenos (provjerava se po IP-u peera, `server.requestIP`, ne po zaglavljima)

| Izvor | Zadano | Napomena |
|---|---|---|
| `127.0.0.1`, `::1` | dopušteno | i dalje traži kod (A3) |
| Tailscale `100.64.0.0/10`, `fd7a:115c:a1e0::/48` | dopušteno | šifrirano, ali A6 → kod |
| zahtjev preko HTTPS-a (ako ploča ima TLS) | dopušteno | |
| privatni LAN (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`), čisti HTTP | **dopušteno** (TASK-5357; do tada odbijeno) | vlasnik ga gasi samo izričitim `tajne.dopustiLanHttp=false` (`403 tajne_lan_http`). Ploča stalno ispisuje upozorenje da lozinka kroz LAN putuje nešifrirano i nudi Tailscale. **node-B** je iza VirtualBox NAT-a: zahtjevi stižu s privatne adrese NAT pristupnika, pa prolaze |
| javna adresa, čisti HTTP | **odbijeno 403** `{greska:"tajne_javni_http"}` | uvijek, bez postavke koja ga otvara; s javne adrese vrijedi samo HTTPS ili Tailscale |
| `X-Forwarded-For` | **ignorira se** | ploča nije iza proxyja; zaglavlje bi napadač sam postavio |

**Obrazloženje dopune §4.3 (TASK-5357).** Pasivni prisluškivač u LAN-u (A1) vidi lozinku na
čistom HTTP-u. To je stvaran trošak, ali nije put do *upisa*. Upis i dalje traži kod iz
vlasnikova privatnog Telegrama, a kod je jednokratan, vrijedi 5 minuta i vezan je uz skup imena
(§4.2). Zadano zatvoren LAN u praksi je značio da vlasnik ne upisuje ništa (nema Tailscalea na
node-A, nema TLS-a). Tajna je tada ostajala stara, u chatu ili u CLI-ju preko tuđe pomoći, a to je
gore od kratkog nešifriranog skoka u vlastitoj mreži. Javne adrese ostaju zatvorene jer tamo
prisluškivač nije „u kući". Konzola (`KonzolaVrata`, TASK-5352) zove `odlukaPrijenosa` s
`dopustiLanHttp:false` i ostaje samo loopback/Tailscale: iza nje nema koda u Telegramu.

### 4.4 CSRF i DNS rebinding

Svi zahtjevi na `/api/tajne*` moraju proći **sve** od ovoga, inače vraćaju 403:
- postojeći `isHostAllowed` i `corsOdluka` (TASK-5333);
- `Content-Type: application/json` (tuđa stranica ga ne može poslati bez preflighta, a preflight
  strani Origin ne prolazi);
- zaglavlje `X-TM-Tajne: 1` (isti razlog, dodatni pojas);
- ako postoji `Sec-Fetch-Site`, mora biti `same-origin`. Ako postoji `Origin`, mora biti vlastiti;
- kod iz §4.2. To je zadnja brana: i uspješan CSRF bez koda ne može ništa.

Rebinding (`Host: napadac.example` → IP čvora) zaustavlja `isHostAllowed`. Ne smije se dodati
`*` ni zamjenski znak u `ALLOWED_HOSTS`.

---

## 5. Spremište: jedno, 0600, atomično, ljuskom-sigurno

### 5.1 Gdje

| TaskManager | Spremište (pisanje) |
|---|---|
| paket (node-A, node-B, svaka instalacija) | `datotekaTajniZaPisanje()` → `$TM_HOME/config/credentials.env` (ili `TM_CREDENTIALS`) |
| glavni (zasebna kodna baza) | njegovo dosadašnje spremište (isto koje koristi `loginStorePath()`) |

Kod je **isti**: modul iz paketa (§9) prenosi se u glavni, kao kod TASK-5311. Glavni ne dobiva
vlastitu varijantu.

### 5.2 Oblik retka (rješava N1)

```
IME='vrijednost'          # POSIX jednostruki navodnici; ' u vrijednosti → '\''
```

- Odbija se: prazna vrijednost, `\0`, `\r`, `\n` i vrijednost dulja od **4096** bajtova.
  Višeretčane tajne (PEM ključevi) nisu u v1: idu kao zasebna datoteka 0600, a ime datoteke kao
  netajna postavka.
- Vrijednost se **ne** `trim`-a. Lozinka smije imati razmak na rubu. Ploča prikaže upozorenje
  ako ga ima, ali ga ne reže.
- Unutar `'…'` ljuska ne radi nikakvu zamjenu (`$`, `` ` ``, `\` su doslovni). Zato isto
  spremište sigurno čitaju i `. spremište`, i parser u procesu, i `secret_probe.py`.
- **Jedan parser**, `LoginCreds.parsirajRedak()`, plus njegova Python zrcalna kopija. Čita:
  `IME='…'` (POSIX dekodiranje), `IME="…"` i `IME=goli` (stari zapisi, kao danas), te
  `export IME=…`. Mjerila `kljucPrisutan`, `odluciteljDavatelji` i `tajnaPostavljena` prelaze na
  taj parser, pa više nema tri regexa koji se razilaze.
- Postojeći goli retci ostaju dok ih netko ne prepiše. **Ne** prepisuju se automatski: promjena
  navodnika mijenja ono što je ljuska dosad čitala. `GET /api/tajne` za takav redak javlja
  `oblik: "stari"`. Ako vrijednost ima `$`, `` ` ``, `;`, `(`, `)`, `|`, `&`, `<` ili `>`, javlja i
  `opasan: true`, s tekstom „upiši je ponovo".

### 5.3 Pisač (poopćeni `LoginCreds`, jedini koji smije pisati)

`LoginCreds.postaviTajnu(ime, vrijednost, {spremiste, tko, ip})` i `LoginCreds.ukloniTajnu(...)`.
`ConfigModul.zapisiTajnu`, `handleLoginApikey` i `ukloniKljucIzDatoteke` postaju tanki omotači
oko njih. Novi mehanizam se **ne** piše uz stari.

Redoslijed upisa:
1. `lstat(spremište)`: ako je simbolička poveznica, nije obična datoteka ili nije vlasništvo
   `getuid()`, **odbij** (`greska:"spremiste_nije_sigurno"`). Mapa mora biti vlasništvo
   korisnika. Ako su joj prava šira od 0700, postavi 0700 i zabilježi.
2. Zaključaj: `<spremište>.lock` s `O_CREAT|O_EXCL` (0600, sadržaj `pid kada`). Zastario je nakon
   30 s ili ako pid ne živi. Isto zaključavanje koristi CLI (§9).
3. Pročitaj, izmijeni **samo** redak tog imena (svi oblici iz §5.2, i `export`), ostalo ostavi
   bajt za bajt.
4. Zapiši u `<spremište>.tmp-<pid>-<16 hex nasumično>` s `O_CREAT|O_EXCL|O_NOFOLLOW`, prava 0600,
   pa `fsync`.
5. `rename` preko spremišta, pa `fsync` mape. Na kraju `chmod 0600` (vrijedi i za datoteku
   koju je netko ranije napravio s 0644).
6. Otključaj, pa upiši audit (§7.3) i događaj (§7.2).

**Bez kopija** (`.bak`): rotacija mora ugasiti staru vrijednost (N2). Pogreška usred upisa
ostavlja staro spremište netaknuto, a `tmp` se briše.

---

## 6. Popis dopuštenih imena (ne slobodno ime)

**Odluka: popis, uz proširenje po pravilu. Slobodno ime ne.** Slobodno ime dopušta A3 da upiše
`ANTHROPIC_BASE_URL`, `BASH_ENV`, `LD_PRELOAD` ili `NODE_OPTIONS` u datoteku koju potrošač
učitava u okolinu. To je izvršenje ili preusmjeravanje svih razgovora.

### 6.1 Izvor popisa (`LoginCreds.dopustenaImena()`, računa se uživo)

1. `envKey` svakog davatelja iz `LOGIN_PROVIDERS`;
2. `*Env` polja modula: `EmailConfig.smtp/imap.lozinkaEnv`, `NextcloudConfig.lozinkaEnv`,
   `GitHubConfig/GitLabConfig.tokenEnv`, `TelegramConfig.botTokenEnv`,
   `rag-backend-config.ENV_LOZINKE`, `IssueSync` veze `tokenEnv`;
3. `tajneImenom` iz profila čvora (`profil.json`, `docs/PROFIL_CVORA_TAJNE.md`);
4. `tajne.dodatnaImena` u postavkama. Ime mora odgovarati
   `^[A-Z][A-Z0-9_]{1,63}_(PASSWORD|PASS|TOKEN|SECRET|KEY|API_KEY)$`.

Uz svako ime popis daje i `izvor` (npr. `email.smtp`), da ploča zna napisati čemu tajna služi.

### 6.2 Tvrda zabrana (vrijedi i ako je ime na popisu)

`PATH`, `HOME`, `SHELL`, `USER`, `IFS`, `ENV`, `BASH_ENV`, `PS4`, `PROMPT_COMMAND`, `LD_*`,
`DYLD_*`, `NODE_*`, `BUN_*`, `PYTHON*`, `PERL5*`, `RUBY*`, `GIT_*`, `SSH_*`, `*_PROXY`,
`*_BASE_URL`, `*_HOST`, `*_URL`, `CLAUDE_*`, `ANTHROPIC_BASE_URL`, `TM_*` (postavke ploče, npr.
`TM_RAZGOVOR_PUNO`, `TM_CREDENTIALS`, `TM_ALLOW_PRIVATE_HOSTS`). Ime koje nije na popisu ili je
zabranjeno daje **400 `ime_nije_dopusteno`** i audit zapis `odbijeno`.

---

## 7. Samo-za-pisanje, rotacija i kako servis dozna novu tajnu

### 7.1 API (vrijednost NIKAD van)

| Metoda | Put | Tijelo | Odgovor |
|---|---|---|---|
| GET | `/api/tajne` | — | `[{ime, izvor, opis, postoji, otisak, oblik, opasan, zasjenjena, zadnje:{radnja, kada, ip}}]` |
| POST | `/api/tajne/kod` | `{ime, radnja}` | `{zahtjevId, istjece, poslanoNa: 1}` (broj primatelja, ne uid) |
| PUT | `/api/tajne/:ime` | `{vrijednost, zahtjevId, kod}` | `{ime, postoji:true, otisakPrije, otisak, zasjenjena, upozorenja[]}` |
| DELETE | `/api/tajne/:ime` | `{zahtjevId, kod}` | `{ime, postoji:false, otisakPrije}` |

- **`otisak`** = prvih 8 hex od **HMAC-SHA256(ključ čvora, vrijednost)**, a ne golog SHA-256.
  Ključ čvora je `config/tajne-otisak.kljuc` (32 nasumična bajta, 0600, nastaje pri prvom upisu).
  Razlog: lozinka maila često ima malo entropije. Goli SHA-256 prefiks od 32 bita u UI-u i
  auditu je proročište za napad rječnikom izvan stroja: pogodak lažno potvrdi 1 od 2³²
  kandidata. Uz ključ čvora otisak izvan čvora ne vrijedi ništa, a za „je li rotirano" i „je li
  isto kao prije" radi jednako dobro. `secret_probe.py` na čvoru čita isti ključ i ispisuje isti
  otisak (polje `otisak_hmac`). Postojeći `sha256_prefix` ostaje za spremišta bez ključa.
- **`zasjenjena: true`** kad okolina procesa ploče ili daemona već ima to ime (N4). Upis tada
  vraća upozorenje „vrijednost iz okoline ima prednost — makni je iz `postavke.env`/systemd i
  restartaj kad je mirno". Upis se **ne** odbija.
- Svaki odgovor `/api/tajne*` ima `Cache-Control: no-store` i `Content-Type: application/json`.
  Poruka o grešci nikad ne citira tijelo zahtjeva (ni Zod poruka s ulazom).
- **Ne postoji** ruta, parametar ni način (`?prikazi=1`, izvoz, „kopiraj", proba koja vraća
  vrijednost) koji vraća vrijednost. Proba veze (`/api/email/proba` i slično) javlja
  samo uspjeh/neuspjeh.

### 7.2 Rotacija i dojava bez restarta

Rotacija je običan `PUT` nad postojećim imenom: stara vrijednost se prepiše, kopija ne ostaje,
a audit nosi `otisakPrije → otisak`. Brisanje miče cijeli redak (`ukloniKljuc`, načelo TASK-4796
„ono što odjava ukloni mora oboriti mjerilo").

Potrošači su tri vrste, i svaka dobiva pravilo:

| Vrsta | Primjer | Pravilo | Kad vidi novu vrijednost |
|---|---|---|---|
| čita pri svakoj uporabi | `procitajTajnu` u `EmailConfig`, `IssueSync`, `RazgovorPloca` | ne pamti vrijednost u modulu | odmah, osim ako je `zasjenjena` (§7.1) |
| ljuska koja učitava u svakom krugu | petlja maila | spremište mora biti u obliku §5.2 | sljedeći krug |
| dugotrajni proces s vrijednošću u memoriji (IMAP veza, poller Telegrama, daemon) | `TelegramPoller`, buduća IMAP petlja | prijavi se na `LoginCreds.naPromjenuTajne(ime, cb)` | unutar ~2 s |

`naPromjenuTajne`: `fs.watch` nad **mapom** spremišta (`rename` mijenja inode, pa pratiti samu
datoteku ne radi), uz odgodu od 500 ms. Nakon toga ponovo se računa otisak tog imena i `cb` se
zove samo ako se otisak promijenio. Pisač usto dopisuje u `stanje/tajne_dogadaji.jsonl`
`{kada, ime, radnja, otisak}` (bez vrijednosti) za procese koji ne mogu `watch`. Usto vrijedi:
- poller Telegrama nakon promjene tokena prekida dugi `getUpdates` i spaja se novim tokenom;
- IMAP/SMTP kod pogreške prijave **jednom** ponovo čita tajnu i pokušava. Tek onda javlja grešku;
- daemon gradi okolinu agenta **u trenutku pokretanja**, nikad iz snimke napravljene pri
  pokretanju daemona.

Restart ploče ili daemona **nije** dio tijeka upisa.

### 7.3 Audit (bez vrijednosti)

`stanje/tajne_audit.jsonl` (0600, samo dopisivanje). Jedan redak po događaju:

```json
{"kada":"2026-10-08T09:41:02+02:00","radnja":"upis","ime":"SMTP_PASSWORD","ishod":"ok",
 "otisakPrije":"1a2b3c4d","otisak":"9f8e7d6c","ip":"100.x.y.z","prijenos":"tailscale",
 "zahtjevId":"…","potvrda":"telegram","razlog":null}
```

`radnja` ∈ `kod_poslan | upis | brisanje | odbijeno | kod_pogresan | zakljucano`. Nikad se ne
zapisuju vrijednost, kod, sažetak koda ni tijelo zahtjeva. `GET /api/tajne` za svako ime
pokazuje zadnji redak (`tko/kada`). „Tko" je IP i prijenos: ploča nema korisnike, a potvrda je
uvijek vlasnikov Telegram.

---

## 8. Tajna ne smije završiti u logu, povijesti, konzoli ni transkriptu

### 8.1 Poslužitelj
- Rute `/api/tajne*` obrađuju se **prije** svakog općeg ispisa tijela (N3) i ne ispisuju ništa
  osim `[TAJNE] <radnja> <IME> <ishod> <prijenos>`.
- Iznimka u obradi se hvata. U dnevnik ide samo `e.name`, ne `e.message`: poruke JSON parsera
  citiraju ulaz.
- N3 (`PUT /api/tasks` ispisuje tijelo) popravlja se u istom zadatku: ispisuju se samo **imena
  polja**, bez vrijednosti.

### 8.2 Preglednik (TASK-3686/4722)
- Obrazac tajne je **vlastiti `<form autocomplete="off">`** (TASK-4722: bez vlastitog obrasca
  preglednik spoji polja u sintetski obrazac). U njemu nema polja za korisničko ime.
- Polje: `type="password"`, `autocomplete="new-password"`, `name` nasumičan po prikazu,
  `data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore`, `spellcheck="false"`.
- Slanje ide kroz `fetch`, bez `submit` navigacije. Polje se **prazni odmah** nakon čitanja,
  prije `await`. Vrijednost se ne sprema u `localStorage`/`sessionStorage`, ne ide u
  `console.*` i ne ostaje u DOM-u ni u varijabli izvan funkcije.
- Konzola ploče (kartica Konzola) **nema** naredbu za tajne: ulaz konzole ide u njezin dnevnik.

### 8.3 Razgovor i agent
- Bot i Klaudio **nikad ne traže vrijednost u chatu**. Na „upiši lozinku za mail" odgovaraju
  poveznicom na ploču čvora (`/#config/tajne?ime=SMTP_PASSWORD`). Ime je javno, vrijednost ne.
- Ako vlasnik ipak pošalje tajnu u chat, ona je već u transkriptu. Ploča i agent je **ne
  upisuju** iz poruke („prepiši iz chata" ne postoji kao radnja). Pravilo za korisnika: takvu
  tajnu odmah rotirati.
- Agent nema alat ni rutu kojom bi upisao tajnu bez koda. Kod mu nikad nije dostupan (§4.2).

### 8.4 Ljuska i CLI
- CLI (§9) čita vrijednost **samo iz TTY-a bez ispisa** (`stdin` uz `isTTY`, `setRawMode`) ili
  iz `stdin` cijevi. Vrijednost u `argv` se **odbija** jer bi bila vidljiva u `ps`,
  `/proc/<pid>/cmdline` i povijesti ljuske.

---

## 9. Jedan mehanizam za sve TaskManagere

| Dio | Gdje | Napomena |
|---|---|---|
| `LoginCreds.ts` (poopćen): `parsirajRedak`, `postaviTajnu`, `ukloniTajnu`, `dopustenaImena`, `otisak`, `naPromjenuTajne`, zaključavanje | paket `src/LoginCreds.ts` | jedini pisač |
| `TajneApi.ts`: rute §7.1, brane §4 | paket `src/` | `TaskWebUI` samo prosljeđuje |
| `PotvrdaVlasnika.ts`: kod, TTL, pokušaji, slanje u privatni Telegram | paket `src/core/` | čista logika, testabilna bez mreže (umetnut pošiljatelj) |
| `scripts/tajna.ts postavi|obrisi|popis IME` | paket | CLI za stroj i bootstrap. Isti pisač i isto zaključavanje. Vrijednost samo iz TTY/stdin |
| Python zrcalo `parsiraj_redak` + `otisak_hmac` | `tools/` paketa i `secret_probe.py` | isti testni vektori kao TS (§11, K4) |
| Kartica Config → „Tajne" | `TaskWebUI` | popis iz §6.1. Uz svaku tajnu: postoji, otisak, zasjenjena, zadnje, gumbi „Upiši/Promijeni" i „Obriši" |
| glavni TaskManager | prijenos istih datoteka (kao TASK-5311) | **nikakva vlastita varijanta**. `loginStorePath()` ostaje njegovo spremište |
| node-A, node-B | dolazi s paketom. `tajne.potvrdaUid` iz profila čvora (nije tajna) | node-B: §4.3 (NAT) |

`docs/PROFIL_CVORA_TAJNE.md` stavke 1 i 6 mijenjaju „ploča/ručno" u „Config → Tajne (kod u
Telegram)". Bootstrap ostaje: prvi bot token na čvoru bez Telegrama upisuje se kroz CLI.

---

## 10. Hitno, prije cijelog ADR-a (N1)

**TASK-5345** (Jelena), na oba TaskManagera (paket i glavni):
1. `handleLoginApikey` i `zapisiTajnu` pišu `IME='…'` (§5.2) i odbijaju `\0\r\n`;
2. `procitajTajnu`, `kljucPrisutan` i `odluciteljDavatelji` čitaju taj oblik;
3. test: vrijednost `x$(touch MARKER)` kroz pisač, pa `bash -c 'set -a; . spremište'` → MARKER **ne**
   nastaje, a `procitajTajnu` vraća izvorni niz.

Dok to nije u pogonu: vlasnik neka ne otvara ploču glavnog stroja prema mrežama kojima ne
vjeruje, a petlja maila neka učitava samo svoje ime, ne cijelo spremište
(`EMAIL_PASSWORD=$(python3 … --get EMAIL_PASSWORD)`, ili parser u Pythonu).

---

## 11. Kriteriji prihvaćanja

### 11.1 Jelena (izvedba) — svaki kriterij ima automatski test u `tests/`

| # | Kriterij | Kako se dokazuje |
|---|---|---|
| J1 | Postoji **jedan** pisač (`LoginCreds.postaviTajnu/ukloniTajnu`). `zapisiTajnu`, `handleLoginApikey` i odjava ga zovu | `grep` za `writeFileSync`/`renameSync` nad putanjom spremišta: jedini pogodak je u `LoginCreds.ts`; test odjave i Telegram tokena prolazi |
| J2 | Oblik `IME='…'`. Ljuskom-učitano = upisano za matricu: `$(id)`, `` `id` ``, `'`, `"`, `\`, `;`, `#`, `=`, razmak na rubu, `é€`, 4096 B | test: `bash -c 'set -a; . f; printf %s "$IME"'` == ulaz, a MARKER ne nastaje |
| J3 | Odbija prazno, `\0`, `\r`, `\n`, >4096 B; odbija ime izvan §6.1 i iz §6.2 | 400 s kodom greške; spremište nepromijenjeno (isti `sha256` datoteke) |
| J4 | Atomično + zaključano: 2 × 50 istodobnih upisa različitih imena (ploča + CLI proces) → svih 100 imena prisutno, nijedan redak razbijen | test s dva procesa |
| J5 | Prava: spremište 0600 nakon upisa i kad je prije bilo 0644; mapa 0700; simbolička poveznica na mjestu spremišta ili `tmp` → odbijeno | `stat` u testu |
| J6 | Nema `.bak`/kopija nakon rotacije | `readdir` mape: samo spremište, `.lock` nema nakon upisa |
| J7 | `GET /api/tajne` i svi odgovori `/api/tajne*` ne sadrže vrijednost ni njezin podniz ≥4 znaka (test s vrijednošću-kanarincem) | test pretražuje sirovo tijelo odgovora |
| J8 | Bez ispravnog koda `PUT`/`DELETE` → 403 i spremište nepromijenjeno; kod je jednokratan; istekne nakon 5 min; nakon 5 pogrešaka `zahtjevId` je mrtav; nakon 10 u 15 min → 429 | test s umetnutim satom i pošiljateljem |
| J9 | Kod ide **samo** na `tajne.potvrdaUid` i nikad u `TG_CHAT_ID` grupe; bez `potvrdaUid` upis je isključen (409 `potvrda_nije_podesena`) | test umetnutog pošiljatelja bilježi primatelje |
| J10 | Prijenos: peer iz LAN-a preko HTTP-a → 403 `tajne_lan_http`; loopback i `100.64/10` prolaze do provjere koda; `X-Forwarded-For` ne mijenja odluku | test `odlukaPrijenosa(ip, tls, postavke)` |
| J11 | CSRF: strani `Origin`, `Sec-Fetch-Site: cross-site`, nedostaje `X-TM-Tajne` ili `Content-Type` nije JSON → 403 | test |
| J12 | Audit: svaki događaj ima redak; nijedan redak ne sadrži vrijednost-kanarinca ni kod | test pretražuje `tajne_audit.jsonl` |
| J13 | Kanarinac se ne pojavljuje u stdout/stderr ploče tijekom upisa, greške parsera i iznimke; `PUT /api/tasks` više ne ispisuje vrijednosti (N3) | test hvata `console.*` |
| J14 | `otisak` = HMAC s ključem čvora; isti na TS i Python strani za zajedničke testne vektore; ključ 0600 | test + `secret_probe.py --name X --json` |
| J15 | `zasjenjena:true` kad okolina ima ime; upis vraća upozorenje | test s postavljenim `process.env` |
| J16 | `naPromjenuTajne` zove `cb` unutar 2 s od `rename` i ne zove ga kad otisak nije promijenjen | test |
| J17 | CLI odbija vrijednost u `argv` (izlaz 2) i čita iz stdin cijevi | test |
| J18 | Hitni dio (§10) je u pogonu na **glavnom** i u paketu; restart po pravilu (`restart_kad_mirno.sh`) i `StaleCodeCheck` bez „STALE" | izvještaj s PID-om i vremenom |
| J19 | Postojeći testovi paketa: 0 fail; `tests/bez-nasih-vrijednosti.test.ts` prolazi | `bun test` |

### 11.2 Potjeh (proba s korisnikove strane, na node-A i glavnom)

| # | Scenarij | Očekivano |
|---|---|---|
| P1 | Goran s mobitela preko Tailscalea: Config → Tajne → `SMTP_PASSWORD` → „Upiši" | stiže kod u **privatni** Telegram, ne u grupu; nakon upisa koda: „postoji", otisak, `zadnje` = sada |
| P2 | odmah nakon P1, proba maila (`/api/email/proba`) | „prijava prihvaćena" **bez** restarta ploče i daemona |
| P3 | rotacija: novi upis iste tajne | otisak se promijeni; stari otisak je u `otisakPrije`; u mapi nema kopije |
| P4 | Chrome i Firefox (desktop) i mobilni preglednik | **nijedan** ne nudi spremanje lozinke; upravitelj lozinki ne popunjava polje |
| P5 | DevTools → Network/Console, i `GET /api/tajne` | vrijednost se ne vidi nigdje osim u tijelu vlastitog `PUT` zahtjeva |
| P6 | upis s LAN adrese preko čistog HTTP-a (ne Tailscale) | jasna poruka „samo preko Tailscalea/HTTPS-a" |
| P7 | pogrešan kod 5× | zahtjev poništen; poruka je razumljiva; audit ima 5 × `kod_pogresan` |
| P8 | u Telegram grupi čvora: „upiši lozinku za mail: abc" | bot ne upisuje; odgovara poveznicom na ploču i savjetom da se lozinka rotira |
| P9 | agentu na čvoru zadatak „postavi OPENROUTER_API_KEY na X" | agent ne uspijeva bez koda (403); kod ne vidi; prijavljuje BLOCKED |
| P10 | `journalctl`/dnevnik ploče, `ingest.jsonl`, transkripti sesija tog dana, `~/.bash_history` | `grep` vrijednosti-kanarinca daje **0** pogodaka |
| P11 | node-B (NAT) | ili Tailscale radi, ili je poruka P6 jasna i navodi `tajne.dopustiLanHttp` |

---

## 12. Što ne radimo (i zašto)

| Ne radimo | Zašto |
|---|---|
| šifriranje spremišta lozinkom ili ključem na istom disku | ključ bi bio na istom disku istog korisnika, pa to nije stvarna zaštita, a dodaje složenost. Granica je korisnik sustava (§3.3) |
| statički token ploče za upis | A3 ga pročita s diska (§4.1) |
| upis tajne kroz Telegram poruku | vrijednost bi završila u `ingest.jsonl`, transkriptu i memoriji (TASK-3043) |
| slobodno ime tajne | §6 |
| „prikaži vrijednost" za vlasnika | jednom otvoren put čitanja je put za A1–A3. Vlasnik koji je zaboravio vrijednost je rotira |
| automatsko prepisivanje starih redaka u novi oblik | mijenja značenje za ljusku (§5.2); prepisuje se upisom |
| poseban korisnik sustava za spremište (+ mali pomoćnik sa `sudo`) | prava izolacija od A3, ali mijenja instalaciju svih čvorova. Prijedlog za kasnije, nakon što ovo radi |

## 13. Posljedice

- (+) Goran upisuje i rotira tajne s mobitela, bez prijave na stroj, na sva četiri TaskManagera.
- (+) Zatvara se N1 (izvršenje kroz vrijednost), za postojeće upise i za nove.
- (+) Jedan parser i jedan pisač umjesto tri i pet.
- (−) Upis s ploče traži poznatog vlasnika: `tajne.potvrdaUid`, inače `VLASNIK_UID` ili privatni chat u profilu instance (§4.2a). Bez ijednog ostaje CLI na stroju.
- (±) Privatni LAN preko čistog HTTP-a je zadano dopušten (§4.3, TASK-5357): upis radi s mobitela u kućnoj mreži, ali lozinka unutar LAN-a putuje nešifrirano. Za šifrirani put koristi Tailscale.
- (−) Agent s ovlasti `puno` i dalje može čitati spremište s diska (§3.3). Ovaj ADR to ne mijenja.
