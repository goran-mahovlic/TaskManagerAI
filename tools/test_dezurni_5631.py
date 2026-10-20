#!/usr/bin/env python3
"""TASK-5631: kartica bez lažnog obećanja kad sustav radi; OpenRouter bez razmišljanja.

Pokretanje:  python3 -m pytest tools/test_dezurni_5631.py -q
Ništa se ne izvršava i ništa živo se ne dira: dijagnoza, postavke i HTTP su podmetnuti.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dezurni as dz  # noqa: E402

RADI = {"radi": True, "uzrok": None, "sto": "Sve radi.", "oporavak": None, "provjere": []}
NE_RADI = {"radi": False, "uzrok": "anthropic", "sto": "Anthropic ne odgovara.",
           "oporavak": "čim oni poprave; provjeravam svakih 30 minuta", "provjere": []}


def _kartica(monkeypatch, d):
    monkeypatch.setattr(dz, "dijagnoza", lambda: d)
    monkeypatch.setattr(dz, "postavke", lambda: {**dz.ZADANE_POSTAVKE, "provider": "openrouter", "model": "m"})
    return dz.kartica()


def test_kartica_kad_radi_ne_obecava_javljanje(monkeypatch):
    k = _kartica(monkeypatch, RADI)
    assert "RADI normalno" in k
    assert "javiti" not in k.lower()


def test_kartica_kad_ne_radi_obecava_javljanje(monkeypatch):
    assert "javiti cim se moze nastaviti" in _kartica(monkeypatch, NE_RADI).lower()


def _tijelo_openrouter(monkeypatch, p):
    uhvaceno = {}

    def lazni_http(url, tijelo, zaglavlja, rok=120):
        uhvaceno["tijelo"] = tijelo
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setattr(dz, "_http_json", lazni_http)
    monkeypatch.setattr(dz, "_ucitaj_kljuc", lambda ime: "lazni")
    monkeypatch.setattr(dz, "_konf_davatelja", lambda ime: {})
    assert dz.pitaj_model("s", "q", 100, p) == "ok"
    return uhvaceno["tijelo"]


def test_openrouter_zadano_bez_razmisljanja(monkeypatch):
    t = _tijelo_openrouter(monkeypatch, {"provider": "openrouter", "model": "m"})
    assert t["reasoning"] == {"enabled": False}


def test_openrouter_reasoning_low(monkeypatch):
    t = _tijelo_openrouter(monkeypatch, {"provider": "openrouter", "model": "m", "reasoning": "low"})
    assert t["reasoning"] == {"effort": "low"}


def test_openai_bez_polja_reasoning(monkeypatch):
    t = _tijelo_openrouter(monkeypatch, {"provider": "openai", "model": "m"})
    assert "reasoning" not in t
