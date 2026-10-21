/**
 * TASK-5658 (plan Mac v2 §4 K4a, P3.2, P4.1): README „Instalacija na novi stroj" i primjeri postavki.
 *
 * README je JEDINI izvor instalacije na novom stroju (K8 ga izvodi doslovno), pa se ovdje drži
 * da ono što piše stvarno postoji: svaka naredba `bash|bun scripts/…` vodi na datoteku u paketu,
 * svaka zastavica `install.sh`/`deinstaliraj.sh` je zastavica te skripte, preduvjeti su upravo
 * ono što `install.sh` (korak K2.3) traži, a EN i HR odjeljak nose iste naredbe.
 *
 * Primjeri `config/postavke.env.primjer` i `config/memorija.primjer.json` ne smiju nositi ni
 * jednu vrijednost stroja: stvarne vrijednosti žive samo u `$TM_HOME/config` (0600).
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const procitaj = (rel: string) => readFileSync(join(KORIJEN, rel), 'utf-8')

const NASLOVI: Record<string, string> = {
  'README.md': '## Install on a new machine (Linux / macOS)',
  'README.hr.md': '## Instalacija na novi stroj (Linux / macOS)',
}

/** Tekst odjeljka od naslova do idućeg `## `. */
function odjeljak(rel: string): string {
  const t = procitaj(rel)
  const i = t.indexOf(NASLOVI[rel])
  if (i < 0) return ''
  const kraj = t.indexOf('\n## ', i + 1)
  return t.slice(i, kraj < 0 ? undefined : kraj)
}

/** Retci naredbi iz ```bash blokova odjeljka (bez komentara i praznih redaka). */
function naredbe(rel: string): string[] {
  const blokovi = [...odjeljak(rel).matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1])
  return blokovi.flatMap(b => b.split('\n'))
    .map(r => r.replace(/\s+#.*$/, '').trim())
    .filter(r => r && !r.startsWith('#'))
}

/** Zastavice koje skripta prepoznaje u svom `case` (npr. `--cvor)`). */
function zastaviceSkripte(rel: string): Set<string> {
  return new Set([...procitaj(rel).matchAll(/^\s*(--[a-z-]+)(?:\|[^)]*)?\)/gm)].map(m => m[1]))
}

describe('README: odjeljak „Instalacija na novi stroj" (K4a)', () => {
  for (const rel of Object.keys(NASLOVI)) {
    test(`${rel} ima odjeljak s naredbama K8 (git clone → install.sh --cvor … --profil upravitelj-cvora --baze)`, () => {
      const n = naredbe(rel)
      expect(n.length).toBeGreaterThan(5)
      expect(n).toContain('git clone https://github.com/goran-mahovlic/TaskManagerAI.git ~/TaskManagerAI')
      expect(n).toContain('cd ~/TaskManagerAI')
      expect(n).toContain('bash scripts/install.sh --cvor <name> --profil upravitelj-cvora --baze')
    })

    test(`${rel}: svaka naredba scripts/… postoji u paketu`, () => {
      const skripte = naredbe(rel).flatMap(r => [...r.matchAll(/\b(?:bash|bun)\s+(scripts\/[\w./-]+)/g)].map(m => m[1]))
      expect(skripte.length).toBeGreaterThan(4)
      for (const s of skripte) expect(existsSync(join(KORIJEN, s)) ? s : `NEMA ${s}`).toBe(s)
    })

    test(`${rel}: zastavice install.sh i deinstaliraj.sh postoje u skripti`, () => {
      const poSkripti: Record<string, Set<string>> = {
        'scripts/install.sh': zastaviceSkripte('scripts/install.sh'),
        'scripts/deinstaliraj.sh': zastaviceSkripte('scripts/deinstaliraj.sh'),
      }
      // naredbe iz blokova i iz `…` u tekstu (npr. ponovno pokretanje s --claude)
      const uTekstu = [...odjeljak(rel).matchAll(/`(bash scripts\/[^`\n]+)`/g)].map(m => m[1])
      for (const r of [...naredbe(rel), ...uTekstu]) {
        const m = r.match(/bash (scripts\/(?:install|deinstaliraj)\.sh)(.*)$/)
        if (!m) continue
        for (const z of m[2].match(/--[a-z-]+/g) ?? []) {
          expect(poSkripti[m[1]].has(z) ? z : `${m[1]} ne zna ${z}`).toBe(z)
        }
      }
    })

    test(`${rel}: profil iz naredbe postoji (profili/upravitelj-cvora)`, () => {
      expect(existsSync(join(KORIJEN, 'profili/upravitelj-cvora/profil.json'))).toBe(true)
    })

    test(`${rel}: preduvjeti su upravo oni koje traži install.sh (Debian apt + macOS Command Line Tools)`, () => {
      const n = naredbe(rel)
      const apt = n.find(r => r.startsWith('sudo apt-get install')) ?? ''
      for (const p of ['git', 'curl', 'unzip', 'ca-certificates', 'python3', 'python3-venv']) {
        expect(apt.split(/\s+/)).toContain(p)
      }
      expect(n).toContain('xcode-select --install')
      expect(n).toContain('sudo -v')   // LaunchDaemon na macOS-u traži sudo (k_preduvjeti)
      const t = procitaj('scripts/install.sh')
      expect(t).toContain('xcode-select --install')
      expect(t).toContain('sudo apt-get install -y')
    })

    test(`${rel}: AI servis bira korisnik — popis + čarobnjak, bez pretpostavljenog servisa`, () => {
      const n = naredbe(rel)
      expect(n).toContain('bun scripts/prijava-ai.ts popis')
      expect(n).toContain('bun scripts/prijava-ai.ts')
      const tekst = odjeljak(rel)
      for (const id of ['claude', 'openrouter', 'ollama']) expect(tekst).toContain(`\`${id}\``)
    })

    test(`${rel}: bez zabranjenih putova K8 (scp, bundle, ručno kopiranje postavki u stablo)`, () => {
      const n = naredbe(rel).join('\n')
      expect(n).not.toMatch(/\bscp\b|\brsync\b|bundle|cp [^\n]*config\/postavke\.env\b|cp [^\n]*memorija\.json/)
    })
  }

  test('install.sh na kraju imenuje iste lokalne datoteke kao tablica u README-u', () => {
    const kraj = procitaj('scripts/install.sh').split('lokalno upiši')[1] ?? ''
    for (const f of ['postavke.env', 'profil.instanca.env', 'memorija.json']) {
      expect(kraj).toContain(`$TM_HOME/config/${f}`)
      for (const rel of Object.keys(NASLOVI)) expect(odjeljak(rel)).toContain(`| \`${f}\` |`)
    }
  })

  test('EN i HR odjeljak nose iste naredbe (isti redoslijed)', () => {
    expect(naredbe('README.hr.md')).toEqual(naredbe('README.md'))
  })
})

