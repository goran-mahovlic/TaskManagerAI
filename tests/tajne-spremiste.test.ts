// TASK-5343 (ADR-0007 §5, §6, §7) — poopćeni LoginCreds: jedan pisač, jedan parser.
// J2 oblik IME='…' (ljuska ne izvršava vrijednost), J3 odbijanja, J4 zaključavanje,
// J5 prava, J6 bez kopija, J14 HMAC otisak, J16 dojava promjene.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parsirajRedak, procitajIzTeksta, kljucPrisutan, kodirajVrijednost, provjeriVrijednost,
  upisiTajnu, ukloniTajnu, ukloniKljucIzDatoteke, otisak, imeZabranjeno, dopustenaImena,
  naPromjenuTajne, opisStarogRetka, postaviTajnu,
} from '../src/LoginCreds'
import { procitajTajnu, tajnaPostavljena, zapisiTajnu } from '../src/core/ConfigModul'

let mapa = ''
let f = ''
beforeEach(() => {
  mapa = mkdtempSync(join(process.env.TM_TEST_TMP || tmpdir(), 'tajne-'))
  chmodSync(mapa, 0o700)
  f = join(mapa, 'credentials.env')
})
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const ljuskom = (put: string, ime: string): string => {
  const r = Bun.spawnSync(['bash', '-c', `set -a; . "$1"; set +a; printf %s "\${${ime}}"`, '_', put], { cwd: mapa })
  return r.stdout.toString()
}

const MATRICA: [string, string][] = [
  ['$(id)', 'x$(touch MARKER)y'],
  ['backtick', 'a`touch MARKER`b'],
  ['jednostruki navodnik', "it's"],
  ['vise navodnika', "'''"],
  ['dvostruki navodnik', 'pa"ss'],
  ['backslash', 'a\\b\\'],
  ['tocka-zarez', 'a; touch MARKER'],
  ['ljestve', 'a #b'],
  ['jednako', 'k=v=w'],
  ['razmak na rubu', ' rubni razmak '],
  ['unicode', 'é€ž🔑'],
  ['dolar', '$HOME$1${PATH}'],
  ['4096 B', 'z'.repeat(4096)],
]

