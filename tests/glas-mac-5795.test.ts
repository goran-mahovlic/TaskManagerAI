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
import { datotekeUsluge, primijeni, sudoersPrimjer, ucitajOpise, vrijednosti } from '../scripts/instalacija/servis'

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
    // PyAV 19 izbacio open(metadata_errors) → faster-whisper 1.2.1 pada (izmjereno na Mac čvoru, /stt HTTP 500)
    expect(s).toContain('AV_VERZIJA="18.0.0"')
    expect(s).toContain('"av==$AV_VERZIJA"')
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
  test('interaktivna: plist BEZ ProcessType=Background/Nice (E-jezgre: /stt 8,1 s umjesto 1,4 s za 9 s zvuka)', () => {
    expect(opis.interaktivna).toBe(true)
    const [d] = datotekeUsluge(opis, 'darwin', v)
    expect(d.sadrzaj).not.toContain('<string>Background</string>')
    expect(d.sadrzaj).not.toContain('<key>Nice</key>')
    expect(d.sadrzaj).not.toContain('LowPriorityIO')
    const ploca = datotekeUsluge(ucitajOpise().find(o => o.ime === 'taskmanager')!, 'darwin', v)[0]
    expect(ploca.sadrzaj).toContain('<string>Background</string>') // ostale usluge kao prije
    expect(datotekeUsluge(opis, 'linux', { ...v, HOME: '/home/regoc' })[0].sadrzaj).not.toContain('Nice=10')
  })
  test('primijeni nad učitanom uslugom: bootstrap tek kad je bootout stvarno gotov (inače launchd „Bootstrap failed: 5")', () => {
    const tm = privremena('tm-voice-')
    const pozivi: string[] = []
    let poBootoutu = -1
    const ex = (argv: string[]) => {
      const c = argv.join(' '); pozivi.push(c)
      if (c.includes('launchctl bootout')) { poBootoutu = 0; return { kod: 0, izlaz: '' } }
      if (c.startsWith('launchctl print')) {
        if (poBootoutu < 0) return { kod: 0, izlaz: 'state = running' }        // učitana prije
        return poBootoutu++ < 2 ? { kod: 0, izlaz: '' } : { kod: 113, izlaz: '' } // launchd još gasi
      }
      return { kod: 0, izlaz: '' }
    }
    primijeni(opis, 'darwin', { ...v, TM_HOME: tm }, { ex, vrijeme: 't' })
    const zadnjiPrint = pozivi.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('launchctl print')).pop()![1]
    const bootstrap = pozivi.findIndex(c => c.includes('launchctl bootstrap'))
    expect(pozivi.filter(c => c.startsWith('launchctl print')).length).toBe(4) // 1 prije + 3 čekanja
    expect(bootstrap).toBeGreaterThan(zadnjiPrint)
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
  test('espeak-ng dobiva tekst kroz stdin (ne argv); preglednik (Origin) i tuđi Host se odbijaju', () => {
    expect(srv).toContain('"--stdin"], input=text.encode()')
    expect(srv).not.toMatch(/"-w",wav,text\]/)
    expect(srv).toContain('not headers.get("Origin")')
    expect((srv.match(/if not lokalni_zahtjev\(self\.headers\)/g) || []).length).toBe(2)
  })
  test('STT pozadina: mlx-whisper na Apple Siliconu (izmjereno 0,42 s vs 3,10 s CPU int8 za 9 s zvuka), inače faster-whisper', () => {
    expect(srv).toContain('STT_BACKEND')
    expect(srv).toContain('mlx-community/whisper-large-v3-turbo')
    expect(srv).toContain('platform.machine() == "arm64"')
    expect(srv).toMatch(/"stt_backend": STT_BACKEND/)
    const s = readFileSync(join(PAKET, 'scripts', 'instaliraj-glas.sh'), 'utf-8')
    expect(s).toContain('MLX_VERZIJA="0.4.3"')
    expect(s).toContain('"mlx-whisper==$MLX_VERZIJA"')
    // Homebrew u PATH PRIJE provjere ffmpeg-a — inače svaki ponovni prolaz zove brew install
    expect(s.indexOf('PATH="$PATH:$(dirname "${BREW_BIN')).toBeLessThan(s.indexOf('FALE_BREW=()'))
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
