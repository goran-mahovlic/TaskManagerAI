#!/usr/bin/env python3
"""Paritet čvora s glavnim sustavom (TASK-5307, ADR-0004 §13) — SAMO ČITANJE.

Uspoređuje lokalni stroj (glavni) s čvorom preko ssh-a u četiri osi:
  kuke      ~/.claude/settings.json → broj kuka po događaju + datoteke kuka koje fale
  značajke  ~/.claude/regoc/features.json → ključevi, ON, razlike, ključevi bez koda na čvoru
  kod       ~/.claude/regoc/*.ts → moduli koji fale na čvoru
  konzola   izvori konzole ploče (~/.tmp/regoc_logs/*.log, daemon.log) → postoji / svjež

Ne čita i ne ispisuje nijednu tajnu: settings.json se svodi na imena kuka,
features.json na `enabled`. Na čvoru ništa ne piše (jedino `cat`/`ls`/`grep`/`stat`).

  python3 paritet.py regoc@10.0.0.20            # sažetak
  python3 paritet.py regoc@10.0.0.20 --tsv      # i tablica značajki (ključ, glavni, čvor, kod na čvoru)
Izlaz: 0 = paritet, 1 = ima razlika (izvještaj), 2 = čvor nedostupan.
"""
import json, os, re, subprocess, sys

HOME = os.path.expanduser('~')
SVJEZE_S = 24 * 3600


def ssh(cilj, cmd):
    r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', cilj, cmd],
                       capture_output=True, text=True, timeout=60)
    if r.returncode == 255:
        print(f'čvor nedostupan: {r.stderr.strip()[:200]}'); sys.exit(2)
    return r.stdout


def lokalno(cmd):
    return subprocess.run(['bash', '-c', cmd], capture_output=True, text=True, timeout=60).stdout


SONDA = r'''
echo '@@settings'; cat ~/.claude/settings.json 2>/dev/null; echo
echo '@@features'; cat ~/.claude/regoc/features.json 2>/dev/null; echo
echo '@@moduli'; (cd ~/.claude/regoc 2>/dev/null && ls *.ts) | LC_ALL=C sort
echo '@@kuke'; (cd ~/.claude/hooks 2>/dev/null && ls *.ts UserPromptSubmit/*.ts 2>/dev/null) | xargs -rn1 basename | LC_ALL=C sort
echo '@@konzola'; for f in ~/.tmp/regoc_daemon.log ~/.tmp/regoc_logs/regoc.log ~/.tmp/regoc_logs/klaudio.log ~/.tmp/regoc_logs/voiceserver.log ~/.tmp/regoc_logs/taskwebui.log; do
  if [ -e "$f" ]; then echo "$(basename $f) $(( $(date +%s) - $(stat -L -c %Y "$f") ))"; else echo "$(basename $f) -1"; fi; done
echo '@@izvori'; cd ~/.claude/regoc 2>/dev/null && cat *.ts lib/*.ts 2>/dev/null | grep -oE "isEnabled\('[A-Za-z0-9]+'" | sort -u
echo '@@kraj'
'''


def rastavi(tekst):
    dijelovi, ime = {}, None
    for red in tekst.splitlines():
        m = re.match(r'^@@(\w+)$', red)
        if m:
            ime = m.group(1); dijelovi[ime] = []
        elif ime:
            dijelovi[ime].append(red)
    return {k: '\n'.join(v) for k, v in dijelovi.items()}


def kuke(settings_txt):
    try:
        h = json.loads(settings_txt or '{}').get('hooks', {})
    except json.JSONDecodeError:
        return {}, []
    po_dogadaju = {ev: sum(len(m.get('hooks', [])) for m in v) for ev, v in h.items()}
    imena = []
    for ev, v in h.items():
        for m in v:
            for x in m.get('hooks', []):
                cmd = x.get('command', '')
                ime = re.search(r'([A-Za-z]+(?:\.hook\.ts|\.py))', cmd)
                imena.append(f"{ev}:{ime.group(1) if ime else cmd[:40]}")
    return po_dogadaju, imena


def znacajke(txt):
    try:
        d = json.loads(txt or '{}')
    except json.JSONDecodeError:
        return {}
    return {k: (v.get('enabled') if isinstance(v, dict) else v) for k, v in d.items() if not k.startswith('_')}


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    cilj, tsv = sys.argv[1], '--tsv' in sys.argv
    g, c = rastavi(lokalno(SONDA)), rastavi(ssh(cilj, SONDA))
    razlika = 0

    gk, gi = kuke(g.get('settings')); ck, ci = kuke(c.get('settings'))
    print(f"KUKE  glavni {sum(gk.values())} {gk}")
    print(f"      čvor   {sum(ck.values())} {ck}")
    fale_kuke = sorted(set(gi) - set(ci))
    print(f"      nespojeno na čvoru ({len(fale_kuke)}): {', '.join(fale_kuke)}")
    gdat, cdat = set(g.get('kuke', '').split()), set(c.get('kuke', '').split())
    print(f"      datoteke kuka koje fale na čvoru ({len(gdat - cdat)}): {', '.join(sorted(gdat - cdat))}")
    razlika += len(fale_kuke)

    gz, cz = znacajke(g.get('features')), znacajke(c.get('features'))
    on = lambda d: sum(1 for v in d.values() if v is True)
    print(f"ZNAČAJKE glavni {len(gz)} ({on(gz)} ON) | čvor {len(cz)} ({on(cz)} ON)")
    kod_cvor = set(re.findall(r"isEnabled\('([A-Za-z0-9]+)'", c.get('izvori', '')))
    kod_glavni = set(re.findall(r"isEnabled\('([A-Za-z0-9]+)'", g.get('izvori', '')))
    rz = [k for k in gz if bool(gz.get(k)) != bool(cz.get(k))]
    print(f"      različito uključeno ({len(rz)}): " + ', '.join(f"{k}[{'ON' if gz.get(k) else 'off'}→{'ON' if cz.get(k) else 'off'}]" for k in rz))
    bez_koda = sorted(k for k in gz if k in kod_glavni and k not in kod_cvor)
    print(f"      prekidač na glavnom ima kod, na čvoru nema ({len(bez_koda)}): {', '.join(bez_koda)}")
    razlika += len(rz)

    gm, cm = set(g.get('moduli', '').split()), set(c.get('moduli', '').split())
    fale_mod = sorted(gm - cm)
    print(f"KOD   moduli glavni {len(gm)} | čvor {len(cm)} | fale na čvoru ({len(fale_mod)}): {', '.join(fale_mod)}")
    razlika += len(fale_mod)

    def konz(d):
        out = {}
        for red in d.get('konzola', '').splitlines():
            ime, s = red.split(); s = int(s)
            out[ime] = 'nema' if s < 0 else ('svjež' if s < SVJEZE_S else f'star {s // 86400} d')
        return out
    gkz, ckz = konz(g), konz(c)
    print('KONZOLA ' + ' | '.join(f"{k}: glavni {gkz.get(k)} / čvor {ckz.get(k)}" for k in gkz))
    razlika += sum(1 for k in gkz if gkz[k] == 'svjež' and ckz.get(k) != 'svjež')

    if tsv:
        print('\nključ\tglavni\tčvor\tkod_na_čvoru')
        for k in list(gz) + [k for k in cz if k not in gz]:
            print(f"{k}\t{gz.get(k)}\t{cz.get(k)}\t{'da' if k in kod_cvor else ('ne' if k in kod_glavni else '—')}")
    print(f"\nUKUPNO razlika: {razlika}")
    sys.exit(0 if razlika == 0 else 1)


if __name__ == '__main__':
    main()
