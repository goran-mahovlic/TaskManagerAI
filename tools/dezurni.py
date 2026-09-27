#!/usr/bin/env python3
"""dezurni.py — rezervni (fallback) agent kad primarni model padne.

Goran, 04.09.2026.: „model mora provjeriti stvarno stanje na Anthropicu — a ne da mi kaže da
ja provjerim. Mora dobiti točnu informaciju radi li sustav i što ne radi. Mora se predstaviti
korisniku, reći što se dogodilo, zašto se javio i da će javiti kad može nastaviti, pa pokrenuti
skriptu koja svakih pola sata provjerava. Kad se sustav oporavi, javi na Telegram."

ZAMISAO: dežurni model NE piše naredbe, NE istražuje i NE zaključuje sam. Skripta izmjeri
stanje i **napiše gotov tekst**; model ga samo pošalje ili prepriča. Time nestaje najveći
izvor grešaka slabih modela.

ZAŠTO NE status.anthropic.com: ta je stranica iza AWS WAF-a („Human Verification") i blokira
i nas i Pi — provjereno 04.09.2026. Umjesto nje mjerimo tri stvari koje su nam dostupne i
zapravo su točnije, jer govore o NAŠEM pristupu, a ne o prosjeku svih korisnika:

    1. mreža do Anthropica — POST api.anthropic.com/v1/messages bez ključa; očekuje se brzi
       401. 401 = njihova strana radi. 5xx ili istek roka = kvar kod njih.
    2. naša kvota i prijava — data/session_usage.cache.json: status, http_error i, najvažnije,
       session_reset_at / weekly_reset_at (odatle točan sat oporavka).
    3. naš put — probni poziv `claude -p` i rade li daemon, ploča i Telegram.

    python3 tools/dezurni.py kartica   # kontekst za model (kratak)
    python3 tools/dezurni.py stanje    # radi li sustav i ŠTO ne radi
    python3 tools/dezurni.py zasto     # zadnjih pet redaka greške
    python3 tools/dezurni.py probaj    # jedan probni poziv primarnog modela
    python3 tools/dezurni.py podigni   # restart daemona i ploče
    python3 tools/dezurni.py javi ["tekst"]   # bez teksta: šalje gotovu obavijest
    python3 tools/dezurni.py straza    # svakih 30 min provjeri; javi kad se oporavi
    python3 tools/dezurni.py proba     # probni poziv DEZURNOG modela (koji god davatelj)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path.home()
ZONA = ZoneInfo("Europe/Zagreb")
PLOCA = "http://localhost:17781"
DNEVNIK = HOME / ".claude/regoc/daemon.log"
KES_KVOTE = HOME / ".claude/regoc/data/session_usage.cache.json"
PUTOVI_SERVISA = [                      # glavni stroj, pa čvorovi (RegocMobile)
    (HOME / "app/regoc_system/regoc-services.sh", ["restart-service", "{s}"]),
    (HOME / ".claude/regoc/manage.sh", ["restart"]),
    (HOME / "tmai_start.sh", []),
]
# Bilo ~/.tmp/regoc_send.py — ~/.tmp se čisti, pa je slanje šutke nestalo. TM_TELEGRAM_SEND ima prednost.
PUTOVI_SLANJA = [Path(os.environ.get("TM_TELEGRAM_SEND") or HOME / ".claude/regoc/tools/telegram_send_text.py")]
POSTAVKE = HOME / ".claude/regoc/config/dezurni.json"
STANJE_STRAZE = HOME / ".claude/regoc/data/dezurni.straza.json"

ZADANE_POSTAVKE = {
    "provider": "ollama",
    "model": "qwen3:8b",
    "baseUrl": "http://192.168.10.4:11434",
    "okidac_uzastopnih_gresaka": 2,
    "smije_podici": True,
    "razmak_straze_min": 30,
}


def postavke() -> dict:
    try:
        return {**ZADANE_POSTAVKE, **json.loads(POSTAVKE.read_text(encoding="utf-8"))}
    except Exception:
        return dict(ZADANE_POSTAVKE)


# ── Davatelji dežurnog (TASK-4709) ───────────────────────────────────────────────────────
# Goran, 06.09.2026.: „config stranica nudi samo Ollamu, a ne sve providere iz
# model-config.json." Uzrok nije bio popis nego most: znao je samo Ollamin `/api/chat`.
#
# Ovdje je ISTO pravilo kao u `tools/Telegram/dezurni.ts` (`NACIN_POZIVA_MOSTA`), jer isti
# posao rade dva jezika — TS most odgovara na Telegramu, a ova skripta mjeri stanje i služi
# kao provjera s ploče (`proba`). Kad se jedan promijeni, mora i drugi; brana je test
# `DezurniDavatelji.test.ts → BRANA` na TS strani i `proba` ovdje.
#
# Ključ se čita iz okoline pa iz spremišta, ide SAMO u zaglavlje zahtjeva i nikad u ispis.
KONFIG_MODELA = HOME / ".claude/regoc/models/model-config.json"
CREDENTIALS = Path(os.environ.get("REGOC_CREDENTIALS_PATH")
                   or (HOME / ".claude/regoc/credentials.env"))

NACIN_PO_IMENU = {
    "ollama": "ollama",
    "anthropic": "claude-cli",   # pretplata preko `claude -p`, ne API ključ
    "openrouter": "openai",
    "openai": "openai",
    "google": "google",
}


def _ucitaj_kljuc(ime: str) -> str:
    if not ime:
        return ""
    if os.environ.get(ime):
        return os.environ[ime]
    try:
        for red in CREDENTIALS.read_text(encoding="utf-8").splitlines():
            red = red.strip()
            if red.startswith("#") or not red.startswith(f"{ime}="):
                continue
            v = red.split("=", 1)[1].strip().strip("\"'")
            if v:
                return v
    except Exception:
        pass
    return ""


def _konf_davatelja(ime: str) -> dict:
    try:
        return json.loads(KONFIG_MODELA.read_text(encoding="utf-8")).get(
            "providers", {}).get(ime, {}) or {}
    except Exception:
        return {}


def nacin_za(ime: str, konf: dict) -> str | None:
    """Koji oblik poziva vrijedi za davatelja. None = most ga ne zna pozvati."""
    n = NACIN_PO_IMENU.get(str(ime).lower())
    if n:
        return n
    if konf.get("anthropicCompatible") and konf.get("baseUrl"):
        return "anthropic"
    return None


def _http_json(url: str, tijelo: dict, zaglavlja: dict, rok: int = 120):
    zahtjev = urllib.request.Request(
        url, json.dumps(tijelo).encode(), {"Content-Type": "application/json", **zaglavlja})
    return json.load(urllib.request.urlopen(zahtjev, timeout=rok))


def pitaj_model(kartica: str, pitanje: str, tokena: int = 200, p: dict | None = None) -> str | None:
    """Pošalji pitanje davatelju iz postavki. None = nije odgovorio.

    None NIKAD ne smije postati tihi pad na Ollamu: korisnik bi dobio tuđi odgovor pod
    potpisom davatelja kojeg je izabrao."""
    p = p or postavke()
    ime = str(p.get("provider") or "ollama").lower()
    model = str(p.get("model") or "")
    konf = _konf_davatelja(ime)
    nacin = nacin_za(ime, konf)
    if not nacin:
        print(f"most dezurnog ne zna pozvati davatelja {ime}", file=sys.stderr)
        return None
    try:
        if nacin == "ollama":
            d = _http_json(f"{p.get('baseUrl') or ZADANE_POSTAVKE['baseUrl']}/api/chat", {
                "model": model, "stream": False, "think": False,
                "options": {"temperature": 0, "num_predict": tokena},
                "messages": [{"role": "system", "content": kartica},
                             {"role": "user", "content": pitanje}],
            }, {})
            return ((d.get("message") or {}).get("content") or "").strip() or None

        if nacin == "claude-cli":
            naredba = ["claude", "-p", f"{kartica}\n\n{pitanje}"]
            if model:
                naredba += ["--model", model]
            pr = subprocess.run(naredba, capture_output=True, timeout=180, text=True)
            izlaz = (pr.stdout or "").strip()
            # Hook-blokada izlazi s exit 0 i vrati prompt — to nije odgovor modela.
            if "operation blocked by hook:" in izlaz.lower():
                return None
            return izlaz or None

        if nacin == "openai":
            url = ("https://openrouter.ai/api/v1/chat/completions" if ime == "openrouter"
                   else "https://api.openai.com/v1/chat/completions")
            kljuc = _ucitaj_kljuc("OPENROUTER_API_KEY" if ime == "openrouter" else "OPENAI_API_KEY")
            if not kljuc:
                print("nema kljuca za tog davatelja", file=sys.stderr)
                return None
            d = _http_json(url, {
                "model": model, "max_tokens": tokena, "temperature": 0,
                "messages": [{"role": "system", "content": kartica},
                             {"role": "user", "content": pitanje}],
            }, {"Authorization": "Bearer " + kljuc})
            por = (d.get("choices") or [{}])[0].get("message") or {}
            return str(por.get("content") or por.get("reasoning") or "").strip() or None

        if nacin == "anthropic":
            env = str(konf.get("apiKey") or "")
            kljuc = _ucitaj_kljuc(env[4:] if env.startswith("env:") else "")
            if not kljuc:
                print("nema kljuca za tog davatelja", file=sys.stderr)
                return None
            d = _http_json(str(konf["baseUrl"]).rstrip("/") + "/v1/messages", {
                "model": model, "max_tokens": tokena, "system": kartica,
                "messages": [{"role": "user", "content": pitanje}],
            }, {"x-api-key": kljuc, "anthropic-version": "2023-06-01"})
            dijelovi = [c.get("text", "") for c in (d.get("content") or [])
                        if c.get("type") == "text"]
            return "\n".join(dijelovi).strip() or None

        if nacin == "google":
            kljuc = _ucitaj_kljuc("GOOGLE_API_KEY")
            if not kljuc:
                print("nema GOOGLE_API_KEY", file=sys.stderr)
                return None
            url = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   f"{model or 'gemini-2.0-flash'}:generateContent?key={kljuc}")
            d = _http_json(url, {
                "systemInstruction": {"parts": [{"text": kartica}]},
                "contents": [{"parts": [{"text": pitanje}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": tokena},
            }, {})
            kand = (d.get("candidates") or [{}])[0]
            dijelovi = [x.get("text", "") for x in ((kand.get("content") or {}).get("parts") or [])]
            return "\n".join(dijelovi).strip() or None
    except Exception as e:
        print(f"davatelj ne odgovara: {str(e)[:160]}", file=sys.stderr)
        return None
    return None


def proba() -> str:
    """Probni poziv trenutačno postavljenog dežurnog — jedini dokaz da izbor stvarno radi.

    Popis davatelja koji nudi nekoga koga most ne može dozvati gori je od popisa s jednim
    davateljem, jer se laž otkrije tek u kvaru. Zato ovo mora biti pokretljivo rukom."""
    p = postavke()
    ime = str(p.get("provider") or "ollama").lower()
    nacin = nacin_za(ime, _konf_davatelja(ime))
    if not nacin:
        return f"NE RADI: most dezurnog ne zna pozvati davatelja {ime}"
    t0 = time.time()
    # 200 tokena, ne 40: modeli koji „misle naglas" potrose mali proracun na razmisljanje i
    # vrate prazan sadrzaj — probni poziv bi ispao neuspjesan iako davatelj radi.
    o = pitaj_model("Ti si dezurni agent. Odgovaraj kratko.",
                    "Odgovori jednom rijecju: radi.", 200, p)
    ms = int((time.time() - t0) * 1000)
    if not o:
        return f"NE RADI: {ime}/{p.get('model')} (oblik {nacin}) nije odgovorio nakon {ms} ms"
    return f"RADI: {ime}/{p.get('model')} (oblik {nacin}) odgovorio za {ms} ms: {o[:200]}"


def _sat(iso: str | None) -> str:
    """ISO -> „18:00 (Europe/Zagreb)". Sat se UVIJEK ispisuje sa zonom: kontejner je UTC,
    pa je „reset u 16:00" već jednom pročitano kao dva sata ranije nego što jest."""
    if not iso:
        return "nepoznato"
    try:
        t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZONA)
        preostalo = t - dt.datetime.now(dt.timezone.utc)
        m = int(preostalo.total_seconds() // 60)
        za = f", za {m // 60} h {m % 60} min" if m > 60 else (f", za {m} min" if m > 0 else "")
        return f"{t:%H:%M} (Europe/Zagreb){za}"
    except Exception:
        return str(iso)


def _proces_zivi(uzorak: str) -> bool:
    try:
        return subprocess.run(["pgrep", "-f", uzorak], capture_output=True,
                              timeout=8).returncode == 0
    except Exception:
        return False


def _ploca_radi() -> bool:
    try:
        urllib.request.urlopen(f"{PLOCA}/health", timeout=6)
        return True
    except Exception:
        return False


def anthropic() -> dict:
    """Radi li Anthropicova strana. Poziv bez ključa mora vratiti 401 — to je dokaz da
    poslužitelj odgovara. 5xx ili istek roka znači kvar kod njih.

    Kad poziv padne mrežnom greškom, provjerava se kontrolni host: ako ni on ne odgovara,
    problem je u našoj mreži, a ne kod Anthropica. Čvorovi (RegocMobile) nemaju izlaz na
    internet, pa bi bez ove razlike dežurni ondje uvijek krivo optuživao Anthropica."""
    zahtjev = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", b"{}",
        {"content-type": "application/json"}, method="POST")
    poceo = time.time()
    try:
        urllib.request.urlopen(zahtjev, timeout=8)
        return {"radi": True, "kod": 200, "opis": "odgovara"}
    except urllib.error.HTTPError as e:
        ms = int((time.time() - poceo) * 1000)
        if e.code < 500:
            return {"radi": True, "kod": e.code, "opis": f"odgovara ({e.code} za {ms} ms)"}
        return {"radi": False, "kod": e.code, "opis": f"kvar kod Anthropica (HTTP {e.code})"}
    except Exception as e:
        if not _ima_interneta():
            return {"radi": False, "kod": None, "mreza": True,
                    "opis": "ovaj stroj nema izlaz na internet"}
        return {"radi": False, "kod": None, "opis": f"nema odgovora ({type(e).__name__})"}


