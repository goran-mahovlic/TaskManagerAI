#!/usr/bin/env python3
"""odlucitelj.py — model odlučuje umjesto korisnika o zadatcima koji čekaju odluku.

Vlasnik, 04.09.2026.: „dodao bi switch i odabir modela koji se moze koristiti umjesto odluke
korisnika. Tipa da kada je odabran neki od nasih dostupnih modela onda oni odluce umjesto
korisnika."

ZAMISAO je ista kao kod dežurnog: model NE piše naredbe i NE mijenja zadatke. Bira **jednu od
tri riječi**, a upis radi ova skripta preko istoga API-ja kojim odluku donosi i čovjek. Zbog
toga je svejedno je li odlučio čovjek ili model — trag je jednak, samo se vidi tko je potpisan.

    KRENI    — zadatak je jasan i može se raditi
    ODGODI   — nije sada na redu; ostaje čekati
    COVJEK   — traži vlasnikovu prosudbu (novac, brisanje, vanjski učinak, nejasan opseg)

`COVJEK` je namjerno lak izlaz. Model koji ne smije reći „ne znam" počne izmišljati, a ovdje
izmišljanje znači pokrenut posao koji nitko nije htio.

NIŠTA NE ČEKA ČOVJEKA DOK JE PREKIDAČ UKLJUČEN (vlasnik, 05.09.2026.): „Ali nista ne treba
cekati mene ako sam odabrao da model odlucuje za mene." Zato `covjek` tada NIJE ishod —
dvojba, nejasan opis, prepoznat rizik i šutnja modela završavaju kao **ODGODI**, s rokom
(`cekanje_sati`, zadano 1 h) nakon kojeg se zadatak sam vrati u prolaz. Rizik se i dalje
prepoznaje, ali se modelu **kaže u prompt** umjesto da se zadatak preda čovjeku; nakon tri
uzastopne odgode stiže javka vlasniku — obavijest, ne blokada. Staro ponašanje (rizik ide
čovjeku) vraća se s `"smije_rizicno": false`.

DRUGI PUT — STRUČNJAK (vlasnik, 05.09.2026.): kad zadatak nosi strukturirano pitanje (blok
„PITANJE ZA ODLUKU" s navedenom strukom i opcijama A/B/C…), model ne bira kreni/odgodi nego
odgovara **u ulozi te struke** i pokazuje na jednu opciju — „Uz opcije mora navesti koji
strucnjak mu odgovara, tako da ako je ukljucen AI odgovor moze znati sto treba." Filtar rizika
vrijedi jednako: pitanje o trošku, brisanju ili vanjskom učinku i dalje ide čovjeku.

    python3 tools/odlucitelj.py --proba          # pokaži što bi odlučio, ne diraj ništa
    python3 tools/odlucitelj.py --izvrsi         # doista upiši odluke
    python3 tools/odlucitelj.py --zadatak TASK-1234 --proba
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from tm_putanje import konfig, ollama_url, stanje

HOME = Path.home()
PLOCA = "http://localhost:17781"
POSTAVKE = konfig("odlucitelj.json", "TM_ODLUCITELJ_CONFIG")   # isti lanac kao OdluciteljPogon.ts

ZADANE = {
    "ukljucen": False,                      # fail-safe: bez izričitog uključivanja ne radi
    "provider": "ollama",
    "model": "qwen3:8b",
    "baseUrl": ollama_url(),               # TM_OLLAMA_URL, bez zadane adrese
    "najvise_po_prolazu": 3,
    "smije_kreni": True,                    # kad je false, model smije samo odgoditi ili tražiti čovjeka
    # Vlasnik, 05.09.2026.: „ništa ne treba čekati mene ako sam odabrao da model odlučuje za mene."
    # Dok je prekidač uključen, `covjek` NIJE ishod: rizičan ili nejasan zadatak model odgađa,
    # ne prosljeđuje. Tko ovo postavi na false, vraća staro ponašanje (rizik ide čovjeku).
    "smije_rizicno": True,
    # Vlasnik, 05.09.2026.: „Mislim da je dovoljno staviti 1h default ali negdje dodati opcije
    # za namjestiti koliko je to cekanje." Jedan broj vrijedi za oboje: koliko čovjek ima
    # vremena prije nego model odluči, i koliko dugo odgođen zadatak ne ulazi u novi prolaz.
    "cekanje_sati": 1,
    "odgode_prije_javke": 3,                # nakon toliko uzastopnih odgoda javi se vlasniku (ne blokira)
    # STROJNI OKIDAČ (05.09.2026., ADR-0010). Zadatak s oznakom `okidac-strojni` čeka stanje
    # koje ovaj alat NE VIDI — nastalu datoteku, prošli trenutak, dovršen preduvjet. Sud iz
    # naslova i opisa ondje je nagađanje: mjereno na TASK-4651, isti model je u 7 minuta rekao
    # i ODGODI i KRENI, a KRENI je zadatak digao 2,2 dana prerano. Zato ga alat preskače.
    # Tko ovo postavi na true, dobiva natrag nagađanje — a ploča ga i dalje odbija (HTTP 409)
    # jer puštanje traži provjerenu činjenicu.
    "pusta_strojni_okidac": False,
}

ODGODE = stanje("odlucitelj_odgode.json")


def cekanje_sati(p: dict) -> float:
    """Koliko sati čovjek ima prije nego model odluči (i koliko traje odgoda).

    `odgoda_sati` je stari naziv iste postavke — prihvaća se da postojeće konfiguracije ne
    puknu, ali `cekanje_sati` pobjeđuje."""
    for kljuc in ("cekanje_sati", "odgoda_sati"):
        if p.get(kljuc) is not None:
            try:
                v = float(p[kljuc])
                if v > 0:
                    return v
            except (TypeError, ValueError):
                pass
    return 1.0

RIJECI = ("kreni", "odgodi", "covjek")



# ── Deterministički filtar rizika ────────────────────────────────────────────────────────
# MJERENO 04.09.2026. na qwen3:8b: bez ovoga model kaže „kreni" na 6 od 7 rizičnih zadataka —
# uključujući trošak od 500 EUR, brisanje RAG kolekcija, slanje ponude klijentu i opis
# „popravi ono što ne radi". Prosudba rizika je preteška za mali model, pa je ovdje ne
# tražimo: skripta sama izdvoji rizično i pošalje čovjeku, a model odlučuje SAMO o ostatku.
# Model nikad ne može prevladati filtar — najgori ishod mu je „kreni" na bezopasnom zadatku.
RIZIK = [
    ("novac", r"\b(eur|usd|€|\$|kupi|kupnj|plati|plaćanj|placanj|račun|racun|naplat|ponud|"
              r"kredit|pretplat|licenc|narudžb|narudzb)\w*"),
    ("brisanje", r"\b(obriši|obrisi|izbriši|izbrisi|briš|bris|delete|drop\s+table|rm\s+-rf|"
                 r"purge|očisti|ocisti|ukloni|reset)\w*"),
    ("vanjski učinak", r"\b(pošalji|posalji|slanje|e-?mail|mail|klijent|naručitelj|narucitelj|"
                       r"objavi|push|deploy|produkcij|uživo|uzivo|live|javno|kupac)\w*"),
    ("tajne", r"\b(ključ|kljuc|lozink|token|credential|api[\s_-]?key|tajn)\w*"),
    # `schema`/`shema` je 05.09.2026. maknuto: shema JSON izlaza (W3, TASK-4615) nema veze s
    # migracijom baze, a filtar je zbog te jedne riječi slao čovjeku svaki zadatak koji je
    # spominje. Nepovratno je selidba podataka, ne opis oblika.
    ("nepovratno", r"\b(migracij|selidb|preseli|nadogradnj|upgrade)\w*"),
]

# Rečenica koja rizičnu radnju IZRIJEKOM ZABRANJUJE nije rizik nego ograda.
# MJERENO 05.09.2026.: TASK-4651 je pao na filtar „brisanje" zbog vlastite upute „NE brisi
# polje agents" — zadatak koji brisanje zabranjuje bio je odbijen kao da ga nalaže.
NIJECNICA = re.compile(r"\b(ne|nemoj|nikad|nikada|bez)\b[\s\w,„”\"'`()-]{0,24}$", re.IGNORECASE)


def _stvaran_pogodak(tekst: str, uzorak: str) -> bool:
    """Postoji li pogodak koji NIJE zanijekan neposredno prije njega?"""
    for m in re.finditer(uzorak, tekst, re.IGNORECASE):
        if not NIJECNICA.search(tekst[max(0, m.start() - 40):m.start()]):
            return True
    return False


def rizik(z: dict) -> str | None:
    """Vraća naziv rizika ili None. Gleda naslov i opis zajedno."""
    tekst = f"{z.get('title') or ''}\n{z.get('description') or ''}".lower()
    for naziv, uzorak in RIZIK:
        if _stvaran_pogodak(tekst, uzorak):
            return naziv
    return None


# ── Vremenski uvjet ──────────────────────────────────────────────────────────────────────
# MJERENO 05.09.2026. na TASK-4619 („prvi izvještaj nakon 30 dana rada W2"): isti model je
# u dva prolaza rekao ODGODI s točnim obrazloženjem, a u trećem KRENI uz „razlog" koji je
# bio puki prepis kartice („priority 3, executor regoc, waiting 30h"). Zadatak čiji okidač
# je PROTEK VREMENA ne može se prosuditi iz naslova i opisa — podatak koji odlučuje (je li
# rok prošao) u kartici ne postoji. Isti model je istog dana TASK-4697 ispravno odgodio jer
# mu je horizont bio napisan brojkom („0,4 od 7 dana"); razlika je bila sreća, ne pravilo.
# Zato se vremenski uvjet prepoznaje deterministički i model se o njemu NE PITA.
VREMENSKI = re.compile(
    r"\b("
    r"(nakon|poslije|posle|za|kroz|unutar|čeka|ceka|prođe|prodje)\s+\d+\s*(dan|dana|tjed|tjedn|mjesec|sat|sati|h)\w*"
    r"|\d+\s*(dan|dana|tjedan|tjedna|tjedno|mjesec|mjeseci)\s+(rada|mjerenja|zapisa|uzorka|prikuplj\w*)"
    r"|najranije\s+\d{1,2}\.\s?\d{1,2}\."
    r"|(mjesečno|mjesecno|tjedno|dnevno)\s+(usporedi|mjeri|izvje\w*|pregled\w*)"
    r")", re.IGNORECASE)


def vremenski_uvjet(z: dict) -> str | None:
    """Vraća doslovan tekst vremenskog uvjeta ili None.

    Nije rizik nego NEDOSTUPAN PODATAK: dok se ne izmjeri je li rok prošao, i „kreni" i
    „odgodi" su nagađanje. Ovakav zadatak pripada oznaci `okidac-strojni` (ADR-0010), gdje
    puštanje traži činjenicu koju poslužitelj sam provjeri."""
    tekst = f"{z.get('title') or ''}\n{z.get('description') or ''}"
    m = VREMENSKI.search(tekst)
    return m.group(0).strip() if m else None


def premalo_opisa(z: dict) -> bool:
    """Zadatak bez konkretnog opisa ne može se procijeniti — ni čovjek ga ne bi pustio
    naslijepo. Prag je nizak namjerno: hvata „popravi ono što ne radi", ne kratke ali
    konkretne zadatke."""
    opis = str(z.get("description") or "").strip()
    if len(opis) < 60:
        return True
    # Opis bez ijednog traga izvedbe (datoteka, naredba, broj, kriterij) je želja, ne zadatak.
    return not re.search(r"[/.]\w{2,}|`|\d|kriterij|provjer|test", opis, re.IGNORECASE)



# ── Davatelji modela ─────────────────────────────────────────────────────────────────────
# Vlasnik, 04.09.2026.: „kod modela odluke imam samo lokalne, htio bi sve — znaci i anthropic i
# google i openrouter i ostale koje sustav nudi."
#
# Izvor istine je `models/model-config.json`. Ključ NIKAD ne ulazi u ovaj kod ni u ispis —
# čita se iz okoline, a ako ga nema, davatelj se pošteno prijavi kao nespreman umjesto da
# tiho ne radi.
KONFIG_MODELA = konfig("model-config.json", "TM_MODEL_CONFIG")
CREDENTIALS = konfig("credentials.env", "TM_CREDENTIALS")


def _ucitaj_kljuc(ime: str) -> str:
    """Ključ iz okoline, pa iz spremišta. Vrijednost se nikad ne ispisuje ni ne vraća dalje."""
    import os
    if os.environ.get(ime):
        return os.environ[ime]
    try:
        for red in CREDENTIALS.read_text(encoding="utf-8").splitlines():
            red = red.strip()
            if red.startswith(f"{ime}=") and not red.startswith("#"):
                return red.split("=", 1)[1].strip().strip("\"'")
    except Exception:
        pass
    return ""


def davatelji() -> dict:
    """Svi davatelji iz konfiguracije, s podatkom je li stvarno upotrebljiv."""
    try:
        konf = json.loads(KONFIG_MODELA.read_text(encoding="utf-8")).get("providers", {})
    except Exception:
        konf = {}
    out = {}
    for ime, v in konf.items():
        if not isinstance(v, dict):
            continue
        env = str(v.get("apiKey") or "")
        env = env.split("env:", 1)[1] if env.startswith("env:") else ""
        # `anthropic` ide preko Claude CLI-ja (pretplata), pa mu API ključ nije uvjet.
        spreman = bool(_ucitaj_kljuc(env)) if env else True
        if ime == "anthropic":
            spreman = _ima_claude_cli()
        if ime == "ollama":
            spreman = True
        out[ime] = {
            "ukljucen": bool(v.get("enabled")),
            "spreman": spreman,
            "kljucVarijabla": env or None,
            "baseUrl": v.get("baseUrl") or None,
            "anthropicCompatible": bool(v.get("anthropicCompatible")),
            "napomena": v.get("_note") or "",
        }
    return out


def _ima_claude_cli() -> bool:
    import shutil
    return shutil.which("claude") is not None


def postavke() -> dict:
    try:
        return {**ZADANE, **json.loads(POSTAVKE.read_text(encoding="utf-8"))}
    except Exception:
        return dict(ZADANE)


def _json(url: str, tijelo=None, metoda=None, rok=20):
    podatci = json.dumps(tijelo).encode() if tijelo is not None else None
    zaglavlja = {"Content-Type": "application/json"} if tijelo is not None else {}
    r = urllib.request.Request(url, podatci, zaglavlja, method=metoda)
    return json.load(urllib.request.urlopen(r, timeout=rok))


def _ucitaj_odgode() -> dict:
    """Odgođeni zadatci: {TASK-ID: {"do": iso, "puta": n}}. Neispravna datoteka = nema odgoda."""
    try:
        d = json.loads(ODGODE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _zapisi_odgode(d: dict) -> None:
    try:
        ODGODE.parent.mkdir(parents=True, exist_ok=True)
        tmp = ODGODE.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(ODGODE)                       # atomično — poluzapisan JSON čita se kao „nema odgoda"
    except Exception:
        pass


def _rok(sati: float) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=sati)).isoformat()


def _odgodi(task_id: str, sati: float) -> int:
    """Zabilježi odgodu i vrati koliko je puta ZAREDOM odgođen."""
    d = _ucitaj_odgode()
    puta = int((d.get(task_id) or {}).get("puta", 0)) + 1
    d[task_id] = {"do": _rok(sati), "puta": puta, "najava": False}
    _zapisi_odgode(d)
    return puta


def _najavi(task_id: str, sati: float) -> str:
    """Zabilježi da je čovjeku dan rok; vrati taj rok (ISO, UTC).

    Vlasnik, 05.09.2026.: „imate x vremena za <sto treba odluciti> odluku inace model xx
    odlucuje za vas." Dok rok traje, model taj zadatak ne dira."""
    d = _ucitaj_odgode()
    zapis = d.get(task_id) or {}
    rok = _rok(sati)
    d[task_id] = {"do": rok, "puta": int(zapis.get("puta", 0)), "najava": True}
    _zapisi_odgode(d)
    return rok


