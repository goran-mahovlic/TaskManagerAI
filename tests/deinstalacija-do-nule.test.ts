/**
 * TASK-5656 (plan Mac v3 K3, P3.4): scripts/deinstaliraj.sh (tri razine) i scripts/provjeri-cisto.sh.
 *
 * Kriteriji koje ovaj test drži (bez mreže, bez sudo-a, u privremenom HOME-u i kopiji paketa):
 *   • install.sh --bez-servisa → deinstaliraj --do-nule → provjeri-cisto = 0 redaka,
 *   • --do-nule briše SAMO po manifestu: datoteke vlasnika stroja (izvan manifesta), njegovi
 *     retci u ~/.zshrc i njegov ključ u authorized_keys ostaju bajt-za-bajt isti,
 *   • put iz manifesta izvan $HOME (npr. Homebrew) se ODBIJA (izlaz 9) i ostaje,
 *   • --suho ne mijenja ništa, zadana razina čuva $TM_HOME, --sve radi kopiju 0600,
 *   • lažni darwin: LaunchDaemoni hr.regoc.* idu kroz `launchctl bootout`, tuđi plist ostaje,
 *   • rc.sh: ono što službeni instalator dopiše u ~/.zshrc omota se oznakama i uklanja točno.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { tmpdir } from 'os'
import { osigurajOvisnosti } from './helpers/ovisnosti'

const KORIJEN = join(import.meta.dir, '..')
// svježa kopija stabla nema node_modules → bun install prije testova (uputa #421)
const NODE_MODULES = osigurajOvisnosti(KORIJEN)
const BUN_DIR = dirname(process.execPath)
const radna = () => process.env.TMPDIR || tmpdir()
mkdirSync(radna(), { recursive: true })

interface Okruzje { korijen: string; home: string; paket: string; tm: string }

/** Kopija paketa (praćene + nove datoteke radnog stabla) kao čist git klon, i prazan HOME. */
function okruzje(ime: string): Okruzje {
  const korijen = mkdtempSync(join(radna(), `tm-deinst-${ime}-`))
  const home = join(korijen, 'home'), paket = join(home, 'TaskManagerAI')
  mkdirSync(home, { recursive: true })
  const popis = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: KORIJEN }).stdout.toString().split('\0').filter(Boolean)
  for (const rel of popis) {
    const izvor = join(KORIJEN, rel)
    if (!existsSync(izvor) || rel.startsWith('docs/')) continue
    mkdirSync(dirname(join(paket, rel)), { recursive: true })
    cpSync(izvor, join(paket, rel))
  }
  const g = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=proba', '-c', 'user.email=proba@example.invalid', ...a], { cwd: paket })
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '--no-verify', '-m', 'proba')
  mkdirSync(join(korijen, 'tmp'), { recursive: true })
  return { korijen, home, paket, tm: join(home, '.taskmanager') }
}

function env(o: Okruzje, dodatno: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: o.home, PATH: `${dodatno.PREDPATH ? dodatno.PREDPATH + ':' : ''}${BUN_DIR}:/usr/bin:/bin`, USER: 'proba', LANG: 'C.UTF-8',
    TMPDIR: join(o.korijen, 'tmp'), TM_POSUDI_IZ: NODE_MODULES, TM_BEZ_MREZE: '1',
    // vrata na kojima ovdje sigurno nitko ne sluša (stroj na kojem test radi ima svoju ploču na 17781)
    TM_CISTO_VRATA: '1 2', TM_INSTALL_SLOBODNO_MIB: '100000', ...dodatno,
  }
}
function skripta(o: Okruzje, ime: string, argv: string[], dodatno: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', `scripts/${ime}`, ...argv], { cwd: o.paket, env: env(o, dodatno), stdout: 'pipe', stderr: 'pipe' })
  return { kod: r.exitCode, out: r.stdout.toString(), izlaz: r.stdout.toString() + r.stderr.toString() }
}
const instaliraj = (o: Okruzje, d: Record<string, string> = {}) =>
  skripta(o, 'install.sh', ['--bez-servisa', '--posudi', '--preskoci', 'pdf'], { TM_PORT: String(20000 + Math.floor(Math.random() * 20000)), ...d })
const cisto = (o: Okruzje, d: Record<string, string> = {}) => skripta(o, 'provjeri-cisto.sh', [], d)

