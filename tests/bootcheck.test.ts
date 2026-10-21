/**
 * TASK-5657 (plan Mac v3 K4): scripts/bootcheck.sh — M1–M7 na Linuxu i macOS-u.
 *
 * Svako mjerenje dobiva podmetnut kontekst: Linux grana s lažnim systemctl/procfs podacima,
 * macOS grana kroz PRAVE funkcije platforme s lažnim izvršiteljem (launchctl, ps, lsof, sntp),
 * pa se obje grane provjeravaju na istom stroju. Mreža je podmetnuta (http/tcp), ništa ne izlazi van.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as B from '../scripts/bootcheck'
import type { Okolina } from '../src/core/platforma'

const KORIJEN = join(import.meta.dir, '..')
const MAPE: string[] = []
function privremena(pref: string): string { const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), pref)); MAPE.push(d); return d }
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })

const PAKET = '/home/x/TaskManagerAI'
const SADA = Date.parse('2026-10-21T01:00:00Z')

interface Mreza { http?: Record<string, number>; json?: Record<string, any>; tcp?: string[] }
/** Linux kontekst: usluga i procesi podmetnuti izravno (procfs grana platforme ima vlastite testove). */
function linux(over: Partial<B.Kontekst> = {}, mreza: Mreza = {}, datoteke: Record<string, string> = {}, izvrsi: Record<string, string> = {}): B.Kontekst {
  const ok: Okolina = { os: 'linux', izvrsi: (argv) => izvrsi[argv.join(' ')] ?? null }
  return {
    os: 'linux', okolina: ok, paket: PAKET, home: '/home/x', tmHome: '/home/x/.taskmanager', usluga: 'regoc-taskmanager',
    env: { TM_PORT: '17781', TM_ALLOWED_HOSTS: 'node-x' },
    opisUsluge: (ime) => ime === 'regoc-taskmanager' ? { stanje: 'active', pid: 500, cwd: PAKET } : { stanje: 'inactive', pid: null, cwd: null },
    procesi: () => [{ pid: 1, ppid: 0, cmd: '/sbin/init' }, { pid: 400, ppid: 1, cmd: '/lib/systemd/systemd --user' },
      { pid: 500, ppid: 400, cmd: '/home/x/.bun/bin/bun src/TaskWebUI.ts' }],
    cwd: (pid) => pid === 500 ? PAKET : null,
    pidNaVratima: (v) => v === 17781 ? 500 : null,
    okolinaProcesa: () => null,
    http: async (url, host) => mreza.http?.[`${url}|${host ?? ''}`] ?? mreza.http?.[url] ?? 0,
    json: async (url) => mreza.json?.[url] ?? null,
    tcp: async (h, p) => (mreza.tcp ?? []).includes(`${h}:${p}`),
    citaj: (p) => datoteke[p] ?? null,
    postoji: (p) => p in datoteke,
    sada: () => SADA,
    ...over,
  }
}
const ZDRAVA_PLOCA: Mreza = { http: {
  'http://127.0.0.1:17781/|node-x:17781': 200, 'http://127.0.0.1:17781/|evil.example.invalid': 403 } }

describe('M1 vlasnik usluge', () => {
  test('aktivna, MainPID drži upravitelj, radna mapa = paket → PASS', async () => {
    expect((await B.m1(linux())).sud).toBe('PASS')
  })
  test('neaktivna ili bez PID-a → FAIL', async () => {
    const r = await B.m1(linux({ opisUsluge: () => ({ stanje: 'inactive', pid: null, cwd: null }) }))
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('inactive')
  })
  test('upravitelj vodi uslugu iz druge mape (stara kopija, TASK-4712) → FAIL', async () => {
    const r = await B.m1(linux({ opisUsluge: () => ({ stanje: 'active', pid: 500, cwd: '/home/x/TaskManagerMD' }) }))
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('TaskManagerMD')
  })
})

describe('M2 radna mapa procesa', () => {
  test('cwd MainPID-a = paket i proces je ploča → PASS', async () => {
    expect((await B.m2(linux())).sud).toBe('PASS')
  })
  test('cwd druga mapa → FAIL', async () => {
    expect((await B.m2(linux({ cwd: () => '/tmp' }))).sud).toBe('FAIL')
  })
  test('MainPID nije ploča (npr. ljuska koja nije exec-ala) → FAIL', async () => {
    const r = await B.m2(linux({ procesi: () => [{ pid: 500, ppid: 400, cmd: 'bash -c sleep 9' }] }))
    expect(r.sud).toBe('FAIL')
  })
})

