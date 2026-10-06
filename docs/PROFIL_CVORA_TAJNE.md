# Kontrolni popis: tajne i ljudske stavke za novi čvor

Uz [ADR-0004](adr/ADR-0004-profil-cvora.md). Profil čvora prenosi **sve osim** ovoga. Svaku
stavku unosi **čovjek, na samom čvoru**. Vrijednost se ne šalje u chat, ne upisuje u zadatak i
ne stavlja u profil ni instancu. `profil-cvora.ts provjeri` za svaku stavku javlja samo
`postoji` / `nema`, a stavke koje nedostaju označava izlaznim kodom 2.

Redoslijed je bitan: stavke 1–3 traži sam rad ploče, 4–6 traže razgovor, 7–9 su ovlasti.

| # | Stavka | Kako se unosi | Kako se provjerava (bez otkrivanja) | Zašto čovjek |
|---|---|---|---|---|
| 1 | **Bot token** (novi bot za ovaj čvor) | BotFather → `/newbot`. Unosi se na ploči čvora: Config → Telegram obavijesti → polje tokena. Ploča ga sprema u datoteku vjerodajnica (`TM_CREDENTIALS`, 0600) pod imenom iz `botTokenEnv` (`TELEGRAM_BOT_TOKEN`) | `provjeri` → `TAJNA postoji TELEGRAM_BOT_TOKEN`; uživo `getMe` vraća samo `@username` bota | token je ključ bota. **Ne smije se dijeliti s drugim čvorom**: Telegram dopušta jedan `getUpdates` po tokenu |
| 2 | **Bot u grupi** | dodaj bota u grupu čvora. U BotFatheru `/setprivacy` → Disable (bot mora vidjeti poruke bez prozivke, `odgovaraNa=dopusteni-sve`) | poruka u grupi stiže u `ingest.jsonl` | to radi samo vlasnik grupe u Telegramu |
| 3 | **ID grupe i dopušteni korisnici** u instanci | `TG_CHAT_ID` = ID **grupe** (negativan broj), `RAZGOVOR_DOPUSTENI_KORISNICI` = brojčani uid ili korisničko ime | `provjeri` → modul `telegram` OK | nije tajna, ali je odluka: tko smije upravljati čvorom. Na prvom čvoru je uid upisan kao chat (nalaz TASK-5278) |
| 4 | **Claude prijava** | kao korisnik usluge (`regoc`) na čvoru: `claude auth login`, pa link u pregledniku | `provjeri` → `ČOVJEK claude-prijava: postoji` (gleda se samo da datoteka prijave postoji i nije prazna, sadržaj se ne čita) | prijava je osobni račun/pretplata |
| 5 | **`TM_RAZGOVOR_PUNO=1`** (samo ako profil traži `ovlasti=puno`) | vlasnik ga ručno dopisuje u `~/TaskManagerAI/config/postavke.env` (0600), zatim restarta `regoc-taskmanager` kad je 0 zadataka `in_progress` | `provjeri` → `razgovor.ovlasti=puno` OK; bez retka alat upisuje `citanje` i upozori | ADR-0002 §7.1 (c): `puno` daje sesiji okolinu i cijeli dom korisnika. To nije postavka nego odluka vlasnika, i alat je nikad ne donosi |
| 6 | **Tajna kanala bot↔bot** `TM_BOT_KANAL_TOKEN` (samo uz modul `bot-kanal`) | ista vrijednost na **oba** kraja (ovaj čvor i drugi bot): `openssl rand -hex 32` na jednom kraju, pa prijenos na drugi kraj izvan chata. Na čvoru se upisuje u `config/postavke.env` | `provjeri` → `TAJNA postoji TM_BOT_KANAL_TOKEN`; uživo poziv bez tajne `/api/razgovor/od-bota` vraća 401 | tajnu vide dvije strane, a prenosi je čovjek |
| 7 | **Tier-2 sposobnosti** (internet, root, LAN) | `primijeni --pisi` upisuje samo **zahtjev** (`pending`, kartica Sigurnost). Odobrava ga admin na čvoru: `sudo /usr/local/sbin/regoc-capguard approve <ime> on`, ili host token (datoteka `<ime>.approve` sa sadržajem `on <epoch>` u mapi odobrenja domaćina) | kartica Sigurnost / `/etc/regoc/capabilities.state`: `allow_<ime>.on=true` | Tier-2 mijenja vatrozid i sudo. Ploča i alat po dizajnu to ne mogu (`src/Capguard.ts`) |
| 8 | **Tunel memorije** (strana glavnog stroja) | na glavnom stroju: SSH ključ za korisnika usluge čvora (javni ključ u `~/.ssh/authorized_keys` čvora), petlja tunela s ciljem tog čvora | na čvoru `127.0.0.1:17792` sluša, a `memorija.url` odgovara | ključ je tajna glavnog stroja i otvara ulaz na čvor |
| 9 | **Banka memorije** | ime u instanci (`MEMORIJA_BANKA`), jedno po čvoru. Banka nastaje prvim upisom | prvi odgovor s 🧠 (uz `memorija.oznakaUspjeha=true`) ili bez 🧠🚫 | odluka je hoće li čvorovi dijeliti sjećanje. Zadano je da ne dijele |

## Što NIJE na ovom popisu (prenosi profil)

Sve ostalo: `telegram.json` bez tokena, `razgovor.*`, `memorija.*` bez tajni, `botKanal.*` bez
tajne, netajni retci `postavke.env`, oblik `~/.claude/settings.json` (kuka SecurityValidator),
`~/CLAUDE.md` iz predloška, željene capguard sposobnosti (kao zahtjev) i provjera da je RAG
isključen.

## Pravilo za dopunu

Kad se pojavi nova tajna, ona ulazi **ovdje** i u `tajneImenom` modula u `profil.json`, nikad u
`settings` ni u instancu. Izvoz radi po bijeloj listi, pa ključ koji profil ne imenuje ionako ne
izlazi. Ovaj popis je mjesto na kojem čovjek saznaje da ga mora unijeti.