/** Sve pod korijenom (osim paketa) s veličinom i vremenom izmjene. */
function snimka(dir: string, osim: string[] = []): string[] {
  const van: string[] = []
  const hodaj = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (osim.includes(p)) continue
      const st = lstatSync(p)
      van.push(`${relative(dir, p)} ${st.isSymbolicLink() ? 'veza' : `${st.size} ${st.mtimeMs}`}`)
      if (e.isDirectory() && !e.isSymbolicLink()) hodaj(p)
    }
  }
  hodaj(dir)
  return van.sort()
}

/** Kao `snimka`, ali mapa bez vremena izmjene: vlasnikova mapa u koju je instalacija nešto
 *  stavila pa to uklonila (~/.local/bin/uv) legitimno ima novi mtime — sadržaj mora biti isti. */
function stanjeHome(dir: string, osim: string[] = []): string[] {
  return snimka(dir, osim).map(r => {
    const [rel] = r.split(' ')
    return lstatSync(join(dir, rel)).isDirectory() ? `${rel} mapa` : r
  })
}

/** Stvari vlasnika stroja: sve izvan manifesta mora ostati netaknuto. */
function vlasnikove(o: Okruzje) {
  mkdirSync(join(o.home, 'Documents'), { recursive: true })
  writeFileSync(join(o.home, 'Documents', 'projekt.txt'), 'tuđe — ne dirati\n')
  mkdirSync(join(o.home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(o.home, '.local', 'bin', 'njegov-alat'), '#!/bin/sh\necho moj\n'); chmodSync(join(o.home, '.local', 'bin', 'njegov-alat'), 0o755)
  mkdirSync(join(o.home, '.ssh'), { recursive: true })
  writeFileSync(join(o.home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAvlasnik vlasnik@laptop\n' + 'ssh-ed25519 AAAAtudji tm-tunel-x\n'  /* N2 (TASK-5686): tuđi ključ, podniz tm-tunel u komentaru */); chmodSync(join(o.home, '.ssh', 'authorized_keys'), 0o600)
  writeFileSync(join(o.home, '.zshrc'), 'export EDITOR=vim\nalias ll="ls -l"\n')
}

/**
 * Lažni `uv` (i njegov službeni instalator kroz lažni `curl`): stvara ono što pravi stvara izvan
 * $TM_HOME — ~/.local/bin/uv, uvx, ~/.config/uv/uv-receipt.json i ~/.cache/uv, a `uv python install`
 * Python u ~/.local/share/uv/python i vezu ~/.local/bin/python3.13 (izmjereno na Macu, K8 krug 1:
 * receipt i veza ostali su nakon --do-nule) — bez mreže. Ostali `curl` pozivi idu pravom curlu.
 */
function lazniUvInstalator(o: Okruzje): string {
  const bin = join(o.korijen, 'lazni-bin'), lazni = join(o.korijen, 'lazni-uv')
  mkdirSync(bin, { recursive: true }); mkdirSync(lazni, { recursive: true })
  writeFileSync(join(lazni, 'python'), '#!/bin/sh\ncase "$*" in *importlib.metadata*) exit 1 ;; esac\nexit 0\n')
  writeFileSync(join(lazni, 'uv'), `#!/bin/sh
case "$1" in
  --version) echo "uv 0.13.4" ;;
  python) p="$HOME/.local/share/uv/python/cpython-3.13-proba/bin/python3.13"
    case "$2" in
      find) [ -x "$p" ] || exit 1; echo "$p" ;;
      install) mkdir -p "$(dirname "$p")" "$HOME/.local/bin"; ln -sf /usr/bin/python3 "$p"; ln -sfn "$p" "$HOME/.local/bin/python3.13" ;;
    esac ;;
  venv) for a; do d="$a"; done; mkdir -p "$d/bin"; cp "${lazni}/python" "$d/bin/python"; chmod 755 "$d/bin/python" ;;
  pip) [ "$3" = --help ] && echo "      --torch-backend <TORCH_BACKEND>"; mkdir -p "$HOME/.cache/uv/wheels"; echo w > "$HOME/.cache/uv/wheels/torch.whl" ;;
esac
exit 0
`)
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
case "$*" in *astral.sh/uv/install.sh*)
  while [ $# -gt 0 ]; do [ "$1" = -o ] && cilj="$2"; shift; done
  printf '%s\\n' '#!/bin/sh' 'mkdir -p "$HOME/.local/bin" "$HOME/.config/uv"' 'cp "${lazni}/uv" "$HOME/.local/bin/uv"; cp "${lazni}/uv" "$HOME/.local/bin/uvx"' 'chmod 755 "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx"' 'echo "{}" > "$HOME/.config/uv/uv-receipt.json"' > "$cilj"
  exit 0 ;;
esac
exec /usr/bin/curl "$@"
`)
  chmodSync(join(bin, 'curl'), 0o755)
  return bin
}

describe('install.sh pada prije manifesta (QA K6 B3) — ponovni install pa --do-nule', () => {
  test('pad na K2.24 → ponovni install → --do-nule → provjeri-cisto = 0 i HOME = snimka prije', async () => {
    const o = okruzje('b3')
    const vrata = 20000 + Math.floor(Math.random() * 20000)
    // „druga ploča" na vratima: /health → 200 iz tuđe mape — k_provjera pada s 8 (prije K2.25)
    const tudja = join(o.korijen, 'tudja'); mkdirSync(tudja)
    const tudji = Bun.spawn([process.execPath, '-e', `Bun.serve({ port: ${vrata}, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1e6)`], { cwd: tudja, stdout: 'ignore', stderr: 'ignore' })
    try {
      vlasnikove(o)
      const prije = stanjeHome(o.home, [o.paket])
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${vrata}/health`); break } catch { await Bun.sleep(100) } }
      const bin = lazniUvInstalator(o)
      const argv = ['--bez-servisa', '--posudi', '--baze', '--preskoci', 'pdf,baze-pgvector']
      const d = { TM_PORT: String(vrata), PREDPATH: bin, TM_INSTALL_OS: 'Linux' }
      const prvi = skripta(o, 'install.sh', argv, d)
      expect(prvi.kod, prvi.izlaz).toBe(8)
      expect(prvi.izlaz).toContain('K2.24-provjera pao')
      expect(existsSync(join(o.home, '.local', 'bin', 'uv'))).toBe(true)    // uv je instaliran u padu
      tudji.kill(); await tudji.exited

      const drugi = skripta(o, 'install.sh', argv, d)
      expect(drugi.kod, drugi.izlaz).toBe(0)
      const putevi = JSON.parse(readFileSync(join(o.tm, 'instalirano.json'), 'utf-8')).stvoreno.map((x: any) => x.put)
      for (const p of [`${o.home}/.local/bin/uv`, `${o.home}/.local/bin/uvx`, `${o.home}/.cache/uv`, o.tm]) expect(putevi).toContain(p)

      const de = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(de.kod, de.izlaz).toBe(0)
      const c = cisto(o)
      expect(c.out, c.izlaz).toBe('')
      expect(c.kod).toBe(0)
      // HOME = snimka prije (logovi krugova namjerno ostaju u ~/.taskmanager-log-arhiva)
      expect(stanjeHome(o.home, [o.paket, join(o.home, '.taskmanager-log-arhiva')])).toEqual(prije)
    } finally { tudji.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 120_000)

  test('pad prije manifesta pa ODMAH --do-nule (bez ponovnog installa) — i dalje čisto', async () => {
    const o = okruzje('b3-odmah')
    const vrata = 20000 + Math.floor(Math.random() * 20000)
    const tudja = join(o.korijen, 'tudja'); mkdirSync(tudja)
    const tudji = Bun.spawn([process.execPath, '-e', `Bun.serve({ port: ${vrata}, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1e6)`], { cwd: tudja, stdout: 'ignore', stderr: 'ignore' })
    try {
      vlasnikove(o)
      const prije = stanjeHome(o.home, [o.paket])
      for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${vrata}/health`); break } catch { await Bun.sleep(100) } }
      const prvi = skripta(o, 'install.sh', ['--bez-servisa', '--posudi', '--baze', '--preskoci', 'pdf,baze-pgvector'],
        { TM_PORT: String(vrata), PREDPATH: lazniUvInstalator(o), TM_INSTALL_OS: 'Linux' })
      expect(prvi.kod, prvi.izlaz).toBe(8)
      tudji.kill(); await tudji.exited
      const de = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(de.kod, de.izlaz).toBe(0)
      expect(cisto(o).out).toBe('')
      expect(stanjeHome(o.home, [o.paket, join(o.home, '.taskmanager-log-arhiva')])).toEqual(prije)
    } finally { tudji.kill(); rmSync(o.korijen, { recursive: true, force: true }) }
  }, 120_000)
})

describe('instalirano.ceka — pad prije nego što bun postoji (B3)', () => {
  test('stavke na čekanju (bez instalirano.json) vide provjeri-cisto i --do-nule', () => {
    const o = okruzje('ceka')
    try {
      const bun = join(o.home, '.bun', 'bin'); mkdirSync(bun, { recursive: true }); writeFileSync(join(bun, 'bun'), 'djelomičan')
      mkdirSync(o.tm, { recursive: true })
      writeFileSync(join(o.tm, 'instalirano.ceka'), `${o.home}/.bun|mapa|K2.4-bun\n${o.tm}|mapa|K2.0-pocetak\n`)
      const prije = cisto(o)
      expect(prije.kod).toBe(1)
      expect(prije.out).toContain(`put\t${o.home}/.bun`)
      const d = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(d.kod, d.izlaz).toBe(0)
      expect(existsSync(join(o.home, '.bun'))).toBe(false)
      expect(cisto(o).out).toBe('')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

const SUSTAVNI_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
const imaReportlab = Bun.spawnSync(['python3', '-c', 'import reportlab, pypdf']).exitCode === 0

describe('deinstaliraj.sh --do-nule — fontovi naredbe pdf (K8 krug 1, TASK-5662)', () => {
  // Na Macu su nakon --do-nule ostali ~/Library/Fonts/DejaVu*.ttf: instaliraj-pdf.sh ih preuzme,
  // a manifest ih nije znao (provjeri-cisto ih zato nije ni vidio).
  test.skipIf(!existsSync(SUSTAVNI_FONT) || !imaReportlab)('lažni darwin: preuzeti fontovi idu u manifest, --do-nule ih briše, HOME = snimka prije', () => {
    const o = okruzje('fontovi')
    try {
      vlasnikove(o)
      mkdirSync(join(o.home, 'Library'), { recursive: true })   // Mac uvijek ima ~/Library (zaštićena)
      const prije = stanjeHome(o.home, [o.paket])
      // zrcalo službenog izdanja DejaVu (isti raspored kao tar 2.37), kao u instaliraj-pdf-mac.test.ts
      const izv = join(o.korijen, 'dejavu-izv'); mkdirSync(join(izv, 'dejavu-fonts-ttf-2.37', 'ttf'), { recursive: true })
      for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) cpSync(SUSTAVNI_FONT, join(izv, 'dejavu-fonts-ttf-2.37', 'ttf', f))
      const tar = join(o.korijen, 'dejavu.tar.bz2')
      expect(Bun.spawnSync(['tar', '-cjf', tar, '-C', izv, 'dejavu-fonts-ttf-2.37']).exitCode).toBe(0)
      const sha = new Bun.CryptoHasher('sha256').update(readFileSync(tar)).digest('hex')
      const i = skripta(o, 'install.sh', ['--bez-servisa', '--posudi'], {
        TM_PORT: String(20000 + Math.floor(Math.random() * 20000)), TM_OS: 'Darwin',
        TM_PDF_DEJAVU_URL: `file://${tar}`, TM_PDF_DEJAVU_SHA256: sha, TM_PDF_PDFTOTEXT: 'nema-pdftotext-5662',
      })
      expect(i.kod, i.izlaz).toBe(0)
      const fontovi = join(o.home, 'Library', 'Fonts')
      expect(existsSync(join(fontovi, 'DejaVuSans.ttf'))).toBe(true)
      const stvoreno = JSON.parse(readFileSync(join(o.tm, 'instalirano.json'), 'utf-8')).stvoreno.map((x: any) => `${x.put}|${x.vrsta}`)
      expect(stvoreno).toContain(`${fontovi}/DejaVuSans.ttf|datoteka`)
      expect(stvoreno).toContain(`${fontovi}/DejaVuSans-Bold.ttf|datoteka`)
      expect(stvoreno).toContain(`${fontovi}|mapa-ako-prazna`)

      const de = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(de.kod, de.izlaz).toBe(0)
      expect(cisto(o).out).toBe('')
      expect(stanjeHome(o.home, [o.paket, join(o.home, '.taskmanager-log-arhiva')])).toEqual(prije)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 180_000)
})

