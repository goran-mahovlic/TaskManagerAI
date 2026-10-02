"""tm_putanje.py — gdje alati iz `tools/` drže podatke i kako nalaze servise.

Python zrcalo `src/core/paths.ts` (ADR-0001 O1.1): JEDAN korijen, `$TM_HOME`, zadano
`~/.taskmanager`. Nijedan alat ne smije imati tuđi raspored mapa ni tuđu adresu kao
rezervnu vrijednost — na drugom stroju te mape nema, a adresa vodi nigdje (TASK-5108).

Adrese servisa (Ollama, Chroma) NEMAJU zadanu vrijednost: dolaze iz istih varijabli
okoline kao u TS dijelu paketa (`TM_OLLAMA_URL`, `TM_CHROMA_HOST`/`TM_CHROMA_PORT`).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

#: Korijen samog paketa (`tools/..`).
PAKET_DIR = Path(__file__).resolve().parent.parent

#: Korijenska mapa za bazu, dnevnike i stanje — ista kao `TM_ROOT` u paths.ts.
TM_ROOT = Path(os.environ.get("TM_HOME") or Path(os.environ.get("HOME") or Path.home()) / ".taskmanager")

#: Mapa za podatke uz bazu (stanje, dnevnici, arhivi).
TM_DATA = TM_ROOT / "data"

#: SQLite baza ploče.
TM_DB = Path(os.environ.get("TM_DB") or TM_DATA / "tasks.db")


def stanje(ime: str) -> Path:
    """Datoteka sa stanjem koje alat sam zatekne/zapiše (`$TM_HOME/data/<ime>`)."""
    return TM_DATA / ime


def konfig(ime: str, env_var: str | None = None) -> Path:
    """Konfiguracijska datoteka — isti redoslijed kao `konfigPutanja()` u paths.ts:

    1. varijabla okoline (puna putanja);
    2. `$TM_HOME/config/<ime>`, ako ta datoteka ondje POSTOJI;
    3. `config/<ime>` uz sam paket.
    """
    if env_var and os.environ.get(env_var):
        return Path(os.environ[env_var])
    if os.environ.get("TM_HOME"):
        uz_bazu = Path(os.environ["TM_HOME"]) / "config" / ime
        if uz_bazu.exists():
            return uz_bazu
    return PAKET_DIR / "config" / ime


def ollama_url() -> str:
    """Adresa Ollame iz `TM_OLLAMA_URL`; prazan niz ako nije postavljena."""
    return (os.environ.get("TM_OLLAMA_URL") or "").rstrip("/")


def chroma_kolekcije() -> str:
    """Bazni URL Chroma v2 kolekcija iz `TM_CHROMA_HOST`/`TM_CHROMA_PORT`.

    Bez `TM_CHROMA_HOST` alat izlazi s porukom — tiho gađanje tuđe adrese je gore od
    jasnog odbijanja.
    """
    domacin = (os.environ.get("TM_CHROMA_HOST") or "").strip()
    if not domacin:
        sys.exit("ChromaDB nije podešen — postavi TM_CHROMA_HOST (i TM_CHROMA_PORT)")
    for prefiks in ("http://", "https://"):
        if domacin.startswith(prefiks):
            domacin = domacin[len(prefiks):]
    domacin = domacin.rstrip("/").split(":")[0]
    port = os.environ.get("TM_CHROMA_PORT") or "8000"
    return f"http://{domacin}:{port}/api/v2/tenants/default_tenant/databases/default_database/collections"