def _ima_interneta() -> bool:
    """Kontrolni host: odgovara li išta izvana."""
    for url in ("https://example.com", "https://cloudflare.com"):
        try:
            urllib.request.urlopen(url, timeout=4)
            return True
        except urllib.error.HTTPError:
            return True          # odgovorio je, makar greskom — mreza radi
        except Exception:
            continue
    return False


def kvota() -> dict:
    try:
        k = json.loads(KES_KVOTE.read_text(encoding="utf-8"))
        u = k.get("entry", {})
        u["_star_min"] = int((time.time() - k.get("cached_at", 0)) / 60)
        return u
    except Exception:
        return {}


def dijagnoza() -> dict:
    """Jedan uzrok, jedna rečenica što ne radi, i kad se očekuje oporavak.
    Redoslijed ide izvana prema unutra: tuđi kvar, pa naša kvota, pa naš softver."""
    a, k = anthropic(), kvota()
    provjere = [f"Anthropic: {a['opis']}"]
    if k:
        provjere.append(
            f"kvota: sesija {k.get('session_percent')} %, tjedan {k.get('weekly_percent')} %"
            f" (mjereno prije {k.get('_star_min')} min)")
    else:
        provjere.append("kvota: nema mjerenja")

    if not a["radi"] and a.get("mreza"):
        return {"radi": False, "uzrok": "nema_mreze",
                "sto": "Ovaj stroj nema izlaz na internet, pa ne može do Anthropica. "
                       "Kvar je u našoj mreži, ne kod Anthropica.",
                "oporavak": "čim se vrati mrežni izlaz; provjeravam svakih 30 minuta",
                "provjere": provjere}
    if not a["radi"]:
        return {"radi": False, "uzrok": "anthropic",
                "sto": "Anthropicova usluga ne odgovara — kvar je na njihovoj strani, ne kod nas.",
                "oporavak": "čim oni poprave; provjeravam svakih 30 minuta",
                "provjere": provjere}

    if str(k.get("http_error") or "").startswith("401") or k.get("status") == "unauthorized":
        return {"radi": False, "uzrok": "prijava",
                "sto": "Naša prijava na Anthropic je istekla (401). Anthropic radi, mi nemamo pristup.",
                "oporavak": "čim se prijava obnovi (`claude login`); pokušavam sam svakih 30 min",
                "provjere": provjere}

    tjedan, sesija = k.get("weekly_percent") or 0, k.get("session_percent") or 0
    if k.get("status") == "rejected" or tjedan >= 90:
        return {"radi": False, "uzrok": "tjedna_kvota",
                "sto": f"Potrošena je tjedna kvota ({tjedan} %). Anthropic radi, ali nas odbija.",
                "oporavak": f"obnova tjedne kvote u {_sat(k.get('weekly_reset_at'))}",
                "provjere": provjere}
    if sesija >= 95:
        return {"radi": False, "uzrok": "sesijska_kvota",
                "sto": f"Potrošena je kvota ove sjednice ({sesija} %).",
                "oporavak": f"sjednica se obnavlja u {_sat(k.get('session_reset_at'))}",
                "provjere": provjere}

    pali = [ime for ime, ziv in (("daemon", _proces_zivi("RegocDaemon.ts")),
                                 ("ploča", _ploca_radi()),
                                 ("Telegram", _proces_zivi("telegram_agent.ts"))) if not ziv]
    provjere.append("servisi: " + ("svi rade" if not pali else "NE RADE: " + ", ".join(pali)))
    if pali:
        return {"radi": False, "uzrok": "nasi_servisi",
                "sto": "Anthropic i kvota su u redu, ali kod nas ne radi: " + ", ".join(pali) + ".",
                "oporavak": "mogu odmah pokušati podići — tipka `podigni`",
                "provjere": provjere}

    return {"radi": True, "uzrok": "nema", "sto": "Sve radi.",
            "oporavak": "", "provjere": provjere}


