/**
 * TASK-5655 (plan Mac v3 K2, P3, P3.1): scripts/install.sh — jedan ulaz za Debian i macOS.
 *
 * Kriteriji koje ovaj test drži (bez mreže, bez sudo-a, u privremenom HOME-u i kopiji paketa):
 *   • --suho ne piše NIŠTA (ni HOME, ni stablo paketa) i ispisuje svaki korak,
 *   • svaki korak ima redak u koraci.jsonl s izlaznim kodom (i preskočeni),
 *   • drugo uzastopno pokretanje javlja „0 promjena",
 *   • pad koraka ostavlja install-rezultat.json s "ishod":"pad", korakom i izlaznim kodom,
 *   • na macOS-u (lažni darwin) --suho ispisuje svih 35 redaka tablice P10,
 *   • komplet se uzima samo iz config/komplet.lock, uz provjeru manifesta.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { tmpdir } from 'os'
import { osigurajOvisnosti } from './helpers/ovisnosti'

const KORIJEN = join(import.meta.dir, '..')
// svježa kopija stabla nema node_modules → bun install prije testova (uputa #421)
const NODE_MODULES = osigurajOvisnosti(KORIJEN)
const BUN_DIR = dirname(process.execPath)
const radna = () => process.env.TMPDIR || tmpdir()

interface Okruzje { korijen: string; home: string; paket: string; tm: string }

/** Kopija paketa (praćene + nove datoteke radnog stabla) kao čist git klon, i prazan HOME. */
function okruzje(ime: string, uredi?: (paket: string) => void): Okruzje {
  const korijen = mkdtempSync(join(radna(), `tm-inst-${ime}-`))
  const home = join(korijen, 'home'), paket = join(korijen, 'paket')
  mkdirSync(home, { recursive: true })
  const popis = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: KORIJEN }).stdout.toString().split('\0').filter(Boolean)
  for (const rel of popis) {
    const izvor = join(KORIJEN, rel)
    if (!existsSync(izvor)) continue
    mkdirSync(dirname(join(paket, rel)), { recursive: true })
    cpSync(izvor, join(paket, rel))
  }
  uredi?.(paket)
  const g = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=proba', '-c', 'user.email=proba@example.invalid', ...a], { cwd: paket })
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '--no-verify', '-m', 'proba')
  return { korijen, home, paket, tm: join(home, '.taskmanager') }
}

function pokreni(o: Okruzje, argv: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', 'scripts/install.sh', ...argv], {
    cwd: o.paket,
    env: {
      HOME: o.home, PATH: `${env.PREDPATH ? env.PREDPATH + ':' : ''}${BUN_DIR}:/usr/bin:/bin`, USER: 'proba', LANG: 'C.UTF-8',
      TMPDIR: join(o.korijen, 'tmp'), TM_PORT: String(env.TM_PORT || 20000 + Math.floor(Math.random() * 20000)),
      // slobodan disk se podmeće (B6, QA K6): test ne smije ovisiti o disku stroja (node-A 4,8 GB)
      TM_POSUDI_IZ: NODE_MODULES, TM_BEZ_MREZE: '1', TM_INSTALL_SLOBODNO_MIB: '100000', ...env,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}
mkdirSync(radna(), { recursive: true })

/** Sve datoteke i mape pod korijenom s veličinom i vremenom izmjene. */
function snimka(dir: string): string[] {
  const van: string[] = []
  const hodaj = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.name === '.git' && d === dir) continue
      const st = statSync(p, { throwIfNoEntry: false } as any) as any
      van.push(`${relative(dir, p)} ${st ? `${st.size} ${st.mtimeMs}` : 'veza'}`)
      if (e.isDirectory() && !e.isSymbolicLink()) hodaj(p)
    }
  }
  hodaj(dir)
  return van.sort()
}

