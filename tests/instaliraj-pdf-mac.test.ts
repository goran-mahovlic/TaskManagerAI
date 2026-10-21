/**
 * TASK-5668 (plan Mac v3 P10): instaliraj-pdf.sh i instaliraj-glas.sh na macOS-u (lažni
 * `TM_OS=Darwin`) ne zovu apt i ne traže root ni Homebrew. DejaVu ide iz službenog izdanja
 * (provjeren sha256) u korisničku mapu fontova; bez pdftotext provjera ide pypdf-om.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'

const PAKET = join(import.meta.dir, '..')
const MAPE: string[] = []
function privremena(pref: string): string { const d = mkdtempSync(join(tmpdir(), pref)); MAPE.push(d); return d }
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })

function pokreni(skripta: string, arg: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(['bash', join(PAKET, 'scripts', skripta), ...arg], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}

const SUSTAVNI_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const imaReportlab = Bun.spawnSync(['python3', '-c', 'import reportlab, pypdf']).exitCode === 0

describe('instaliraj-pdf.sh — macOS grana (lažni Darwin)', () => {
  test('--suho: bez apt-a, font se traži u ~/Library/Fonts, ne u /usr/share', () => {
    const home = privremena('pdf-mac-suho-')
    const { izlaz } = pokreni('instaliraj-pdf.sh', ['--suho'], { HOME: home, TM_OS: 'Darwin', TM_PDF_PDFTOTEXT: 'nema-pdftotext-5668' })
    expect(izlaz).not.toMatch(/apt/)
    expect(izlaz).toContain(`preuzimam DejaVu 2.37 u ${home}/Library/Fonts (bez root-a)`)
    expect(izlaz).not.toContain('/usr/share/fonts')
    expect(izlaz).toMatch(/nema pdftotext — provjera dijakritika ide pypdf-om/)
    expect(existsSync(join(home, 'Library'))).toBe(false) // suho ništa ne piše
  })

  test.skipIf(!existsSync(SUSTAVNI_FONT) || !imaReportlab)('preuzimanje (zrcalo, sha256) → ~/Library/Fonts → proba s č ć ž š đ prolazi', () => {
    const home = privremena('pdf-mac-')
    // zrcalo izdanja: isti raspored kao službeni tar (dejavu-fonts-ttf-2.37/ttf/…)
    const izv = privremena('dejavu-izv-')
    mkdirSync(join(izv, 'dejavu-fonts-ttf-2.37', 'ttf'), { recursive: true })
    copyFileSync(SUSTAVNI_FONT, join(izv, 'dejavu-fonts-ttf-2.37', 'ttf', 'DejaVuSans.ttf'))
    const tar = join(izv, 'dejavu.tar.bz2')
    expect(Bun.spawnSync(['tar', '-cjf', tar, '-C', izv, 'dejavu-fonts-ttf-2.37']).exitCode).toBe(0)
    const sha = createHash('sha256').update(readFileSync(tar)).digest('hex')

    const env = { HOME: home, TM_OS: 'Darwin', TM_PDF_DEJAVU_URL: `file://${tar}`, TM_PDF_DEJAVU_SHA256: sha, TM_PDF_PDFTOTEXT: 'nema-pdftotext-5668' }
    const pogresan = pokreni('instaliraj-pdf.sh', [], { ...env, TM_PDF_DEJAVU_SHA256: '0'.repeat(64) })
    expect(pogresan.kod).toBe(1) // krivi sha256 → font se ne postavlja
    expect(existsSync(join(home, 'Library', 'Fonts', 'DejaVuSans.ttf'))).toBe(false)

    const { kod, izlaz } = pokreni('instaliraj-pdf.sh', [], env)
    expect(izlaz).not.toMatch(/apt/)
    expect(izlaz).toContain(`✅ ${home}/Library/Fonts/DejaVuSans.ttf`)
    expect(izlaz).toContain('PDF SPREMAN')
    expect(kod).toBe(0)
    // B7 (QA K6): proba ide u privremenu mapu, ne u ~/app/tmp (raspored izvornog sustava)
    expect(existsSync(join(home, 'app'))).toBe(false)
  }, 60_000)
})

describe('instaliraj-pdf.sh — B7: ništa izvan manifesta u HOME-u (QA K6 TASK-5660)', () => {
  test.skipIf(!existsSync(SUSTAVNI_FONT))('Linux: proba i fontconfig ne ostaju u HOME-u; privremena mapa se briše', () => {
    const home = privremena('pdf-b7-home-'), tmp = privremena('pdf-b7-tmp-')
    const { kod, izlaz } = pokreni('instaliraj-pdf.sh', [], { HOME: home, TMPDIR: tmp, TM_OS: 'Linux', XDG_CACHE_HOME: '' })
    expect(izlaz).toContain('PDF SPREMAN')
    expect(kod).toBe(0)
    // u HOME-u smije biti samo ono što install.sh upisuje u manifest (veza pdf i venv)
    expect(existsSync(join(home, 'app'))).toBe(false)
    expect(existsSync(join(home, '.cache'))).toBe(false)
    expect(existsSync(join(home, '.local', 'bin', 'pdf'))).toBe(true)
    expect(Bun.spawnSync(['ls', '-A', tmp]).stdout.toString().trim()).toBe('')
  }, 120_000)
})

describe('instaliraj-glas.sh — uputa za ffmpeg ovisi o OS-u', () => {
  test('Darwin: bez apt-a; Linux: apt install ffmpeg', () => {
    const home = privremena('glas-')
    const mac = pokreni('instaliraj-glas.sh', ['--suho'], { HOME: home, TM_OS: 'Darwin', TM_GLAS_FFMPEG: 'nema-ffmpeg-5668' }).izlaz
    expect(mac).toMatch(/ffmpeg \(statična binarka u ~\/\.local\/bin/)
    expect(mac).not.toMatch(/apt/)
    const lin = pokreni('instaliraj-glas.sh', ['--suho'], { HOME: home, TM_OS: 'Linux', TM_GLAS_FFMPEG: 'nema-ffmpeg-5668' }).izlaz
    expect(lin).toMatch(/ffmpeg \(apt install ffmpeg\)/)
  })
})
