# P3 (TASK-5298): pokreće se NA ČVORU; uspoređuje izlaz alata (stdin) sa stvarnim vrijednostima tajni.
# Ispisuje SAMO imena polja i brojeve — nikad vrijednost ni dio vrijednosti.
import sys, os, json
izlaz = sys.stdin.read()
H = os.path.expanduser('~')
env = {}
for l in open(H + '/TaskManagerAI/config/postavke.env'):
    if '=' in l and not l.startswith('#'):
        k, v = l.rstrip('\n').split('=', 1); env[k] = v.strip().strip('"\'')

def listovi(o, put):
    if isinstance(o, dict):
        for k, v in o.items(): yield from listovi(v, put + '.' + k)
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from listovi(v, put + '[%d]' % i)
    elif isinstance(o, str): yield put, o

def iz_datoteke(ime, put):
    if not put or not os.path.exists(os.path.expanduser(put)): return []
    t = open(os.path.expanduser(put)).read()
    try: return [(ime + p, v) for p, v in listovi(json.loads(t), '')]
    except Exception:
        r = []
        for l in t.splitlines():
            if '=' in l and not l.startswith('#'):
                k, v = l.split('=', 1); r.append((ime + ':' + k.strip(), v.strip().strip('"\'')))
        return r or [(ime + '(sirovo)', t.strip())]

tajne = []
if env.get('TM_BOT_KANAL_TOKEN'): tajne.append(('TM_BOT_KANAL_TOKEN', env['TM_BOT_KANAL_TOKEN']))
tajne += iz_datoteke('TM_CREDENTIALS', env.get('TM_CREDENTIALS'))
tajne += iz_datoteke('claude-prijava', H + '/.claude/.credentials.json')
tajne = [(i, v) for i, v in tajne if len(v) >= 16]  # kratke vrijednosti (vrsta pretplate i sl.) nisu tajna
pogodaka = 0
for ime, v in tajne:
    cijela = v in izlaz
    dio = any(v[i:i + 12] in izlaz for i in range(0, len(v) - 11))  # bilo koji 12-znakovni odsječak
    pogodaka += (cijela or dio)
    print('%s: cijela=%s odsjecak12=%s' % (ime, 'DA' if cijela else 'ne', 'DA' if dio else 'ne'))
print('TAJNI_PROVJERENO=%d POGODAKA=%d IZLAZ_BAJTOVA=%d' % (len(tajne), pogodaka, len(izlaz.encode())))