def _vec_najavljen(task_id: str, d: dict) -> bool:
    """Je li čovjek već dobio svoj rok za ovaj zadatak? Rok se daje JEDNOM."""
    return bool((d.get(task_id) or {}).get("najava"))


def _jos_odgodjen(task_id: str, d: dict) -> bool:
    from datetime import datetime, timezone
    zapis = d.get(task_id)
    if not zapis:
        return False
    try:
        return datetime.fromisoformat(str(zapis.get("do"))) > datetime.now(timezone.utc)
    except Exception:
        return False


def _skini_odgodu(task_id: str) -> None:
    d = _ucitaj_odgode()
    if d.pop(task_id, None) is not None:
        _zapisi_odgode(d)


def cekaju(p: dict | None = None) -> list[dict]:
    """Samo zadatci koje odluka DOISTA pušta u rad.

    05.09.2026.: prolaz je trošio model i na zadatke koje i dalje drži nedovršena ovisnost
    (`cekaNa`) — odluka ih ne može pokrenuti, a jedan je zbog toga i pušten prerano.

    Istoga dana izbačeni su i zadatci sa **strojno provjerljivim okidačem** (`okidacStrojni`,
    oznaka `okidac-strojni`): njihovo je stanje izvan dosega ovog alata, pa je svaki sud
    nagađanje. Ovdje se ne troši model na ono što se ne može znati."""
    p = p or {}
    try:
        svi = _json(f"{PLOCA}/api/odluke").get("zadatci", [])
    except Exception as e:
        print(f"ploča ne odgovara: {e}", file=sys.stderr)
        return []
    odgode = _ucitaj_odgode()
    # Zadatak koji je nestao iz reda (čovjek je odlučio, ili je krenuo) ne treba više nositi
    # zapis — inače bi mu stara najava vrijedila i kad se za mjesec dana vrati.
    ziv = {str(z.get("id")) for z in svi}
    if any(k not in ziv for k in list(odgode)):
        odgode = {k: v for k, v in odgode.items() if k in ziv}
        _zapisi_odgode(odgode)
    strojni_prolaze = bool(p.get("pusta_strojni_okidac", False))

    def u_redu(z: dict) -> bool:
        # TASK-5173 (03.10.2026.): JEDAN filtar. Ploča je brojila 3 zadatka „u redu
        # odlučitelja", a ovaj alat je pregledao 0 — svatko je filtrirao po svome. Sad filtar
        # računa poslužitelj (OdlukeRazvrstaj.ts: ovisnost, ljudske oznake, okidac-strojni uz
        # istu sklopku `pusta_strojni_okidac`, odgoda) i šalje ga kao `zaOdlucitelja`; alat
        # ga samo čita. Stari filtar ostaje SAMO za stariju ploču koja polje ne šalje.
        if "zaOdlucitelja" in z:
            return bool(z["zaOdlucitelja"])
        return not z.get("cekaNa") and (strojni_prolaze or not z.get("okidacStrojni"))

    # Odgođen zadatak se NE pita ponovno svakih 5 min — inače bi model svaki put trošio poziv
    # na istu odluku, a odgoda ne bi značila ništa.
    return [z for z in svi
            if u_redu(z)
            and not _jos_odgodjen(str(z.get("id")), odgode)]