def stanje() -> str:
    d = dijagnoza()
    r = ["SUSTAV RADI" if d["radi"] else "SUSTAV NE RADI", d["sto"]]
    if d["oporavak"]:
        r.append("oporavak: " + d["oporavak"])
    r += ["", "provjereno:"] + ["  " + p for p in d["provjere"]]
    return "\n".join(r)


def obavijest() -> str:
    """Gotov tekst za korisnika — model ga ne sastavlja, samo šalje."""
    d = dijagnoza()
    if d["radi"]:
        return ("Sustav je ponovno u pogonu — možete nastaviti s radom.\n"
                "Javlja dežurni; primarni model opet odgovara.")
    return (
        "Javlja se dežurni agent (rezervni model).\n\n"
        f"Što se dogodilo: {d['sto']}\n"
        f"Zašto se javljam: primarni model trenutačno ne može odgovarati, pa umjesto njega "
        f"privremeno odgovaram ja.\n"
        f"Kada dalje: {d['oporavak'] or 'čim se sustav vrati'}. "
        f"Provjeravam svakih 30 minuta i javit ću vam čim se može nastaviti s radom.")


def zasto() -> str:
    if not DNEVNIK.exists():
        return "nema dnevnika daemona"
    uzorak = re.compile(r"error|greska|greška|429|401|rejected|failed|BLOKIRAM|Unable", re.I)
    nadjeno = []
    try:
        with DNEVNIK.open(encoding="utf-8", errors="replace") as fh:
            for red in fh:
                if uzorak.search(red):
                    nadjeno.append(red.strip()[:160])
    except Exception as e:
        return f"dnevnik se ne da citati: {e}"
    return "\n".join(nadjeno[-5:]) if nadjeno else "u dnevniku nema zapisa greske"


