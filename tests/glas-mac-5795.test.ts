/**
 * TASK-5795: glas (TTS + STT) na macOS čvoru — instalacija bez reinstalacije paketa.
 * instaliraj-glas.sh: Homebrew (ffmpeg, espeak-ng), engleski glasovi uz sha256, --stt (faster-whisper
 * + usluga `voice`); usluga iz istog opisa kao ostale (launchd hr.regoc.voice / systemd regoc-voice),
 * kroz s-okolinom.sh; servis glasa je u paketu (tools/glas/regoc-voice-server.py).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { datotekeUsluge, sudoersPrimjer, ucitajOpise, vrijednosti } from '../scripts/instalacija/servis'

const PAKET = join(import.meta.dir, '..')
const MAPE: string[] = []
const privremena = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); MAPE.push(d); return d }
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })

function pokreni(arg: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(['bash', join(PAKET, 'scripts', 'instaliraj-glas.sh'), ...arg], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
}

describe('instaliraj-glas.sh na macOS-u (lažni Darwin)', () => {
  test('--suho: fale ffmpeg i espeak-ng → brew install oboje, ništa se ne instalira', () => {
    const home = privremena('glas-brew-')
    const bin = join(home, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'brew'), '#!/bin/sh\necho "BREW POZVAN $*" >> "$HOME/brew.log"\n'); chmodSync(join(bin, 'brew'), 0o755)
    const { izlaz } = pokreni(['--suho'], { HOME: home, TM_OS: 'Darwin', TM_GLAS_FFMPEG: 'nema-ffmpeg-5795', PATH: `${bin}:/usr/bin:/bin` })
    expect(izlaz).toMatch(/\(suho\) brew install ffmpeg( espeak-ng)?/)
    expect(existsSync(join(home, 'brew.log'))).toBe(false)
  })
  test('--bez-brew: Homebrew se ne dira', () => {
    const home = privremena('glas-bezbrew-')
    const { izlaz } = pokreni(['--suho', '--bez-brew'], { HOME: home, TM_OS: 'Darwin', TM_GLAS_FFMPEG: 'nema-ffmpeg-5795' })
    expect(izlaz).not.toMatch(/\(suho\) brew install/)
  })
  test('engleski glas s krivim sha256 se odbija (glasovi-en.sha256), i u --suho', () => {
    const home = privremena('glas-en-')
    const mapa = join(home, 'glasovi'); mkdirSync(mapa)
    writeFileSync(join(mapa, 'en_GB-alan-medium.onnx'), 'lazno'); writeFileSync(join(mapa, 'en_GB-alan-medium.onnx.json'), '{}')
    const { izlaz } = pokreni(['--suho', '--bez-brew'], { HOME: home, TM_OS: 'Darwin', TM_GLAS_MODEL: join(mapa, 'hr_regoc.onnx'), TM_GLAS_FFMPEG: 'nema-ffmpeg-5795' })
    expect(izlaz).toContain('en_GB-alan-medium: sha256 ne odgovara')
  })
  test('kontrolni zbrojevi engleskih glasova su u paketu (tri glasa, onnx + json)', () => {
    const t = readFileSync(join(PAKET, 'tools', 'glas', 'glasovi-en.sha256'), 'utf-8').trim().split('\n')
    expect(t.length).toBe(6)
    for (const ime of ['en_GB-alan-medium', 'en_US-ryan-high', 'en_US-lessac-high']) expect(t.some(r => r.endsWith(`  ${ime}.onnx`))).toBe(true)
  })
  test('macOS bez sha256sum/readlink -f: skripta ima zamjene', () => {
    const s = readFileSync(join(PAKET, 'scripts', 'instaliraj-glas.sh'), 'utf-8')
    expect(s).toContain('shasum -a 256')
    expect(s).not.toMatch(/readlink -f/)
    expect(s).toContain('sudo -n -u "$VLASNIK_BREW"')
  })
})

describe('usluga voice (templates/servis/usluge.json)', () => {
  const opis = ucitajOpise().find(o => o.ime === 'voice')!
  const v = { ...vrijednosti({ HOME: '/Users/regoc', USER: 'regoc' }), PAKET: '/Users/regoc/TaskManagerAI' }
  test('stalna, uvjet glas, kroz s-okolinom.sh, Python iz venva glasa', () => {
    expect(opis).toBeDefined()
    expect(opis.uvjet).toBe('glas')
    expect(opis.vrsta).toBe('stalna')
    expect(opis.argv[0]).toBe('{{PAKET}}/scripts/s-okolinom.sh')
  })
  test('macOS: /Library/LaunchDaemons/hr.regoc.voice.plist — oznaka koju čita usluga(regoc-voice) (m.glas)', () => {
    const [d] = datotekeUsluge(opis, 'darwin', v)
    expect(d.put).toBe('/Library/LaunchDaemons/hr.regoc.voice.plist')
    expect(d.sadrzaj).toContain('<string>hr.regoc.voice</string>')
    expect(d.sadrzaj).toContain('<string>/Users/regoc/.local/share/regoc-piper/venv/bin/python</string>')
    expect(d.sadrzaj).toContain('<string>/Users/regoc/TaskManagerAI/tools/glas/regoc-voice-server.py</string>')
    expect(d.sadrzaj).toContain('<string>regoc</string>') // UserName, ne root
  })
  test('Linux: regoc-voice.service (isto ime kao na node-A)', () => {
    const d = datotekeUsluge(opis, 'linux', { ...v, HOME: '/home/regoc' })
    expect(d[0].put).toBe('/home/regoc/.config/systemd/user/regoc-voice.service')
  })
  test('suženi sudoers nabraja i hr.regoc.voice, a datoteka primjera je jednaka generatoru', () => {
    const s = sudoersPrimjer(ucitajOpise())
    expect(s).toContain('/bin/launchctl kickstart -k system/hr.regoc.voice')
    expect(readFileSync(join(PAKET, 'templates', 'servis', 'sudoers.primjer'), 'utf-8')).toBe(s)
  })
})

describe('servis glasa u paketu i okolina usluge', () => {
  const srv = readFileSync(join(PAKET, 'tools', 'glas', 'regoc-voice-server.py'), 'utf-8')
  test('Python iz venva (sys.executable), ne python3 iz PATH-a launchd-a; ffmpeg i iz Homebrewa', () => {
    expect(srv).toContain('PY = sys.executable')
    expect(srv).not.toContain('["python3","-c","import piper"]')
    expect(srv).not.toMatch(/\| python3 -m piper/)
    expect(srv).toContain('/opt/homebrew/bin/ffmpeg')
  })
  test('ugovor kao Glas.ts: /health, /tts, /stt (+ ?lang=), samo 127.0.0.1', () => {
    for (const s of ['"/health"', '"/tts"', '"/stt"', 'parse_qs(put.query).get("lang")', 'ThreadingHTTPServer(("127.0.0.1", PORT)']) expect(srv).toContain(s)
  })
  test('python3 -m py_compile prolazi', () => {
    expect(Bun.spawnSync(['python3', '-m', 'py_compile', join(PAKET, 'tools', 'glas', 'regoc-voice-server.py')]).exitCode).toBe(0)
  })
  test('s-okolinom.sh dodaje Homebrew NA KRAJ PATH-a (ffmpeg za glas pod launchd-om)', () => {
    const d = privremena('sok-')
    const lazni = join(d, 'opt-homebrew-bin')
    const s = readFileSync(join(PAKET, 'scripts', 's-okolinom.sh'), 'utf-8').replace('for d in /opt/homebrew/bin /usr/local/bin', `for d in ${lazni}`)
    mkdirSync(lazni); writeFileSync(join(d, 's.sh'), s)
    const r = Bun.spawnSync(['bash', join(d, 's.sh'), '--', 'bash', '-c', 'echo "$PATH"'], { env: { PATH: '/usr/bin:/bin', HOME: d, TM_HOME: d }, stdout: 'pipe' })
    expect(r.stdout.toString().trim()).toBe(`/usr/bin:/bin:${lazni}`)
  })
})