describe('M3 HTTP vlastiti/tuđi Host', () => {
  test('200 za vlastiti Host (prvi iz TM_ALLOWED_HOSTS), 403 za tuđi → PASS', async () => {
    expect((await B.m3(linux({}, ZDRAVA_PLOCA))).sud).toBe('PASS')
  })
  test('tuđi Host dobije 200 (brana Hosta ne radi) → FAIL', async () => {
    const r = await B.m3(linux({}, { http: { 'http://127.0.0.1:17781/|node-x:17781': 200, 'http://127.0.0.1:17781/|evil.example.invalid': 200 } }))
    expect(r.sud).toBe('FAIL')
  })
  test('TM_BIND samo na adresi tailneta → mjeri na toj adresi, ne na 127.0.0.1', async () => {
    const r = await B.m3(linux({ env: { TM_PORT: '17781', TM_BIND: '100.64.0.9', TM_ALLOWED_HOSTS: 'cvor' } },
      { http: { 'http://100.64.0.9:17781/|cvor:17781': 200, 'http://100.64.0.9:17781/|evil.example.invalid': 403 } }))
    expect(r.sud).toBe('PASS')
  })
})

describe('M4 osirotjeli procesi na vratima', () => {
  test('vrata drži MainPID, nema drugih ploča iz paketa → PASS', async () => {
    expect((await B.m4(linux())).sud).toBe('PASS')
  })
  test('vrata drži dijete MainPID-a (omotač) → PASS', async () => {
    const k = linux({ pidNaVratima: () => 501, procesi: () => [{ pid: 500, ppid: 400, cmd: 'bash s-okolinom.sh' },
      { pid: 501, ppid: 500, cmd: 'bun src/TaskWebUI.ts' }], cwd: () => PAKET })
    expect((await B.m4(k)).sud).toBe('PASS')
  })
  test('vrata drži osirotjeli bun (PPID=1, TASK-3682) → FAIL s PID-om', async () => {
    const k = linux({ pidNaVratima: () => 777, procesi: () => [{ pid: 500, ppid: 400, cmd: 'bun src/TaskWebUI.ts' },
      { pid: 777, ppid: 1, cmd: 'bun src/TaskWebUI.ts' }], cwd: () => PAKET })
    const r = await B.m4(k)
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('777')
  })
  test('druga ploča iz istog paketa izvan usluge → FAIL; ploča iz drugog stabla se ne broji', async () => {
    const k = linux({ procesi: () => [{ pid: 500, ppid: 400, cmd: 'bun src/TaskWebUI.ts' },
      { pid: 601, ppid: 1, cmd: 'bun src/TaskWebUI.ts' }, { pid: 602, ppid: 1, cmd: 'bun src/TaskWebUI.ts' }],
      cwd: (p) => p === 602 ? '/tmp/drugi-paket' : PAKET })
    const r = await B.m4(k)
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('601')
    expect(r.detalji.join(' ')).not.toContain('602')
  })
  test('nitko ne sluša na vratima → FAIL', async () => {
    expect((await B.m4(linux({ pidNaVratima: () => null }))).sud).toBe('FAIL')
  })
})

