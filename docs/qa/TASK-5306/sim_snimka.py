#!/usr/bin/env python3
"""TASK-5306: simulirana potrošena Anthropic sesija — drži session_usage.cache.json na SIM_PCT % (zadano 99) (svježe).
Daemon svakih 5 min sam izmjeri i prepiše keš; ova petlja ga vraća na 99 % svake 2 s.
Zaustavljanje: kill PID (pa svježe mjerenje: python3 ~/app/regoc_system/tools/session_usage.py --quiet)."""
import json, os, time
PCT = float(os.environ.get('SIM_PCT', '99'))
P = os.path.expanduser('~/.claude/regoc/data/session_usage.cache.json')
while True:
    try:
        cur = json.load(open(P)).get('entry', {})
    except Exception:
        cur = {}
    e = dict(cur)
    e.update({'ts': time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime()), 'session_percent': PCT,
              'status': 'allowed_warning', 'http_error': None, 'simulacija': 'TASK-5306'})
    if cur.get('session_percent') != PCT or time.time() % 30 < 2:
        tmp = P + '.sim'
        json.dump({'cached_at': time.time(), 'entry': e}, open(tmp, 'w'))
        os.replace(tmp, P)
    time.sleep(2)
