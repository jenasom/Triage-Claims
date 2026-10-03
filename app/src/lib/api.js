/**
 * API client.
 *
 * Vite proxies /api to the Fastify server on :8000 in development
 * (see vite.config.js), so these are same-origin in both dev and a
 * deployment that puts them behind one host.
 */

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const fetchClaims = ({ route = 'all', limit = 50, offset = 0 } = {}) =>
  get(`/api/claims?route=${route}&limit=${limit}&offset=${offset}`)

export const fetchStats = () => get('/api/stats')
export const fetchConfig = () => get('/api/config')
export const fetchAudit = (id) => get(`/api/claims/${id}/audit`)

export const overrideRoute = (id, route, actor, note = '') =>
  post(`/api/claims/${id}/override`, { route, actor, note })

export const submitClaim = (claim) => post('/api/claims', claim)

/* ---------------------------------------------------------------
   Customer intake — the conversational claim flow.
   --------------------------------------------------------------- */

export const startIntake = () => post('/api/intake/start', {})

export const sendIntakeMessage = (sessionId, message) =>
  post('/api/intake/message', { sessionId, message })

export const uploadIntakeDocument = (sessionId, documentType, filename, dataUri) =>
  post('/api/intake/upload', { sessionId, documentType, filename, dataUri })

export const fetchIntakeSession = (sessionId) => get(`/api/intake/${sessionId}`)
export const fetchIntakeConfig = () => get('/api/intake-config')

/* ---------------------------------------------------------------
   Supervisor — the claims desk assistant on the dashboard.
   --------------------------------------------------------------- */

export const askSupervisor = (sessionId, message) =>
  post('/api/supervisor/ask', { sessionId: sessionId ?? undefined, message })

export const fetchSupervisorConfig = () => get('/api/supervisor-config')

/* ---------------------------------------------------------------
   Voice — Fish Audio, proxied through the server so the key stays
   off the client. These are binary rather than JSON, so they do not
   use the helpers above.
   --------------------------------------------------------------- */

export async function transcribeAudio(blob) {
  const res = await fetch(`${BASE}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? 'Could not transcribe that recording')
  }
  return res.json()
}

export async function speakText(text) {
  const res = await fetch(`${BASE}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? 'Could not play that reply')
  }
  return res.blob()
}

export const fetchVoiceConfig = () => get('/api/voice-config')

/** Whether live voice intake is available (Deepgram Voice Agent). */
export const fetchVoiceAgentConfig = () => get('/api/voiceagent-config')

/* ---------------------------------------------------------------
   Claim status — the claimant's own view of their claim.
   --------------------------------------------------------------- */

export const lookupClaim = (reference, surname) =>
  post('/api/status/lookup', { reference, surname })

export const refreshStatus = (token) => get(`/api/status/${token}`)

export const supplyDocument = (reference, surname, documentType, filename, dataUri) =>
  post('/api/status/upload', { reference, surname, documentType, filename, dataUri })

/** Ask the assistant about a claim (read-only, scoped by token). */
export const askAboutClaim = (token, question) =>
  post(`/api/status/${token}/ask`, { question })

/* ---------------------------------------------------------------
   Staff intake — first notice of loss, taken at the counter.
   --------------------------------------------------------------- */

export const fetchStaffIntakeConfig = () => get('/api/staff/intake-config')

/**
 * Take a claim on a caller's behalf.
 *
 * Unlike `post`, this preserves the structured body of a rejection.
 * The server answers with per-field problems so the form can mark the
 * fields that need attention — flattening that to a message string
 * would make an officer re-read the whole form with a caller waiting.
 */
export async function submitStaffClaim(payload) {
  const res = await fetch(`${BASE}/api/staff/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null)
  if (res.ok) return body

  const err = new Error(body?.error ?? `${res.status} ${res.statusText}`)
  err.fields = body?.fields ?? null
  err.gaps = body?.gaps ?? null
  err.contradictions = body?.contradictions ?? null
  err.canLodgeProvisionally = Boolean(body?.canLodgeProvisionally)
  err.rejectedDocuments = body?.rejectedDocuments ?? []
  throw err
}

/**
 * Resume a claim that was already lodged.
 *
 * Authorised by the status token the claimant already holds, so they
 * are not asked for their reference and surname a second time.
 */
export const continueClaim = (token, documentType) =>
  post('/api/intake/continue', { token, ...(documentType ? { documentType } : {}) })
