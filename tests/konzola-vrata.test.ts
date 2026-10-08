// TASK-5352 (ADR-0007, nalaz QA TASK-5344) — `/api/konzola/exec` je čitao spremište tajni
// (cat/grep/tail…) preko LAN-a bez ikakve prijave. Brane: (b) vrata konzole — samo loopback
// ili Tailscale + CSRF zaglavlje X-TM-Konzola; (a) bez čitača datoteka i bez putova tajni.
import { describe, expect, test } from 'bun:test'
import { odlukaNaredbe, vrataKonzole } from '../src/KonzolaVrata'

const zag = (h: Record<string, string> = {}) =>
  new Headers({ 'Content-Type': 'application/json', 'X-TM-Konzola': '1', Host: 'ploca:17781', ...h })
const z = (ip: string | null, h?: Record<string, string>) => ({ metoda: 'POST', zaglavlja: zag(h), ip })

describe('vrataKonzole — prijenos (isti sud kao tajne, bez iznimke za LAN HTTP)', () => {
  test('loopback i Tailscale prolaze', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.7', '100.127.1.1', 'fd7a:115c:a1e0::5'])
      expect(vrataKonzole(z(ip))).toBeNull()
  })
  test('LAN, javna adresa i nepoznat peer se odbijaju (403)', () => {
    for (const ip of ['192.0.2.20', '10.0.0.5', '172.24.0.2', '100.128.0.1', '8.8.8.8', null]) {
      const r = vrataKonzole(z(ip))
      expect(r?.status).toBe(403)
      expect(r?.greska).toMatch(/^konzola_prijenos/)
    }
  })
})

describe('vrataKonzole — CSRF', () => {
  test('bez X-TM-Konzola → 403 (stranica s tuđeg izvora ne može poslati jednostavan POST)', () => {
    const h = new Headers({ 'Content-Type': 'application/json', Host: 'ploca:17781' })
    expect(vrataKonzole({ metoda: 'POST', zaglavlja: h, ip: '127.0.0.1' })?.greska).toBe('konzola_csrf')
  })
  test('text/plain tijelo, tuđi Origin ili Sec-Fetch-Site cross-site → 403', () => {
    expect(vrataKonzole(z('127.0.0.1', { 'Content-Type': 'text/plain' }))?.greska).toBe('konzola_csrf')
    expect(vrataKonzole(z('127.0.0.1', { Origin: 'http://zlo.example' }))?.greska).toBe('konzola_csrf')
    expect(vrataKonzole(z('127.0.0.1', { 'Sec-Fetch-Site': 'cross-site' }))?.greska).toBe('konzola_csrf')
  })
  test('vlastiti Origin i same-origin prolaze', () => {
    expect(vrataKonzole(z('127.0.0.1', { Origin: 'http://ploca:17781', 'Sec-Fetch-Site': 'same-origin' }))).toBeNull()
  })
})

describe('odlukaNaredbe — nema čitača datoteka ni putova tajni', () => {
  const ne = (cmd: string, nacin: 'plan' | 'work' = 'work') => {
    const r = odlukaNaredbe(cmd, nacin, {})
    expect('status' in r ? r.status : 200).toBe(403)
  }
  test('cat/head/tail/grep/find/less/more/strings/xxd/od/base64 se odbijaju', () => {
    for (const c of ['cat ~/.config/x/credentials.env', 'head -c 999 config/credentials.env',
      'tail -n 5 /proc/1/environ', 'grep -r TOKEN /home', 'find / -name credentials.env -exec cat {} ;',
      'less x', 'more x', 'strings x', 'xxd x', 'od -c x', 'base64 x']) ne(c)
  })
  test('ps ne smije ispisati okolinu procesa (BSD „e", -o environ, --format)', () => {
    for (const c of ['ps e', 'ps eww', 'ps auxe', 'ps -o environ', 'ps --format=pid,environ', 'ps -p 1 -o args,environ']) ne(c)
    for (const c of ['ps', 'ps aux', 'ps -ef', 'ps auxf']) expect(odlukaNaredbe(c, 'plan', {})).toEqual({ argv: c.split(' ') })
  })
  test('putovi tajni i /proc/*/environ se odbijaju i za dopuštene naredbe', () => {
    for (const c of ['ls /proc/1/environ', 'wc -c config/credentials.env', 'ls ~/.config/x/.env', 'wc /proc/self/environ']) ne(c)
  })
  test('git ne čita datoteke izvan repozitorija (--no-index, -C, --output, apsolutni put, ..)', () => {
    for (const c of ['git diff --no-index /dev/null /home/k/.config/x/credentials.env',
      'git -C / log', 'git log --output=/tmp/x', 'git diff /etc/passwd', 'git show HEAD:../../x',
      'git -c core.pager=cat log', 'git diff --ext-diff']) ne(c)
    expect(odlukaNaredbe('git log --oneline -5', 'plan', {})).toEqual({ argv: ['git', 'log', '--oneline', '-5'] })
    expect(odlukaNaredbe('git log main..HEAD', 'plan', {})).toEqual({ argv: ['git', 'log', 'main..HEAD'] })
    expect(odlukaNaredbe('wc -l src/TajneApi.ts', 'plan', {})).toEqual({ argv: ['wc', '-l', 'src/TajneApi.ts'] })
  })
  test('git: skraćene duge opcije i put iza „=" ne zaobilaze zabranu', () => {
    for (const c of ['git diff --no-ind a b', 'git diff --no-i a b', 'git log --out=x', 'git log --outp=x',
      'git diff --ext-d', 'git log --format=x --src-prefix=/etc/', 'git log --git-d=/x', 'git show --textc']) ne(c)
    expect(odlukaNaredbe('git log --stat --format=%h', 'plan', {})).toEqual({ argv: ['git', 'log', '--stat', '--format=%h'] })
  })
  test('skriveni čitači kroz poruku o grešci: wc --files0-from, date -f/--file, hostname -F', () => {
    for (const c of ['wc --files0-from=x', 'wc --files0', 'date -f x', 'date --file=x', 'date --fi=x', 'hostname -F x', 'hostname --file x']) ne(c)
    for (const c of ['wc -l x', 'wc -lc x', 'date +%F', 'date -u', 'date -Iseconds', 'date --iso-8601=seconds', 'hostname -I', 'hostname -f'])
      expect(odlukaNaredbe(c, 'plan', {})).toEqual({ argv: c.split(' ') })
  })
  test('git u plan načinu samo čita; bun/node samo u work načinu', () => {
    ne('git commit -m x', 'plan')
    ne('bun --version', 'plan')
    expect(odlukaNaredbe('bun --version', 'work', {})).toEqual({ argv: ['bun', '--version'] })
  })
  test('alias prolazi; ostalo s popisa radi kao prije', () => {
    expect(odlukaNaredbe('services', 'plan', { services: ['/x/regoc-services.sh', 'status'] })).toEqual({ argv: ['/x/regoc-services.sh', 'status'] })
    for (const c of ['ls -la', 'whoami', 'df -h', 'free -m', 'uptime', 'date', 'hostname', 'wc -l src/TaskWebUI.ts'])
      expect(odlukaNaredbe(c, 'plan', {})).toEqual({ argv: c.split(' ') })
  })
  test('stare blokade ostaju (sudo, $(…), rm -rf), prazna naredba → 400', () => {
    ne('ls $(cat x)'); ne('sudo ls'); ne('ls; rm -rf /')
    expect(odlukaNaredbe('   ', 'work', {})).toMatchObject({ status: 400 })
  })
})
