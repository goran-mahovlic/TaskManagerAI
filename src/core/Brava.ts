/**
 * Datoteka-brava s PID-om — jedan proces za jedan posao.
 *
 * Izvorno u `TelegramPoller.ts` (§5.2 dizajna): dva pollera s istim tokenom si tiho kradu
 * poruke. Isti kvar ima orkestrator: dvije petlje nad istom pločom natječu se za iste
 * zadatke. Zato brava živi ovdje, a oba je koriste — poller s imenom „poller", petlja
 * orkestratora (u procesu ploče ILI `scripts/orchestrator.ts`) s imenom „orkestrator".
 *
 * Mrtav vlasnik (PID kojega nema) se preuzima: brava koja preživi pad procesa ne smije
 * zauvijek blokirati sljedeće pokretanje.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { osigurajMapu } from './paths'

export interface Brava { ok: boolean; razlog?: string; osloboditi?: () => void }

/** PID živog procesa koji drži bravu, osim nas samih; `null` ako je nema ili je vlasnik mrtav. */
export function vlasnikBrave(path: string): number | null {
  try {
    if (!existsSync(path)) return null
    const pid = Number(readFileSync(path, 'utf-8').trim())
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null
    try { process.kill(pid, 0); return pid } catch (e: any) { return e?.code === 'EPERM' ? pid : null }
  } catch {
    return null
  }
}

/**
 * Uzmi bravu. Ako je vlasnik živ, NE uzima se i jasno kaže tko je drži. `ime` je riječ u
 * poruci („poller već radi u procesu 123").
 */
export function uzmiBravu(path: string, ime = 'proces'): Brava {
  try {
    const drugi = vlasnikBrave(path)
    if (drugi) return { ok: false, razlog: `${ime} već radi u procesu ${drugi} (${path})` }
    osigurajMapu(path)
    writeFileSync(path, String(process.pid), 'utf-8')
    return {
      ok: true,
      osloboditi: () => { try { unlinkSync(path) } catch { /* već je maknuta */ } },
    }
  } catch (e: any) {
    return { ok: false, razlog: `brava se ne može uzeti: ${String(e?.message || e)}` }
  }
}
