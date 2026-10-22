/**
 * spremiste-tajni.ts — TASK-5705 (uputa #441): JEDAN čitač spremišta tajni za cijeli komplet.
 *
 * Spremište je `~/.claude/regoc/credentials.env` (ili `REGOC_CREDENTIALS`). Na čvoru s paketom
 * TaskManagerAI je to poveznica na spremište paketa (`$TM_HOME/config/credentials.env`) koju
 * stvara `instalacija.sh` kompleta — tajne upisuje vlasnik čvora na ploči (Config → Tajne,
 * ADR-0007), a komplet ih čita odavde bez restarta.
 *
 * Pisač ploče piše `IME='…'` (POSIX jednostruki navodnici, ADR-0007 §5.2); stari ručni zapis je
 * `IME=…`. Ovaj čitač razumije oba, isto kao `LoginCreds.parsirajRedak` u paketu: čitač kompleta
 * je prije vraćao vrijednost S navodnicima kad ju je upisala ploča. Ništa se ne izvršava (`$(…)`
 * ostaje doslovno), vrijednost se nikad ne izvozi u `process.env` i nikad ne ispisuje.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

export function putSpremistaTajni(env: Record<string, string | undefined> = process.env): string {
  return env.REGOC_CREDENTIALS || join(env.HOME || '', '.claude', 'regoc', 'credentials.env')
}

/** Riječ ljuske s navodnicima (`'…'`, `"…"`, `'a'\''b'`) → niz; nezatvoren navodnik → null. */
function dekodiraj(s: string): string | null {
  let out = '', i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') break // ostatak je razmak ili `# komentar`
    if (c === "'") {
      const kraj = s.indexOf("'", i + 1)
      if (kraj < 0) return null
      out += s.slice(i + 1, kraj); i = kraj + 1
    } else if (c === '"') {
      i++
      for (;;) {
        if (i >= s.length) return null
        const d = s[i]!
        if (d === '"') { i++; break }
        if (d === '\\' && i + 1 < s.length && '$`"\\'.includes(s[i + 1]!)) { out += s[i + 1]; i += 2; continue }
        out += d; i++
      }
    } else if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2 }
    else { out += c; i++ }
  }
  return out
}

const DODJELA = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** Vrijednost retka za točno ime `ime`; drugo ime, komentar ili prazno → null. */
export function vrijednostRetka(redak: string, ime: string): string | null {
  const m = DODJELA.exec(redak.replace(/\r$/, ''))
  if (!m || m[1] !== ime) return null
  const sirovo = m[2]!.trim()
  let v: string | null = null
  if (sirovo.startsWith("'") || sirovo.startsWith('"')) v = dekodiraj(sirovo)
  if (v === null) v = sirovo.replace(/^["']|["']$/g, '') // stari goli zapis
  return v || null
}

/** Tajna `ime` iz spremišta; zadnji redak pobjeđuje (kao u ljusci). Nema datoteke/imena → null. */
export function procitajTajnuSpremista(ime: string, put: string = putSpremistaTajni()): string | null {
  let tekst: string
  try { tekst = readFileSync(put, 'utf-8') } catch { return null }
  let v: string | null = null
  for (const r of tekst.split('\n')) { const x = vrijednostRetka(r, ime); if (x !== null) v = x }
  return v
}
