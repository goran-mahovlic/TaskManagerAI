# Integracije — Nextcloud, e-pošta, GitLab, GitHub

> Sve četiri se podešavaju s ploče (**Config → Integracije**) ili izravno u
> `config/<ime>.json`. Nijedna se ne pali sama.
>
> Izvedba: TASK-4800 po dizajnu `docs/DIZAJN-integracije.md` (Kosjenka, TASK-4799).

---

## 0. Jedno pravilo koje vrijedi za sve četiri

**Tajna nikad ne ide u JSON.** U konfiguraciji stoji **IME varijable okoline**:

```jsonc
"lozinkaEnv": "NEXTCLOUD_APP_PASSWORD"   // ✅ ime varijable
"lozinka": "…"                            // ❌ nikad
```

Sama vrijednost dolazi iz okoline procesa ili iz `$TM_HOME/config/credentials.env`
(prava **0600**, u `.gitignore`). Ploča provjerava **samo postoji li** tajna i vrijednost ne
vraća ni u jednom odgovoru — to je i testirano (`tests/integracije.test.ts`, tvrdnja nad
cijelim tijelom odgovora, ne samo nad poljem).

Gdje se traži konfiguracija (isti redoslijed kao za sve ostalo u paketu):

```
$TM_<IME>_CONFIG  →  $TM_HOME/config/<ime>.json  →  config/<ime>.json uz paket
```

**„Probaj konekciju"** ide na adresu koju si **ti** upisao, pa prolazi kroz `ProbeGuard`:
samo `https` (za `http` treba izričito `dopustiHttp`), bez `file:`/`gopher:`/`ftp:`, bez
slijeđenja preusmjeravanja na drugi host, odgovor najviše 64 KB, rok 10 s, najviše jedna
proba u 5 s. Odgovor je **sažetak** (HTTP kod, trajanje, poslužitelj), nikad sirovo tijelo —
inače bi „Probaj" postao čitač unutarnjih stranica.

Privatne mreže (`10/8`, `192.168/16`, `127/8`…) su **dopuštene** zadano, jer kućni Nextcloud
i lokalni GitLab žive upravo ondje. Na stroju izloženom internetu isključi
`dopustiPrivatneMreze`.

---

## 1. Nextcloud (`config/nextcloud.json`)

Protokol: WebDAV (`PROPFIND`, `MKCOL`, `PUT`), bez vanjskih knjižnica.

| Polje | Značenje |
|---|---|
| `baseUrl` | npr. `https://oblak.primjer.hr` |
| `korisnik` | tvoje korisničko ime |
| `lozinkaEnv` | IME varijable sa **zaporkom aplikacije** (Settings → Security → App passwords) |
| `korijenskaMapa` | npr. `TaskManager` — bez `..`, bez vodeće kose crte |
| `mapaPoProjektu` | `true` → `<korijen>/<Projekt>/` |

Postavljanje tajne:

```bash
mkdir -p "$TM_HOME/config"
printf 'NEXTCLOUD_APP_PASSWORD=%s\n' "$(read -rs -p 'zaporka aplikacije: ' p; echo "$p")" \
  >> "$TM_HOME/config/credentials.env"
chmod 600 "$TM_HOME/config/credentials.env"
```

**Zaporka aplikacije, ne zaporka naloga.** Aplikacijska se može opozvati pojedinačno i ne
otključava web sučelje.

Proba radi `PROPFIND Depth: 0` na korijen tvojih datoteka; `207 Multi-Status` znači da radi.
Poruke po ishodu: `401` → korisnik ili zaporka nisu točni; `404` → adresa nije Nextcloud ili
korisnik ne postoji.

**Opseg:** modul zna osigurati mapu i postaviti datoteku. Sinkronizacija u oba smjera nije u
opsegu — za to postoji `rclone` i ne treba mu naša lošija preslika.

---

## 2. E-pošta (`config/email.json`)

| Smjer | Protokol | Što treba |
|---|---|---|
| `izlaz` | SMTP | `smtp.host`, `smtp.korisnik`, `smtp.posiljatelj`, `primatelji`, knjižnica `nodemailer` |
| `ulaz` | IMAP | `imap.host`, `imap.korisnik`, `imap.mapa` (zadano `INBOX`) |

Slanje traži neobaveznu knjižnicu (Bun nema ugrađen SMTP klijent):

```bash
bun add nodemailer
```

Bez nje kartica jasno kaže što nedostaje, a **ostatak paketa radi normalno** — isti obrazac
kao `chromadb` i `ollama`.

