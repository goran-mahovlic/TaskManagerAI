/**
 * VoiceRelay — dogovor između RegocDaemona i `mumble_bridge` (TASK-2612).
 *
 * Odgovor agenta namijenjen GOVORU ima:
 *   to_agent='user'  AND  voice_relay=1  AND  chat_id u rezerviranom Mumble rasponu
 * gdje je `chat_id = MUMBLE_CHAT_BASE - <mumble channel_id>`.
 *
 * Raspon je izabran izvan Telegramovih ID-eva (korisnici su pozitivni, grupe
 * ~-1e9…-5e12 kakve su i REGOČ grupe), pa kolizija sa stvarnim
 * chatom nije moguća.
 *
 * Zrcalna implementacija u Pythonu: voice/mumble/db_io.py (isti brojevi).
 * Jedan izvor istine za brojeve = ova datoteka + db_io.py zaglavlje; testovi na
 * obje strane provjeravaju istu granicu.
 */

export const MUMBLE_CHAT_BASE = -9_100_000_000
export const MUMBLE_CHAT_MIN = -9_199_999_999

export function isMumbleChatId(chatId: unknown): boolean {
  return typeof chatId === 'number' && Number.isInteger(chatId) &&
         chatId <= MUMBLE_CHAT_BASE && chatId >= MUMBLE_CHAT_MIN
}

export function chatIdForChannel(channelId: number): number {
  if (!Number.isInteger(channelId) || channelId < 0 || channelId > 99_999_999) {
    throw new RangeError(`channel_id izvan raspona: ${channelId}`)
  }
  return MUMBLE_CHAT_BASE - channelId
}

export function channelForChatId(chatId: number): number {
  if (!isMumbleChatId(chatId)) throw new RangeError(`chat_id nije Mumble kanal: ${chatId}`)
  return MUMBLE_CHAT_BASE - chatId
}

/** Poruka koju daemon NE smije poslati na Telegram — nju izgovara mumble_bridge. */
export function isMumbleVoiceMessage(msg: { voice_relay?: unknown; chat_id?: unknown }): boolean {
  const voice = msg.voice_relay === 1 || msg.voice_relay === true
  return voice && isMumbleChatId(msg.chat_id)
}
