#!/usr/bin/env python3
"""
REGOČ — čitač potrošnje Claude sesije (Max pretplata).

Cilj: prije i poslije svakog zadatka vidjeti koliko je 5h-sesija i 7d-tjedan
potrošen, koliko je do resetiranja, i pratiti trend kroz vrijeme radi
optimizacije potrošnje.

Kako radi:
  Pošalje minimalan probe (1 token) na SLUŽBENI Anthropic endpoint
  https://api.anthropic.com/v1/messages s OAuth tokenom iz
  ~/.claude/.credentials.json. Anthropic u response HEADERIMA vrati stanje
  limita:
    anthropic-ratelimit-unified-5h-utilization  = % sesije (5h prozor)
    anthropic-ratelimit-unified-7d-utilization  = % tjedna (7d prozor)
    anthropic-ratelimit-unified-5h-reset         = reset sesije (epoch)
    anthropic-ratelimit-unified-7d-reset         = reset tjedna (epoch)
    anthropic-ratelimit-unified-status           = stanje (allowed/...)
  Cijena: ~1 ulazni token po pozivu (zanemarivo).

  Token IDE ISKLJUČIVO na api.anthropic.com (Bearer). Ništa se ne šalje
  trećoj strani; jedini zapis je lokalni JSONL log.

Uporaba:
  python session_usage.py                       # jednokratno: ispiši + logiraj
  python session_usage.py --json                # strojno čitljiv JSON na stdout
  python session_usage.py --quiet               # samo logiraj, bez ispisa
  python session_usage.py --no-log              # ispiši, ne logiraj
  python session_usage.py --task "PDF izvoz" --phase before   # snimka PRIJE
  python session_usage.py --task "PDF izvoz" --phase after    # snimka POSLIJE + delta

Izlazni kodovi (TASK-3461 — mjerilo koje ne radi mora biti GLASNO):
  0  mjereno (ili odbijenica kvote 429/`rejected`, koja je također vijest)
  1  probe uopće nije prošao (mreža, credentials fale) — `SystemExit` s porukom
  2  mjerilo je odbijeno: HTTP greška BEZ upotrebljivog broja (npr. 401 Unauthorized).
     Uz kod 2 na stderr ide točno JEDAN redak s razlogom. Keš se pritom NE dira —
     fail-CLOSED pravilo iz `write_cache()` ostaje netaknuto.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

CRED_FILE = Path.home() / ".claude" / ".credentials.json"
LOG_FILE = Path.home() / ".claude" / "regoc" / "data" / "session_usage.jsonl"
CACHE_FILE = Path.home() / ".claude" / "regoc" / "data" / "session_usage.cache.json"
SESSIONS_PATH = Path.home() / ".claude" / "tools" / "Telegram" / "chat_sessions.json"
REGOC_SEND = Path.home() / ".tmp" / "regoc_send.py"
TG_LOG = Path.home() / ".claude" / "regoc" / "data" / "session_usage.telegram.log"
ENDPOINT = "https://api.anthropic.com/v1/messages"
PROBE_MODEL = "claude-haiku-4-5-20251001"  # najjeftiniji za probe
BLOCK_THRESHOLD = 97.0  # ≥ ovo % sesije → zaustavi početak rada (UserPromptSubmit hook)
CACHE_TTL = 120.0       # s — gate smije koristiti keš mlađi od ovoga (inače svjež probe)
EXIT_METER_REJECTED = 2  # mjerilo odbijeno (HTTP greška bez brojke) — v. `measurement_failure()`

# ANSI boje za brzo vizualno upozorenje u terminalu
_C_RED, _C_YEL, _C_GRN, _C_DIM, _C_OFF = "\033[91m", "\033[93m", "\033[92m", "\033[2m", "\033[0m"


def load_token() -> str:
    if not CRED_FILE.exists():
        raise SystemExit(f"[GREŠKA] credentials nisu nađeni: {CRED_FILE}")
    data = json.loads(CRED_FILE.read_text(encoding="utf-8"))
    token = data.get("claudeAiOauth", {}).get("accessToken")
    if not token:
        raise SystemExit("[GREŠKA] nema claudeAiOauth.accessToken u credentials")
    return token


def probe(token: str) -> dict:
    """Pošalji 1-token probe, vrati response headere (i na rate-limit grešci)."""
    body = json.dumps({
        "model": PROBE_MODEL,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "q"}],
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        },
    )
    headers: dict = {}
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            for k, v in resp.getheaders():
                headers[k.lower()] = v
            _ = resp.read()  # isprazni tijelo da se veza uredno zatvori
    except urllib.error.HTTPError as e:
        # I na grešci (npr. 429) Anthropic vraća rate-limit headere — zadrži ih.
        for k, v in e.headers.items():
            headers[k.lower()] = v
        headers["_http_error"] = f"{e.code} {e.reason}"
    except Exception as e:
        raise SystemExit(f"[GREŠKA] probe nije uspio: {type(e).__name__}: {e}")
    return headers


def probe_with_reload() -> dict:
    """Probe, a na 401 još jedan pokušaj s NANOVO pročitanim credentialsima (TASK-3461, D).

    Pristupni token se čita s diska i ovaj alat ga NE osvježava sam — osvježava ga Claude
    CLI kad mu istekne. Izmjereno 26.08.2026: između isteka tokena i CLI-jeva osvježavanja
    prošao je 141 minuta u kojima je svaki probe vraćao 401, pa je snimka potrošnje stajala,
    a s njom i vrata autonomije.

    Lijek bez rizika: kad probe vrati 401, datoteka s credentialsima se pročita IZNOVA. Ako
    je u međuvremenu netko (CLI) upisao novi token, drugi pokušaj prolazi odmah umjesto da
    se čeka idući ciklus. Ako je token isti, drugi pokušaj se NE radi — nema što promijeniti.

    VLASTITO osvježavanje preko `refreshToken` se NE radi: pisanje u datoteku s tajnama
    može se sudariti s CLI-jem koji piše istu datoteku. To čeka Goranovu izričitu odluku.
    """
    token = load_token()
    headers = probe(token)
    if not str(headers.get("_http_error") or "").startswith("401"):
        return headers
    try:
        fresh = load_token()
    except SystemExit:
        return headers          # credentials su u međuvremenu nestali → ostaje prvi ishod
    if fresh == token:
        return headers          # isti token → drugi pokušaj bi bio isti 401, ne trošimo ga
    return probe(fresh)


def _percent(val):
    """Anthropic vraća iskorištenost kao decimalni razlomak (0.0–1.0+)."""
    if not val:
        return None
    try:
        return round(float(str(val).rstrip("%")) * 100, 1)
    except (ValueError, AttributeError):
        return None


def _epoch(val):
    if not val:
        return None
    try:
        return datetime.fromtimestamp(float(val), tz=timezone.utc).isoformat()
    except (ValueError, AttributeError):
        return val


def summarize(headers: dict) -> dict:
    g = headers.get
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "session_percent": _percent(g("anthropic-ratelimit-unified-5h-utilization")),
        "weekly_percent": _percent(g("anthropic-ratelimit-unified-7d-utilization")),
        "session_reset_at": _epoch(g("anthropic-ratelimit-unified-5h-reset")),
        "weekly_reset_at": _epoch(g("anthropic-ratelimit-unified-7d-reset")),
        "status": g("anthropic-ratelimit-unified-status"),
        "overage_status": g("anthropic-ratelimit-unified-overage-status"),
        "fallback_model": g("anthropic-ratelimit-unified-fallback"),
        "http_error": g("_http_error"),
    }


def append_log(entry: dict) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def is_informative(entry: dict) -> bool:
    """Nosi li snimka ijednu upotrebljivu vijest za vrata autonomije?

    Postotak je vijest; odbijenica kvote (429 / `rejected`) je također vijest — i to
    ona najvažnija. Snimka bez ijednog od toga (mreža pukla, headeri fale) NIJE
    mjerenje nego neuspjeh mjerenja.
    """
    if entry.get("session_percent") is not None:
        return True
    return entry.get("status") == "rejected" or "429" in str(entry.get("http_error") or "")


def measurement_failure(entry: dict) -> str | None:
    """Vrati razlog kad mjerenje NIJE uspjelo, inače `None` (TASK-3461, A1).

    Razlika koju je incident 26.08.2026. pokazao skupom: HTTP greška NIJE uvijek neuspjeh
    mjerenja. Odbijenica kvote (429 / `rejected`) dolazi s ispravnim rate-limit headerima —
    to je mjerenje, i to najvažnije. Neuspjeh je HTTP greška koja NE nosi nijednu vijest
    (401 Unauthorized: istekao token → nema ni postotka ni odbijenice).

    Zato se ovdje koristi ista definicija vijesti kao u `is_informative()`: samo neinformativna
    HTTP greška je neuspjeh mjerenja i samo ona daje izlazni kod `EXIT_METER_REJECTED`.
    """
    err = entry.get("http_error")
    if not err or is_informative(entry):
        return None
    return str(err)


def write_cache(entry: dict) -> None:
    """Spremi zadnju snimku u keš (dijele je hookovi, TaskWebUI i daemonov gate).

    TASK-3046, dva pravila naučena iz incidenta 29.07.2026:

    1. NEUSPJEH MJERENJA NE BRIŠE ZADNJU VIJEST. Prazna snimka (bez postotka i bez
       odbijenice) preko dobre bi značila „nikad izmjereno" → `autonomyTier` je na
       tome fail-OPEN → rafal spawnova. Zato staru snimku ostavljamo da ostari:
       `autonomyTierFromUsage()` je na staroj snimci fail-CLOSED, što je ispravno
       ponašanje kad ne znamo koliko smo potrošili.
    2. ZAPIS JE ATOMIČAN. Daemon čita ovu datoteku svakih par sekundi; djelomično
       zapisan JSON kod čitatelja završi u `catch` → `null` → opet fail-open.
    """
    try:
        if not is_informative(entry):
            try:
                prev = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
                if is_informative(prev.get("entry") or {}):
                    return  # čuvaj zadnju pravu vijest; neka ostari i zatvori vrata
            except Exception:
                pass  # keša nema ili je pokvaren → svejedno zapiši ovo što imamo
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(f".tmp{os.getpid()}")
        tmp.write_text(
            json.dumps({"cached_at": time.time(), "entry": entry}, ensure_ascii=False),
            encoding="utf-8")
        os.replace(tmp, CACHE_FILE)
    except Exception:
        pass


def read_cache(max_age: float = CACHE_TTL) -> dict | None:
    """Vrati kеširanu snimku ako je mlađa od max_age sekundi, inače None."""
    try:
        payload = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        if time.time() - float(payload["cached_at"]) <= max_age:
            return payload["entry"]
    except Exception:
        pass
    return None


def _rel(iso: str) -> str:
    """Ljudski čitljiv 'za Xh Ymin' iz ISO vremena."""
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso)
        secs = (dt - datetime.now(timezone.utc)).total_seconds()
        if secs < 0:
            return "prošlo"
        h, m = int(secs // 3600), int((secs % 3600) // 60)
        return f"za {h}h {m}min" if h else f"za {m}min"
    except Exception:
        return iso


# Zona se navodi IZRIJEKOM (TASK-3006). Kontejner nema `TZ`, pa je zona procesa UTC —
# `.astimezone()` bez argumenta ostavljao je vrijeme u UTC-u, a ispis je izgledao kao
# lokalno vrijeme. Posljedica: reset u 22:50 UTC čitao se u 22:40 po Zagrebu kao „za
# deset minuta", umjesto točnih dva sata.
ZONA = ZoneInfo(os.environ.get("REGOC_TZ", "Europe/Zagreb"))


def _local(iso: str) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(ZONA).strftime("%H:%M %d.%m.")
    except Exception:
        return iso


def _color(pct):
    if pct is None:
        return _C_DIM
    return _C_RED if pct >= 90 else _C_YEL if pct >= 70 else _C_GRN


def _find_last(task: str, phase: str):
    """Nađi zadnji log-unos za (task, phase). Za delta izračun."""
    if not LOG_FILE.exists():
        return None
    last = None
    with LOG_FILE.open(encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("task") == task and e.get("phase") == phase:
                last = e
    return last


def print_human(e: dict) -> None:
    sp, wp = e["session_percent"], e["weekly_percent"]
    sc, wc = _color(sp), _color(wp)
    sess = f"{sp:.0f}%" if sp is not None else "?"
    wk = f"{wp:.0f}%" if wp is not None else "?"
    zona = ZONA.key.split("/")[-1]
    print(f"  Sesija (5h): {sc}{sess:>4}{_C_OFF}   reset {_local(e['session_reset_at'])} {zona}  ({_rel(e['session_reset_at'])})")
    print(f"  Tjedan (7d): {wc}{wk:>4}{_C_OFF}   reset {_local(e['weekly_reset_at'])} {zona}  ({_rel(e['weekly_reset_at'])})")
    if e.get("status") and e["status"] != "allowed":
        print(f"  {_C_YEL}status: {e['status']}{_C_OFF}")
    if e.get("http_error"):
        print(f"  {_C_DIM}http: {e['http_error']}{_C_OFF}")


def _tg_log(line: str) -> None:
    try:
        TG_LOG.parent.mkdir(parents=True, exist_ok=True)
        with TG_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _chat_for_session(session_id: str):
    """Vrati chat_id ako je session_id mapiran u chat_sessions.json, inače None."""
    if not session_id:
        return None
    try:
        m = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
        for cid, meta in m.items():
            if meta.get("sessionId") == session_id:
                return int(cid)
    except Exception:
        pass
    return None


def send_telegram(text: str, session_id: str) -> None:
    """Best-effort slanje na Telegram — SAMO ako je sesija mapirana na chat.
    Ishod (OK/SKIP/FAIL) upisuje u TG_LOG radi provjere. Nikad ne baca."""
    stamp = datetime.now(timezone.utc).isoformat()
    chat = _chat_for_session(session_id)
    if chat is None:
        _tg_log(f"{stamp} SKIP session={session_id or '?'} (nije mapirana na chat)")
        return
    try:
        import subprocess
        r = subprocess.run(
            ["/usr/bin/python3", str(REGOC_SEND), "--chat", str(chat), text],
            capture_output=True, text=True, timeout=40)
        if r.returncode == 0:
            _tg_log(f"{stamp} OK chat={chat} :: {r.stdout.strip()}")
        else:
            _tg_log(f"{stamp} FAIL chat={chat} rc={r.returncode} :: "
                    f"{r.stdout.strip()} | {r.stderr.strip()}")
    except Exception as ex:
        _tg_log(f"{stamp} ERROR chat={chat} :: {type(ex).__name__}: {ex}")


def _oneline(e: dict) -> str:
    """Kratki jednoredni sažetak za hook systemMessage."""
    sp, wp = e["session_percent"], e["weekly_percent"]
    sess = f"{sp:.0f}%" if sp is not None else "?"
    wk = f"{wp:.0f}%" if wp is not None else "?"
    warn = "  ⚠️ BLIZU LIMITA" if sp is not None and sp >= 90 else ""
    return (f"📊 Sesija (5h): {sess} · Tjedan (7d): {wk} · "
            f"reset sesije {_rel(e['session_reset_at'])}{warn}")


def hook_stop(session_id: str = "") -> None:
    """Stop hook: nakon svake poruke prikaži stanje sesije u TUI-u (systemMessage)
    i pošalji ga na Telegram (ako je sesija mapirana). Fail-open."""
    try:
        entry = summarize(probe_with_reload())  # Stop = uvijek svjež (odražava stanje NAKON rada)
        append_log(entry)
        write_cache(entry)                       # osvježi keš za idući gate
        msg = _oneline(entry)
    except Exception as ex:
        msg = f"📊 Stanje sesije: nedostupno ({type(ex).__name__})"
    send_telegram(msg, session_id)               # best-effort na Telegram + upis u TG_LOG
    print(json.dumps({"systemMessage": msg, "suppressOutput": True}, ensure_ascii=False))


def hook_prompt(session_id: str = "") -> None:
    """UserPromptSubmit hook: blokiraj početak rada ako je sesija ≥ BLOCK_THRESHOLD %.
    Prvo pokušaj keš (svjež ≤ CACHE_TTL); samo ako ga nema → svjež probe.
    Fail-open: ako probe ne uspije, NE blokiraj (radije nastavi nego se zaključaj)."""
    try:
        entry = read_cache()
        if entry is None:                        # keš star/prazan → svjež probe + osvježi keš
            entry = summarize(probe_with_reload())
            append_log(entry)
            write_cache(entry)
        sp = entry["session_percent"]
        if sp is not None and sp >= BLOCK_THRESHOLD:
            reset = _local(entry["session_reset_at"])
            rel = _rel(entry["session_reset_at"])
            reason = (f"⛔ Potrošnja sesije je {sp:.0f}% (prag {BLOCK_THRESHOLD:.0f}%). "
                      f"Rad je zaustavljen do resetiranja sesije u {reset} ({rel}). "
                      f"Pričekaj reset ili podigni prag u session_usage.py (BLOCK_THRESHOLD).")
            # Blokada briše moj odgovor → bez ovoga bi na Telegramu bila tišina; javi razlog.
            send_telegram(reason, session_id)
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
            return
    except Exception:
        pass  # fail-open: ne blokiraj na grešci
    print(json.dumps({"suppressOutput": True}))


def main() -> None:
    # Hook načini: čitaj hook JSON sa stdina (ignoriramo sadržaj), emitiraj hook JSON na stdout.
    if len(sys.argv) >= 2 and sys.argv[1] == "--hook":
        mode = sys.argv[2] if len(sys.argv) >= 3 else ""
        raw = ""
        try:
            raw = sys.stdin.read()  # isprazni stdin (da writer ne dobije SIGPIPE)
        except Exception:
            pass
        session_id = ""
        try:
            if raw.strip():
                session_id = (json.loads(raw) or {}).get("session_id", "") or ""
        except Exception:
            session_id = ""
        if mode == "stop":
            hook_stop(session_id)
        elif mode == "prompt":
            hook_prompt(session_id)
        return

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quiet", action="store_true", help="Bez ispisa, samo logiraj")
    ap.add_argument("--json", action="store_true", help="Strojno čitljiv JSON na stdout")
    ap.add_argument("--no-log", action="store_true", help="Ne zapisuj u JSONL")
    ap.add_argument("--task", help="Naziv zadatka (za prije/poslije praćenje)")
    ap.add_argument("--phase", choices=["before", "after"], help="Faza snimke")
    args = ap.parse_args()

    entry = summarize(probe_with_reload())
    if args.task:
        entry["task"] = args.task
    if args.phase:
        entry["phase"] = args.phase

    if not args.no_log:
        append_log(entry)
    # TASK-3046: i CLI put osvježava keš. Do sada je keš pisao SAMO hook, pa je
    # daemonov gate autonomije ostajao slijep čim agenti prestanu raditi — a to je
    # točno stanje u kojem gate treba vidjeti. Vidi RegocDaemon.refreshSessionUsage().
    write_cache(entry)

    # TASK-3461: neuspjelo mjerenje mora VIKATI. Jedan redak na stderr (ide i uz `--quiet`,
    # jer `--quiet` obećava tišinu na stdoutu, ne na kanalu za greške) i poseban izlazni kod
    # koji daemon razlikuje od „probe je pao" (exit 1). Redoslijed je namjeran: prvo se
    # zapiše i pohrani ono što se doznalo, tek onda se prijavljuje kvar.
    failure = measurement_failure(entry)
    if failure:
        print(f"[mjerilo] probe odbijen: {failure} — snimka potrošnje se ne osvježava, "
              f"vrata autonomije stoje na zadnjoj poznatoj razini", file=sys.stderr)

    if args.json:
        print(json.dumps(entry, ensure_ascii=False, indent=2))
    elif not args.quiet:
        label = f" — {args.task} [{args.phase}]" if args.task and args.phase else ""
        print(f"REGOČ potrošnja sesije{label}")
        print_human(entry)

        # Delta na 'after' u odnosu na zadnji 'before' istog zadatka
        if args.task and args.phase == "after":
            before = _find_last(args.task, "before")
            if before and before.get("session_percent") is not None and entry["session_percent"] is not None:
                ds = entry["session_percent"] - before["session_percent"]
                dw = (entry["weekly_percent"] or 0) - (before["weekly_percent"] or 0)
                print(f"  {_C_DIM}Δ zadatak: sesija {ds:+.1f}pp, tjedan {dw:+.1f}pp{_C_OFF}")

    if failure:
        raise SystemExit(EXIT_METER_REJECTED)


if __name__ == "__main__":
    main()
