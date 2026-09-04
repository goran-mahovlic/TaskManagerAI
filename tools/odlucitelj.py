#!/usr/bin/env python3
"""odlucitelj.py — model odlučuje umjesto korisnika o zadatcima koji čekaju odluku.

Goran, 04.09.2026.: „dodao bi switch i odabir modela koji se moze koristiti umjesto odluke
korisnika. Tipa da kada je odabran neki od nasih dostupnih modela onda oni odluce umjesto
korisnika."

ZAMISAO je ista kao kod dežurnog: model NE piše naredbe i NE mijenja zadatke. Bira **jednu od
tri riječi**, a upis radi ova skripta preko istoga API-ja kojim odluku donosi i čovjek. Zbog
toga je svejedno je li odlučio čovjek ili model — trag je jednak, samo se vidi tko je potpisan.

    KRENI    — zadatak je jasan i može se raditi
    ODGODI   — nije sada na redu; ostaje čekati
    COVJEK   — traži Goranovu prosudbu (novac, brisanje, vanjski učinak, nejasan opseg)

`COVJEK` je namjerno lak izlaz. Model koji ne smije reći „ne znam" počne izmišljati, a ovdje
izmišljanje znači pokrenut posao koji nitko nije htio.

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

HOME = Path.home()
PLOCA = "http://localhost:17781"
POSTAVKE = HOME / ".claude/regoc/config/odlucitelj.json"

ZADANE = {
    "ukljucen": False,                      # fail-safe: bez izričitog uključivanja ne radi
    "provider": "ollama",
    "model": "qwen3:8b",
    "baseUrl": "http://192.168.10.4:11434",
    "najvise_po_prolazu": 3,
    "smije_kreni": True,                    # kad je false, model smije samo odgoditi ili tražiti čovjeka
}

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
    ("nepovratno", r"\b(migracij|selidb|preseli|nadogradnj|upgrade|schema|shema)\w*"),
]


def rizik(z: dict) -> str | None:
    """Vraća naziv rizika ili None. Gleda naslov i opis zajedno."""
    tekst = f"{z.get('title') or ''}\n{z.get('description') or ''}".lower()
    for naziv, uzorak in RIZIK:
        if re.search(uzorak, tekst, re.IGNORECASE):
            return naziv
    return None


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
# Goran, 04.09.2026.: „kod modela odluke imam samo lokalne, htio bi sve — znaci i anthropic i
# google i openrouter i ostale koje sustav nudi."
#
# Izvor istine je `models/model-config.json`. Ključ NIKAD ne ulazi u ovaj kod ni u ispis —
# čita se iz okoline, a ako ga nema, davatelj se pošteno prijavi kao nespreman umjesto da
# tiho ne radi.
KONFIG_MODELA = HOME / ".claude/regoc/models/model-config.json"
CREDENTIALS = HOME / ".claude/regoc/credentials.env"


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


def cekaju() -> list[dict]:
    try:
        return _json(f"{PLOCA}/api/odluke").get("zadatci", [])
    except Exception as e:
        print(f"ploča ne odgovara: {e}", file=sys.stderr)
        return []


def procitaj(odgovor: str) -> str | None:
    """Tolerantno čitanje: traži riječ bilo gdje, ne samo kao prvu.

    Isto pravilo kao kod dežurnog — mjereno je da slab model rado odgovori rečenicom
    („Mislim da treba covjek.") koja je sadržajno točna, pa krivnja za promašaj pada na
    strogo uspoređivanje, ne na model."""
    t = (odgovor or "").lower()
    t = t.replace("čovjek", "covjek").replace("kreće", "kreni")
    nadjene = [(t.find(k), k) for k in RIJECI if k in t]
    return sorted(nadjene)[0][1] if nadjene else None


def kartica(z: dict, p: dict) -> str:
    """Kontekst je namjerno kratak — odluka se donosi o JEDNOM zadatku, bez povijesti."""
    dopusteno = "kreni / odgodi / covjek" if p.get("smije_kreni", True) else "odgodi / covjek"
    return (
        "Odlucujes umjesto korisnika hoce li se ovaj zadatak poceti raditi.\n\n"
        f"ZADATAK {z.get('id')} (prioritet {z.get('priority')}, izvrsitelj {z.get('assignee')},"
        f" ceka {z.get('cekaSati')} h)\n"
        f"NASLOV: {z.get('title')}\n"
        f"OPIS: {str(z.get('description') or '')[:700]}\n\n"
        "PRAVILA:\n"
        "- PRVA rijec tvog odgovora mora biti odluka. Ne pisi nista prije nje.\n"
        "  Zatim novi red i jedna recenica obrazlozenja.\n"
        f"- Dopustene rijeci: {dopusteno}.\n"
        "- covjek biraj kad zadatak trosi novac, nesto brise, ima ucinak izvan ovog sustava,\n"
        "  ili kad iz opisa ne vidis sto se tocno trazi. Bolje pitati nego pogoditi.\n"
        "- kreni biraj samo kad je posao jasan i bezopasan.\n"
    )


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
    try:
        r = urllib.request.Request(f"{p.get('baseUrl') or 'http://192.168.10.4:11434'}/api/chat",
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


def odluci(z: dict, p: dict) -> dict:
    r = rizik(z)
    if r:
        return {"id": z["id"], "rijec": "covjek",
                "razlog": f"traži čovjeka: {r} (prepoznato u opisu, model nije ni pitan)",
                "upisati": False, "filtar": r}
    if premalo_opisa(z):
        return {"id": z["id"], "rijec": "covjek",
                "razlog": "traži čovjeka: opis je prekratak ili bez traga izvedbe",
                "upisati": False, "filtar": "nejasno"}
    odgovor = pitaj_model(p, kartica(z, p))
    if not odgovor:
        # Model ne odgovara → zadatak OSTAJE korisniku. Nikad se ne pretpostavlja „kreni":
        # tišina mjerila je razlog za oprez, ne za rad (isto pravilo kao kod vrata autonomije).
        return {"id": z["id"], "rijec": None, "razlog": "model nije odgovorio", "upisati": False}
    rijec = procitaj(odgovor)
    if rijec == "kreni" and not p.get("smije_kreni", True):
        rijec = "covjek"
    return {"id": z["id"], "rijec": rijec, "razlog": obrazlozenje(odgovor),
            "sirovo": odgovor[:160], "upisati": rijec in ("kreni", "odgodi")}


def upisi(z: dict, o: dict, p: dict) -> str:
    """Odluka ide istim putem kojim je donosi i čovjek — /api/tasks/<ID>/odluka."""
    potpis = f"{p['provider']}/{p['model']}"
    if o["rijec"] == "kreni":
        tekst = f"KRENI — {o['razlog']}"
    else:
        tekst = f"ODGODI — {o['razlog']}"
    try:
        _json(f"{PLOCA}/api/tasks/{z['id']}/odluka",
              {"odluka": tekst, "by": f"odlucitelj ({potpis})"}, "POST")
        return "upisano"
    except urllib.error.HTTPError as e:
        return f"nije upisano (HTTP {e.code})"
    except Exception as e:
        return f"nije upisano ({e})"


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

    popis = cekaju()
    if n.zadatak:
        popis = [z for z in popis if z.get("id") == n.zadatak]
    popis = popis[: int(p.get("najvise_po_prolazu", 3))]
    if not popis:
        print("nema zadataka koji cekaju odluku")
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
        rijec = (o["rijec"] or "bez odluke").upper()
        print(f"{o['id']:10} {rijec:11} {o.get('ishod', 'proba')}  {o['naslov']}")
        if o["razlog"]:
            print(f"           {o['razlog'][:96]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