describe('J2 — oblik IME=\'…\': ljuska čita isto što je upisano i ništa ne izvršava', () => {
  for (const [opis, v] of MATRICA) {
    test(opis, () => {
      expect(upisiTajnu('SMTP_PASSWORD', v, { spremiste: f }).ok).toBe(true)
      expect(ljuskom(f, 'SMTP_PASSWORD')).toBe(v)
      expect(existsSync(join(mapa, 'MARKER'))).toBe(false)
      expect(procitajTajnu('SMTP_PASSWORD', f)).toBe(v)
      expect(procitajIzTeksta(readFileSync(f, 'utf-8'), 'SMTP_PASSWORD')).toBe(v)
    })
  }

  test('zapisiTajnu (Telegram) i ukloniKljucIzDatoteke idu kroz isti pisač', () => {
    expect(zapisiTajnu('TELEGRAM_BOT_TOKEN', 'x$(touch MARKER)', f).ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe("TELEGRAM_BOT_TOKEN='x$(touch MARKER)'\n")
    ljuskom(f, 'TELEGRAM_BOT_TOKEN')
    expect(existsSync(join(mapa, 'MARKER'))).toBe(false)
    expect(ukloniKljucIzDatoteke(f, 'TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(tajnaPostavljena('TELEGRAM_BOT_TOKEN', f)).toBe(false)
  })

  test('kodirajVrijednost: \' → \'\\\'\'', () => {
    expect(kodirajVrijednost("a'b")).toBe("'a'\\''b'")
  })
})

describe('parser čita sve oblike (stari goli, dvostruki, export)', () => {
  test('oblici', () => {
    expect(parsirajRedak("IME='a b'")).toEqual({ ime: 'IME', vrijednost: 'a b' })
    expect(parsirajRedak("export IME='a'\\''b'")).toEqual({ ime: 'IME', vrijednost: "a'b" })
    expect(parsirajRedak('IME="x y"')).toEqual({ ime: 'IME', vrijednost: 'x y' })
    expect(parsirajRedak('IME=goli')).toEqual({ ime: 'IME', vrijednost: 'goli' })
    expect(parsirajRedak('  # komentar')).toBeNull()
    expect(parsirajRedak('')).toBeNull()
  })
  test('kljucPrisutan prati parser: prazan navodnik nije prijava', () => {
    expect(kljucPrisutan("A=''\n", 'A')).toBe(false)
    expect(kljucPrisutan("A='x'\n", 'A')).toBe(true)
    expect(kljucPrisutan('export A=x\n', 'A')).toBe(true)
    expect(kljucPrisutan('AB=x\n', 'A')).toBe(false)
  })
  test('stari redak s opasnim znakom javlja opasan; novi oblik nije opasan', () => {
    expect(opisStarogRetka('A=a$(b)')).toEqual({ oblik: 'stari', opasan: true })
    expect(opisStarogRetka('A="a$(b)"')).toEqual({ oblik: 'stari', opasan: true })
    expect(opisStarogRetka("A='a$(b)'")).toEqual({ oblik: 'novi', opasan: false })
    expect(opisStarogRetka("A='it'\\''s'")).toEqual({ oblik: 'novi', opasan: false })
    expect(opisStarogRetka('A=abc')).toEqual({ oblik: 'stari', opasan: false })
  })
})

describe('J3 — odbijanja ostavljaju spremište bajt za bajt', () => {
  test('prazno, \\0, \\r, \\n, >4096 B', () => {
    upisiTajnu('SMTP_PASSWORD', 'prvo', { spremiste: f })
    const prije = sha(f)
    for (const v of ['', 'a\0b', 'a\rb', 'a\nB=1', 'z'.repeat(4097)]) {
      const r = upisiTajnu('SMTP_PASSWORD', v, { spremiste: f })
      expect(r.ok).toBe(false)
      expect(r.greska).toMatch(/^vrijednost_/)
      expect(sha(f)).toBe(prije)
    }
    expect(provjeriVrijednost('ok')).toBeNull()
  })
  test('ime krivog oblika', () => {
    expect(upisiTajnu('mala', 'x', { spremiste: f }).greska).toBe('ime_neispravno')
    expect(existsSync(f)).toBe(false)
  })
  test('tvrda zabrana §6.2', () => {
    for (const ime of ['PATH', 'BASH_ENV', 'LD_PRELOAD', 'NODE_OPTIONS', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
      'HTTPS_PROXY', 'TM_CREDENTIALS', 'CLAUDE_CODE_X', 'GIT_SSH_COMMAND', 'PYTHONPATH', 'SMTP_HOST', 'X_URL']) {
      expect(imeZabranjeno(ime)).toBe(true)
    }
    for (const ime of ['SMTP_PASSWORD', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TM_PGVECTOR_PASSWORD']) expect(imeZabranjeno(ime)).toBe(false)
  })
})

describe('§6.1 — popis dopuštenih imena', () => {
  test('izvori + dodatna imena po pravilu sufiksa, zabranjena ispadaju', () => {
    const p = dopustenaImena({
      davatelji: [{ envKey: 'OPENROUTER_API_KEY', izvor: 'davatelj.openrouter' }],
      moduli: [{ ime: 'SMTP_PASSWORD', izvor: 'email.smtp' }, { ime: 'ANTHROPIC_BASE_URL', izvor: 'zlo' }],
      dodatna: ['MOJ_SERVIS_TOKEN', 'SLOBODNO', 'TM_X_TOKEN', 'bad_TOKEN'],
    })
    const imena = p.map(x => x.ime).sort()
    expect(imena).toEqual(['MOJ_SERVIS_TOKEN', 'OPENROUTER_API_KEY', 'SMTP_PASSWORD'])
    expect(p.find(x => x.ime === 'SMTP_PASSWORD')!.izvor).toBe('email.smtp')
  })
})

describe('J5/J6 — prava, simbolička poveznica, bez kopija', () => {
  test('0600 i kad je prije bilo 0644; mapa 0700', () => {
    writeFileSync(f, 'A=b\n', { mode: 0o644 }); chmodSync(f, 0o644); chmodSync(mapa, 0o755)
    expect(upisiTajnu('SMTP_PASSWORD', 'v', { spremiste: f }).ok).toBe(true)
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(statSync(mapa).mode & 0o777).toBe(0o700)
    expect(readFileSync(f, 'utf-8')).toBe("A=b\nSMTP_PASSWORD='v'\n")
  })
  test('stegniMapu:false i postaviTajnu (glavni stroj) ne diraju prava mape', () => {
    chmodSync(mapa, 0o775)
    expect(upisiTajnu('SMTP_PASSWORD', 'v', { spremiste: f, stegniMapu: false }).ok).toBe(true)
    expect(statSync(mapa).mode & 0o777).toBe(0o775)
    expect(postaviTajnu(f, 'IMAP_PASSWORD', 'w').ok).toBe(true)
    expect(statSync(mapa).mode & 0o777).toBe(0o775)
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
  test('simbolička poveznica na mjestu spremišta → odbijeno', () => {
    const cilj = join(mapa, 'drugdje'); writeFileSync(cilj, 'X=1\n')
    symlinkSync(cilj, f)
    expect(upisiTajnu('SMTP_PASSWORD', 'v', { spremiste: f }).greska).toBe('spremiste_nije_sigurno')
    expect(readFileSync(cilj, 'utf-8')).toBe('X=1\n')
    expect(lstatSync(f).isSymbolicLink()).toBe(true)
  })
  test('rotacija: ostali retci bajt za bajt, nema .bak, .lock ni tmp', () => {
    writeFileSync(f, '# glava\nA=b\nexport SMTP_PASSWORD=staro\nC="d"\n', { mode: 0o600 })
    const r1 = upisiTajnu('SMTP_PASSWORD', 'novo', { spremiste: f })
    expect(r1.ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe("# glava\nA=b\nexport SMTP_PASSWORD='novo'\nC=\"d\"\n")
    const r2 = upisiTajnu('SMTP_PASSWORD', 'trece', { spremiste: f })
    expect(r2.otisakPrije).toBe(r1.otisak)
    expect(r2.otisak).not.toBe(r1.otisak)
    expect(readdirSync(mapa).filter(n => n !== 'tajne-otisak.kljuc').sort()).toEqual(['credentials.env'])
  })
  test('ukloniTajnu miče sve retke tog imena', () => {
    writeFileSync(f, "A=1\nSMTP_PASSWORD=x\nexport SMTP_PASSWORD='y'\n", { mode: 0o600 })
    const r = ukloniTajnu('SMTP_PASSWORD', { spremiste: f })
    expect(r.ok).toBe(true); expect(r.uklonjen).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe('A=1\n')
    expect(ukloniTajnu('SMTP_PASSWORD', { spremiste: f }).uklonjen).toBe(false)
  })
})

describe('J4 — zaključavanje: dva procesa × 50 upisa', () => {
  test('svih 100 imena prisutno, nijedan redak razbijen', async () => {
    const skripta = join(mapa, 'pisac.ts')
    const lc = join(import.meta.dir, '..', 'src', 'LoginCreds.ts')
    writeFileSync(skripta, `import { upisiTajnu } from ${JSON.stringify(lc)}
const [p, f] = process.argv.slice(2)
for (let i = 0; i < 50; i++) { const r = upisiTajnu('T' + p + '_' + i + '_TOKEN', 'v' + p + i + "'x", { spremiste: f }); if (!r.ok) { console.error(r.greska); process.exit(1) } }`)
    const procesi = ['A', 'B'].map(p => Bun.spawn(['bun', skripta, p, f], { stderr: 'pipe' }))
    const izlazi = await Promise.all(procesi.map(p => p.exited))
    expect(izlazi).toEqual([0, 0])
    const tekst = readFileSync(f, 'utf-8')
    for (const p of ['A', 'B']) for (let i = 0; i < 50; i++) {
      expect(procitajIzTeksta(tekst, `T${p}_${i}_TOKEN`)).toBe(`v${p}${i}'x`)
    }
    expect(tekst.trim().split('\n').length).toBe(100)
    expect(readdirSync(mapa).filter(n => n.includes('.lock') || n.includes('.tmp-'))).toEqual([])
  }, 30_000)
})

describe('J14 — otisak je HMAC s ključem čvora', () => {
  test('8 hex, ovisi o ključu, ključ 0600', () => {
    const k = join(mapa, 'tajne-otisak.kljuc')
    const o1 = otisak('lozinka', k)
    expect(o1).toMatch(/^[0-9a-f]{8}$/)
    expect(statSync(k).mode & 0o777).toBe(0o600)
    expect(otisak('lozinka', k)).toBe(o1)
    expect(o1).not.toBe(createHash('sha256').update('lozinka').digest('hex').slice(0, 8))
    writeFileSync(k, Buffer.alloc(32, 7))
    expect(otisak('lozinka', k)).not.toBe(o1)
  })
  test('zajednički vektori TS = Python', () => {
    const vektori = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'tajne-vektori.json'), 'utf-8'))
    const k = join(mapa, 'kljuc'); writeFileSync(k, Buffer.from(vektori.kljucHex, 'hex'), { mode: 0o600 })
    for (const v of vektori.otisci) expect(otisak(v.vrijednost, k)).toBe(v.otisak)
    for (const r of vektori.retci) expect(parsirajRedak(r.redak)?.vrijednost ?? null).toBe(r.vrijednost)
    const py = Bun.spawnSync(['python3', join(import.meta.dir, '..', 'tools', 'tajna_redak.py'), '--vektori',
      join(import.meta.dir, 'fixtures', 'tajne-vektori.json')])
    expect(py.stderr.toString()).toBe('')
    expect(py.exitCode).toBe(0)
  })
})

describe('J16 — naPromjenuTajne', () => {
  test('cb unutar 2 s nakon promjene, ne zove se bez promjene otiska', async () => {
    upisiTajnu('SMTP_PASSWORD', 'a', { spremiste: f })
    let pozivi = 0
    const stop = naPromjenuTajne('SMTP_PASSWORD', () => { pozivi++ }, { spremiste: f })
    try {
      await Bun.sleep(100)
      upisiTajnu('DRUGO_TOKEN', 'x', { spremiste: f })
      await Bun.sleep(1200)
      expect(pozivi).toBe(0)
      const t0 = Date.now()
      upisiTajnu('SMTP_PASSWORD', 'b', { spremiste: f })
      while (pozivi === 0 && Date.now() - t0 < 2000) await Bun.sleep(50)
      expect(pozivi).toBe(1)
    } finally { stop() }
  }, 10_000)
})
