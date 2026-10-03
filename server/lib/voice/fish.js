/**
 * Fish Audio — speech in, speech out.
 *
 * Both halves proxy through this server rather than going direct from
 * the browser, for one reason: a key in frontend code is a key anyone
 * can read. The audio round-trip costs a little latency and buys not
 * publishing the credential.
 *
 * https://docs.fish.audio/api-reference/endpoint/openapi-v1/
 */

const BASE = process.env.FISH_BASE_URL ?? 'https://api.fish.audio'
const TTS_MODEL = process.env.FISH_TTS_MODEL ?? 's2.1-pro'

/** An optional cloned/selected voice from fish.audio. */
const VOICE_ID = process.env.FISH_VOICE_ID || null

export const hasCredentials = () => Boolean(process.env.FISH_AUDIO_API_KEY)
export const ttsModel = TTS_MODEL
export const voiceId = VOICE_ID

function auth() {
  const key = process.env.FISH_AUDIO_API_KEY
  if (!key) throw new Error('FISH_AUDIO_API_KEY is not set')
  return `Bearer ${key}`
}

/** Turn a Fish HTTP failure into something a caller can act on. */
async function fail(res, what) {
  const body = await res.text().catch(() => '')
  const detail = body.slice(0, 200)

  if (res.status === 401) throw new Error(`Fish Audio rejected the API key`)
  if (res.status === 402) throw new Error(`Fish Audio account has no credit`)
  if (res.status === 503) throw new Error(`Fish Audio is busy — try again`)
  throw new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`)
}

/**
 * Transcribe recorded audio.
 *
 * `audio` is a Buffer of whatever the browser recorded — typically
 * webm/opus from MediaRecorder. Language is left unset: Fish detects it,
 * and a claimant may switch between English and Pidgin mid-sentence.
 */
export async function transcribe(audio, filename = 'speech.webm') {
  const form = new FormData()
  form.append('audio', new Blob([audio]), filename)
  // Timestamps add latency on short clips and we do not use them.
  form.append('ignore_timestamps', 'true')

  const res = await fetch(`${BASE}/v1/asr`, {
    method: 'POST',
    headers: { Authorization: auth() },
    body: form,
  })

  if (!res.ok) await fail(res, 'Transcription')

  const json = await res.json()
  return {
    text: (json.text ?? '').trim(),
    durationSeconds: json.duration ?? null,
    language: json.language_code ?? json.language ?? null,
  }
}

/**
 * Speak text.
 *
 * Returns MP3 bytes. `latency: 'balanced'` rather than 'normal' —
 * someone waiting to hear a question notices the difference, and the
 * quality cost is small at this length.
 */
export async function speak(text, { format = 'mp3' } = {}) {
  const body = {
    text,
    format,
    latency: 'balanced',
    normalize: true,
    ...(VOICE_ID ? { reference_id: VOICE_ID } : {}),
  }

  const res = await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/json',
      model: TTS_MODEL,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) await fail(res, 'Speech synthesis')

  const buffer = Buffer.from(await res.arrayBuffer())
  return { audio: buffer, contentType: format === 'mp3' ? 'audio/mpeg' : `audio/${format}` }
}

/**
 * Strip what should not be read aloud.
 *
 * The agent writes for a screen — markdown emphasis, claim ids meant to
 * be copied. Read literally, "**AKD-778-FF**" becomes "asterisk asterisk
 * A K D..." and a reference number becomes an unintelligible run of
 * letters. This is not cosmetic: a spoken reply that garbles the one
 * detail a claimant needs is worse than no speech at all.
 */
export function forSpeech(text) {
  if (!text) return ''

  return (
    text
      // Markdown emphasis and code marks.
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      // Claim ids: CLM-2401-0026 → "claim C L M, 2 4 0 1, 0 0 2 6"
      .replace(/\bCLM-(\d{4})-(\d{3,4})\b/gi, (_m, a, b) =>
        `claim reference ${a.split('').join(' ')}, ${b.split('').join(' ')}`,
      )
      // Registration plates: LSD-441-KJ → spelled out
      .replace(/\b([A-Z]{3})-(\d{3})-([A-Z]{2})\b/g, (_m, a, n, c) =>
        `${a.split('').join(' ')} ${n.split('').join(' ')} ${c.split('').join(' ')}`,
      )
      // Naira amounts read as words, not a symbol.
      .replace(/₦\s?([\d,]+)/g, (_m, n) => `${n.replace(/,/g, '')} naira`)
      // Bullet markers at the start of a line.
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  )
}
