// Keep local development on Vite's proxy; production connects to Render.
export const API_BASE = (import.meta.env.VITE_API_BASE ??
  (import.meta.env.PROD ? 'https://triage-claims.onrender.com' : '')).replace(/\/+$/, '')

export function voiceUrl(path, sessionId) {
  const url = new URL(`${API_BASE}${path}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (sessionId) url.searchParams.set('sessionId', sessionId)
  return url.toString()
}
