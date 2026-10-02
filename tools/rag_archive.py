#!/usr/bin/env python3
"""rag_archive.py — arhiviraj pa ukloni šum iz RAG korpusa (R3, TASK-4310).

PRAVILO (LESSONS: „ne briši povijest — arhiviraj"): ništa se ne briše iz Chrome
prije nego što postoji potpuni izvoz (ids + documents + metadatas + embeddings)
na disku. Arhiva je JSONL (jedan dokument = jedan redak), po kolekciji, plus
manifest.json sa zbrojevima i vremenom. Vraćanje je JEDNA naredba (--restore).

ŠTO RADI
  --export KOL [KOL ...]   izvezi navedene kolekcije u $TM_HOME/data/rag_arhiv/
  --drop KOL [KOL ...]     obriši kolekciju iz Chrome (SAMO ako je već arhivirana --export)
  --restore KOL            vrati arhiviranu kolekciju natrag u Chromu (getOrCreate + add)
  --out DIR                ciljni direktorij arhive (default $TM_HOME/data/rag_arhiv)

Primjer (točno R3 iz docs/RAG-2026-09-04_pregled_i_prijedlog.md):
  python3 rag_archive.py --export test regoc_seedtest_2620 pai_agent_unknown \
      pai_agent_Bash pai_agent_Explore
  python3 rag_archive.py --drop test regoc_seedtest_2620 pai_agent_unknown
  # pai_agent_Bash/Explore se NE dropaju — samo isključuju iz zadane pretrage (kod, ne ovaj alat)
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request
from datetime import datetime, timezone

from tm_putanje import stanje
from tm_putanje import chroma_kolekcije as baza  # TM_CHROMA_HOST/TM_CHROMA_PORT, bez zadane adrese
DEFAULT_OUT = str(stanje("rag_arhiv"))


def dohvati(put: str, tijelo=None):
    if tijelo is None:
        return json.load(urllib.request.urlopen(put, timeout=60))
    req = urllib.request.Request(put, json.dumps(tijelo).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=180))


def kolekcije() -> dict[str, str]:
    return {c["name"]: c["id"] for c in dohvati(baza() + "?limit=500")}


def _manifest_path(out_dir: str) -> str:
    return os.path.join(out_dir, "manifest.json")


def _load_manifest(out_dir: str) -> dict:
    p = _manifest_path(out_dir)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return {"version": 1, "kolekcije": {}}


def _save_manifest(out_dir: str, manifest: dict) -> None:
    with open(_manifest_path(out_dir), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")


def export_kolekcija(ime: str, out_dir: str, kol: dict[str, str]) -> int:
    os.makedirs(out_dir, exist_ok=True)
    manifest = _load_manifest(out_dir)

    if ime not in kol:
        print(f"  {ime}: ne postoji u Chromi — preskačem izvoz (možda već obrisana)")
        return 0

    cid = kol[ime]
    n = dohvati(f"{baza()}/{cid}/count")
    jsonl_path = os.path.join(out_dir, f"{ime}.jsonl")
    zapisano = 0
    korak = 200
    with open(jsonl_path, "w", encoding="utf-8") as f:
        offset = 0
        while offset < n:
            limit = min(korak, n - offset)
            d = dohvati(f"{baza()}/{cid}/get",
                        {"limit": limit, "offset": offset,
                         "include": ["metadatas", "documents", "embeddings"]})
            ids = d.get("ids") or []
            docs = d.get("documents") or []
            metas = d.get("metadatas") or []
            embs = d.get("embeddings") or []
            for i, doc, meta, emb in zip(ids, docs, metas, embs):
                red = {"id": i, "document": doc, "metadata": meta or {}, "embedding": emb}
                f.write(json.dumps(red, ensure_ascii=False) + "\n")
                zapisano += 1
            offset += limit

    manifest["kolekcije"][ime] = {
        "broj_dokumenata": zapisano,
        "izvezeno_u": os.path.abspath(jsonl_path),
        "izvezeno_at": datetime.now(timezone.utc).isoformat(),
        "izvor": baza(),
    }
    _save_manifest(out_dir, manifest)
    print(f"  {ime}: {zapisano} dokumenata → {jsonl_path}")
    return zapisano


# Kolekcije koje se čitaju pri pokretanju sjednice (SSOT je
# ~/.claude/skills/CORE/Tools/lib/rag-memory.ts → STARTUP_COLLECTIONS). Ovdje su ponovljene
# jer python alat ne uvozi TypeScript; ako se ondje promijeni popis, promijeni i ovdje.
STARTUP_KOLEKCIJE = {
    "pai_sessions", "pai_learning_system", "pai_agent_Explore",
    "hrvatski_pravopis", "regoc_znanje",
}


def broj_zasticenih(cid: str) -> int:
    """Koliko dokumenata u kolekciji nosi `zasticeno=True` (pravila, lekcije, pogreške).

    Goran, 04.09.2026.: „treba paziti da ih se ne bi obrisalo — posebno prijašnje pogreške
    i pravila." Oznaku upisuje `tools/rag_tipovi.py`; ovdje je brana. Ako Chroma ne odgovori,
    vraća se -1 i brisanje se odbija — nepoznato stanje nije dopuštenje.
    """
    try:
        req = urllib.request.Request(
            f"{baza()}/{cid}/get",
            json.dumps({"where": {"zasticeno": True}, "limit": 1000, "include": []}).encode(),
            {"Content-Type": "application/json"})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        return len(d.get("ids") or [])
    except Exception as e:
        print(f"    (provjera zaštite nije uspjela: {e})")
        return -1


def drop_kolekcija(ime: str, out_dir: str, kol: dict[str, str], dopusti_zasticeno: bool = False) -> int:
    manifest = _load_manifest(out_dir)
    zapis = manifest.get("kolekcije", {}).get(ime)
    if not zapis or not os.path.exists(zapis.get("izvezeno_u", "")):
        print(f"  {ime}: NEMA arhive u {out_dir} — odbijam obrisati (pravilo: arhiviraj prije brisanja)")
        return 1
    if ime not in kol:
        print(f"  {ime}: već ne postoji u Chromi")
        return 0
    if ime in STARTUP_KOLEKCIJE and not dopusti_zasticeno:
        print(f"  {ime}: čita se PRI POKRETANJU SJEDNICE (LoadContext/CLAUDE.md) — odbijam obrisati. "
              f"Brisanje bi presjeklo kontinuitet znanja među sjednicama.")
        return 1
    cid = kol[ime]
    zast = broj_zasticenih(cid)
    if zast != 0 and not dopusti_zasticeno:
        if zast < 0:
            print(f"  {ime}: ne mogu provjeriti zaštićene dokumente — odbijam obrisati")
        else:
            print(f"  {ime}: sadrži {zast} ZAŠTIĆENIH dokumenata (pravila/lekcije/pogreške) — "
                  f"odbijam obrisati. Ako je doista potrebno: --dopusti-zasticeno")
        return 1
    n_prije = dohvati(f"{baza()}/{cid}/count")
    if n_prije != zapis["broj_dokumenata"]:
        print(f"  {ime}: UPOZORENJE broj u Chromi ({n_prije}) != broj u arhivi "
              f"({zapis['broj_dokumenata']}) — provjeri prije brisanja")
        return 1
    # v2 API: DELETE .../collections/{ime} radi po IMENU, ne po id-u (id vraća 404).
    req = urllib.request.Request(f"{baza()}/{ime}", method="DELETE")
    urllib.request.urlopen(req, timeout=60)
    print(f"  {ime}: obrisana iz Chrome ({n_prije} dokumenata, arhiva ostaje na disku)")
    return 0


def restore_kolekcija(ime: str, out_dir: str) -> int:
    manifest = _load_manifest(out_dir)
    zapis = manifest.get("kolekcije", {}).get(ime)
    jsonl_path = zapis["izvezeno_u"] if zapis else os.path.join(out_dir, f"{ime}.jsonl")
    if not os.path.exists(jsonl_path):
        print(f"  {ime}: arhiva {jsonl_path} ne postoji")
        return 1

    # getOrCreate kolekciju (v2 API: POST na bazu s imenom)
    kol = kolekcije()
    if ime in kol:
        cid = kol[ime]
    else:
        created = dohvati(baza(), {"name": ime})
        cid = created["id"]

    ids, docs, metas, embs = [], [], [], []
    with open(jsonl_path, encoding="utf-8") as f:
        for linija in f:
            red = json.loads(linija)
            ids.append(red["id"])
            docs.append(red["document"])
            metas.append(red["metadata"])
            embs.append(red["embedding"])

    korak = 100
    vraceno = 0
    for k in range(0, len(ids), korak):
        dohvati(f"{baza()}/{cid}/add", {
            "ids": ids[k:k + korak],
            "documents": docs[k:k + korak],
            "metadatas": metas[k:k + korak],
            "embeddings": embs[k:k + korak],
        })
        vraceno += len(ids[k:k + korak])
    print(f"  {ime}: vraćeno {vraceno} dokumenata u Chromu iz {jsonl_path}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", nargs="+", metavar="KOL")
    ap.add_argument("--drop", nargs="+", metavar="KOL")
    ap.add_argument("--dopusti-zasticeno", action="store_true",
                    help="dopusti brisanje kolekcije koja sadrzi zasticene dokumente (pravila/lekcije/pogreske)")
    ap.add_argument("--restore", metavar="KOL")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()

    if a.export:
        kol = kolekcije()
        rc = 0
        for ime in a.export:
            export_kolekcija(ime, a.out, kol)
        return rc
    if a.drop:
        kol = kolekcije()
        rc = 0
        for ime in a.drop:
            rc |= drop_kolekcija(ime, a.out, kol, a.dopusti_zasticeno)
        return rc
    if a.restore:
        return restore_kolekcija(a.restore, a.out)

    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