def procitaj(odgovor: str) -> str | None:
    """Tolerantno čitanje: traži riječ bilo gdje, ne samo kao prvu.

    Isto pravilo kao kod dežurnog — mjereno je da slab model rado odgovori rečenicom
    („Mislim da treba covjek.") koja je sadržajno točna, pa krivnja za promašaj pada na
    strogo uspoređivanje, ne na model."""
    t = (odgovor or "").lower()
    t = t.replace("čovjek", "covjek").replace("kreće", "kreni")
    nadjene = [(t.find(k), k) for k in RIJECI if k in t]
    return sorted(nadjene)[0][1] if nadjene else None


def kartica(z: dict, p: dict, rizik_naziv: str | None = None, bez_covjeka: bool = False) -> str:
    """Kontekst je namjerno kratak — odluka se donosi o JEDNOM zadatku, bez povijesti.

    `bez_covjeka` je stanje iz vlasnikova naloga (05.09.2026.): „nista ne treba cekati mene ako
    sam odabrao da model odlucuje za mene." Tada model NEMA izlaz `covjek` — dvojba zavrsava
    kao ODGODI, sto je odluka koju stroj moze donijeti sam i koja se poslije sama vraca."""
    if bez_covjeka:
        dopusteno = "kreni / odgodi" if p.get("smije_kreni", True) else "odgodi"
    else:
        dopusteno = "kreni / odgodi / covjek" if p.get("smije_kreni", True) else "odgodi / covjek"
    upozorenje = ""
    if rizik_naziv:
        upozorenje = (
            f"\nPAZI — u opisu je prepoznat rizik: {rizik_naziv}. Zadatak moze trositi novac,\n"
            "nesto obrisati, imati ucinak izvan ovog sustava ili dirati tajne. Pusti ga SAMO ako\n"
            "iz opisa jasno vidis da je taj potez namjeran, ogranicen i povratan. U svakoj dvojbi: odgodi.\n")
    pravila_zavrsetak = (
        "- odgodi biraj kad zadatak trosi novac, nesto brise, ima ucinak izvan ovog sustava,\n"
        "  ili kad iz opisa ne vidis sto se tocno trazi. Odgoda je sigurna: zadatak se vraca kasnije.\n"
        if bez_covjeka else
        "- covjek biraj kad zadatak trosi novac, nesto brise, ima ucinak izvan ovog sustava,\n"
        "  ili kad iz opisa ne vidis sto se tocno trazi. Bolje pitati nego pogoditi.\n")
    return (
        "Odlucujes umjesto korisnika hoce li se ovaj zadatak poceti raditi.\n\n"
        f"ZADATAK {z.get('id')} (prioritet {z.get('priority')}, izvrsitelj {z.get('assignee')},"
        f" ceka {z.get('cekaSati')} h)\n"
        f"NASLOV: {z.get('title')}\n"
        f"OPIS: {str(z.get('description') or '')[:700]}\n"
        f"{upozorenje}\n"
        "PRAVILA:\n"
        "- PRVA rijec tvog odgovora mora biti odluka. Ne pisi nista prije nje.\n"
        "  Zatim novi red i jedna recenica obrazlozenja.\n"
        f"- Dopustene rijeci: {dopusteno}.\n"
        + pravila_zavrsetak +
        "- kreni biraj samo kad je posao jasan i bezopasan.\n"
    )