const koraci = (tm: string) => readFileSync(join(tm, 'log/install/zadnji/koraci.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
const rezultat = (tm: string) => JSON.parse(readFileSync(join(tm, 'log/install/zadnji/install-rezultat.json'), 'utf-8'))
const OSNOVNO = ['--bez-servisa', '--posudi', '--preskoci', 'pdf']

describe('install.sh — uporaba', () => {
  test('--help izlazi s 0, nepoznat argument s 2', () => {
    const o = okruzje('pomoc')
    try {
      expect(pokreni(o, ['--help']).kod).toBe(0)
      const r = pokreni(o, ['--nema-me'])
      expect(r.kod).toBe(2)
      expect(r.izlaz).toContain('nepoznat argument')
      expect(pokreni(o, ['--cvor', 'Loše Ime']).kod).toBe(2)
      expect(existsSync(o.tm)).toBe(false)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  })

  test('nepodržan OS → izlaz 3 i install-rezultat.json s "ishod":"pad" (zapisuje se i u padu)', () => {
    const o = okruzje('os')
    try {
      const r = pokreni(o, OSNOVNO, { TM_INSTALL_OS: 'FreeBSD' })
      expect(r.kod).toBe(3)
      const rez = rezultat(o.tm)
      expect(rez).toMatchObject({ ishod: 'pad', korak: 'K2.1-os', izlaz: 3 })
      expect(koraci(o.tm).at(-1)).toMatchObject({ korak: 'K2.1-os', izlaz: 3 })
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('install.sh --suho', () => {
  test('ne piše ništa ni u HOME ni u paket, a ispisuje svaki korak s izlaznim kodom', () => {
    const o = okruzje('suho')
    try {
      const prijeHome = snimka(o.home), prijePaket = snimka(o.paket)
      const r = pokreni(o, ['--suho', '--cvor', 'proba-cvor', '--profil', 'upravitelj-cvora', '--baze', '--posudi'])
      expect(r.kod).toBe(0)
      expect(snimka(o.home)).toEqual(prijeHome)
      expect(snimka(o.paket)).toEqual(prijePaket)
      const retci = r.izlaz.split('\n').filter(l => l.startsWith('KORAK ')).map(l => JSON.parse(l.slice(6)))
      expect(retci.length).toBeGreaterThanOrEqual(25)
      for (const k of retci) expect(typeof k.izlaz).toBe('number')
      for (const id of ['K2.1-os', 'K2.4-bun', 'K2.8-instanca', 'K2.18-baze-pgvector', 'K2.23-servis-taskmanager', 'K2.24-provjera', 'K2.26-ai-prijava'])
        expect(retci.map(k => k.korak)).toContain(id)
      const rez = JSON.parse(r.izlaz.split('\n').find(l => l.startsWith('REZULTAT '))!.slice(9))
      expect(rez.ishod).toBe('suho')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('B6: provjera diska je podmetljiva — malo diska uz --baze → izlaz 3 s porukom', () => {
    const o = okruzje('disk')
    try {
      const r = pokreni(o, ['--suho', '--baze', '--posudi'], { TM_INSTALL_SLOBODNO_MIB: '4800' })
      expect(r.kod, r.izlaz).toBe(3)
      expect(r.izlaz).toContain('disk: 4800 MiB slobodno')
      expect(r.izlaz).toMatch(/disk≥\d+MiB/)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('lažni darwin: tablica P10 sa svih 35 redaka (✓/✗/„nije podržano”) i ništa zapisano', () => {
    const o = okruzje('darwin')
    try {
      // naredbe macOS-a kao lažnjaci (samo za čitanje, izlaz 0)
      const bin = join(o.korijen, 'lazni-mac')
      mkdirSync(bin)
      for (const n of ['sw_vers', 'xcode-select', 'launchctl', 'plutil', 'sudo', 'lsof', 'sysctl'])
        { writeFileSync(join(bin, n), n === 'sw_vers' ? '#!/bin/sh\necho 27.0.1\n' : '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, n), 0o755) }
      const prije = snimka(o.home)
      const r = pokreni(o, ['--suho', '--cvor', 'proba-mac', '--baze', '--posudi'], { TM_INSTALL_OS: 'Darwin', PREDPATH: bin })
      expect(r.kod).toBe(0)
      expect(snimka(o.home)).toEqual(prije)
      const tablica = r.izlaz.split('\n').filter(l => /^\s{4}\d{1,2}\s{2,}/.test(l))
      expect(tablica.map(l => Number(l.trim().split(/\s+/)[0]))).toEqual(Array.from({ length: 35 }, (_, i) => i + 1))
      expect(tablica.filter(l => l.includes('nije podržano')).length).toBe(3)
      expect(r.izlaz).toContain('Homebrew: nema — nije potreban')
      // omotač se postavlja samo kad naredbe nema (ovdje je PATH s /usr/bin, pa ovisi o stroju)
      expect(r.izlaz).toMatch(/\(suho\).*\.local\/bin\/setsid|setsid: postoji/)
      expect(r.izlaz).toMatch(/zapisala bih \/Library\/LaunchDaemons\/hr\.regoc\.taskmanager\.plist/)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('install.sh — prava instalacija u privremenom HOME-u', () => {
  let o: Okruzje
  let prvi: ReturnType<typeof pokreni>, drugi: ReturnType<typeof pokreni>
  let koraciPrvi: any[]
  beforeAll(() => {
    o = okruzje('pravo')
    const TM_PORT = String(20000 + Math.floor(Math.random() * 20000))
    prvi = pokreni(o, [...OSNOVNO, '--cvor', 'proba-cvor', '--bind', '127.0.0.1'], { TM_PORT })
    koraciPrvi = existsSync(join(o.tm, 'log/install/zadnji')) ? koraci(o.tm) : []
    drugi = pokreni(o, [...OSNOVNO, '--cvor', 'proba-cvor'], { TM_PORT })
  }, 120_000)
  afterAll(() => rmSync(o.korijen, { recursive: true, force: true }))

  test('prvo pokretanje: uspjeh, ploča na /health → 200, svaki korak ima izlaz 0', () => {
    expect(prvi.kod).toBe(0)
    expect(koraciPrvi.length).toBeGreaterThanOrEqual(25)
    for (const k of koraciPrvi) { expect(k.izlaz).toBe(0); expect(typeof k.trajanje_s).toBe('number') }
    expect(koraciPrvi.find(k => k.korak === 'K2.24-provjera')?.razlog).toMatch(/HTTP 200/)
    expect(koraciPrvi.find(k => k.korak === 'K2.7-pdf')?.razlog).toMatch(/preskočen/)
  })

  test('drugo pokretanje: „0 promjena" (iz loga i iz ispisa), isti popis koraka', () => {
    expect(drugi.kod).toBe(0)
    expect(drugi.izlaz).toContain('GOTOVO: 0 promjena')
    expect(rezultat(o.tm)).toMatchObject({ ishod: 'uspjeh', promijenjeno: 0, izlaz: 0 })
    const k2 = koraci(o.tm)
    expect(k2.filter(k => k.promijenjeno)).toEqual([])
    expect(k2.map(k => k.korak)).toEqual(koraciPrvi.map(k => k.korak))
  })

  test('log P3.1: četiri datoteke, simlink zadnji, okolina bez varijabli okoline', () => {
    const d = join(o.tm, 'log/install/zadnji')
    for (const f of ['koraci.jsonl', 'install.log', 'okolina.txt', 'install-rezultat.json']) expect(existsSync(join(d, f))).toBe(true)
    expect(readdirSync(join(o.tm, 'log/install')).filter(x => /^\d{8}-\d{6}/.test(x)).length).toBe(2)
    const okolina = readFileSync(join(d, 'okolina.txt'), 'utf-8')
    expect(okolina).toContain('uname:')
    expect(okolina).not.toContain('TM_POSUDI_IZ')
  })

  test('instanca čvora: postavke.env 0600 s TM_BIND, mape 0700, manifest bez duplikata', () => {
    const p = join(o.tm, 'config/postavke.env')
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toMatch(/^TM_BIND=127\.0\.0\.1$/m)
    expect(statSync(o.tm).mode & 0o777).toBe(0o700)
    expect(statSync(join(o.tm, 'config')).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(o.tm, 'config/instalacija.env'), 'utf-8')).toContain('CVOR_IME=proba-cvor')
    const m = JSON.parse(readFileSync(join(o.tm, 'instalirano.json'), 'utf-8'))
    const putevi = m.stvoreno.map((s: any) => s.put)
    expect(putevi).toContain(o.tm)
    expect(new Set(putevi).size).toBe(putevi.length)
    // stablo paketa ostaje čisto (lokalno ide samo u $TM_HOME)
    expect(Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: o.paket }).stdout.toString()).toBe('')
  })
})

/** Lažni `uv` i lažni python venva: bilježe argumente u ZAPIS, ništa ne preuzimaju (B5). */
function lazniUv(o: Okruzje) {
  const bin = join(o.korijen, 'lazni-uv'), zapis = join(o.korijen, 'zapis')
  mkdirSync(bin, { recursive: true }); mkdirSync(zapis, { recursive: true })
  writeFileSync(join(zapis, 'python'), `#!/bin/sh
printf '%s\\n' "python $*" >> "${zapis}/python.log"
case "$*" in *importlib.metadata*) exit 1 ;; esac
exit 0
`)
  writeFileSync(join(bin, 'uv'), `#!/bin/sh
printf '%s\\n' "uv $*" >> "${zapis}/uv.log"
case "$1" in
  --version) echo "uv 0.13.4" ;;
  python) echo /usr/bin/python3 ;;
  venv) for a; do d="$a"; done; mkdir -p "$d/bin"; cp "${zapis}/python" "$d/bin/python"; chmod 755 "$d/bin/python" ;;
  pip) [ "$3" = --help ] && echo "      --torch-backend <TORCH_BACKEND>" ;;
esac
exit 0
`)
  chmodSync(join(bin, 'uv'), 0o755)
  const citaj = (f: string) => existsSync(join(zapis, f)) ? readFileSync(join(zapis, f), 'utf-8') : ''
  return { bin, uv: () => citaj('uv.log'), python: () => citaj('python.log') }
}

describe('install.sh --baze — B5: CPU torch na Linuxu i modeli bez ONNX/OpenVINO kopija', () => {
  test('Linux: uv pip install ide s --torch-backend cpu; snapshot_download s ignore_patterns', () => {
    const o = okruzje('baze-cpu')
    try {
      const l = lazniUv(o)
      const r = pokreni(o, [...OSNOVNO, '--baze', '--preskoci', 'baze-pgvector'], { PREDPATH: l.bin, TM_INSTALL_OS: 'Linux' })
      expect(r.kod, r.izlaz).toBe(0)
      const pip = l.uv().split('\n').find(x => x.startsWith('uv pip install') && x.includes('hindsight-api'))
      expect(pip, l.uv()).toBeDefined()
      expect(pip).toContain('--torch-backend cpu')
      // bge-m3 i reranker nose po 2–4 GB ONNX/OpenVINO kopija koje Hindsight (torch) ne čita
      expect(l.python()).toContain('ignore_patterns')
      expect(l.python()).toContain('onnx/*')
      expect(l.python()).toContain('openvino/*')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 120_000)

  test('--suho: plan venva na Linuxu kaže CPU torch', () => {
    const o = okruzje('baze-suho')
    try {
      const lin = pokreni(o, ['--suho', '--baze', '--posudi'], { TM_INSTALL_OS: 'Linux' })
      expect(lin.kod, lin.izlaz).toBe(0)
      expect(lin.izlaz).toContain('torch: CPU (--torch-backend cpu)')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('install.sh — pad koraka', () => {
  test('rječnici nedostaju → izlaz 5, install-rezultat.json s korakom i izlazom, retci do pada', () => {
    const o = okruzje('pad', p => rmSync(join(p, 'locales'), { recursive: true, force: true }))
    try {
      const r = pokreni(o, OSNOVNO)
      expect(r.kod).toBe(5)
      expect(rezultat(o.tm)).toMatchObject({ ishod: 'pad', korak: 'K2.10-rjecnici', izlaz: 5 })
      const k = koraci(o.tm)
      expect(k.at(-1)).toMatchObject({ korak: 'K2.10-rjecnici', izlaz: 5 })
      expect(k.at(-1).stderr_rep.length).toBeGreaterThan(0)
      expect(k.slice(0, -1).every(x => x.izlaz === 0)).toBe(true)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('čvor iz stabla s lokalnim postavkama → izlaz 3 (P4.1: lokalno samo u $TM_HOME)', () => {
    const o = okruzje('lokalno', p => writeFileSync(join(p, 'config/postavke.env'), 'TM_PORT=1\n'))
    try {
      const r = pokreni(o, [...OSNOVNO, '--cvor', 'proba'])
      expect(r.kod).toBe(3)
      expect(rezultat(o.tm)).toMatchObject({ ishod: 'pad', korak: 'K2.2-stablo', izlaz: 3 })
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('install.sh --komplet', () => {
  /** Lažni javni modul kompleta (lokalni git) + lock koji ga pina. */
  function komplet(o: Okruzje, pokvari = false) {
    const repo = join(o.korijen, 'regoc-komplet')
    mkdirSync(repo)
    writeFileSync(join(repo, 'README.md'), 'komplet\n')
    writeFileSync(join(repo, 'instalacija.sh'), '#!/bin/bash\n# ugovor P11: PROMIJENJENO ili ISTO\nm="$4/komplet-pripremljen"; if [ -f "$m" ]; then echo ISTO; else [ "${5:-}" = --suho ] || touch "$m"; echo PROMIJENJENO; fi\n')
    const sha = (f: string) => new Bun.CryptoHasher('sha256').update(readFileSync(join(repo, f))).digest('hex')
    writeFileSync(join(repo, 'MANIFEST.sha256'), `${sha('README.md')}  README.md\n${sha('instalacija.sh')}  instalacija.sh\n`)
    const g = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=p', '-c', 'user.email=p@example.invalid', ...a], { cwd: repo })
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'k')
    const commit = g('rev-parse', 'HEAD').stdout.toString().trim()
    const lock = { repo, commit, manifest_sha256: pokvari ? '0'.repeat(64) : sha('MANIFEST.sha256'), odrediste: 'komplet-odrediste' }
    writeFileSync(join(o.paket, 'config/komplet.lock'), JSON.stringify(lock))
    Bun.spawnSync(['git', 'add', 'config/komplet.lock'], { cwd: o.paket })
    Bun.spawnSync(['git', '-c', 'user.name=p', '-c', 'user.email=p@example.invalid', 'commit', '-qm', 'lock', '--no-verify'], { cwd: o.paket })
    return { repo, commit }
  }
  const ARG = [...OSNOVNO, '--komplet', '--preskoci', 'claude']

  test('bez config/komplet.lock → izlaz 5 s jasnom porukom', () => {
    const o = okruzje('bezlock')
    try {
      const r = pokreni(o, ARG)
      expect(r.kod).toBe(5)
      expect(r.izlaz).toContain('komplet.lock ne postoji')
      expect(rezultat(o.tm)).toMatchObject({ ishod: 'pad', korak: 'K2.14-komplet', izlaz: 5 })
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('klon na commitu iz locka, manifest provjeren, drugo pokretanje bez promjene', () => {
    const o = okruzje('komplet')
    try {
      const { commit } = komplet(o)
      const TM_PORT = String(20000 + Math.floor(Math.random() * 20000))
      const r1 = pokreni(o, ARG, { TM_PORT })
      expect(r1.kod).toBe(0)
      const dir = join(o.home, 'komplet-odrediste')
      expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()).toBe(commit)
      expect(existsSync(join(o.tm, 'komplet-pripremljen'))).toBe(true)
      expect(readFileSync(join(o.tm, 'config/instalacija.env'), 'utf-8')).toContain(`TM_SUSTAV_DIR=${dir}`)
      const r2 = pokreni(o, ARG, { TM_PORT })
      expect(r2.kod).toBe(0)
      expect(koraci(o.tm).find(k => k.korak === 'K2.14-komplet')).toMatchObject({ izlaz: 0, promijenjeno: false })
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('manifest ne odgovara locku → izlaz 5', () => {
    const o = okruzje('kvar')
    try {
      komplet(o, true)
      const r = pokreni(o, ARG)
      expect(r.kod).toBe(5)
      expect(r.izlaz).toContain('MANIFEST.sha256 ≠ manifest_sha256')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('zapis.sh — tajne nikad u log', () => {
  test('zatamni() skriva KLJUČ=vrijednost, postgres://k:lozinka@, Bearer, sk- i -P', () => {
    const ulaz = [
      'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz', 'TELEGRAM_BOT_TOKEN: 123456:ABCdef',
      'url postgres://rag:tajnaLozinka@127.0.0.1:15433/rag', 'Authorization: Bearer eyJhbGciOi.abc',
      'pg0 start -P supertajna -n rag', 'TM_PGVECTOR_PASSWORD=xyz123',
    ].join('\n')
    const r = Bun.spawnSync(['bash', '-c', `. scripts/instalacija/zapis.sh; zatamni`], { cwd: KORIJEN, stdin: new TextEncoder().encode(ulaz) })
    const van = r.stdout.toString()
    for (const tajna of ['sk-or-v1', 'ABCdef', 'tajnaLozinka', 'eyJhbGciOi', 'supertajna', 'xyz123']) expect(van).not.toContain(tajna)
    expect(van.match(/«skriveno»/g)?.length).toBe(6)
    expect(van).toContain('postgres://rag:«skriveno»@127.0.0.1')
  })

  // TASK-5686 (S1, pregled K5 TASK-5659): REGOČ čita install.log i dijelove prepisuje u zadatak.
  // Vrijednosti se slažu iz dijelova da ni test ne nosi nešto nalik pravom tokenu.
  test('zatamni() skriva i vrijednost u navodnicima, Telegram token bez imena i GitHub token', () => {
    const tg = '123456789:' + 'Ab9_-'.repeat(7)
    const ghp = 'ghp_' + 'a1B2'.repeat(9)
    const pat = 'github_pat_' + '11ABCDE_'.repeat(6)
    const ulaz = [
      'TELEGRAM_BOT_TOKEN="dvostrukiNavod1"', "TM_RAG_KEY='jednostrukiNavod2'", 'export API_SECRET = "razmak i navod"',
      `curl https://api.telegram.org/bot${tg}/getMe`, `  ${tg}`,
      `git remote https://${ghp}@github.com/x/y`, `token: ${pat}`,
      'DB_PASSWORD=ab"cdSredina', 'X_SECRET="nezatvoren do kraja retka',
    ].join('\n')
    const r = Bun.spawnSync(['bash', '-c', `. scripts/instalacija/zapis.sh; zatamni`], { cwd: KORIJEN, stdin: new TextEncoder().encode(ulaz) })
    const van = r.stdout.toString()
    for (const tajna of ['dvostrukiNavod1', 'jednostrukiNavod2', 'razmak i navod', 'Ab9_-Ab9', 'a1B2a1B2', '11ABCDE_', 'cdSredina', 'nezatvoren', 'retka'])
      expect(van, van).not.toContain(tajna)
    expect(van).toContain('https://api.telegram.org/bot«skriveno»/getMe')
    expect(van).toContain('TELEGRAM_BOT_TOKEN=«skriveno»')
  })

  test('json_s daje ispravan JSON i za navodnike, kose crte, nove retke i UTF-8', () => {
    const r = Bun.spawnSync(['bash', '-c', `. scripts/instalacija/zapis.sh; json_s "$(printf 'a"b\\\\c\\nčvor\\tž')"`], { cwd: KORIJEN })
    expect(JSON.parse(r.stdout.toString())).toBe('a"b\\c\nčvor\tž')
  })
})
