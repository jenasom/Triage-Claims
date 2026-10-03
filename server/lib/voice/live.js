/**
 * Voice agents currently on a call.
 *
 * Keyed by intake session id for an intake call, and by claim
 * reference for a claim-status call. The two id spaces cannot
 * collide — one is a UUID, the other is CLM-xxxx-xxxx — so a single
 * map serves both.
 *
 * Lives in its own module rather than in either route, because both
 * need it and `voiceAgent.js` already imports from `intake.js` — a
 * registry in either one would make the pair circular.
 *
 * The reason it exists at all: Deepgram holds its own conversation
 * state. A document uploaded on screen never reaches the voice agent,
 * so without this the claimant uploads a photo, watches the system
 * read it, and is asked for it again.
 */
export const LIVE_VOICE = new Map()

/** Register an agent for the duration of a call. */
export function setLiveVoice(sessionId, agent) {
  LIVE_VOICE.set(sessionId, agent)
}

/** Clear it, but only if it is still the same agent — a reconnect may
 *  have replaced it since. */
export function clearLiveVoice(sessionId, agent) {
  if (LIVE_VOICE.get(sessionId) === agent) LIVE_VOICE.delete(sessionId)
}

export function getLiveVoice(sessionId) {
  return LIVE_VOICE.get(sessionId) ?? null
}
