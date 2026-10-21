# Mac — krugovi instalacije s GitHuba (K8 / K8a)

Petlja popravka iz plana Mac v3 (§4 K8a, P3.3). Svaki krug kreće od nule: `deinstaliraj.sh --do-nule`
i `rm -rf ~/TaskManagerAI`, zatim `provjeri-cisto.sh` = 0. Nakon toga se izvode **doslovno** naredbe
iz README-a („Install on a new machine"). Ništa se ne krpa na Macu. Svaki pad dobiva popravak u
paketu i test koji ga hvata, a na GitHub ga pusha samo vlasnik repozitorija. Kočnica: ako 5 krugova zaredom padne na istom
koraku, petlja staje i javlja se vlasniku.

Čvor: Mac (macOS 27.0.1, arm64, Command Line Tools, Homebrew drugog korisnika bez `openssl@3`).
Instalaciju izvodi korisnik usluge `regoc` preko SSH-a. Log se čita ovako:
`cat ~/.taskmanager/log/install/zadnji/install-rezultat.json` i
`grep -v '"izlaz":0' ~/.taskmanager/log/install/zadnji/koraci.jsonl`.

| Krug | Datum | Commit (GitHub) | Naredba | Ishod | Korak koji je pao | Izlaz | Trajanje | Popravak (commit) |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-21 19:58 | `894bddd` | README korak 2, bez `--komplet` (README ga ne navodi; `config/komplet.lock` na GitHubu ne postoji) | pad | `K2.18-baze-pgvector` | 6 | 35,6 s | grana `zadatak/TASK-5662` (vidi niže) |

## Krug 1 — 2026-10-21

**Prije:** Mac je čist (`~/TaskManagerAI`, `~/.taskmanager` i plistovi `hr.regoc.*` ne postoje).
`origin/main` = `894bddd`.

**Izvedeno:** `git clone https://github.com/goran-mahovlic/TaskManagerAI.git ~/TaskManagerAI` →
`bash scripts/install.sh --cvor <ime-čvora> --profil upravitelj-cvora --baze`. README-ov
`sudo -v` je zamijenjen sa `sudo -n true`, jer `regoc` ima NOPASSWD, a `sudo -v` bez terminala
ipak traži lozinku (zbog unosa `(ALL) ALL` iz grupe admin). Isto provjerava i sam install.sh.
`xcode-select --install` nije pokrenut jer su Command Line Tools već instalirani.

**Pad:** `K2.18-baze-pgvector`, izlaz 6, `install-rezultat.json` → `"ishod":"pad"`.
Koraci K2.1–K2.17 imaju izlaz 0. `git status --porcelain` na Macu je prazan.

```
Error: PostgreSQL error: … dyld: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib
  Referenced from: …/.taskmanager/rag/home/.pg0/installation/18.1.0/lib/libpq.5.dylib
GREŠKA: pg0 start nije uspio (…/.taskmanager/rag/pg0-start.log)
```

**Uzrok (izmjereno `otool -L`):** pg0 0.15.2 (najnovija verzija na PyPI-ju) raspakira PostgreSQL 18.1
čiji su `bin/postgres` i `lib/libpq.5.dylib` vezani uz Homebrewov `openssl@3`. Pogođeno je 10 Mach-O
datoteka. Na Macu Homebrew nije obavezan, a i kad postoji, ne pripada nužno korisniku.
`DYLD_FALLBACK_LIBRARY_PATH` ne pomaže: `postgres --version` s njim radi, ali initdb poziva
`postgres -V` kroz `/bin/sh`, a SIP tom procesu briše DYLD_* varijable. Izmjereno: „program postgres
is needed by initdb but was not found".

**Popravak 1 (pad):** `scripts/macos/pg0-openssl.sh` čini instalaciju pg0 samostalnom:
- `libssl.3.dylib` i `libcrypto.3.dylib` (OpenSSL 3.5.8) dolaze iz javnog wheela `psycopg-binary 3.3.6`
  s PyPI-ja, s pinanim sha256 (arm64 i x86_64), i idu u `installation/<v>/lib`;
- reference `…/opt/openssl@3/lib/…` prepisuju se na `@loader_path` (`install_name_tool`), a zatim
  slijedi ad-hoc potpis (`codesign -s -`).

`install.sh` u pgvector koraku na macOS-u radi tri stvari prije pravog starta: binarke raspakira
jednokratnim `pg0 start`, poziva `pg0 drop -f` i pokreće popravak. Hindsight na macOS-u dijeli tu
instalaciju preko veze `hindsight/home/.pg0/installation`, jer bi njegov vlastiti pg0 HOME raspakirao
pokvarenu.
Pokus na Macu u `/tmp` (instalacija nije dirana, pokus je obrisan) dao je: 10 datoteka popravljeno →
`pg0 start` OK → `CREATE EXTENSION vector` → 0.8.5 → `pg0 stop`.
Test: `tests/pg0-openssl-macos.test.ts` (5) i lažni darwin u `tests/install-sh.test.ts`.

**Popravak 2 (upozorenje, ne pad):** `K2.7-pdf` je javio „naredba pdf nije spremna". Uzrok je
`python3 -m pip --python …`: pip iz Command Line Tools Pythona 3.9 (pip 21.2) tu zastavicu nema
(„no such option: --python"). Novi `scripts/instalacija/pip-u-venv.sh` prvo koristi pip samog venva
(`ensurepip`, bez `-q`, koji ensurepip ne prima). Pip sustava s `--python` ostaje rezerva za Debian.
Na Macu (`/tmp`) to daje reportlab 4.4.4 i pypdf 6.1.1. Test: `tests/pip-u-venv.test.ts` (3).

**Čišćenje nakon kruga 1 (L4) — popravak 3:** `deinstaliraj.sh --do-nule` je završio s izlazom 0, ali
s korakom `D10-provjera` izlaz 8 (`provjeri-cisto`: 3 ostatka). Na Macu su ostale stvari koje je
napravila instalacija, a manifest `instalirano.json` ih nije poznavao:
- `~/.config/uv/uv-receipt.json`, koji piše službeni instalator uv-a,
- veza `~/.local/bin/python3.13` (stvara je `uv python install`; nakon brisanja Pythona visi),
- `~/Library/Fonts/DejaVu*.ttf` (5 fontova iz `instaliraj-pdf.sh`); `provjeri-cisto` ih nije vidio.

Popravci:
- `install.sh` upisuje receipt i nove veze `~/.local/bin/python*`;
- `instaliraj-pdf.sh` kroz `TM_PDF_STVORENO` javlja fontove i mapu koje je sam stvorio;
- `pip_u_venv` dobiva `--no-cache-dir`.

Testovi: lažni uv u `tests/deinstalacija-do-nule.test.ts` sada radi isto što i pravi (HOME = snimka
prije). Novi test „fontovi naredbe pdf" (lažni darwin) prolazi cijeli put install → `--do-nule` →
`provjeri-cisto` = 0. Na Macu su ostaci kruga 1 maknuti tek u čišćenju prije kruga 2.

**Otvoreno za K8 (nije pad instalacije):** D2 = B traži `--komplet`, a `config/komplet.lock` ni javni
modul `regoc-komplet` (K3a, odluka D3) na GitHubu ne postoje, pa `install.sh --komplet` staje s
izlazom 5. README ga zato ne navodi. Usluga `daemon` (RegocDaemon) na Macu za sada ne postoji.

**Sljedeće:** vlasnik pusha granu → `deinstaliraj.sh --do-nule` + `rm -rf ~/TaskManagerAI` →
`provjeri-cisto.sh` = 0 → krug 2.