describe('M5 prijava modela (bilo koji davatelj) i mjerilo autonomije', () => {
  const H = '/home/x/.taskmanager'
  test('OpenRouter ključ u spremištu (ne Claude) → PASS; vrijednost se ne ispisuje', async () => {
    const r = await B.m5(linux({}, {}, { [`${H}/config/credentials.env`]: "OPENROUTER_API_KEY='sk-or-TAJNO'\n" }))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('openrouter')
    expect(JSON.stringify(r)).not.toContain('TAJNO')
  })
  test('Claude prijava datotekom na Linuxu → PASS', async () => {
    const r = await B.m5(linux({}, {}, { '/home/x/.claude/.credentials.json': '{}' }))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('claude')
  })
  test('nijedan servis nije prijavljen → UPOZORENJE s uputom (instalacija ne bira servis)', async () => {
    const r = await B.m5(linux())
    expect(r.sud).toBe('UPOZORENJE')
    expect(r.detalji.join(' ')).toContain('prijava-ai.ts')
  })
  test('prijavljen samo davatelj isključen u model-configu → UPOZORENJE', async () => {
    const r = await B.m5(linux({}, {}, {
      [`${H}/config/credentials.env`]: 'OPENAI_API_KEY=x\n',
      [`${H}/config/model-config.json`]: JSON.stringify({ providers: { openai: { apiKey: 'env:OPENAI_API_KEY', enabled: false } } }) }))
    expect(r.sud).toBe('UPOZORENJE')
  })
  test('Ollama uključena u model-configu i odgovara → PASS bez ijedne tajne', async () => {
    const r = await B.m5(linux({}, { http: { 'http://127.0.0.1:11434/api/tags': 200 } }, {
      [`${H}/config/model-config.json`]: JSON.stringify({ providers: { ollama: { enabled: true } } }) }))
    expect(r.sud).toBe('PASS')
  })
  const prijava = { [`${H}/config/credentials.env`]: 'ANTHROPIC_API_KEY=x\n' }
  test('autonomyGate uključen, mjerilo svježe → PASS', async () => {
    const r = await B.m5(linux({}, {}, { ...prijava, [`${PAKET}/config/features.json`]: '{"autonomyGate":{"enabled":true}}',
      [`${PAKET}/tools/session_usage.py`]: '#',
      [`${H}/data/session_usage.cache.json`]: JSON.stringify({ cached_at: SADA / 1000 - 600, entry: { status: 'allowed', http_error: null } }) }))
    expect(r.sud).toBe('PASS')
  })
  test('autonomyGate uključen, mjerilo nikad nije mjerilo (fail-open, TASK-4777) → FAIL', async () => {
    const r = await B.m5(linux({}, {}, { ...prijava, [`${PAKET}/config/features.json`]: '{"autonomyGate":{"enabled":true}}',
      [`${PAKET}/tools/session_usage.py`]: '#' }))
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('mjerilo')
  })
  test('autonomyGate uključen, zadnje mjerenje s HTTP greškom → FAIL', async () => {
    const r = await B.m5(linux({}, {}, { ...prijava, [`${PAKET}/config/features.json`]: '{"autonomyGate":{"enabled":true}}',
      [`${PAKET}/tools/session_usage.py`]: '#',
      [`${H}/data/session_usage.cache.json`]: JSON.stringify({ cached_at: SADA / 1000 - 60, entry: { http_error: 401 } }) }))
    expect(r.sud).toBe('FAIL')
  })
  test('features iz TM_FEATURES_FILE usluge; noviji keš iz TM_IZVORNI_PODACI ima prednost', async () => {
    const r = await B.m5(linux({ env: { TM_FEATURES_FILE: '/k/features.json', TM_IZVORNI_PODACI: '/k/data' } }, {}, { ...prijava,
      '/k/features.json': '{"autonomyGate":{"enabled":true}}', [`${PAKET}/tools/session_usage.py`]: '#',
      [`${H}/data/session_usage.cache.json`]: JSON.stringify({ cached_at: SADA / 1000 - 90000, entry: {} }),
      '/k/data/session_usage.cache.json': JSON.stringify({ cached_at: SADA / 1000 - 120, entry: { status: 'allowed' } }) }))
    expect(r.sud).toBe('PASS')
  })
  test('autonomyGate=false → mjerilo nije potrebno', async () => {
    const r = await B.m5(linux({}, {}, { ...prijava, [`${PAKET}/config/features.json`]: '{"autonomyGate":{"enabled":false}}' }))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('autonomyGate=false')
  })
})

describe('M6 sat', () => {
  test('Linux: NTPSynchronized=yes → PASS', async () => {
    const r = await B.m6(linux({}, {}, {}, { 'timedatectl show -p NTPSynchronized --value': 'yes\n' }))
    expect(r.sud).toBe('PASS')
  })
  test('Linux: NTP nije sinkroniziran, a HTTP Date kaže 4 h razlike (node-A, nodovi-zaostatak) → UPOZORENJE, nikad FAIL', async () => {
    const k = linux({}, {}, {}, { 'timedatectl show -p NTPSynchronized --value': 'no\n' })
    k.httpDatum = async () => SADA - 4 * 3600_000
    const r = await B.m6(k)
    expect(r.sud).toBe('UPOZORENJE')
    expect(r.detalji.join(' ')).toMatch(/14400|4 h/)
  })
})