def probaj() -> str:
    try:
        p = subprocess.run(
            ["claude", "-p", "odgovori samo rijecju: ok", "--model", "claude-haiku-4-5-20251001"],
            capture_output=True, timeout=90, text=True)
        izlaz = (p.stdout or "").strip()
        if p.returncode == 0 and izlaz:
            return f"primarni model RADI (odgovor: {izlaz[:60]})"
        greska = (p.stderr or "").strip()[:180] or "prazan izlaz, bez poruke"
        return f"primarni model NE RADI (izlazni kod {p.returncode}): {greska}"
    except FileNotFoundError:
        return "primarni model NE RADI: nema naredbe `claude` na ovom stroju"
    except subprocess.TimeoutExpired:
        return "primarni model NE RADI: nema odgovora ni nakon 90 sekundi"
    except Exception as e:
        return f"primarni model NE RADI: {e}"


def podigni() -> str:
    """Restart onime što na ovom stroju postoji, pa DOKAZ da je uspjelo.

    Dvije zamke, obje izmjerene na node-B 04.09.2026.:
      * `bun` nije u PATH-u ne-interaktivne ljuske, pa skripte pucaju s „command not found";
        zato se PATH dopunjuje ovdje.
      * `manage.sh` vraća izlazni kod 0 i kad ništa nije napravio — pa se ne vjeruje kodu
        nego se stanje mjeri prije i poslije. Dežurni ne smije tvrditi da je podigao sustav
        ako nije."""
    if not postavke().get("smije_podici", True):
        return "podizanje je iskljuceno u postavkama (dezurni.json)"
    stanje_prije = dijagnoza()
    if stanje_prije["radi"]:
        return "Ne podizem servise: sustav radi. " + stanje_prije["sto"]
    if stanje_prije["uzrok"] in ("nema_mreze", "anthropic", "tjedna_kvota", "sesijska_kvota",
                                "prijava"):
        return ("Ne podizem servise: uzrok nije kod nas.\n" + stanje_prije["sto"] +
                "\nRestart to ne rjesava, a prekinuo bi tekuci posao.")
    nadjene = [(p, a) for p, a in PUTOVI_SERVISA if p.exists()]
    if not nadjene:
        return "na ovom stroju nema skripte za podizanje servisa"

    prije = stanje_prije
    okolina = {**os.environ,
               "PATH": f"{HOME}/.bun/bin:{HOME}/.local/bin:" + os.environ.get("PATH", "")}
    glavna = [(p, a) for p, a in nadjene if "{s}" in " ".join(a)]
    ishodi = []
    for put, obrazac in (glavna or nadjene):
        mete = ("daemon", "taskwebui") if "{s}" in " ".join(obrazac) else (None,)
        for servis in mete:
            args = [a.format(s=servis) for a in obrazac] if servis else obrazac
            ime = servis or put.name
            try:
                p = subprocess.run(["bash", str(put), *args], capture_output=True,
                                   timeout=25, text=True, env=okolina, cwd=str(put.parent))
                greska = (p.stderr or "").strip()
                if p.returncode != 0 or "command not found" in greska or "No such file" in greska:
                    ishodi.append(f"{ime}: NIJE USPJELO — {greska.splitlines()[-1][:70]}"
                                  if greska else f"{ime}: NIJE USPJELO (kod {p.returncode})")
                else:
                    zadnji = [r for r in (p.stdout or "").splitlines() if r.strip()]
                    ishodi.append(f"{ime}: {zadnji[-1][:70] if zadnji else 'pokrenuto'}")
            except subprocess.TimeoutExpired:
                # Skripta koja ne zavrsava nije nuzno neuspjeh — `manage.sh restart` drzi
                # proces, a posao je obavljen. Ishod ce reci mjerenje, ne izlazni kod.
                ishodi.append(f"{ime}: pokrenuto (skripta ne zavrsava sama)")
            except Exception as e:
                ishodi.append(f"{ime}: NIJE USPJELO ({e})")

    time.sleep(5)
    poslije = dijagnoza()
    if poslije["radi"] and not prije["radi"]:
        ishod = "USPJELO — sustav sada radi."
    elif poslije["radi"]:
        ishod = "sustav radi (i prije je radio)."
    else:
        ishod = "NIJE POMOGLO — i dalje: " + poslije["sto"]
    return "\n".join(ishodi) + "\n\n" + ishod + "\n\n" + stanje()