def kartica_strucnjaka(z: dict, p: dict) -> str:
    """Kartica za zadatak koji nosi STRUKTURIRANO PITANJE (blok „PITANJE ZA ODLUKU").

    Vlasnik, 05.09.2026.: „Uz opcije mora navesti koji strucnjak mu odgovara, tako da ako je
    ukljucen AI odgovor moze znati sto treba." Zato model ovdje ne bira kreni/odgodi nego
    odgovara U ULOZI navedene struke i pokazuje na jednu od ponudjenih opcija — a `covjek`
    mu ostaje otvoren kad ni struka ne razrjesava dilemu.
    """
    q = z.get("pitanje") or {}
    opcije = q.get("opcije") or []
    popis = "\n".join(f"  {o.get('oznaka')}) {o.get('tekst')}" for o in opcije)
    slova = ", ".join(str(o.get("oznaka")) for o in opcije)
    uloga = z.get("ulogaModela") or f"Ti si ekspert za {q.get('ekspert')}."
    preporuka = f"\nAGENT PREPORUCA: {q['preporuka']}\n" if q.get("preporuka") else ""
    return (
        f"{uloga}\n\n"
        f"ZADATAK {z.get('id')}: {z.get('title')}\n"
        f"PITANJE: {q.get('pitanje')}\n\n"
        f"OPCIJE:\n{popis}\n{preporuka}\n"
        "PRAVILA:\n"
        f"- PRVA rijec tvog odgovora mora biti slovo opcije ({slova}) ili rijec covjek.\n"
        "  Zatim novi red i jedna recenica strucnog obrazlozenja.\n"
        "- covjek biraj kad ti struka ne daje prednost nijednoj opciji ili kad odluka trosi\n"
        "  novac, nesto brise ili ima ucinak izvan ovog sustava.\n"
        "- Ne izmisljaj opciju koje nema na popisu.\n"
    )