describe('M7 izvori memorije i RAG-a odgovaraju prekidačima', () => {
  const H = '/home/x/.taskmanager'
  const mj = (memorija: string, rag: string, dodatno: any = {}) => JSON.stringify({
    memorija: { izvor: memorija, nasa: { host: '127.0.0.1', port: 17792 }, lokalna: { host: '127.0.0.1', port: 17796, usluga: 'regoc-hindsight', ...dodatno.mem } },
    rag: { izvor: rag, nasa: { host: '127.0.0.1', port: 15432 }, lokalna: { host: '127.0.0.1', port: 15433, baza: 'rag', korisnik: 'rag', lozinkaEnv: 'TM_PGVECTOR_LOKALNA_PASSWORD', usluga: 'regoc-pgvector' } } })
  test('nasa + iskljuceno: posrednik odgovara, lokalne usluge stoje → PASS', async () => {
    const r = await B.m7(linux({}, { http: { 'http://127.0.0.1:17792/health': 200 } }, { [`${H}/config/memorija.json`]: mj('nasa', 'iskljuceno') }))
    expect(r.sud).toBe('PASS')
  })
  test('nasa nedostupna (tunel pao) → UPOZORENJE: čvor radi dalje (fail-safe)', async () => {
    const r = await B.m7(linux({}, {}, { [`${H}/config/memorija.json`]: mj('nasa', 'iskljuceno') }))
    expect(r.sud).toBe('UPOZORENJE')
  })
  test('izvor nije lokalna, a lokalni Hindsight radi (troši RAM) → FAIL', async () => {
    const r = await B.m7(linux({ opisUsluge: (i) => i === 'regoc-hindsight' ? { stanje: 'active', pid: 9, cwd: null } : { stanje: 'active', pid: 500, cwd: PAKET } },
      { http: { 'http://127.0.0.1:17792/health': 200 } }, { [`${H}/config/memorija.json`]: mj('nasa', 'iskljuceno') }))
    expect(r.sud).toBe('FAIL')
    expect(r.detalji.join(' ')).toContain('regoc-hindsight')
  })
  test('memorija lokalna: usluga radi, banka čvora ima memorije → PASS; prazna banka → FAIL', async () => {
    const usl = (i: string) => i === 'regoc-hindsight' ? { stanje: 'active' as const, pid: 9, cwd: null } : { stanje: 'inactive' as const, pid: null, cwd: null }
    const dat = { [`${H}/config/memorija.json`]: mj('lokalna', 'iskljuceno') }
    const env = { MEMORIJA_BANKA: 'cvor_x' }
    const pun = await B.m7(linux({ opisUsluge: usl, env }, { http: { 'http://127.0.0.1:17796/health': 200 },
      json: { 'http://127.0.0.1:17796/v1/default/banks': { banks: [{ bank_id: 'cvor_x', fact_count: 1020 }] } } }, dat))
    expect(pun.sud).toBe('PASS')
    const prazan = await B.m7(linux({ opisUsluge: usl, env }, { http: { 'http://127.0.0.1:17796/health': 200 },
      json: { 'http://127.0.0.1:17796/v1/default/banks': { banks: [{ bank_id: 'cvor_x', fact_count: 0 }] } } }, dat))
    expect(prazan.sud).toBe('FAIL')
  })
  test('rag lokalna: pgvector radi i SELECT extversion vrati verziju → PASS; usluga stoji → FAIL', async () => {
    const usl = (i: string) => i === 'regoc-pgvector' ? { stanje: 'active' as const, pid: 9, cwd: null } : { stanje: 'inactive' as const, pid: null, cwd: null }
    const dat = { [`${H}/config/memorija.json`]: mj('iskljuceno', 'lokalna'), [`${H}/rag/spremno.json`]: '{"bin":"/pg/bin"}',
      [`${H}/config/credentials.env`]: "TM_PGVECTOR_LOKALNA_PASSWORD='p'\n", '/pg/bin/psql': '' }
    const upit = "/pg/bin/psql -h 127.0.0.1 -p 15433 -U rag -d rag -tAc SELECT extversion FROM pg_extension WHERE extname='vector'"
    const r = await B.m7(linux({ opisUsluge: usl }, { tcp: ['127.0.0.1:15433'] }, dat, { [upit]: '0.8.1\n' }))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('0.8.1')
    const stoji = await B.m7(linux({}, { tcp: [] }, dat, { [upit]: '0.8.1\n' }))
    expect(stoji.sud).toBe('FAIL')
  })
  test('rag iskljuceno, a memory-config paketa ima rag.enabled=true → FAIL (prekidač i stvarnost se razilaze)', async () => {
    const r = await B.m7(linux({}, {}, { [`${H}/config/memorija.json`]: mj('iskljuceno', 'iskljuceno'),
      [`${H}/config/memory-config.json`]: '{"rag":{"enabled":true}}' }))
    expect(r.sud).toBe('FAIL')
  })
  test('bez memorija.json (starija instalacija, node-A): izvor izveden iz MEMORIJA_BANKA i memory-config → nasa/iskljuceno', async () => {
    const r = await B.m7(linux({ env: { MEMORIJA_BANKA: 'cvor_x' } }, { http: { 'http://127.0.0.1:17792/health': 200 } }, {}))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('izvedeno')
  })
  test('TASK-5658: memorija.json = config/memorija.primjer.json (prazni host/port) → zadane adrese na 127.0.0.1', async () => {
    const primjer = readFileSync(join(KORIJEN, 'config/memorija.primjer.json'), 'utf-8')
    const r = await B.m7(linux({}, { http: { 'http://127.0.0.1:17792/health': 200 } }, { [`${H}/config/memorija.json`]: primjer }))
    expect(r.sud).toBe('PASS')
    expect(r.detalji.join(' ')).toContain('http://127.0.0.1:17792/health → 200')
  })
})

