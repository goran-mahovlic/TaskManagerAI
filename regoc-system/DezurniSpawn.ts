/**
 * DezurniSpawn — prijelaz agenta na dežurni (rezervni) model kad primarni padne (TASK-5362).
 *
 * Na čvorovima (node-A, node-B) agente u zadatcima pokreće OVAJ daemon, ne orkestrator paketa
 * TaskManagerAI. Paket od TASK-5359 ima most `src/Dezurni.ts` (postavke, stanje, simulacija pada,
 * prepoznavanje 429/401/limit/nedostupan, cilj kroz ANTHROPIC_BASE_URL); ovdje se taj ISTI most
 * uvozi iz paketa instaliranog na stroju, pa ploča (Test, „Simuliraj pad") i daemon dijele
 * postavke i stanje. Nijedno pravilo dežurnog se ne kopira.
 *
 * Fail-open: nema paketa, nema mosta, uvoz pukne, prekidač `dezurniSpawn` ugašen → `null`
 * i spawn ide točno starim putem.
 *
 * Put vrijedi SAMO za `claude` CLI bez preusmjerenja (compat): dežurni vozi isti CLI kroz
 * ANTHROPIC_BASE_URL, pa agent zadržava alate i identitet.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || '/root'

/** Ono što daemon treba od mosta paketa (podskup `DezurniRazgovora` iz src/Dezurni.ts). */
export interface DezurniMost {
  ukljucen(): boolean
  simulacija(): boolean
  jePad(tekst: string): { vrsta: string; razlog: string } | null
  cilj(): { model?: string; env: Record<string, string>; spec: string } | null
  greska(): { pocinje: boolean; broj: number }
  uspjeh(): { zavrsilo: boolean }
}

/** Gdje je paket na ovom stroju: TM_PAKET_DIR → ~/TaskManagerAI (čvor) → ~/app/TaskManager/TaskManagerAI. */
export function paketDir(env: Record<string, string | undefined> = process.env, home = HOME): string | null {
  const kandidati = [env.TM_PAKET_DIR, join(home, 'TaskManagerAI'), join(home, 'app/TaskManager/TaskManagerAI')]
  for (const k of kandidati) if (k && existsSync(join(k, 'src/Dezurni.ts'))) return k
  return null
}

/** Putanje iz `config/postavke.env` paketa (ista okolina s kojom radi ploča). Samo TM_* varijable. */
export function postavkePaketa(paket: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const red of readFileSync(join(paket, 'config/postavke.env'), 'utf-8').split('\n')) {
      const m = red.match(/^\s*(TM_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch { /* bez postavki → zadane putanje paketa */ }
  return out
}

/** Opcije mosta: iste datoteke koje čita ploča (TM_DEZURNI_CONFIG, TM_MODEL_CONFIG, TM_HOME, TM_CREDENTIALS). */
export function opcijeMosta(paket: string, pe: Record<string, string>, home = HOME) {
  const tmHome = pe.TM_HOME || join(home, '.taskmanager')
  const cfg = (ime: string, kljuc: string) => pe[kljuc] || (pe.TM_HOME && existsSync(join(pe.TM_HOME, 'config', ime))
    ? join(pe.TM_HOME, 'config', ime) : join(paket, 'config', ime))
  return {
    dezPut: cfg('dezurni.json', 'TM_DEZURNI_CONFIG'),
    mcPut: cfg('model-config.json', 'TM_MODEL_CONFIG'),
    stanjePut: join(tmHome, 'data', 'dezurni.stanje.json'),
    credPut: cfg('credentials.env', 'TM_CREDENTIALS'),
  }
}

/**
 * Učitaj most dežurnog iz paketa. `null` = nema ga ili je ugašen (spawn ide starim putem).
 * Sinkrono (`require`): točka spawna u daemonu nije async, a spawn se ne smije odgađati.
 */
export function ucitajDezurnog(log: (s: string) => void = () => {}, paket = paketDir()): DezurniMost | null {
  if (!paket) return null
  try {
    const o = opcijeMosta(paket, postavkePaketa(paket))
    const dz = require(join(paket, 'src/Dezurni.ts'))
    const cm = require(join(paket, 'src/core/ConfigModul.ts'))
    const most: DezurniMost = dz.dezurniRazgovora({
      dezPut: o.dezPut, mcPut: o.mcPut, stanjePut: o.stanjePut,
      citajTajnu: (ime: string) => cm.procitajTajnu(ime, o.credPut),
    })
    return most.ukljucen() ? most : null
  } catch (e: any) {
    log(`⚠️ [dežurni] most paketa (${paket}) se ne da učitati: ${String(e?.message || e).slice(0, 200)} — spawn bez dežurnog`)
    return null
  }
}

/** Naredba „primarnog" dok traje simulacija s ploče: pada kao pravi 429, bez poziva modela. */
export const SIMULIRANI_PAD_CMD = ['sh', '-c',
  'echo "API Error: 429 rate limit — SIMULIRAN pad primarnog modela (simulacija s ploče, dežurni)" >&2; exit 1']

/** Je li ishod spawna pad primarnog modela. Uspješan izlaz nikad nije pad. */
export function padSpawna(most: DezurniMost, exitCode: number | null, isError: boolean, stdout: string, stderr: string) {
  if (exitCode === 0 && !isError) return null
  return most.jePad(`${stderr || ''}\n${stdout || ''}`)
}

/** Argumenti za ponovni spawn: isti CLI i prompt, model dežurnog, nova sesija (stara je zauzeta). */
export function argumentiDezurnog(cmdArgs: string[], model: string | undefined, sesija: string): string[] {
  const a = [...cmdArgs]
  const i = a.indexOf('--model')
  if (model) { if (i >= 0) a[i + 1] = model; else a.splice(1, 0, '--model', model) }
  const s = a.indexOf('--session-id')
  if (s >= 0) a[s + 1] = sesija
  return a
}

/** Okolina dežurnog: okolina spawna + preusmjerenje; prijava pretplate se NE nosi. */
export function okolinaDezurnog(spawnEnv: Record<string, string>, ciljEnv: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = { ...spawnEnv, ...ciljEnv }
  delete o.CLAUDE_CODE_OAUTH_TOKEN
  return o
}