def procitaj_opciju(odgovor: str, opcije: list[dict]) -> str | None:
    """Vrati oznaku opcije koju je model odabrao, ili None.

    Trazi se slovo kao samostalan znak („B", „B)", „Odgovor: B") — a ne slovo bilo gdje u
    tekstu, jer bi tada svako „A" iz recenice bilo odluka."""
    t = (odgovor or "").strip()
    if not t:
        return None
    dopustena = {str(o.get("oznaka") or "").upper() for o in opcije}
    for m in re.finditer(r"\b([A-Za-z])\s*[\)\.\:,]|^([A-Za-z])\b", t, re.MULTILINE):
        slovo = (m.group(1) or m.group(2) or "").upper()
        if slovo in dopustena:
            return slovo
    return None


def pitaj_model(p: dict, tekst: str) -> str | None:
    """Pošalji pitanje odabranom davatelju. Vraća tekst odgovora ili None.

    None uvijek znači „nije odgovorio" — a pozivatelj to tumači kao „ostaje čovjeku", nikad
    kao „kreni". Tišina nije dopuštenje."""
    ime = str(p.get("provider") or "ollama").lower()
    model = str(p.get("model") or "")
    d = davatelji().get(ime, {})

    if ime == "ollama":
        return _pitaj_ollama(p, tekst)
    if ime == "anthropic":
        return _pitaj_claude_cli(model, tekst)
    if ime == "openrouter":
        return _pitaj_openai_oblik("https://openrouter.ai/api/v1/chat/completions",
                                   _ucitaj_kljuc("OPENROUTER_API_KEY"), model, tekst)
    if ime == "google":
        return _pitaj_google(model, tekst)
    if d.get("anthropicCompatible") and d.get("baseUrl"):
        return _pitaj_anthropic_oblik(str(d["baseUrl"]),
                                      _ucitaj_kljuc(str(d.get("kljucVarijabla") or "")),
                                      model, tekst)
    print(f"davatelj {ime} nije podrzan u odlucitelju", file=sys.stderr)
    return None


def _pitaj_ollama(p: dict, tekst: str) -> str | None:
    tijelo = {
        "model": p["model"], "stream": False, "think": False,
        "options": {"temperature": 0, "num_predict": 80},
        "messages": [{"role": "user", "content": tekst}],
    }
    adresa = p.get('baseUrl') or ollama_url()
    if not adresa:
        print("ollama nije podesena — postavi TM_OLLAMA_URL ili baseUrl u postavkama", file=sys.stderr)
        return None
    try:
        r = urllib.request.Request(f"{adresa}/api/chat",
                                   json.dumps(tijelo).encode(), {"Content-Type": "application/json"})
        odg = json.load(urllib.request.urlopen(r, timeout=180))
        return ((odg.get("message") or {}).get("content") or "").strip() or None
    except Exception as e:
        print(f"ollama ne odgovara: {e}", file=sys.stderr)
        return None