def javi(poruka: str = "") -> str:
    alat = next((p for p in PUTOVI_SLANJA if p.exists()), None)
    if not alat:
        return "na ovom stroju nema alata za slanje na Telegram (poruka nije poslana)"
    try:
        p = subprocess.run(["python3", str(alat), poruka or obavijest()],
                           capture_output=True, timeout=40, text=True)
        return "poruka poslana" if p.returncode == 0 else \
            f"slanje nije uspjelo: {(p.stderr or '')[:120]}"
    except Exception as e:
        return f"slanje nije uspjelo: {e}"


def straza(razmak_min: int | None = None, najvise_sati: int = 24) -> str:
    """Svakih pola sata provjeri je li se sustav vratio; kad jest — javi i stani.

    Oporavak traži DVIJE uzastopne uspješne provjere. Jedan uspjeh je premalo: upravo nas je
    takav fail-open već koštao rafala spawnova."""
    razmak = (razmak_min or postavke().get("razmak_straze_min", 30)) * 60
    kraj = time.time() + najvise_sati * 3600
    uspjeha, krugova = 0, 0
    while time.time() < kraj:
        krugova += 1
        d = dijagnoza()
        uspjeha = uspjeha + 1 if d["radi"] else 0
        STANJE_STRAZE.parent.mkdir(parents=True, exist_ok=True)
        STANJE_STRAZE.write_text(json.dumps({
            "provjereno": dt.datetime.now(ZONA).isoformat(timespec="seconds"),
            "radi": d["radi"], "uzrok": d["uzrok"], "sto": d["sto"],
            "uzastopnih_uspjeha": uspjeha, "krugova": krugova}, ensure_ascii=False, indent=1),
            encoding="utf-8")
        if uspjeha >= 2:
            javi()
            return f"sustav se oporavio nakon {krugova} provjera; korisnik obaviješten"
        time.sleep(razmak)
    javi(f"Dežurni: sustav se nije oporavio ni nakon {najvise_sati} h. Zadnji nalaz: "
         f"{dijagnoza()['sto']}")
    return f"nema oporavka ni nakon {najvise_sati} h; korisnik obaviješten"


