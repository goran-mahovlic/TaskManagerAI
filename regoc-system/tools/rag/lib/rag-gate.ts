/**
 * TASK-5273 — RAG prekidač po čvoru. Čvor bez RAG-a (node-A: ni ChromaDB ni pgvector, samo
 * Hindsight) isključuje Tier 1 postojećim poljem `rag.enabled=false` u memory-config.json
 * (ili REGOC_RAG_ENABLED=0). Postavka se čita UŽIVO (reload) — preklop ne traži restart.
 * Tko god dira RAG (daemon, RagCollections, CLI alati), pita ovo i preskače bez mreže.
 */
import { loadMemoryConfig, isRagEnabled } from "./memory-config";

/** Stalni dio poruke — testovi i grep loga ga traže. */
export const RAG_ISKLJUCEN_OZNAKA = "RAG isključen na ovom čvoru";

export function ragUkljucen(): boolean {
  try {
    return isRagEnabled(loadMemoryConfig({ reload: true }));
  } catch {
    return true; // nečitljiva postavka → stari put (ponašanje kao prije prekidača)
  }
}

export function ragIskljucenPoruka(alat: string): string {
  return `${RAG_ISKLJUCEN_OZNAKA} (memory-config rag.enabled=false) — ${alat} preskočen, nastavi bez RAG-a.`;
}