def _pitaj_claude_cli(model: str, tekst: str) -> str | None:
    """Anthropic ide preko Claude CLI-ja jer nemamo API ključ — koristi se pretplata.

    UPOZORENJE koje je ugrađeno namjerno: ovo troši ISTU kvotu koja gasi autonomiju. Odluka
    o zadatku ne smije koštati više od samog zadatka, pa je zadani izbor i dalje lokalni
    model, a Anthropic ima smisla samo kad je odluka teška."""
    import subprocess
    naredba = ["claude", "-p", tekst]
    if model:
        naredba += ["--model", model]
    try:
        pr = subprocess.run(naredba, capture_output=True, timeout=180, text=True)
        return (pr.stdout or "").strip() or None
    except Exception as e:
        print(f"claude CLI ne odgovara: {e}", file=sys.stderr)
        return None


def _pitaj_openai_oblik(url: str, kljuc: str, model: str, tekst: str) -> str | None:
    if not kljuc:
        print("nema ključa za tog davatelja", file=sys.stderr)
        return None
    tijelo = {"model": model, "max_tokens": 500, "temperature": 0,
              "messages": [{"role": "user", "content": tekst}]}
    try:
        r = urllib.request.Request(url, json.dumps(tijelo).encode(),
                                   {"Authorization": "Bearer " + kljuc,
                                    "Content-Type": "application/json"})
        d = json.load(urllib.request.urlopen(r, timeout=120))
        por = (d.get("choices") or [{}])[0].get("message") or {}
        # Neki modeli na OpenRouteru vrate `content: null`, a odgovor stave u `reasoning`
        # (izmjereno na ling-3.0-flash). Bez ovoga bi pao na .strip() nad None i izgledalo
        # bi kao da davatelj ne radi, iako je odgovorio.
        tekst = por.get("content") or por.get("reasoning") or ""
        return str(tekst).strip() or None
    except Exception as e:
        print(f"davatelj ne odgovara: {str(e)[:120]}", file=sys.stderr)
        return None


def _pitaj_anthropic_oblik(baseUrl: str, kljuc: str, model: str, tekst: str) -> str | None:
    """GLM, Kimi, MiniMax, Qwen, DeepSeek — svi nude Anthropicov oblik poruka."""
    if not kljuc:
        print("nema ključa za tog davatelja", file=sys.stderr)
        return None
    tijelo = {"model": model, "max_tokens": 500,
              "messages": [{"role": "user", "content": tekst}]}
    try:
        r = urllib.request.Request(baseUrl.rstrip("/") + "/v1/messages",
                                   json.dumps(tijelo).encode(),
                                   {"x-api-key": kljuc, "anthropic-version": "2023-06-01",
                                    "Content-Type": "application/json"})
        d = json.load(urllib.request.urlopen(r, timeout=120))
        dijelovi = [c.get("text", "") for c in (d.get("content") or []) if c.get("type") == "text"]
        return "\n".join(dijelovi).strip() or None
    except Exception as e:
        print(f"davatelj ne odgovara: {str(e)[:120]}", file=sys.stderr)
        return None


def _pitaj_google(model: str, tekst: str) -> str | None:
    kljuc = _ucitaj_kljuc("GOOGLE_API_KEY")
    if not kljuc:
        print("nema GOOGLE_API_KEY", file=sys.stderr)
        return None
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model or 'gemini-2.0-flash'}:generateContent?key={kljuc}")
    tijelo = {"contents": [{"parts": [{"text": tekst}]}],
              "generationConfig": {"temperature": 0, "maxOutputTokens": 120}}
    try:
        r = urllib.request.Request(url, json.dumps(tijelo).encode(),
                                   {"Content-Type": "application/json"})
        d = json.load(urllib.request.urlopen(r, timeout=120))
        kand = (d.get("candidates") or [{}])[0]
        dijelovi = [x.get("text", "") for x in ((kand.get("content") or {}).get("parts") or [])]
        return "\n".join(dijelovi).strip() or None
    except Exception as e:
        print(f"google ne odgovara: {str(e)[:120]}", file=sys.stderr)
        return None


def obrazlozenje(odgovor: str) -> str:
    redci = [r.strip() for r in (odgovor or "").splitlines() if r.strip()]
    for r in redci[1:]:
        if len(r) > 3:
            return r[:200]
    return redci[-1][:200] if redci else ""


def samostalan(p: dict) -> bool:
    """Odlučuje li model doista UMJESTO čovjeka?

    Vlasnik, 05.09.2026.: „Ali nista ne treba cekati mene ako sam odabrao da model odlucuje za
    mene." Kad je prekidač uključen, `covjek` prestaje biti ishod: dvojba i rizik završavaju
    kao ODGODI. Odgoda je odluka koju stroj smije donijeti sam — zadatak se poslije vrati, a
    ništa ne stoji na čovjeku."""
    return bool(p.get("ukljucen")) and bool(p.get("smije_rizicno", True))


def _predaj_covjeku(z: dict, razlog: str, filtar: str) -> dict:
    return {"id": z["id"], "rijec": "covjek", "razlog": f"traži čovjeka: {razlog}",
            "upisati": False, "filtar": filtar}


def sto_treba_odluciti(z: dict) -> str:
    """Rečenica koja čovjeku kaže O ČEMU odlučuje — bez nje je najava prazna obavijest."""
    q = z.get("pitanje") or {}
    if q.get("pitanje"):
        opcije = q.get("opcije") or []
        popis = "; ".join(f"{o.get('oznaka')}) {o.get('tekst')}" for o in opcije)
        return f"{q['pitanje']}" + (f" — opcije: {popis}" if popis else "")
    return str(z.get("title") or "").strip() or "(zadatak bez naslova)"