describe('macOS: cijeli bootcheck kroz prave funkcije platforme (launchctl, ps, lsof, sntp)', () => {
  const MP = '/Users/r/TaskManagerAI'
  const odg: Record<string, string> = {
    'launchctl print system/hr.regoc.taskmanager': `\tstate = running\n\tworking directory = ${MP}\n\tpid = 311\n`,
    'launchctl print system/hr.regoc.hindsight': '\tstate = not running\n',
    'lsof -a -p 311 -d cwd -Fn': `p311\nfcwd\nn${MP}\n`,
    'ps -A -o pid=,ppid=,command=': '    1     0 /sbin/launchd\n  311     1 /Users/r/.bun/bin/bun src/TaskWebUI.ts\n  400     1 /usr/sbin/sshd\n',
    'lsof -nP -iTCP:17781 -sTCP:LISTEN -t': '311\n',
    'sntp -t 5 time.apple.com': '+0.002 +/- 0.02 time.apple.com 17.253.14.45\n',
  }
  const ok: Okolina = { os: 'darwin', izvrsi: (argv) => odg[argv.join(' ')] ?? null, imaNaredbu: () => false }
  const datoteke: Record<string, string> = { '/Users/r/.taskmanager/config/credentials.env': "CLAUDE_CODE_OAUTH_TOKEN='x'\n",
    '/Users/r/.taskmanager/config/memorija.json': JSON.stringify({ memorija: { izvor: 'nasa' }, rag: { izvor: 'iskljuceno' } }) }
  const k = B.napraviKontekst({ os: 'darwin', okolina: ok, paket: MP, home: '/Users/r', env: { TM_PORT: '17781', TM_ALLOWED_HOSTS: 'mac.tailnet' },
    http: async (url, host) => ({ 'http://127.0.0.1:17781/|mac.tailnet:17781': 200, 'http://127.0.0.1:17781/|evil.example.invalid': 403,
      'http://127.0.0.1:17792/health|': 200 } as Record<string, number>)[`${url}|${host ?? ''}`] ?? 0,
    json: async () => null, tcp: async () => false,
    citaj: (p) => datoteke[p] ?? null, postoji: (p) => p in datoteke, sada: () => SADA, realpath: (p) => p })
  test('M1–M8 PASS; Claude pretplata na Macu se priznaje samo kroz token (Keychain usluga ne vidi)', async () => {
    const izvj = await B.pokreni(k)
    expect(izvj.mjerenja.map(m => `${m.id}=${m.sud}`)).toEqual(['M1=PASS', 'M2=PASS', 'M3=PASS', 'M4=PASS', 'M5=PASS', 'M6=PASS', 'M7=PASS', 'M8=PASS'])
    expect(izvj.verdikt).toBe('PASS')
  })
  test('PPID=1 na macOS-u NIJE siroče — launchd je roditelj LaunchDaemona', async () => {
    expect((await B.m4(k)).sud).toBe('PASS')
  })
  test('Mac: odstupanje sntp 95 s → M6 UPOZORENJE', async () => {
    const k2 = { ...k, okolina: { ...ok, izvrsi: (a: string[]) => a[0] === 'sntp' ? '+95.1 +/- 0.02 time.apple.com 1.2.3.4\n' : ok.izvrsi!(a) } }
    expect((await B.m6(k2)).sud).toBe('UPOZORENJE')
  })
})

