/**
 * TASK-5662 (K8 krug 1, Mac): PostgreSQL koji pg0 0.15.2 raspakira na macOS-u vezan je uz
 * Homebrewov OpenSSL (`/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`), pa na čvoru bez
 * Homebrewova openssl@3 `K2.18-baze-pgvector` pada s izlazom 6 (dyld: Library not loaded).
 * DYLD_* okolina to ne rješava: initdb zove `postgres -V` kroz /bin/sh, a SIP mu briše DYLD_*.
 *
 * scripts/macos/pg0-openssl.sh čini instalaciju samostalnom: libssl/libcrypto 3 iz javnog wheela
 * (pinan sha256) u INSTALACIJA/lib, reference → @loader_path, ad-hoc potpis. Ovdje se provjerava
 * bez Maca: otool / install_name_tool / codesign su lažnjaci koji rade nad datotekom `<f>.refs`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const PAKET = join(import.meta.dir, '..')
const SKRIPTA = join(PAKET, 'scripts', 'macos', 'pg0-openssl.sh')
const MAPE: string[] = []
afterAll(() => { for (const d of MAPE) rmSync(d, { recursive: true, force: true }) })
const HB = '/opt/homebrew/opt/openssl@3/lib'

function okruzje() {
  const k = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pg0-openssl-')); MAPE.push(k)
  const bin = join(k, 'lazni'), zapis = join(k, 'zapis.log'), inst = join(k, 'installation', '18.1.0')
  mkdirSync(bin, { recursive: true })
  for (const d of ['bin', 'lib', 'share/extension']) mkdirSync(join(inst, d), { recursive: true })
  // otool -L f → reference iz f.refs (kao Mach-O); bez .refs → nije objekt
  writeFileSync(join(bin, 'otool'), `#!/bin/bash
f="\${@: -1}"; [ -f "$f.refs" ] || { echo "$f: is not an object file"; exit 1; }
echo "$f:"; while read -r r; do printf '\\t%s (compatibility version 3.0.0, current version 3.0.0)\\n' "$r"; done < "$f.refs"
`)
  writeFileSync(join(bin, 'install_name_tool'), `#!/bin/bash
echo "install_name_tool $*" >> "${zapis}"
f="\${@: -1}"
while [ "$#" -gt 1 ]; do
  if [ "$1" = -change ]; then sed -i "s|^$2\\$|$3|" "$f.refs"; shift 3; else shift; fi
done
`)
  writeFileSync(join(bin, 'codesign'), `#!/bin/bash\necho "codesign $*" >> "${zapis}"\n`)
  for (const n of ['otool', 'install_name_tool', 'codesign']) chmodSync(join(bin, n), 0o755)

  // raspored kao pg0 18.1.0 na Macu (izmjereno): postgres izravno na Homebrew, libpq u lib/
  const machO = (rel: string, refs: string[]) => {
    writeFileSync(join(inst, rel), rel.startsWith('bin/') ? '#!/bin/sh\necho "postgres (PostgreSQL) 18.1"\n' : 'dylib')
    chmodSync(join(inst, rel), 0o755)
    writeFileSync(join(inst, rel) + '.refs', refs.join('\n') + '\n')
  }
  machO('bin/postgres', [`${HB}/libssl.3.dylib`, `${HB}/libcrypto.3.dylib`, '/usr/lib/libSystem.B.dylib'])
  machO('bin/initdb', ['@executable_path/../lib/libpq.5.dylib', '/usr/lib/libSystem.B.dylib'])
  machO('lib/libpq.5.dylib', [`${HB}/libssl.3.dylib`, `${HB}/libcrypto.3.dylib`])
  machO('lib/vector.dylib', ['/usr/lib/libSystem.B.dylib'])
  machO('lib/sslinfo.dylib', ['/usr/local/opt/openssl@3/lib/libssl.3.dylib']) // Intel Homebrew
  writeFileSync(join(inst, 'lib', 'libpgport.a'), 'ar')

  // wheel: zip s psycopg_binary/.dylibs/lib{ssl,crypto}.3.dylib (kao psycopg-binary 3.3.6)
  const w = join(k, 'w'); mkdirSync(join(w, 'psycopg_binary', '.dylibs'), { recursive: true })
  writeFileSync(join(w, 'psycopg_binary', '.dylibs', 'libssl.3.dylib'), 'SSL')
  writeFileSync(join(w, 'psycopg_binary', '.dylibs', 'libcrypto.3.dylib'), 'CRYPTO')
  const whl = join(k, 'psycopg_binary.whl')
  expect(Bun.spawnSync(['python3', '-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', whl.replace(/\.whl$/, ''), w]).exitCode).toBe(0)
  Bun.spawnSync(['mv', whl.replace(/\.whl$/, '.zip'), whl])
  const sha = new Bun.CryptoHasher('sha256').update(readFileSync(whl)).digest('hex')

  const pokreni = (env: Record<string, string> = {}, arg: string[] = []) => {
    const r = Bun.spawnSync(['bash', SKRIPTA, inst, ...arg], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: k, TM_PG0_OPENSSL_URL: `file://${whl}`, TM_PG0_OPENSSL_SHA256: sha, ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
  }
  const refs = (rel: string) => readFileSync(join(inst, rel) + '.refs', 'utf-8')
  const poziv = () => existsSync(zapis) ? readFileSync(zapis, 'utf-8') : ''
  return { inst, pokreni, refs, poziv }
}

describe('pg0-openssl.sh — PostgreSQL iz pg0 bez Homebrewova OpenSSL-a (K8 krug 1)', () => {
  test('reference na Homebrew OpenSSL → @loader_path, knjižnice iz wheela u lib/, ad-hoc potpis; drugi put ISTO', () => {
    const o = okruzje()
    const r = o.pokreni()
    expect(r.kod, r.izlaz).toBe(0)
    expect(r.izlaz.trim().split('\n').at(-1)).toBe('PROMIJENJENO')
    expect(readFileSync(join(o.inst, 'lib', 'libssl.3.dylib'), 'utf-8')).toBe('SSL')
    expect(readFileSync(join(o.inst, 'lib', 'libcrypto.3.dylib'), 'utf-8')).toBe('CRYPTO')
    // bin/ → ../lib, lib/ → ista mapa; Intel prefiks /usr/local isto
    expect(o.refs('bin/postgres')).toContain('@loader_path/../lib/libssl.3.dylib')
    expect(o.refs('bin/postgres')).toContain('@loader_path/../lib/libcrypto.3.dylib')
    expect(o.refs('lib/libpq.5.dylib')).toContain('@loader_path/libssl.3.dylib')
    expect(o.refs('lib/sslinfo.dylib')).toContain('@loader_path/libssl.3.dylib')
    for (const f of ['bin/postgres', 'lib/libpq.5.dylib', 'lib/sslinfo.dylib']) expect(o.refs(f)).not.toContain('/opt/openssl@3/')
    // diraju se i potpisuju SAMO datoteke s vanjskom referencom (arm64 ne pokreće nepotpisan Mach-O)
    const p = o.poziv()
    expect(p.match(/^codesign /gm)?.length).toBe(3)
    expect(p).toContain(`codesign --force -s - ${join(o.inst, 'bin', 'postgres')}`)
    expect(p).not.toContain('initdb')
    expect(p).not.toContain('vector.dylib')

    const drugi = o.pokreni({ TM_PG0_OPENSSL_URL: 'file:///nema/ovog/wheela.whl' })
    expect(drugi.kod, drugi.izlaz).toBe(0)
    expect(drugi.izlaz.trim().split('\n').at(-1)).toBe('ISTO')
    expect(o.poziv()).toBe(p)
  })

  test('krivi sha256 wheela → izlaz 5, binarke i lib/ netaknuti', () => {
    const o = okruzje()
    const r = o.pokreni({ TM_PG0_OPENSSL_SHA256: '0'.repeat(64) })
    expect(r.kod, r.izlaz).toBe(5)
    expect(r.izlaz).toContain('sha256')
    expect(existsSync(join(o.inst, 'lib', 'libssl.3.dylib'))).toBe(false)
    expect(o.refs('bin/postgres')).toContain(`${HB}/libssl.3.dylib`)
    expect(o.poziv()).toBe('')
  })

  test('--suho ne piše ništa; bez argumenta → izlaz 2', () => {
    const o = okruzje()
    const r = o.pokreni({}, ['--suho'])
    expect(r.kod, r.izlaz).toBe(0)
    expect(r.izlaz).toContain('(suho)')
    expect(existsSync(join(o.inst, 'lib', 'libssl.3.dylib'))).toBe(false)
    expect(o.poziv()).toBe('')
    expect(Bun.spawnSync(['bash', SKRIPTA]).exitCode).toBe(2)
  })
})

describe('install.sh — macOS: pgvector i Hindsight koriste samostalan PostgreSQL', () => {
  const install = readFileSync(join(PAKET, 'scripts', 'install.sh'), 'utf-8')
  test('pgvector korak na macOS-u raspakira pg0 i zove pg0-openssl.sh prije pravog starta', () => {
    const fn = install.slice(install.indexOf('k_baze_pgvector() {'), install.indexOf('hindsight_env() {'))
    expect(fn).toMatch(/\[ "\$OS" = darwin \] && \{ pg0_macos_openssl \|\| return \$\?; \}/)
    expect(fn.indexOf('pg0_macos_openssl')).toBeLessThan(fn.indexOf('pg0 start --name tm-rag -p 15433 -d'))
    expect(install).toContain('scripts/macos/pg0-openssl.sh')
  })
  test('Hindsight na macOS-u dijeli popravljenu instalaciju (vlastiti pg0 HOME bi raspakirao Homebrewovu)', () => {
    const fn = install.slice(install.indexOf('k_baze_hindsight() {'), install.indexOf('k_baze_modeli() {'))
    expect(fn).toContain('$TM_HOME/rag/home/.pg0/installation')
    expect(fn).toContain('$d/home/.pg0/installation')
  })
  test('alatne mape: uv-receipt, veza python3.13 i predmemorije macOS-a idu u manifest ako ih prije nije bilo', () => {
    const red = install.split('\n').findIndex(l => l.startsWith('ALATNE_MAPE='))
    const alatne = install.split('\n').slice(red, red + 2).join(' ')
    for (const m of ['$HOME/.config/uv', '$HOME/.local/bin/python$PYTHON_BAZE', '$HOME/Library/Caches/bun', '$HOME/Library/Caches/pip']) expect(alatne).toContain(m)
  })
})