def _lokalno(iso: str) -> str:
    """ISO (UTC) → „17:05" po Europe/Zagreb. Sat bez navedene zone je poziv na nesporazum."""
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
        return datetime.fromisoformat(iso).astimezone(ZoneInfo("Europe/Zagreb")).strftime("%H:%M")
    except Exception:
        return iso[11:16]


def opisi_rok(sati: float) -> str:
    if sati >= 1:
        cijeli = int(sati)
        return f"{cijeli} h" if sati == cijeli else f"{sati:g} h"
    return f"{int(round(sati * 60))} min"


def potpis_modela(p: dict) -> str:
    """`openrouter/auto` već nosi davatelja u imenu — „openrouter/openrouter/auto" je šum."""
    davatelj, model = str(p.get("provider") or ""), str(p.get("model") or "")
    return model if (not davatelj or model.startswith(f"{davatelj}/")) else f"{davatelj}/{model}"


def najava_tekst(z: dict, p: dict, rok_iso: str, sati: float) -> str:
    naslov = str(z.get("title") or "")[:80]
    return (f"\u23f3 Ima\u0161 {opisi_rok(sati)} za odluku o {z.get('id')} \u2014 \u201e{naslov}\u201c.\n"
            f"\u0160to treba odlu\u010diti: {sto_treba_odluciti(z)[:400]}\n"
            f"Ako ne odgovori\u0161 do {_lokalno(rok_iso)} (Europe/Zagreb), odlu\u010duje model "
            f"{potpis_modela(p)}.")


def odluci(z: dict, p: dict) -> dict:
    r = rizik(z)
    sam = samostalan(p)

    # NAJAVA PRIJE ODLUKE (vlasnik, 05.09.2026.): „imate x vremena za <sto treba odluciti> odluku
    # inace model xx odlucuje za vas." Rok se daje JEDNOM po zadatku; dok traje, model ga ne
    # dira, a kad istekne, odlučuje bez daljnjeg čekanja.
    if sam and not _vec_najavljen(str(z.get("id")), _ucitaj_odgode()):
        sati = cekanje_sati(p)
        return {"id": z["id"], "rijec": "najava", "upisati": True, "najavaSati": sati,
                "razlog": f"najava: čovjek ima {opisi_rok(sati)} prije nego model odluči"}
    # Vremenski uvjet ide PRIJE rizika i prije modela: pitanje nije je li zadatak opasan nego
    # je li uopće došao na red. Model se o tome ne pita jer odgovor nije u kartici.
    v = vremenski_uvjet(z)
    if v:
        razlog = (f"odgoda: okidač je vremenski (\u201e{v[:60]}\u201c) \u2014 je li rok prošao ne piše u "
                  f"kartici, pa je i \u201ekreni\u201c i \u201eodgodi\u201c nagađanje; zadatak traži oznaku "
                  f"`okidac-strojni` (ADR-0010)")
        if not sam:
            return _predaj_covjeku(z, f"vremenski okidač (\u201e{v[:60]}\u201c)", "vrijeme")
        return {"id": z["id"], "rijec": "odgodi", "filtar": "vrijeme",
                "razlog": razlog, "upisati": True}

    if r and not sam:
        return _predaj_covjeku(z, f"{r} (prepoznato u opisu, model nije ni pitan)", r)
    if premalo_opisa(z):
        # Nejasan opis nije stvar hrabrosti nego podataka — ni model ni čovjek ne mogu
        # procijeniti ono što nije napisano. Kad model odlučuje sam, to je ODGODA.
        if not sam:
            return _predaj_covjeku(z, "opis je prekratak ili bez traga izvedbe", "nejasno")
        return {"id": z["id"], "rijec": "odgodi", "filtar": "nejasno",
                "razlog": "odgoda: opis je prekratak ili bez traga izvedbe (model nije ni pitan)",
                "upisati": True}

    # Zadatak sa strukturiranim pitanjem ide drugim putem: model odgovara U ULOZI struke i
    # bira jednu od ponuđenih opcija.
    q = z.get("pitanje") or {}
    opcije = q.get("opcije") or []
    if len(opcije) >= 2:
        odgovor = pitaj_model(p, kartica_strucnjaka(z, p))
        if not odgovor:
            return {"id": z["id"], "rijec": None, "razlog": "model nije odgovorio", "upisati": False}
        slovo = procitaj_opciju(odgovor, opcije)
        if not slovo or procitaj(odgovor) == "covjek":
            razlog = obrazlozenje(odgovor) or "model nije pokazao ni na jednu opciju"
            if not sam:
                return {"id": z["id"], "rijec": "covjek", "razlog": razlog,
                        "sirovo": odgovor[:160], "upisati": False}
            return {"id": z["id"], "rijec": "odgodi", "filtar": "bez odabira",
                    "razlog": f"odgoda: {razlog}", "sirovo": odgovor[:160], "upisati": True}
        izabrana = next(o for o in opcije if str(o.get("oznaka")).upper() == slovo)
        return {"id": z["id"], "rijec": "opcija", "opcija": slovo,
                "tekstOpcije": str(izabrana.get("tekst") or ""),
                "razlog": obrazlozenje(odgovor), "sirovo": odgovor[:160], "upisati": True}

    odgovor = pitaj_model(p, kartica(z, p, rizik_naziv=r if sam else None, bez_covjeka=sam))
    if not odgovor:
        # Model ne odgovara → NE pretpostavlja se „kreni": tišina je razlog za oprez, ne za rad
        # (isto pravilo kao kod vrata autonomije). Kad model odlučuje sam, tišina je odgoda —
        # zadatak se vraća u sljedeći prolaz, ali ne pada na čovjeka.
        if not sam:
            return {"id": z["id"], "rijec": None, "razlog": "model nije odgovorio", "upisati": False}
        return {"id": z["id"], "rijec": "odgodi", "filtar": "bez odgovora",
                "razlog": "odgoda: model nije odgovorio", "upisati": True}
    rijec = procitaj(odgovor)
    if rijec == "kreni" and not p.get("smije_kreni", True):
        rijec = "odgodi" if sam else "covjek"
    if rijec == "covjek" and sam:
        # Model je ipak posegnuo za „covjek" — ta riječ ovdje ne postoji, pa je to odgoda.
        rijec = "odgodi"
    if rijec is None and sam:
        rijec = "odgodi"
    ishod = {"id": z["id"], "rijec": rijec, "razlog": obrazlozenje(odgovor),
             "sirovo": odgovor[:160], "upisati": rijec in ("kreni", "odgodi")}
    if r:
        # Rizik ostaje zapisan i kad ga je model pustio — da se poslije zna ŠTO je pušteno.
        ishod["filtar"] = r
        ishod["rizikPusten"] = (rijec == "kreni")
    return ishod


