/**
 * ZatvaranjeSpawna — evidencija zadataka čiji je proces agenta izašao, a daemon još piše presudu
 * (vratar, kritičar, zatvaranje). TASK-5674: kritičar zna raditi i 2 min; čuvar za to vrijeme briše
 * „mrtav spawn" iz `activeAgentSpawns`, otkucaj čisti najam po mrtvom pidu, pa je siroče-oporavak
 * zadatak vraćao u `pending` i PASS kritičara padao s HTTP 409 (TASK-5657, 21.10.2026.).
 * Strop drži zaglavljen rukovatelj (TASK-4992) da zadatak ne ostane „živ" zauvijek.
 */

export const ZATVARANJE_STROP_MS = 30 * 60_000

export class ZatvaranjeSpawna {
  private readonly od = new Map<string, number>()
  constructor(private readonly stropMs: number = ZATVARANJE_STROP_MS) {}

  zapocni(taskId: string, sad: number = Date.now()): void {
    this.od.set(taskId, sad)
  }

  zavrsi(taskId: string): void {
    this.od.delete(taskId)
  }

  aktivni(sad: number = Date.now()): Set<string> {
    for (const [id, t] of [...this.od]) if (sad - t > this.stropMs) this.od.delete(id)
    return new Set(this.od.keys())
  }
}

/** Živi spawnovi + oni koji se zatvaraju (novi skup; ulaz se ne mijenja). */
export function saZatvaranjem(tracked: Set<string>, z: ZatvaranjeSpawna, sad: number = Date.now()): Set<string> {
  return new Set([...tracked, ...z.aktivni(sad)])
}
