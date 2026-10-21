/**
 * TASK-5662 (K8 krug 1, Mac): instaliraj-pdf.sh je na macOS-u zvao `python3 -m pip --python VENV`,
 * a pip Pythona iz Command Line Tools (3.9, pip 21.2) tu zastavicu nema (dolazi s pipom 22.3):
 * „no such option: --python" → K2.7-pdf upozorenje „naredba pdf nije spremna" (izmjereno na Macu).
 * pip_u_venv: prvo pip samog venva (ensurepip), a pip sustava s --python samo kao rezerva
 * (Debian bez ensurepip-a).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const POMOCNIK = join(import.meta.dir, '..', 'scripts', 'instalacija', 'pip-u-venv.sh')
const MAPE: string[] = []
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })

/** Lažni venv python (ensurepip uspije ili ne) i lažni python3 sustava sa starim pipom. */
function okruzje(ensurepip: boolean) {
  const k = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pip-venv-')); MAPE.push(k)
  const venv = join(k, 'venv'), bin = join(k, 'bin'), zapis = join(k, 'zapis.log')
  mkdirSync(join(venv, 'bin'), { recursive: true }); mkdirSync(bin)
  writeFileSync(join(venv, 'bin', 'python'), `#!/bin/bash
echo "venv $*" >> "${zapis}"
case "$*" in
  "-m pip --version") [ -f "${venv}/ima-pip" ] && exit 0; exit 1 ;;
  "-m ensurepip") ${ensurepip ? `touch "${venv}/ima-pip"; exit 0` : 'exit 1'} ;;
  "-m pip install"*) [ -f "${venv}/ima-pip" ] && exit 0; exit 1 ;;
esac
exit 0
`)
  writeFileSync(join(bin, 'python3'), `#!/bin/bash
echo "sustav $*" >> "${zapis}"
case "$*" in *--python*) echo "no such option: --python" >&2; exit 2 ;; esac
exit 0
`)
  chmodSync(join(venv, 'bin', 'python'), 0o755); chmodSync(join(bin, 'python3'), 0o755)
  const pokreni = () => {
    const r = Bun.spawnSync(['bash', '-c', `. "${POMOCNIK}"; pip_u_venv "${venv}" reportlab==4.4.4 pypdf==6.1.1`],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' })
    return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString(), zapis: existsSync(zapis) ? readFileSync(zapis, 'utf-8') : '' }
  }
  return { pokreni }
}

describe('pip_u_venv — pip u venv i na macOS-u (CLT Python 3.9 nema pip --python)', () => {
  test('venv dobije vlastiti pip (ensurepip) i instalira njime; pip sustava se ne zove', () => {
    const r = okruzje(true).pokreni()
    expect(r.kod, r.izlaz + r.zapis).toBe(0)
    expect(r.zapis).toMatch(/^venv -m ensurepip$/m) // ensurepip ne zna -q (izmjereno: CLT Python 3.9)
    expect(r.zapis).toMatch(/venv -m pip install .*--no-cache-dir reportlab==4\.4\.4 pypdf==6\.1\.1/) // predmemorija nije u manifestu
    expect(r.zapis).not.toContain('sustav')
  })
  test('bez ensurepip-a (Debian) → rezerva: pip sustava s --python', () => {
    const r = okruzje(false).pokreni()
    expect(r.zapis).toMatch(/sustav -m pip --python \S+\/venv\/bin\/python install/)
    expect(r.kod).not.toBe(0) // lažni stari pip sustava odbija --python → pad se vidi
  })
  test('instaliraj-pdf.sh koristi pip_u_venv, ne izravno pip --python', () => {
    const t = readFileSync(join(import.meta.dir, '..', 'scripts', 'instaliraj-pdf.sh'), 'utf-8')
    expect(t).toContain('pip_u_venv "$VENV"')
    expect(t).not.toMatch(/^\s*python3 -m pip --python/m)
  })
})