describe('verdikt, izlaz i ljuska scripts/bootcheck.sh', () => {
  test('UPOZORENJE ne obara verdikt; --strogo ga obara; FAIL uvijek obara', () => {
    const m = (sud: B.Sud) => ({ id: 'M1', naslov: '', sud, detalji: [] })
    expect(B.verdikt([m('PASS'), m('UPOZORENJE')])).toBe('PASS')
    expect(B.verdikt([m('PASS'), m('UPOZORENJE')], true)).toBe('FAIL')
    expect(B.verdikt([m('PASS'), m('FAIL')])).toBe('FAIL')
  })
  test('pravi poziv na stroju bez usluge: izlaz 1, zapis u $TM_HOME/log/bootcheck (txt+json), bez tajni u zapisu', () => {
    const tm = privremena('tm-bootcheck-')
    mkdirSync(join(tm, 'config'), { recursive: true })
    writeFileSync(join(tm, 'config/credentials.env'), "OPENROUTER_API_KEY='sk-or-NEVIDLJIVA'\n", { mode: 0o600 })
    writeFileSync(join(tm, 'config/postavke.env'), 'TM_PORT=1\n')
    const r = Bun.spawnSync(['bash', 'scripts/bootcheck.sh', '--cekaj', '0', '--usluga', 'regoc-nepostojeca-5657'],
      { cwd: KORIJEN, env: { PATH: process.env.PATH!, HOME: tm, TM_HOME: tm } })
    const izlaz = r.stdout.toString()
    expect(r.exitCode).toBe(1)
    expect(izlaz).toMatch(/M1 .*FAIL/)
    expect(izlaz).toContain('VERDIKT: FAIL')
    expect(izlaz).not.toContain('NEVIDLJIVA')
    expect(existsSync(join(tm, 'log/bootcheck/zadnji.txt'))).toBe(true)
    const j = JSON.parse(readFileSync(join(tm, 'log/bootcheck/zadnji.json'), 'utf-8'))
    expect(j.mjerenja.length).toBe(8)
    expect(j.verdikt).toBe('FAIL')
    expect(JSON.stringify(j)).not.toContain('NEVIDLJIVA')
  }, 60_000)
  test('bootcheck.sh je bash 3.2 kompatibilan (macOS /bin/bash): bez mapfile, declare -A, ${x,,}', () => {
    const t = readFileSync(join(KORIJEN, 'scripts/bootcheck.sh'), 'utf-8')
    expect(t).not.toMatch(/mapfile|readarray|declare -A|\$\{[a-zA-Z_]+,,\}|\$\{[a-zA-Z_]+\^\^\}/)
    expect(Bun.spawnSync(['bash', '-n', join(KORIJEN, 'scripts/bootcheck.sh')]).exitCode).toBe(0)
  })
  test('--help izlazi s 0, nepoznata opcija s 2', () => {
    expect(Bun.spawnSync(['bash', 'scripts/bootcheck.sh', '--help'], { cwd: KORIJEN }).exitCode).toBe(0)
    expect(Bun.spawnSync(['bash', 'scripts/bootcheck.sh', '--nema'], { cwd: KORIJEN }).exitCode).toBe(2)
  })
})