**`imap.filtar`** je jedino polje koje bi bez provjere pustilo tvoj niz u IMAP naredbu, pa
se odbija sve što sadrži navodnik ili prijelaz retka (CRLF injekcija).

Ulazna poruka postaje **jedan** `POST /api/ingest` sa `source: "email"`. Hoće li od nje
nastati zadatak odlučuju **Ulazna vrata** (pragovi i položaj po izvoru), ne modul e-pošte.

---

## 3. GitHub (`config/github.json`) — donesi svoj nalog

**Ovo nije novi HTTP klijent.** `gh` CLI sam čuva tvoju prijavu, pa paket ne mora ni vidjeti
tvoj token.

```bash
# 1. instaliraj gh: https://cli.github.com
gh --version

# 2. prijavi se SVOJIM nalogom (otvara preglednik ili traži jednokratni kod)
gh auth login
#    - What account do you want to log into?  GitHub.com
#    - What is your preferred protocol?       HTTPS  (ili SSH, ako radiš s ključem)
#    - Authenticate Git with your credentials? Yes

# 3. provjera — ovo je točno ono što radi gumb „Probaj konekciju"
gh auth status
gh repo view vlasnik/repozitorij --json name
```

Zatim na ploči: `nacin: cli`, `repo: vlasnik/repozitorij`. Gotovo — nikakav token nije upisan
nigdje u paketu.

**SSH ključ** (ako radiš `git push`, a ne samo issue):

```bash
ssh-keygen -t ed25519 -C "tvoja@adresa"      # Enter za zadano mjesto
gh ssh-key add ~/.ssh/id_ed25519.pub --title "ovaj stroj"
ssh -T git@github.com                        # očekuj „successfully authenticated"
```

**API način** (`nacin: api`) postoji za strojeve na kojima `gh` ne može biti instaliran.
Tada u `tokenEnv` upiši IME varijable (npr. `GITHUB_TOKEN`), a sam token stavi u
`credentials.env`. Token treba doseg `repo` (odnosno `issues: write` za fine-grained).

---

## 4. GitLab (`config/gitlab.json`) — isto, s `glab`

```bash
# 1. instaliraj glab: https://gitlab.com/gitlab-org/cli
glab --version

# 2. prijava (i za gitlab.com i za vlastiti poslužitelj)
glab auth login                       # gitlab.com
glab auth login --hostname gitlab.tvrtka.hr

# 3. provjera
glab auth status
glab api projects/grupa%2Frepozitorij
```

Na ploči: `nacin: cli`, `host: gitlab.com` (ili tvoj poslužitelj), `projekt: grupa/repozitorij`.

**API način:** `tokenEnv` (npr. `GITLAB_TOKEN`), token s dosegom `api`, a zove se
`GET {host}/api/v4/projects/{projekt}` kroz `ProbeGuard`.

**Zajedničko s GitHubom:** oba dijele `src/core/IssueSync.ts` — jedan mehanizam, dvije tanke
izvedbe. Opseg je issue (otvori / zatvori). Git operacije nisu u opsegu; za njih postoji
`src/core/GitCommitGate.ts` i tvoj vlastiti `git`.

---

## 5. Telegram

Izlazne obavijesti i ulazni kanal opisani su u `docs/INSTALL.md` §7; dizajn ulaza je u
`docs/DIZAJN-telegram-poller.md`. Ukratko:

* **izlaz** — bot token + chat id, kartica Telegram;
* **ulaz** — `ulaz.ukljucen`, poller zove `POST /api/ingest`; gumb **„Probaj ulaz"** pokaže
  koliko poruka čeka i **iz kojih chatova** (tako doznaješ `chat.id` svoje grupe) bez
  otvaranja ijednog zadatka.

---

## 6. Kad nešto ne radi

| Što vidiš | Što je |
|---|---|
| značka **nepotpuno**, tekst „tajna nije postavljena" | varijabla iz `*Env` nije ni u okolini ni u `credentials.env` |
| „nešifrirani http nije dopušten" | uključi `dopustiHttp` samo ako doista ideš preko `http` |
| „poslužitelj preusmjerava na drugi host" | adresa te vodi drugamo — upiši konačnu adresu |
| „naredba `gh` nije dostupna" | CLI nije na `PATH`-u; poruka nosi vezu za instalaciju |
| spremio si s ploče, ali proba i dalje vidi prazno | bilo je tako do 10.09.2026. (putanja se razrješavala pri pokretanju); nadogradi paket |
| značka **radi** ne pojavljuje se ni nakon uspješne probe | osvježi stranicu — značka se računa iz zadnjeg zapisanog ishoda (`data/integracije.json`) |