describe('primjeri postavki bez ijedne vrijednosti (P4.1)', () => {
  test('config/postavke.env.primjer: nijedan aktivan redak, svaka zakomentirana postavka je prazna', () => {
    const retci = procitaj('config/postavke.env.primjer').split('\n')
    const aktivni = retci.filter(r => r.trim() && !r.trim().startsWith('#'))
    expect(aktivni).toEqual([])
    const postavke = retci.map(r => r.match(/^#\s?([A-Z][A-Z0-9_]*)=(.*)$/)).filter(Boolean) as RegExpMatchArray[]
    expect(postavke.length).toBeGreaterThan(5)
    for (const m of postavke) expect(`${m[1]}=${m[2]}`).toBe(`${m[1]}=`)
    const imena = postavke.map(m => m[1])
    for (const ime of ['TM_PORT', 'TM_BIND', 'TM_ALLOWED_HOSTS']) expect(imena).toContain(ime)
  })

  test('config/memorija.primjer.json: izvor je prekidač, adrese/vrata/banke/korisnici prazni', () => {
    const j = JSON.parse(procitaj('config/memorija.primjer.json'))
    expect(['nasa', 'lokalna', 'iskljuceno']).toContain(j.memorija.izvor)
    expect(['nasa', 'lokalna', 'iskljuceno']).toContain(j.rag.izvor)
    const vrijednosti: string[] = []
    const obidi = (o: any, put: string) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') obidi(v, `${put}.${k}`)
        else if (['host', 'port', 'banka', 'baza', 'korisnik', 'lozinka', 'ollama', 'url'].includes(k) && v !== '' && v !== null) {
          vrijednosti.push(`${put}.${k}=${v}`)
        }
      }
    }
    obidi(j, '')
    expect(vrijednosti).toEqual([])
    // polja i dalje postoje, da se zna što se lokalno upisuje
    expect(Object.keys(j.memorija.nasa)).toEqual(expect.arrayContaining(['host', 'port']))
    expect(Object.keys(j.rag.lokalna)).toEqual(expect.arrayContaining(['host', 'port', 'lozinkaEnv']))
  })

  test('lokalne kopije primjera ne mogu u repozitorij (.gitignore)', () => {
    const r = Bun.spawnSync(['git', 'check-ignore', 'config/postavke.env', 'config/memorija.json', '.env'], { cwd: KORIJEN })
    expect(r.stdout.toString().trim().split('\n').sort()).toEqual(['.env', 'config/memorija.json', 'config/postavke.env'])
  })
})
