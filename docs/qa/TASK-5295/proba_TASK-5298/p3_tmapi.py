# P3 dopuna: je li TASK_MANAGER_API URL i potječe li pogodak odsječka iz javnog oblika adrese. Ispisuje samo da/ne.
import sys, os, re
izlaz = sys.stdin.read()
H = os.path.expanduser('~')
env = dict(l.rstrip('\n').split('=', 1) for l in open(H + '/TaskManagerAI/config/postavke.env') if '=' in l and not l.startswith('#'))
v = ''
for l in open(os.path.expanduser(env['TM_CREDENTIALS'].strip())):
    if l.startswith('TASK_MANAGER_API='): v = l.split('=', 1)[1].strip().strip('"\'')
pog = [v[i:i + 12] for i in range(len(v) - 11) if v[i:i + 12] in izlaz]
print('je_url=%s lokalna_adresa=%s pogodaka_odsjecaka=%d svi_pogoci_unutar_http_127_0_0_1=%s' % (
    bool(re.match(r'^https?://', v)), bool(re.match(r'^https?://(127\.0\.0\.1|localhost)(:\d+)?(/.*)?$', v)),
    len(pog), all(p in 'http://127.0.0.1:1778' or p in 'http://127.0.0.1:1779' for p in pog)))
