# ADR-0006 — Znanje čvora: opći REGOČ u paketu, privatno nikad, memorija izolirana po čvoru

| | |
|---|---|
| **Stanje** | Prihvaćeno (dizajn, bez koda). Izvedba: Jelena (§9). Proba: Potjeh (TASK-5332, §9). Pregled izolacije: Malik |
| **Datum** | 07.10.2026. |
| **Autorica** | Kosjenka (Architect), TASK-5330 (PRJ-048) |
| **Nalog** | Goran, grupa node-A, 07.10.2026.: banka čvora mora znati **opći** REGOČ (agenti, pravila, alati i njihova uporaba, TaskManager, tijekovi), ali **ne naš privatni** (klijenti, osobe, naši i vanjski Nextcloud, DocuSeal, naši projekti, naše Telegram grupe i chat id-evi); mora znati projekte koji idu kroz **njegov** TaskManager i **njegov** Telegram. Uputa #191: čvor bez RAG-a to mora znati, a korpus, identitet i `~/CLAUDE.md` slažu se iz postavki. Uputa #192: čvor koristi **vanjski korisnik** i mora biti **jednako sposoban** kao naš sustav; razlika smije biti samo u podacima i tajnama; čvor je predložak za kloniranje; memorija se ne gasi dok izolacija ne bude gotova |
| **Nadograđuje** | ADR-0004 (profil čvora; §13 tablica pariteta TASK-5307 — ovaj ADR dodaje osi **znanje** i **izolacija memorije**, ostale osi ne ponavlja), ADR-0001 §8 (brana „bez naših vrijednosti"), ADR-0002 §16 (memorija razgovora) |
| **Mjerenja** | `docs/qa/TASK-5330/` (skripta `razvrstaj_kartu.py` i njezin izlaz) |

---

## 1. Problem (izmjereno 07.10.2026., samo čitanje)

**1.1 Banka čvora nosi naše podatke.** `regoc_opus_nodea` je napunjena alatom glavnog stroja
`tools/rag/hindsight_pokus.py --banka regoc_opus_nodea` iz **istog** korpusa kao `regoc_sustav_opus`:
14 ručnih datoteka karte `~/app/regoc_system/docs/system-map/*.md` + dva sažetka (registar agenata,
`CLAUDE.md`). Za banku je promijenjena samo misija, ne sadržaj. Recall na banci čvora:

| Upit | Rezultata | Privatna činjenica među prva tri |
|---|---|---|
| klijent (ime tvrtke) | 12 | da — osobe, chat id grupe, projekt grupe |
| DocuSeal | 11 | da — naša adresa, mapa toka potpisivanja |
| naziv klijentskog projekta | 14 | da — ID projekta, mapa repoa, naš Pi |
| naziv EU prijave | 14 | da — ID projekta, uid osobe, ovlasti osobe |
| RAG-FIRST | 17 | pravilo „prije ne znam pretraži RAG" — **netočno na čvoru bez RAG-a** |

**1.2 Karta je pomiješana do razine rečenice.** `razvrstaj_kartu.py` nad cijelom kartom (ručni
sloj 14 + generirani `popis/` 89 datoteka = **103 datoteke, 317 odjeljaka, 289 KB**):

| Presuda odjeljka | Odjeljaka | Napomena |
|---|---|---|
| OPĆE | 205 | ništa privatno, nijedna mogućnost |
| UVJETNO (ovisi o mogućnosti čvora: RAG, Nextcloud, DocuSeal, glas, Ollama, internet) | 56 | istinito samo na čvoru koji tu mogućnost ima |
| PRIVATNO | 56 | **104 KB od 289 KB (36 %)** |

Privatno nije u nekoliko „privatnih datoteka" nego razliveno: `projekti.md` 7/7 odjeljaka
(47/50 rečenica), `korisnici-i-grupe.md` 27/46 rečenica, `mogucnosti-i-ovlasti.md` 6/7 odjeljaka,
ali i `agenti.md` („Kosjenka je zadana izvršiteljica zadataka koje <osoba> traži"),
`tijekovi-mehanizmi.md` (14 općih odjeljaka + 2 privatna samo zbog imena vlasnika). U generiranom
sloju 14/89 datoteka ima privatni odjeljak — opisi alata spominju naše projekte (`PRJ-0xx`) i
vještina za naš hardver navodi naše repoe. **Filtar po datoteci ne radi; po odjeljku gubi opće
znanje; čist rez traži promjenu na izvoru (§4).**

**1.3 Vlasnik je uloga, a ne ime.** Najčešći „privatni" pogodak u inače općim pravilima je ime
vlasnika („samo uz Goranovo odobrenje", „Goranova odluka 02.09."). Pravilo je opće („samo vlasnik
odobrava prijenos tajne"), vrijednost uloge je naš podatak. Na čvoru je vlasnik netko drugi.

**1.4 Sudar ID-eva projekata.** Ploča node-A ima vlastite projekte `PRJ-001 REGOČ`, `PRJ-002
Testing`, `PRJ-033 Pretinac` (3 projekta). Banka čvora istodobno nosi ≈ 60 naših tvrdnji oblika
„PRJ-0xx je <naš projekt>" — **isti prostor imena, drugo značenje**. Agent na čvoru ne može znati
koji `PRJ-0xx` je njegov.

**1.5 Hindsight nema zaštitu po banci.** API (0.10.2, `127.0.0.1:17792`) radi s
`DefaultTenantExtension` (bez prijave, jedna shema `public`). Tunel `tunel-nodea.sh` je
`ssh -R 127.0.0.1:17792:127.0.0.1:17792` — čvor vidi **cijeli** API: `GET /v1/default/banks` vraća
sve 4 banke (`regoc_sustav_opus`, `regoc_sustav_sonnet`, arhivu i banku čvora), a recall/retain/
brisanje rade na svakoj. Vanjski korisnik node-A može čitati našu glavnu banku i pisati u nju.

**1.6 Ni komplet izvornog sustava nije čist.** Teret `deploy_node_a.sh` (`MANIFEST.sha256`, 200
datoteka; pročitano 176) ima privatne pogotke u kodu: bez imena vlasnika **46 datoteka / 158
pogodaka** (projekti 96, klijenti 33, chat id 24), s imenom vlasnika 81 / 356. Najveći:
`ProjectGuess.ts` 41 (naša preslikavanja projekata), `IngestGateConfig.ts` 24 (naši chat id-evi),
`RegocDaemon.ts` 58. To nije memorija, ali je isti problem: **kod ide svugdje, a nosi naše podatke.**
Izlaz: `docs/qa/TASK-5330/mjerenje_kompleta_2026-10-07.txt`.

**1.7 Znanje čvora ne ulazi nigdje.** Na čvoru je memorija samo **čitanje** (`src/razgovor/Memorija.ts`
radi `memories/recall`); nijedan put ne upisuje projekte, zadatke ni razgovore čvora u njegovu
banku. Čvor zna naš sustav, a ne zna svoj.

## 2. Odluka u jednoj rečenici

Postoje **tri tereta s tri pravila** — **kod** (paket + komplet: ide svugdje, jednak), **znanje o
sustavu** (opći korpus, **u paketu**, generiran iz karte i uvjetovan mogućnostima čvora) i **podaci
čvora** (baza, banka, razgovori, instanca, tajne: nastaju i ostaju na čvoru) — a granicu između
njih drži **bijela lista na izvoru** plus **brana s privatnim popisom koji nije u paketu**, dok
memoriju svakog čvora drži **zaseban Hindsight** (cilj) uz **posrednika s dopuštenom bankom** odmah.

## 3. Tri tereta (odgovor na uputu #192: „popis što se nosi, popis što nikad")

| Teret | Što | Gdje nastaje | Ide na čvor | Provjera |
|---|---|---|---|---|
| **K — kod** | paket TaskManagerAI; komplet izvornog sustava (`~/.claude/regoc` po MANIFEST-u, ADR-0004 §13.9); vještine, tijekovi (`workflows.json`), kuke, alati | git paketa, `gradi_komplet.sh` | **da, uvijek, ista verzija** (paritet mogućnosti) | ADR-0004 `provjeri` (moduli `paket`, `znacajke`, `kuke`); **nova** brana privatnog popisa nad teretom (§5.2) |
| **Z — znanje o sustavu** | opći korpus: što je REGOČ, agenti, pravila, tijekovi, alati i kako se koriste, TaskManager, mehanizmi i prekidači — **bez vrijednosti** | generator iz karte glavnog stroja → `znanje/sustav/` **u paketu** (§4) | **da, uvijek**; na čvoru se render-a prema mogućnostima i instanci (§6) | brana ADR-0001 §8 + privatni popis; mjerilo recall (§9) |
| **P — podaci čvora** | baza ploče (`regoc.db`, projekti, zadaci), `messages.db`, razgovori, banka Hindsighta čvora, `profil.instanca.env`, tajne, `~/.claude/projects/*/memory`, `MEMORY/` kuka učenja | na čvoru, iz njegove ploče i njegova Telegrama (§7) | **nikad s glavnog**; novi čvor kreće s praznom bazom | `nikadNeNosi` u profilu (§8) |

**Nikad se ne nosi s glavnog na čvor** (popis je dio profila, §8, i provjerljiv je): `regoc.db`,
`messages.db`, `conversations/`, `chat_sessions.json`, ručni sloj karte `docs/system-map/*.md` u
izvornom obliku, sažetak `CLAUDE.md` glavnog sustava, RAG kolekcije (`agent_*`, `pai_learning_system`
…), Hindsight banke glavnog (`regoc_sustav_*`) i drugih čvorova, `credentials.env`,
`.credentials.json`, `telegram.json` s tokenom, `deploy/profili/*.instanca.env`, privatni popis
(§4.3), Claude datotečna memorija (`~/.claude/projects/*/memory`), `MEMORY/`, radne mape grupa.

## 4. Pravilo: što je opće, a što privatno — i gdje se reže

### 4.1 Pravilo (po kategoriji podatka, ne po datoteci)

| Opće — ide u Z | Privatno — nikad u Z | Uvjetno — u Z samo kao ovisno o mogućnosti (§6) |
|---|---|---|
| agenti, uloge, lanci, modeli kao **mehanizam** (ModelRouter, `model-config.json`) | imena i uid-ovi ljudi; klijenti i njihove tvrtke | RAG (kolekcije, `rag-query`, RAG-FIRST, pgvector) |
| pravila i zamke sustava (DONE s dokazom, StaleCodeCheck, restart uz 0 `in_progress`, uputa preko `/uputa` …) | naši projekti: ID-evi, nazivi, mape, repoi | Nextcloud (alat `nc.py`, pravila pohrane) |
| alati, vještine, kuke i **kako se koriste** | naše Telegram grupe, chat id-evi, radne podmape grupa | DocuSeal (tok potpisivanja kao mogućnost) |
| TaskManager: statusi, prijelazi, API, oznaka `chat:<id>` **kao obrazac** | naše adrese, domene, korisnički računi usluga (lokalni i vanjski Nextcloud, DocuSeal, tailnet) | glas (STT/TTS) |
| tijekovi, mehanizmi, prekidači (ime i svrha; **stanje** dolazi s čvora) | vlasnik **po imenu** i njegove pojedinačne odluke s datumom | lokalni modeli (Ollama), dežurni model |
| ovlasti **kao uloge**: vlasnik, korisnik s pravom dokumenata, grupa sustava | ovlasti imenovanih osoba i grupa | internet / objava (GitHub, javni linkovi), root |
| zamke iz lekcija koje vrijede za svaki čvor | NESUKLADNOSTI glavnog stroja (stanje **našeg** pogona) | — |
| — | putanje i UID-ovi našeg kontejnera, naš disk, naš Pi | **mjesno**: putanje se pišu `${HOME}`, `${TM_HOME}`, `${SUSTAV_DIR}` i render-aju po čvoru |

### 4.2 Odluka po dokumentu karte (izmjereno §1.2; tablica = ulaz za izvedbu §9)

| Datoteka karte | Odluka | Što ulazi u Z |
|---|---|---|
| `agenti.md` | **opće, uz dvije rečenice van** | sve osim „zadana izvršiteljica za <osobu>" i ovlasti imenovanih; RAG kolekcija agenta → uvjetno `rag` |
| `tijekovi-mehanizmi.md`, `tijekovi-pravilo-uporabe.md` | **opće** (18/22 odjeljka) | sve; ime vlasnika → uloga „vlasnik" |
| `tijekovi-rada.md` | **odjeljci** | „Od poruke do agenta", „TaskManager", „Lanac i kontekst", „Slanje dokumenata", „Vrata autonomije" (uloga) = opće; „RAG" = uvjetno; „Nextcloud" = uvjetno, samo pravilo bez adresa; „DocuSeal" i „Jutarnji pregled <klijenta>" = **privatno** (tokovi naših klijenata) |
| `alati-i-vjestine.md` | **opće** | sve; Espacenet/ključevi kao ime varijable smiju; spominjanje klijenta van |
| `pravila-i-zamke.md` | **opće, uz uloge** | sve; „Nextcloud bez dodatka = lokalni <adresa>" → uvjetno, bez adrese; RAG-FIRST → uvjetno `rag` (§6.3) |
| `telegram-sesija.md` | **odjeljci** | burst merge, SEND_DOC, pravila odgovora, delegiranje kao obrazac, ulazna vrata = opće; „Tko odgovara" i „Posebno po grupi" = **privatno** (naš bot, naše grupe). Na čvoru se Telegram opisuje iz **njegova** razgovornog modula (ADR-0002), ne iz Klaudija glavnog stroja |
| `mogucnosti-i-ovlasti.md` | **prepisati na uloge** | tri razine (smije sam / uz vlasnikovo odobrenje / nikad) su opće; „po korisniku" i „po grupi" su **privatno** — na čvoru ih daje instanca (§7.2) |
| `direktoriji-i-datoteke.md` | **mjesno → predložak** | ključne mape kao `${HOME}/.claude/regoc`, `${TM_HOME}`; kontejner, host, UID, RAID, naši repoi = **privatno** |
| `servisi-i-portovi.md` | **mjesno → predložak + uvjetno** | daemon, ploča 17781, StaleCodeCheck, restart = opće; vanjske usluge s adresama = **privatno**; Hindsight = opće bez adrese |
| `projekti.md` | **privatno cijelo** | ništa. Projekte čvora daje njegova ploča (§7.1) |
| `korisnici-i-grupe.md` | **privatno cijelo** | samo odjeljak „Jezik" (opće). Ljude i grupe čvora daje instanca (§7.2) |
| `NESUKLADNOSTI.md` | **privatno cijelo** | ništa — to je stanje našeg pogona, ne sustava |
| `README.md` | opće (o karti) | samo „Dva sloja karte" |
| `popis/*` (generirani) | **opće, generira se na čvoru** (§5.1) | identiteti agenata, tijekovi, vještine, alati, prekidači — iz izvora istine **čvora** |

### 4.3 Gdje se reže: na izvoru, bijelom listom (ne filtrom crne liste na izlazu)

1. **Oznaka opsega na izvoru.** Svaki odjeljak ručnog sloja karte dobiva oznaku u retku ispod
   naslova: `<!-- opseg: opce -->`, `<!-- opseg: uvjet rag -->` (ili `nextcloud`, `docuseal`,
   `glas`, `ollama`, `internet`, `root`) ili `<!-- opseg: privatno -->`. **Odjeljak bez oznake =
   privatno** (bijela lista, kao ADR-0004 §5 pr. 1: nepoznato je privatno dok se ne dokaže
   suprotno). Mješovite odjeljke autor karte **razdvaja** na opći i privatni odjeljak; ime vlasnika
   u općem odjeljku postaje „vlasnik" (vrijednost uloge je u privatnom odjeljku).
2. **Brana s privatnim popisom.** Generator nakon reza traži u izlazu (a) opće uzorke koje paket
   smije znati (`PRJ-\d{3}`, chat id, uid, e-pošta, IP, tuđi HOME) i (b) izraze s **privatnog
   popisa** — `~/.claude/regoc/deploy/profili/privatno.popis` na glavnom stroju (0600, **izvan
   paketa**: i sam popis imena klijenata je naš podatak). Popis se gradi iz naših izvora
   (`/api/projects` glavne ploče = ID-evi, + kratak ručni popis osoba, klijenata i usluga) i
   osvježava pri svakoj gradnji. Pogodak → **izlaz 5, ništa se ne piše** (isti obrazac kao brana
   tajni u `gradi_komplet.sh`).
3. **Zašto ne samo crna lista.** Crna lista propušta novo ime koje još nitko nije upisao; bijela
   lista na izvoru ga ne propušta jer je novi odjeljak privatan dok ga netko ne označi. Crna lista
   ostaje kao **druga** linija (kanarinac), ne kao filtar.

## 5. Kako nastaje korpus čvora (generator, ne ručna kopija)

### 5.1 Dva izvora, dva mjesta gradnje

| Sloj | Izvor | Gradi se | Zašto ondje |
|---|---|---|---|
| **opći ručni sloj** | `docs/system-map/*.md` glavnog (odjeljci `opce` i `uvjet …`) | na **glavnom** stroju, alatom `katalog znanje` (proširenje `katalog.py popis`), izlaz u paket: `znanje/sustav/*.md` + `znanje/MANIFEST.sha256` | izvor je privatan i živi samo kod nas; u paket ide samo izlaz, git ga prati, brana ga mjeri |
| **generirani sloj** (`popis/`) | `REGOC_AGENTS.json`, `workflows.json`, `skills/`, `katalog.json`, `features.json`, `config/*.json` | **na čvoru**, istim `katalog popis` iz kompleta (K) | čvor ima **iste** izvore istine kao glavni (paritet K), a stanje prekidača i modele mora pokazati **svoje**, ne naše |

Opći ručni sloj je **znanje o sustavu** (#192: zajedničko, ide svugdje) i zato je u paketu; ne
generira se na čvoru jer čvor nema izvornu kartu. Generirani sloj nije u paketu jer bi nosio stanje
glavnog stroja. Opisi u `katalog.json` koji spominju naše projekte (14/89 datoteka, §1.2) ispravljaju
se **na izvoru** (opis alata = svrha, ne „za PRJ-0xx"), a brana §4.3/2 ih hvata dok se ne isprave.

### 5.2 Brana nad kodom (K)

Ista brana privatnog popisa ide i u `gradi_komplet.sh` kao **zapor** (ratchet, ADR-0001 §8):
osnovica 46 datoteka / 158 pogodaka (§1.6), smije samo padati. Teški slučajevi (`ProjectGuess.ts`,
`IngestGateConfig.ts`) postaju **postavke** (`config/*.json` koje komplet ne nosi, `cp -n`), a kod
ostaje bez vrijednosti. Komentari s imenom vlasnika i datumom odluke smiju ostati (povijest odluke,
ne podatak), ali se broje odvojeno.

### 5.3 Upis u banku čvora

Novi alat paketa **`scripts/znanje-cvora.ts`** (zamjenjuje `hindsight_pokus.py --banka …` za čvorove;
`hindsight_pokus.py` ostaje alat **naše** banke):

```
bun scripts/znanje-cvora.ts sastavi [--instanca …]   # znanje/sustav + popis/ čvora → $TM_HOME/data/znanje/korpus/ (render §6)
bun scripts/znanje-cvora.ts provjeri                 # brana: opći uzorci + (na glavnom) privatni popis; razlika korpus↔banka
bun scripts/znanje-cvora.ts upisi (--suho | --pisi)  # retain samo promijenjenih (sha256 po dokumentu), brisanje nestalih
```

* `document_id` = `sustav/<ime>` (opći), `cvor/<…>` (podaci čvora, §7) — dva prostora imena, nikad
  `system-map/…` (naš).
* Misija banke i `retain_mission` iz profila: „banka zna opći sustav REGOČ i **ovaj** čvor; ID-evi
  projekata u bazi su ID-evi **ove** ploče; nikad ne izvlači vrijednosti tajni; naslov odjeljka je
  uvjet rečenice" (preuzeto iz `hindsight_pokus.py`, bez imena).
* Upis rade **vrata kvote** i **brava** kao u `hindsight_pokus.py` (retain troši LLM).

**Čišćenje sadašnje banke:** banka se ne čisti brisanjem dokumenata (Hindsight konsolidirana
opažanja preživljavaju brisanje izvora). Gradi se **nova** banka `${MEMORIJA_BANKA}` iz čistog korpusa;
`memorija.banka` se prebacuje kroz API ploče (vrijedi uživo, keš ≤ 5 s) tek kad mjerilo §9 Z1 prođe;
stara `regoc_opus_nodea` ostaje do Goranove potvrde pa se briše. Memorija se pritom ne gasi (#192).

## 6. Mogućnosti čvora: jedan izvor za korpus, identitet i `~/CLAUDE.md` (uputa #191)

### 6.1 Izvor istine: `mogucnosti` u profilu, izmjereno na čvoru

Novi modul profila `mogucnosti` (vlasnik `paket`, samo provjera i zapis): `profil-cvora.ts provjeri`
**mjeri** i zapisuje `$TM_HOME/config/mogucnosti.json`:

| Ključ | Mjeri se | node-A danas |
|---|---|---|
| `rag` | `memory-config.json` `rag.enabled` **i** nema `TM_CHROMA_*` (modul `rag`) | **false** |
| `memorija` | `memorija.url/health` = 200 i ime banke | true, banka iz instance |
| `nextcloud` | ime vjerodajnice postoji (samo ime, ADR-0004 §5 pr. 2) | false |
| `docuseal` | ime vjerodajnice postoji | false |
| `glas` | modul `glas` OK | true |
| `ollama` | `OLLAMA_URL/api/tags` = 200 | true |
| `internet`, `root` | capguard stanje | prema `capguard` |

Vrijednost se ne upisuje rukom; mijenja se kad se promijeni stroj (uključen RAG → sljedeći
`provjeri` zapiše `rag: true`).

### 6.2 Tri potrošača, ista datoteka

| Potrošač | Kako čita | Što mijenja |
|---|---|---|
| **korpus** (`znanje-cvora.ts sastavi`) | odjeljak `uvjet X`: ako je X uključen → tekst odjeljka; ako nije → **izričita činjenica** iz predloška, npr. „Na ovom čvoru RAG nije uključen; memorija je samo Hindsight banka `${MEMORIJA_BANKA}`; za činjenice o sustavu čitaj memoriju i datoteke." Promjena `mogucnosti.json` → `upisi` zamjenjuje samo pogođene dokumente | banka |
| **identitet agenata i sesije** | `ragUkljucen()` (`skills/CORE/Tools/lib/rag-gate.ts`, već u kompletu, ADR-0004 §13.9) čita isti `rag.enabled`; dopuna: blok identiteta na čvoru bez RAG-a ne ispisuje odjeljke „Tvoja RAG memorija", „RAG kolekcije" ni upute `rag-store` | prompt spawna |
| **`~/CLAUDE.md`** (modul `upravitelj`) | predložak dobiva blokove `{{#rag}}…{{/rag}}` / `{{^rag}}…{{/rag}}` (i za ostale ključeve); `primijeni --modul upravitelj` ponovno piše datoteku kad se `mogucnosti.json` promijeni | vodič upravitelja (Šaban) |

### 6.3 RAG-FIRST na čvoru bez RAG-a

Pravilo se ne briše nego **mijenja oblik po mogućnosti**: s RAG-om „prije ne znam pretraži RAG";
bez RAG-a „prije ne znam pretraži memoriju (Hindsight banka čvora) i datoteke (`grep`, `read`)".
Isti tekst ide u korpus (uvjetni odjeljak), u identitet i u `~/CLAUDE.md`. Vještina `CORE` iz
kompleta i dalje spominje `rag-query.ts` (kod je isti svugdje, #192); alat na čvoru bez RAG-a samo
javi da je RAG isključen (`rag-gate`), a identitet ima prednost.

## 7. Znanje čvora iz vlastite ploče i vlastitog Telegrama

### 7.1 Ploča čvora → banka čvora (deterministički, bez razgovora)

| Dokument (`document_id`) | Izvor na čvoru | Kad |
|---|---|---|
| `cvor/projekti` | `GET /api/projects` ploče čvora: ID, naziv, opis, stanje, broj zadataka | promjena otiska (sha256 izlaza), provjera svakih 30 min |
| `cvor/zadatak/<TASK-n>` | zatvoren zadatak: naslov, projekt, izvršitelj, `resultSummary` (prvih ~2 KB) | pri zatvaranju (`completed`), samo projekti koji nisu Pretinac |
| `cvor/ovlasti-i-grupe` | instanca + `telegram.json` bez tokena: ime bota, chat id grupe čvora, dopušteni korisnici **kao ID/ime**, ovlast razgovora | promjena instance/postavki |
| `cvor/stanje` | `mogucnosti.json`, verzija paketa i kompleta, broj agenata | `provjeri` |

Ovo je odgovor na „mora znati projekte koji se rade kroz njegov TaskManager": ID-evi u banci čvora
su **samo** njegovi (§1.4 nestaje jer naši ID-evi nikad ne ulaze).

### 7.2 Telegram čvora → banka čvora

Razgovor se ne upisuje sirov (šum, tajne u porukama, trošak retaina). Upisuje se **dnevni sažetak po
chatu** `cvor/razgovor/<chat>/<datum>`: odluke, imenovani projekti, tko je što tražio; sažetak radi
model čvora u istom koraku kao retain. Prije upisa prolazi **brana tajni** (oblici tokena/ključeva,
isti uzorci kao `gradi_komplet.sh`) → pogodak = dan se ne upisuje i javlja se u konzolu. Prekidač
`memorija.upis` (`off|shadow|on`, zadano `shadow` = sažetak se piše na disk, ne u banku) — isti
obrazac kao ostali prekidači memorije.

### 7.3 Što čvor nikad ne upisuje

Vrijednosti tajni; sadržaj privitaka (samo ime datoteke); poruke iz chatova koji nisu u
`TG_DOPUSTENI_CHATOVI`; ništa iz banke drugog čvora.

## 8. Izolacija Hindsighta po čvoru — opcije s cijenom

Izmjereno za cijenu: naša instanca (0.10.2, lokalni embeddings + reranker) troši **4,05 GB RSS** +
PostgreSQL ≈ 0,27 GB; na disku `venv` 6,7 GB + `hf-cache` 6,9 GB. node-A: 15,6 GB RAM (slobodno
14,2 GB), 4 jezgre, disk **72 %, 7,5 GB slobodno**. Hindsight ima ugrađeno proširenje zakupca
(`HINDSIGHT_API_TENANT_EXTENSION`): `ApiKeyTenantExtension` (jedan ključ, jedna shema) i sučelje
za vlastito (ključ → zasebna PostgreSQL shema).

| Opcija | Izolacija | Cijena izvedbe | Cijena pogona | Tko plaća retain (LLM) | Rizik / napomena |
|---|---|---|---|---|---|
| **A — zasebna instanca na čvoru** (`hindsight-api-slim` + vlastiti PostgreSQL ili SQLite-pg; embeddings na Ollami čvora ili CPU model ≈ 0,6–1,2 GB) | **potpuna**: podaci vanjskog korisnika nikad nisu kod nas, ni naši kod njega | srednja: novi modul profila `memorija-lokalno` (unit, venv, model), 1–2 dana | čvor: ≈ 2–4 GB RAM, ≈ 4–6 GB diska (procjena, slim bez torch modela); **node-A treba proširenje diska** (7,5 GB slobodno) | **čvor** (njegova Claude prijava ili OpenRouter, ADR-0005) | ispravno za vanjskog korisnika i kloniranje; čvor radi i kad smo mi ugašeni; nadogradnja Hindsighta po čvoru |
| **B — posrednik s dopuštenom bankom na glavnom stroju** (mali HTTP proxy na `127.0.0.1:17794`; tunel čvora pokazuje na njega umjesto na 17792) | jaka na razini API-ja: dopušten samo `/v1/default/banks/${MEMORIJA_BANKA}/…` (recall, reflect, memories, documents); popis banaka vraća samo njegovu; sve ostalo 403 | **mala**: ≈ 100–150 redaka + test, pola dana; promjena `tunel-nodea.sh` (cilj porta) | zanemariva (jedan bun proces) | **mi** (naša kvota) | podaci vanjskog korisnika žive **kod nas**; čvor ovisi o našem pogonu; zatvara §1.5 odmah |
| **C — zakupac po čvoru u našoj instanci** (vlastiti `TenantExtension`: ključ čvora → shema) | jaka (zasebna shema u bazi) | srednja: proširenje + ključ po čvoru (tajna, sloj „tajne" ADR-0004) + **svi naši klijenti Hindsighta moraju slati ključ** (daemon, ploča, `hindsight_pokus.py`, petlja) | mala | mi | širok zahvat u **naš** pogon zbog čvora; ključ je nova tajna za prijenos na VM (Goranovo odobrenje) |
| **D — druga instanca na glavnom stroju samo za čvorove** | jaka (zaseban proces i baza) | mala–srednja | **+4 GB RAM** kod nas, + disk | mi | ista ovisnost kao B, skuplja od B, slabija od A |

**Odluka:**
* **Odmah (faza 1): B.** Najjeftinije zatvara stvarnu rupu (čvor čita i piše našu glavnu banku),
  ne dira naš pogon, memorija čvora radi bez prekida (#192: „ne gasiti"). Posrednik je dio
  izvornog sustava (vlasnik `glavni-stroj`, kao tunel); dopuštena banka je vrijednost iz instance.
* **Cilj (faza 2): A** za svaki čvor koji koristi vanjski korisnik. Tek A ispunjava #192 doslovno:
  podaci čvora nastaju i **ostaju** na čvoru, a trošak retaina nosi čvor. Preduvjet: disk čvora
  (P7, §10), mjerenje slim instance na čvoru (RAM, latencija recalla ≤ rok 20 s).
* **C i D se ne rade:** C mijenja naš pogon zbog tuđeg, D plaća A-cijenu bez A-koristi.

## 9. Profil čvora: moduli i mjerila (ponovljivo za node-B)

### 9.1 Novi i prošireni moduli (`profili/upravitelj-cvora/profil.json`)

| Modul | Vlasnik | Primjena | Provjera |
|---|---|---|---|
| `mogucnosti` (**novo**) | paket | zapiše `config/mogucnosti.json` iz mjerenja (§6.1) | svaki ključ izmjeren; promjena → `upravitelj` i `znanje` javljaju „treba ponovo" |
| `znanje` (**novo**) | paket | `znanje-cvora.ts sastavi` + `upisi --pisi` (uz vrata kvote) | `znanje/MANIFEST.sha256` paketa = korpus čvora (otisci); banka ima sve `sustav/*` dokumente i nijedan `system-map/*`; brana opći uzorci = 0 |
| `znanje-cvora` (**novo**) | paket | petlja §7.1/§7.2 (prekidač `memorija.upis`) | zadnji upis `cvor/projekti` mlađi od 1 h; `cvor/projekti` = otisak `/api/projects` |
| `memorija` (prošireno) | paket | + `memorija.misija`, `memorija.upis` | + `GET banks` kroz `memorija.url` vraća **samo** `${MEMORIJA_BANKA}` |
| `tunel-memorije` (prošireno) | glavni-stroj | — | + cilj tunela je posrednik (faza 1) ili modul `memorija-lokalno` OK (faza 2) |
| `memorija-lokalno` (**novo, faza 2**) | paket + stroj | unit `regoc-hindsight`, venv slim, model | `/health` 200; `memorija.url` pokazuje na lokalni |
| `upravitelj` (prošireno) | paket | predložak s `{{#rag}}` blokovima iz `mogucnosti.json` | `~/CLAUDE.md` čvora bez RAG-a ne sadrži `rag-query` ni „pretraži RAG" |
| `nikadNeNosi` (**novo polje profila**) | paket | — | popis §3 (putanje i obrasci); `provjeri` javlja `RAZLIKA` ako na čvoru postoji nešto s popisa a ne potječe s čvora (npr. `system-map/*` dokument u banci) |

Instanca dobiva: `VLASNIK_ULOGA_IME` (kako se vlasnik zove u korpusu čvora; zadano „vlasnik"),
`MEMORIJA_MISIJA` (neobavezno). `MEMORIJA_BANKA` već postoji.

Novi čvor (ADR-0004 §13.5) dobiva **korak 3a** iza `primijeni`:
`profil-cvora.ts primijeni --modul mogucnosti,znanje --pisi` (prvi upis korpusa) i, za fazu 2,
`--modul memorija-lokalno`. node-B time ponavlja node-A bez ijednog dokumenta s glavnog osim
`znanje/sustav/` iz paketa.

### 9.2 Mjerila prihvaćanja

**Jelena — izvedba** (`bun test`, bez mreže):

| # | Mjerilo |
|---|---|
| Z1 | generator: odjeljak bez oznake `opseg` ne ulazi u izlaz; odjeljak `privatno` ne ulazi; `uvjet rag` uz `rag:false` daje izričitu činjenicu „RAG nije uključen" |
| Z2 | brana: kanarinac (izraz s privatnog popisa ubačen u odjeljak `opce`) → izlaz 5, nijedna datoteka napisana; isto za `PRJ-\d{3}`, chat id, e-poštu |
| Z3 | `znanje/sustav/` u paketu prolazi `tests/bez-nasih-vrijednosti.test.ts` (brana se proširuje na `znanje/`; `docs/` ostaje izuzet) |
| Z4 | `znanje-cvora.ts upisi --suho` ne mijenja ništa; drugi `--pisi` → 0 dokumenata; nestali `sustav/*` se briše |
| Z5 | `CLAUDE.md` predložak: `rag:false` → bez `rag-query`; `rag:true` → s njim; isto za identitet (`IdentityBlock` uz `ragUkljucen()=false` nema „Tvoja RAG memorija") |
| Z6 | posrednik (B): dopuštena banka 200; druga banka, `GET /banks` bez filtra, `/v1/default/banks/<druga>/memories/recall`, `DELETE` tuđe banke → 403; popis banaka = samo dopuštena |
| Z7 | `gradi_komplet.sh`: zapor privatnog popisa (osnovica 46/158), raste → izlaz 5 |

**Potjeh — proba na node-A** (TASK-5332):

| # | Mjerilo |
|---|---|
| P1 | recall na novoj banci čvora za svaki izraz s privatnog popisa (≈ 92 upita, s glavnog stroja) → **0 privatnih činjenica**; isti upiti na staroj banci → > 0 (dokaz da mjerilo vidi curenje) |
| P2 | „imaš li RAG?" upravitelju i jednom agentu na node-A → „nemam; memorija je Hindsight banka …"; u promptima spawnova na node-A 0 poziva `rag-query` (grep dnevnika daemona, 24 h) |
| P3 | s node-A kroz tunel: `GET /v1/default/banks` → samo banka čvora; recall na `regoc_sustav_opus` → 403 |
| P4 | projekt stvoren na ploči node-A → recall „koji su projekti" vraća ga u ≤ 1 h; nijedan naš `PRJ-0xx` |
| P5 | opća pitanja („kako se šalje uputa agentu u radu", „što radi StaleCodeCheck", „koji je lanac za E4") → točan odgovor iz banke čvora (paritet znanja) |
| P6 | node-B (kad je dostupan): `sastavi` s njegovom instancom → `sustav/*` jednaki node-A (otisci), razlika samo u `cvor/*` |

## 10. Preduvjeti i redoslijed

| # | Preduvjet / korak | Tko |
|---|---|---|
| R1 | Oznake `opseg` u ručnom sloju karte + razdvajanje mješovitih odjeljaka + vlasnik kao uloga (14 datoteka, tablica §4.2) | Jelena (karta), pregled Kosjenka |
| R2 | Opisi u `katalog.json` bez naših projekata (14/89 datoteka popisa) | Jelena |
| R3 | `katalog znanje` + `znanje/` u paketu + brana Z2/Z3 | Jelena |
| R4 | posrednik (B) + `tunel-nodea.sh` na novi port | Jelena, pregled Malik |
| R5 | `scripts/znanje-cvora.ts`, moduli `mogucnosti`, `znanje`, `znanje-cvora`, `upravitelj` s blokovima | Jelena |
| R6 | nova banka node-A, prebacivanje `memorija.banka`, proba P1–P5 | Potjeh (TASK-5332) |
| R7 | (faza 2) disk node-A ≥ 15 GB slobodno; mjerenje slim instance | Goran (disk) / Jelena |
| R8 | (zasebno) zapor privatnog popisa nad kompletom (§5.2), `ProjectGuess`/`IngestGateConfig` u postavke | Jelena, Malik |

R4 ne čeka R1–R3: zatvara rupu §1.5 neovisno o korpusu.

## 11. Što ne radimo (i zašto)

* **Ne kopiramo kartu na čvor i ne filtriramo je ondje** — izvor je privatan; filtar na čvoru znači
  da privatno već jest na čvoru.
* **Ne stavljamo privatni popis u paket** — popis imena klijenata je sam po sebi curenje.
* **Ne gasimo memoriju čvora** dok se gradi čista banka (#192); prebacivanje je jedna postavka.
* **Ne upisujemo sirove razgovore** u banku (§7.2).
* **Ne radimo C ni D** (§8).
* **Ne smanjujemo kod** na čvoru da bismo sakrili podatke — kod ostaje jednak (#192); podaci iz koda
  sele u postavke (§5.2).

## 12. Posljedice

**Dobro:** granica „naše / opće / čvorovo" postaje mjerljiva (brana + P1) umjesto obećanja;
novi čvor dobiva znanje o sustavu iz paketa, a znanje o sebi gradi sam; ID-evi projekata u banci
čvora prestaju se sudarati s našima; čvor bez RAG-a dosljedno to zna na tri mjesta iz jedne
postavke; vanjski korisnik prestaje vidjeti našu glavnu banku (faza 1) i prestaje ovisiti o nama (faza 2).

**Cijena:** karta dobiva disciplinu oznaka (novi odjeljak bez oznake ne stiže na čvor — namjerno);
održavanje privatnog popisa na glavnom stroju; faza 2 traži disk i nadogradnju Hindsighta po čvoru;
retain korpusa na novoj banci troši kvotu jednom (≈ 100 dokumenata, vrata kvote vrijede).

## 13. Usklađenje s TASK-5307 (ADR-0004 §13)

ADR-0004 §13 mjeri paritet na osima kuke · značajke · konzola · oporavak · kod (P5). Ovaj ADR dodaje
dvije osi u istu tablicu i u isti `paritet.py`, ne zaseban alat: **znanje** (`sustav/*` banke čvora =
`znanje/MANIFEST.sha256` paketa; 0 `system-map/*`) i **izolacija memorije** (popis banaka kroz
`memorija.url` = samo banka čvora). Kuka `AgentMemoryRead/Write` ostaje „uvjetno (modul `rag`)" iz
§13.2.2 — sada uvjet čita `mogucnosti.json`.

## 14. Izvedba (TASK-5331, Jelena, 07.10.2026.)

| Korak | Gdje | Stanje |
|---|---|---|
| R1 | `docs/system-map/opseg.tsv` uz kartu (repo sustava, ne paket) — 58 odjeljaka + uzorci `popis/` | izvedeno |
| R2 | nije rađeno na izvoru: `katalog.json` opisi ostaju; generator iz njih izbacuje retke s pogotkom (`+redigiraj`) | djelomično |
| R3 | `scripts/znanje-sustav.ts` + `src/znanje/Korpus.ts`; izlaz `znanje/sustav/` (81 dok.) + `znanje/MANIFEST.sha256` | izvedeno, Z1–Z3 |
| R4 | `src/znanje/Posrednik.ts` + `scripts/memorija-posrednik.ts`; na glavnom ga drži petlja tunela | u pogonu, Z6 |
| R5 | `scripts/znanje-cvora.ts` + `src/znanje/Cvor.ts`; moduli `mogucnosti`, `znanje` (timer `regoc-znanje`), `memorija.izolacija`, polje `nikadNeNosi` | izvedeno, Z4; Z5 (blokovi `{{#rag}}`) nije |
| R8 | zapor privatnog popisa nad kompletom | nije rađeno (zaseban posao) |

**Odstupanja od teksta odluke (i zašto):**

1. **Oznake opsega su u zasebnoj tablici `opseg.tsv` uz kartu, ne u retku ispod naslova.**
   Datoteke ručnog sloja istodobno uređuju drugi zadaci (necommitane izmjene u tri datoteke u
   trenutku izvedbe); tablica ne dira njihov tekst. Bijela lista ostaje: odjeljak bez retka u
   tablici = privatno, pa i preimenovan odjeljak ispada dok ga netko ne upiše.
2. **Uz opseg odjeljka postoji `+redigiraj`.** Opći odjeljak koji nosi pokoju privatnu rečenicu
   (ime klijenta, chat id) ne mora se razdvajati na izvoru: generator izbaci redak/rečenicu s
   pogotkom. Odjeljak `opce` BEZ `+redigiraj` je strog — pogodak = izlaz 5 (kanarinac Z2).
3. **Uvjet po rečenici.** U općem odjeljku rečenica koja je UPUTA za mogućnost (RAG-FIRST,
   `rag-query`, kolekcija `agent_*`, …) dobiva oznaku `<!--u:rag-->…<!--/u-->`; čvor bez mogućnosti
   je ne vidi, a na njenom mjestu (jednom po dokumentu) stoji izričita činjenica iz §6.2. Usputni
   spomen („ne ispisuj tajnu u RAG") ostaje.
4. **Generator uz to briše stanje našeg pogona:** meta-redak `**Provjereno:**`, rečenice „Dana
   <datum> …" (PID, brojevi, položaji prekidača) i oznake naših zadataka `TASK-n` (isti sudar kao
   `PRJ-` u §1.4). Ime vlasnika postaje uloga preko kategorije `vlasnik` u privatnom popisu.
5. **Posrednik sluša na 17795**, ne 17794: 17793 i 17794 već zauzima Hindsight. Na čvoru se ne
   mijenja ništa (tunel i dalje daje `127.0.0.1:17792`). Posrednik je **bijela lista (metoda,
   podput)** — recall, retain, reflect, popis/brisanje dokumenata, statistika; webhookovi,
   kloniranje, prijenos, uvoz, postavke LLM-a i brisanje banke su 403. `PUT` banke propušta samo
   ime, misije i narav. Vrata kvote i brava vrijede za retain i reflect.
6. **Prekidač razgovora je `ZNANJE_RAZGOVOR` u instanci** (off | shadow | on; uz `ZNANJE_RAZGOVOR_OD` = prvi dan — razgovori prije čiste banke ponavljaju činjenice stare), ne postavka ploče
   `memorija.upis`: ploča paketa nema opći API postavki, a instanca je ionako mjesto vrijednosti
   po čvoru (ponovljivo za node-B). U banku idu samo završeni dani; dan s oblikom tajne se ne upisuje.
7. **Zadatak s oblikom tajne u punom tekstu rezultata** (npr. 64-znamenkasti heks) ne ide u banku —
   provjera je nad punim tekstom prije skraćivanja i još jednom nad svakim dokumentom korpusa.
8. **Upis ide po važnosti** (znanje čvora → ručni sloj → alati → tijekovi → vještine), jer vrata
   kvote mogu prekinuti prvi upis; timer nastavlja kad se kvota obnovi.

**Stara banka `regoc_opus_nodea`** nije obrisana: izvezena je u arhivu na glavnom stroju
(`raid/hindsight/manifests/regoc_opus_nodea/arhiva_TASK-5331_20261007.json`, 0600; 14 dokumenata,
374 činjenice), ime joj je `ARHIVA …`, a posrednik je čvoru više ne propušta. Briše se tek uz
vlasnikovu potvrdu (§5.3).

**Mjerenje curenja** (`docs/qa/TASK-5331/mjeri_curenje.ts`, izrazi s privatnog popisa bez ID-eva
koje čvor ima i sam): stara banka 89/90 izraza vraća privatnu činjenicu; brojke nove banke su u
`docs/qa/TASK-5331/README.md`.