def kartica() -> str:
    """Kontekst dežurnog. Namjerno ima samo TRI tipke: mjereno na qwen3:8b, sa šest tipki
    pogodak pada na 2/5 jer se `javi`/`straza` i `stanje`/`probaj` preklapaju. Obavijest
    korisniku, probni poziv i provjeru svakih pola sata pokreće okidač sam — to nije izbor
    koji se prepušta modelu.

    Uvod se mijenja prema izmjerenom stanju. Prva izvedba je i kad sve radi tvrdila „primarni
    model ne radi", pa je model tu proturječnost popunio izmišljenim satom oporavka
    („Rad možete nastaviti u 09:00") — kartica koja laže tjera model da halucinira."""
    p, d = postavke(), dijagnoza()
    uvod = ("TI SI DEZURNI AGENT. Sustav trenutacno RADI normalno.\n"
            if d["radi"] else
            "TI SI DEZURNI AGENT. Primarni model ne radi; ti privremeno odgovaras korisniku.\n")
    return (
        uvod + f"Vozi te {p['provider']}/{p['model']}.\n\n"
        "IZMJERENO STANJE — ovo je vec provjereno i tocno:\n"
        f"  {d['sto']}\n"
        + (f"  Rad se moze nastaviti: {d['oporavak']}.\n" if d["oporavak"] else "") + "\n"
        "KAKO ODGOVARAS KORISNIKU:\n"
        "- Predstavi se kao dezurni i reci sto se dogodilo.\n"
        + ("- Kad korisnik pita kada moze nastaviti, ponovi cijeli redak odozgo koji to\n"
           "  govori, sa satom i zonom.\n" if d["oporavak"] else
           "- Sustav radi. Ne spominji nikakvo vrijeme ni sat.\n") +
        "- Reci da ces javiti cim se moze nastaviti s radom.\n"
        "- Kratko, na hrvatskom. Nista ne izmisljaj i ne trazi da korisnik sam provjerava.\n\n"
        "AKO TREBAS ALAT, napisi TOCNO jednu od ove tri rijeci:\n"
        "stanje  = ponovno izmjeri sto radi a sto ne\n"
        "zasto   = zadnjih pet redaka greske iz dnevnika\n"
        "podigni = ponovno pokreni daemon i plocu\n")


TIPKE = {"stanje": stanje, "zasto": zasto, "probaj": probaj, "podigni": podigni,
         "kartica": kartica, "obavijest": obavijest, "proba": proba,
         "straza": lambda: straza()}


def main() -> int:
    if len(sys.argv) < 2:
        print(kartica())
        return 0
    tipka = sys.argv[1].strip().lower()
    if tipka == "javi":
        print(javi(" ".join(sys.argv[2:])))
        return 0
    fn = TIPKE.get(tipka)
    if not fn:
        print("nepoznata tipka. dopustene: " + ", ".join(list(TIPKE) + ["javi"]))
        return 2
    print(fn())
    return 0


if __name__ == "__main__":
    sys.exit(main())
