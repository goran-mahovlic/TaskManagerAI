#!/usr/bin/env python3
"""TASK-5295: stanje čvora kao JSON — SAMO netajni ključevi (bijela lista), samo čitanje."""
import hashlib, json, os, sqlite3
H = os.path.expanduser('~'); P = H + '/TaskManagerAI'
TAJNO = {'TM_CREDENTIALS', 'TM_BOT_KANAL_TOKEN'}
env = {}
for r in open(P + '/config/postavke.env', encoding='utf-8'):
    r = r.strip()
    if r and not r.startswith('#') and '=' in r:
        k, v = r.split('=', 1)
        env[k] = '<tajna-postoji>' if k in TAJNO else v
try:
    tg = json.load(open(P + '/config/telegram.json')); tg.pop('botToken', None)
except Exception:
    tg = {}
db = env.get('TM_DB') or H + '/.taskmanager/data/tasks.db'
c = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
st = {}
for k, v in c.execute("select key,value from settings where key like 'razgovor.%' or key like 'memorija.%'"):
    if k == 'razgovor.botKanal.stanje': continue
    try: st[k] = json.loads(v)
    except Exception: st[k] = v
cap = {}
try: cap = {k: v.get('on') for k, v in json.load(open('/etc/regoc/capabilities.state'))['capabilities'].items()}
except Exception: pass
try: hooks = json.load(open(H + '/.claude/settings.json')).get('hooks')
except Exception: hooks = None
sv = H + '/.claude/hooks/SecurityValidator.hook.ts'
sha = hashlib.sha256(open(sv, 'rb').read()).hexdigest() if os.path.exists(sv) else None
print(json.dumps({'home': H, 'env': env, 'telegram': tg, 'settings': st, 'capguard': cap,
                  'settingsJsonHooks': hooks, 'secvalSha': sha}, ensure_ascii=False))