def upisi(z: dict, o: dict, p: dict) -> str:
    """Odluka ide istim putem kojim je donosi i čovjek — /api/tasks/<ID>/odluka."""
    # Najava NIJE odluka: zadatak se ne dira, samo se zabilježi rok i pripremi poruka koju
    # daemon šalje u konzolu i na Telegram.
    if o["rijec"] == "najava":
        sati = float(o.get("najavaSati") or cekanje_sati(p))
        rok = _najavi(z["id"], sati)
        o["najavaDo"] = rok
        o["najavaTekst"] = najava_tekst(z, p, rok, sati)
        o["javiti"] = True
        return "najavljeno"

    potpis = potpis_modela(p)
    if o["rijec"] == "opcija":
        # Puna rečenica, ne samo slovo: opcije žive u opisu, a opis se mijenja — za pola
        # godine bi „B" bilo nečitljivo.
        tekst = f"{o['opcija']}) {o['tekstOpcije']} — {o['razlog']}"
    elif o["rijec"] == "kreni":
        tekst = f"KRENI — {o['razlog']}"
    else:
        tekst = f"ODGODI — {o['razlog']}"
    try:
        _json(f"{PLOCA}/api/tasks/{z['id']}/odluka",
              {"odluka": tekst, "by": f"odlucitelj ({potpis})"}, "POST")
    except urllib.error.HTTPError as e:
        return f"nije upisano (HTTP {e.code})"
    except Exception as e:
        return f"nije upisano ({e})"

    # Odgoda mora imati rok, inače bi se isti zadatak pitao svakih 5 min i odgoda ne bi
    # značila ništa. Nakon N uzastopnih odgoda javlja se vlasniku — ali zadatak i dalje NE
    # čeka njega, nego se sam vraća u sljedeći prolaz.
    if o["rijec"] == "odgodi":
        # ISTI broj kao i rok koji dobiva čovjek (`cekanje_sati`, zadano 1 h). Do 05.09.2026.
        # ovdje je stajalo `p.get("odgoda_sati", 4)`: polje „čekanje (h)" na ploči pisalo je
        # `cekanje_sati`, pa odgoda nije slušala ništa — ostajala je na 4 h koje nitko nije
        # tražio. Postavka koju gumb ne pomiče je isti kvar kao prekidač bez pogona.
        sati = cekanje_sati(p)
        puta = _odgodi(z["id"], sati)
        o["odgodaPuta"] = puta
        o["odgodaSati"] = sati
        if puta >= int(p.get("odgode_prije_javke", 3)):
            o["javiti"] = True
    else:
        _skini_odgodu(z["id"])
    return "upisano"


def main() -> int:
    a = argparse.ArgumentParser()
    a.add_argument("--izvrsi", action="store_true", help="doista upiši odluke")
    a.add_argument("--proba", action="store_true", help="samo pokaži (zadano)")
    a.add_argument("--zadatak", help="samo jedan zadatak")
    a.add_argument("--json", action="store_true")
    n = a.parse_args()

    p = postavke()
    if n.izvrsi and not p.get("ukljucen"):
        print("odlucitelj je iskljucen u postavkama (config/odlucitelj.json) — ne upisujem nista")
        return 3

    popis = cekaju(p)
    if n.zadatak:
        popis = [z for z in popis if z.get("id") == n.zadatak]
    popis = popis[: int(p.get("najvise_po_prolazu", 3))]
    if not popis:
        # `--json` MORA ostati JSON i kad nema posla: pozivatelj (OdluciteljPogon) tekstualni
        # ispis čita kao grešku, pa je prazan red 05.09.2026. na ploči izgledao kao „odlučitelj
        # je pao".
        print("[]" if n.json else "nema zadataka koji cekaju odluku")
        return 0

    ishodi = []
    for z in popis:
        o = odluci(z, p)
        o["naslov"] = str(z.get("title") or "")[:52]
        if n.izvrsi and o["upisati"]:
            o["ishod"] = upisi(z, o, p)
        ishodi.append(o)

    if n.json:
        print(json.dumps(ishodi, ensure_ascii=False, indent=1))
        return 0
    for o in ishodi:
        rijec = (f"OPCIJA {o['opcija']}" if o["rijec"] == "opcija"
                 else (o["rijec"] or "bez odluke").upper())
        print(f"{o['id']:10} {rijec:11} {o.get('ishod', 'proba')}  {o['naslov']}")
        if o["razlog"]:
            print(f"           {o['razlog'][:96]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