describe('deinstaliraj.sh --do-nule — od instalacije do čistog stroja', () => {
  test('install --bez-servisa → --do-nule → provjeri-cisto = 0; tuđe ostaje bajt-za-bajt', () => {
    const o = okruzje('nula')
    try {
      vlasnikove(o)
      const prije = { zshrc: readFileSync(join(o.home, '.zshrc'), 'utf-8'), kljucevi: readFileSync(join(o.home, '.ssh/authorized_keys'), 'utf-8') }
      const i = instaliraj(o)
      expect(i.kod, i.izlaz).toBe(0)
      expect(existsSync(join(o.tm, 'instalirano.json'))).toBe(true)
      // što bi instalacija dodala izvan $TM_HOME (bun, uv, venv…) — dopisujemo kroz isti manifest.ts
      const bun = join(o.home, '.bun', 'bin'); mkdirSync(bun, { recursive: true })
      symlinkSync('/bin/sleep', join(bun, 'bun'))
      mkdirSync(join(o.home, '.local', 'share', 'uv', 'python'), { recursive: true })
      writeFileSync(join(o.home, '.local', 'bin', 'uv'), 'uv')
      writeFileSync(join(o.home, '.zshrc'), prije.zshrc + '# >>> TaskManagerAI >>> (bun.sh/install)\nexport PATH="$HOME/.bun/bin:$PATH"\n# <<< TaskManagerAI <<<\n')
      writeFileSync(join(o.home, '.ssh/authorized_keys'), prije.kljucevi + 'restrict,port-forwarding ssh-ed25519 AAAAtunel tm-tunel\n')
      const m = Bun.spawnSync(['bun', 'scripts/instalacija/manifest.ts', join(o.tm, 'instalirano.json')], {
        cwd: o.paket, stdin: Buffer.from([`${o.home}/.bun|mapa|K2.4-bun`, `${o.home}/.local/share/uv/python|mapa|K2.16`, `${o.home}/.local/bin/uv|datoteka|K2.15`,
          `${o.home}/.local/share/uv|mapa|K2.25`, `${o.home}/.local/share|mapa-ako-prazna|K2.25`].join('\n')),
      })
      expect(m.exitCode).toBe(0)
      // zaostali proces iz instalacije (npr. ručno pokrenut bun) — mora ga zaustaviti
      const proces = Bun.spawn([join(bun, 'bun'), '300'], { stdout: 'ignore', stderr: 'ignore' })
      const prijeCisto = cisto(o)
      expect(prijeCisto.kod).toBe(1)
      expect(prijeCisto.out).toContain(`put\t${o.tm}`)
      expect(prijeCisto.out).toContain('proces\t')
      expect(prijeCisto.out).toContain('rc\t')
      expect(prijeCisto.out).toContain('kljuc\t')

      const vlasnik = snimka(join(o.home, 'Documents')).concat(snimka(join(o.home, '.local', 'bin')).filter(r => !r.startsWith('uv ')))
      const d = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(d.kod, d.izlaz).toBe(0)
      const c = cisto(o)
      expect(c.out, c.izlaz).toBe('')            // 0 redaka = čisto
      expect(c.kod).toBe(0)
      // zaustavljen (ostaje samo zombi dok ga test ne pokupi — „Z" ili ga više nema)
      expect(Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(proces.pid)]).stdout.toString().trim()).toMatch(/^(Z.*)?$/)
      // tuđe: isto
      expect(snimka(join(o.home, 'Documents')).concat(snimka(join(o.home, '.local', 'bin')))).toEqual(vlasnik)
      expect(readFileSync(join(o.home, '.zshrc'), 'utf-8')).toBe(prije.zshrc)
      expect(readFileSync(join(o.home, '.ssh/authorized_keys'), 'utf-8')).toBe(prije.kljucevi)
      expect(existsSync(join(o.home, '.local', 'share'))).toBe(false)     // bila je prazna i naša
      expect(existsSync(join(o.home, '.local', 'bin'))).toBe(true)        // nije u manifestu
      // paket ostaje (skripta radi iz njega), logovi krugova i manifest u arhivi
      expect(existsSync(join(o.paket, 'scripts', 'deinstaliraj.sh'))).toBe(true)
      const arhiva = join(o.home, '.taskmanager-log-arhiva')
      expect(readdirSync(join(arhiva, 'install')).some(x => /^\d{8}-\d{6}/.test(x))).toBe(true)
      expect(readdirSync(join(arhiva, 'manifest')).length).toBe(1)
      const rez = JSON.parse(readFileSync(join(arhiva, 'deinstalacija', 'zadnji', 'deinstalacija-rezultat.json'), 'utf-8'))
      expect(rez.ishod).toBe('uspjeh')
      const koraci = readFileSync(join(arhiva, 'deinstalacija', 'zadnji', 'koraci.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
      expect(koraci.map(k => k.korak)).toEqual(['D1-usluge', 'D2-procesi', 'D3-naredbe', 'D4-kopija', 'D5-arhiva', 'D6-tm-home', 'D7-manifest', 'D8-rc', 'D9-kljuc', 'D10-provjera'])
      expect(koraci.every(k => k.izlaz === 0)).toBe(true)
      // drugi --do-nule na čistom stroju: ništa za ukloniti, i dalje čisto
      const d2 = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(d2.kod, d2.izlaz).toBe(0)
      expect(cisto(o).out).toBe('')
      proces.kill(9)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)

  test('put iz manifesta izvan $HOME (tuđi Homebrew), zaštićena mapa i veza van → odbijeno (izlaz 9), ostaje', () => {
    const o = okruzje('brana')
    try {
      const tudje = join(o.korijen, 'opt-homebrew'); mkdirSync(join(tudje, 'bin'), { recursive: true }); writeFileSync(join(tudje, 'bin', 'brew'), 'brew')
      mkdirSync(join(o.home, '.ssh'), { recursive: true }); writeFileSync(join(o.home, '.ssh', 'id_ed25519'), 'tajno')
      symlinkSync(tudje, join(o.home, 'veza-van'))
      mkdirSync(join(o.tm), { recursive: true })
      const stavke = [tudje, `${o.home}/.ssh`, `${o.home}/.ssh/id_ed25519`, `${o.home}/veza-van/bin`, o.home, `${o.home}/../izvan`, o.paket]
      writeFileSync(join(o.tm, 'instalirano.json'), JSON.stringify({ verzija: 1, stvoreno: stavke.map(put => ({ put, vrsta: 'mapa', korak: 'proba', kada: 'x' })) }, null, 2) + '\n')
      const d = skripta(o, 'deinstaliraj.sh', ['--do-nule', '--bez-kopije'])
      expect(d.kod, d.izlaz).toBe(9)
      expect(d.izlaz).toContain(`ODBIJENO ${tudje} — izvan ${o.home}`)
      expect(d.izlaz).toContain('ODBIJENO ' + o.paket)
      expect(existsSync(join(tudje, 'bin', 'brew'))).toBe(true)
      expect(readFileSync(join(o.home, '.ssh', 'id_ed25519'), 'utf-8')).toBe('tajno')
      expect(existsSync(join(o.paket, 'scripts', 'deinstaliraj.sh'))).toBe(true)
      expect(existsSync(o.home)).toBe(true)
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)

  test('--suho ne mijenja ništa; zadana razina čuva $TM_HOME; --sve: kopija 0600, runtime ostaje', () => {
    const o = okruzje('razine')
    try {
      expect(instaliraj(o).kod).toBe(0)
      const bin = join(o.home, '.local', 'bin'); mkdirSync(bin, { recursive: true })
      symlinkSync(join(o.paket, 'scripts', 'pdf', 'pdf'), join(bin, 'pdf'))
      mkdirSync(join(o.home, '.bun'), { recursive: true })
      Bun.spawnSync(['bun', 'scripts/instalacija/manifest.ts', join(o.tm, 'instalirano.json')], { cwd: o.paket, stdin: Buffer.from(`${o.home}/.bun|mapa|K2.4-bun`) })
      const prije = snimka(o.home, [o.paket])
      const s = skripta(o, 'deinstaliraj.sh', ['--suho', '--do-nule'])
      expect(s.kod, s.izlaz).toBe(0)
      expect(s.izlaz).toContain(`(suho) uklonila bih ${o.tm}`)
      expect(s.izlaz).toContain(`(suho) uklonila bih ${o.home}/.bun`)
      expect(snimka(o.home, [o.paket])).toEqual(prije)

      const z = skripta(o, 'deinstaliraj.sh', [])
      expect(z.kod, z.izlaz).toBe(0)
      expect(existsSync(join(bin, 'pdf'))).toBe(false)          // veza u paket = naredba paketa
      expect(existsSync(join(o.tm, 'data'))).toBe(true)         // podaci ostaju
      expect(existsSync(join(o.tm, 'log', 'deinstalacija', 'zadnji', 'koraci.jsonl'))).toBe(true)

      const v = skripta(o, 'deinstaliraj.sh', ['--sve'])
      expect(v.kod, v.izlaz).toBe(0)
      expect(existsSync(o.tm)).toBe(false)
      expect(existsSync(join(o.home, '.bun'))).toBe(true)       // runtime ostaje uz --sve
      const tgz = readdirSync(o.home).filter(x => /^taskmanager-backup-\d{8}-\d{6}\.tgz$/.test(x))
      expect(tgz.length).toBe(1)
      expect(statSync(join(o.home, tgz[0])).mode & 0o777).toBe(0o600)
      const sadrzaj = Bun.spawnSync(['tar', 'tzf', join(o.home, tgz[0])]).stdout.toString()
      expect(sadrzaj).toContain('.taskmanager/data/tasks.db')
      expect(sadrzaj).toContain('.taskmanager/backups/')
      expect(sadrzaj).not.toContain('.taskmanager/log/install/')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 60_000)
})

describe('deinstaliraj.sh — lažni darwin (LaunchDaemon)', () => {
  test('hr.regoc.* kroz launchctl bootout i sudo rm; tuđi plist ostaje; bez sudo-a izlaz 3', () => {
    const o = okruzje('darwin')
    try {
      const ld = join(o.korijen, 'LaunchDaemons'); mkdirSync(ld)
      for (const f of ['hr.regoc.taskmanager.plist', 'hr.regoc.daemon.plist', 'com.tailscale.tailscaled.plist']) writeFileSync(join(ld, f), '<plist/>')
      const lazni = join(o.korijen, 'lazni'); mkdirSync(lazni)
      const zapis = join(o.korijen, 'pozivi.txt')
      writeFileSync(join(lazni, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> ${zapis}\ncase "$1 $2" in "print system/hr.regoc.taskmanager") exit 0 ;; "print system") echo "  123 0 hr.regoc.taskmanager"; exit 0 ;; esac\n[ "$1" = bootout ] && exit 0\nexit 113\n`)
      writeFileSync(join(lazni, 'sudo'), `#!/bin/sh\n[ "$1" = -n ] && shift\n[ -f ${o.korijen}/bez-sudo ] && exit 1\necho "sudo $*" >> ${zapis}\nexec "$@"\n`)
      writeFileSync(join(lazni, 'sw_vers'), '#!/bin/sh\necho 27.0.1\n')
      for (const f of ['launchctl', 'sudo', 'sw_vers']) chmodSync(join(lazni, f), 0o755)
      const d = { PREDPATH: lazni, TM_INSTALL_OS: 'darwin', TM_LAUNCHD_DIR: ld }

      writeFileSync(join(o.korijen, 'bez-sudo'), '')
      const bez = skripta(o, 'deinstaliraj.sh', [], d)
      expect(bez.kod, bez.izlaz).toBe(3)
      expect(bez.izlaz).toContain("sudo -v")
      rmSync(join(o.korijen, 'bez-sudo'))

      const r = skripta(o, 'deinstaliraj.sh', [], d)
      expect(r.kod, r.izlaz).toBe(0)
      const pozivi = readFileSync(zapis, 'utf-8')
      expect(pozivi).toContain('sudo launchctl bootout system/hr.regoc.taskmanager')
      expect(pozivi).not.toContain('bootout system/hr.regoc.daemon')      // nije učitan → samo plist
      expect(pozivi).toContain(`sudo rm -f ${ld}/hr.regoc.daemon.plist`)
      expect(readdirSync(ld)).toEqual(['com.tailscale.tailscaled.plist'])
      // provjeri-cisto vidi učitanu uslugu u launchd-u (lažni launchctl je i dalje „drži")
      const c = cisto(o, d)
      expect(c.out).toContain('ucitano\tsystem/hr.regoc.taskmanager')
    } finally { rmSync(o.korijen, { recursive: true, force: true }) }
  }, 30_000)
})

describe('rc.sh — retci službenih instalatora u ~/.zshrc', () => {
  const ljuska = (home: string, kod: string) => Bun.spawnSync(['bash', '-c', `. scripts/instalacija/rc.sh; ${kod}`], {
    cwd: KORIJEN, env: { HOME: home, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })

  test('dopisano se omota oznakama, rc_ukloni vraća izvornik; nova datoteka → RC-NOVA; sredina → upozorenje', () => {
    const home = mkdtempSync(join(radna(), 'tm-rc-'))
    try {
      const zsh = join(home, '.zshrc'), izvornik = 'export EDITOR=vim\n# moje\n'
      writeFileSync(zsh, izvornik)
      writeFileSync(join(home, '.bashrc'), 'a\nb\n')
      const r = ljuska(home, `rc_snimi "$HOME/snimka"
        printf '\\n# bun\\nexport BUN_INSTALL="$HOME/.bun"\\n' >> "$HOME/.zshrc"
        printf 'export X=1\\n' > "$HOME/.profile"
        printf 'a\\nUBACENO\\nb\\n' > "$HOME/.bashrc"
        rc_oznaci "$HOME/snimka" bun.sh/install`)
      const izl = r.stdout.toString()
      expect(izl).toContain(`RC ${zsh}`)
      expect(izl).toContain(`RC-NOVA ${home}/.profile`)
      expect(izl).toContain(`RC-UPOZORENJE ${home}/.bashrc`)
      const s = readFileSync(zsh, 'utf-8')
      expect(s).toBe(izvornik + '# >>> TaskManagerAI >>> (bun.sh/install)\n# bun\nexport BUN_INSTALL="$HOME/.bun"\n# <<< TaskManagerAI <<<\n')
      expect(existsSync(join(home, 'snimka'))).toBe(false)
      expect(ljuska(home, 'rc_ukloni "$HOME/.zshrc"').exitCode).toBe(0)
      expect(readFileSync(zsh, 'utf-8')).toBe(izvornik)
      expect(ljuska(home, 'rc_ukloni "$HOME/.zshrc"').exitCode).toBe(1)   // nema više oznaka
      expect(readFileSync(join(home, '.bashrc'), 'utf-8')).toBe('a\nUBACENO\nb\n')   // sredinu ne dira
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('provjeri-cisto.sh — samostalno (bez repozitorija)', () => {
  test('kroz stdin (curl | bash): prazan HOME = 0 redaka; vrata procesa iz HOME-a su ostatak, tuđa samo napomena', async () => {
    const home = mkdtempSync(join(radna(), 'tm-cisto-'))
    const posluzitelj = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    try {
      const pokreni = (vrata: string) => Bun.spawnSync(['bash', '-s'], {
        stdin: Buffer.from(readFileSync(join(KORIJEN, 'scripts', 'provjeri-cisto.sh'))),
        cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TM_CISTO_VRATA: vrata }, stdout: 'pipe', stderr: 'pipe' })
      const r = pokreni('1')
      expect(r.stdout.toString()).toBe('')
      expect(r.exitCode).toBe(0)
      expect(r.stderr.toString()).toContain('čisto (0 ostataka)')
      // tuđi proces (ovaj test, radna mapa izvan HOME-a) na vratima: napomena, 0 redaka
      const t = pokreni(String(posluzitelj.port))
      expect(t.stdout.toString()).toBe('')
      expect(t.exitCode).toBe(0)
      expect(t.stderr.toString()).toContain(`napomena: vrata ${posluzitelj.port}`)
      // proces instalacije (radna mapa u HOME-u) na vratima: ostatak
      const vrata = 20000 + Math.floor(Math.random() * 20000)
      const nas = Bun.spawn([process.execPath, '-e', `Bun.serve({ port: ${vrata}, hostname: '127.0.0.1', fetch: () => new Response('ok') })`], { cwd: home, stdout: 'ignore', stderr: 'ignore' })
      try {
        for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${vrata}/`)).ok) break } catch {} await Bun.sleep(100) }
        const z = pokreni(String(vrata))
        expect(z.exitCode).toBe(1)
        expect(z.stdout.toString()).toMatch(new RegExp(`^vrata\\t${vrata} \\(PID ${nas.pid}`))
      } finally { nas.kill(9) }
    } finally { posluzitelj.stop(true); rmSync(home, { recursive: true, force: true }) }
  })
})
