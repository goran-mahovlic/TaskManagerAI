#!/usr/bin/env python3
"""TASK-5295: profil.json + instanca.env -> očekivane vrijednosti; usporedi sa stanjem čvora (stdin JSON).

Stanje čvora skuplja stanje_cvora.py NA ČVORU (samo netajni ključevi). Ovo je proba dizajna,
ne alat iz ADR-0004 (njega piše Jelena kao scripts/profil-cvora.ts).
"""
import json, re, sys

profil = json.load(open(sys.argv[1]))
inst = {}
for r in open(sys.argv[2], encoding='utf-8'):
    r = r.strip()
    if r and not r.startswith('#') and '=' in r:
        k, v = r.split('=', 1); inst[k] = v
stanje = json.load(sys.stdin)
inst.setdefault('HOME', stanje['home'])

def zamijeni(v):
    if isinstance(v, str):
        m = re.fullmatch(r'\$\{(\w+):json\}', v)
        if m: return json.loads(inst.get(m.group(1)) or '[]')
        return re.sub(r'\$\{(\w+)\}', lambda m: inst.get(m.group(1), ''), v)
    if isinstance(v, dict): return {k: zamijeni(x) for k, x in v.items()}
    if isinstance(v, list): return [zamijeni(x) for x in v]
    return v

ok = razlika = 0
def usporedi(ime, ocek, stv):
    global ok, razlika
    if ocek == stv: ok += 1
    else:
        razlika += 1; print(f'RAZLIKA {ime}: profil={json.dumps(ocek, ensure_ascii=False)} cvor={json.dumps(stv, ensure_ascii=False)}')

M = profil['moduli']
for k, v in zamijeni(M['okolina']['postavkeEnv']).items():
    usporedi('env.' + k, v, stanje['env'].get(k))
for k in M['okolina']['nesmijeBiti']:
    usporedi('env.nema.' + k, False, k in stanje['env'])
def ravno(o, p=''):
    for k, v in o.items():
        if isinstance(v, dict): yield from ravno(v, p + k + '.')
        else: yield p + k, v
tg_stv = dict(ravno(stanje['telegram']))
for k, v in ravno(zamijeni(M['telegram']['json'])):
    usporedi('telegram.' + k, v, tg_stv.get(k))
for mod in ('razgovor', 'glas', 'memorija', 'bot-kanal'):
    for k, v in zamijeni(M[mod]['settings']).items():
        stv = stanje['settings'].get(k)
        if stv is None and k == 'memorija.oznakaUspjeha': stv = False  # nije upisano = zadano
        usporedi('settings.' + k, v, stv)
for k, v in M['capguard']['zeljeno'].items():
    usporedi('capguard.' + k, v, stanje['capguard'].get(k))
usporedi('claude.settingsJson.hooks', zamijeni(M['claude']['settingsJson']['hooks']), stanje['settingsJsonHooks'])
usporedi('claude.SecurityValidator.sha256', inst.get('SECURITYVALIDATOR_SHA256'), stanje['secvalSha'])
print(f'ISTO {ok}  RAZLIKA {razlika}')
sys.exit(1 if razlika else 0)
