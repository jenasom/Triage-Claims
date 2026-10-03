import { z } from 'zod'
import { transcribe, speak, forSpeech, hasCredentials, ttsModel, voiceId } from '../lib/voice/fish.js'

/**
 * Voice endpoints for claimant intake.
 *
 * Both proxy Fish Audio so the API key stays on the server. Audio is
 * handled in memory and never written to disk — a recording of someone
 * describing an accident is personal, and keeping it would be a
 * retention question nobody has answered.
 */

/** Recordings are short utterances; anything larger is a mistake. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

const SpeakSchema = z.object({
  text: z.string().min(1).max(2000),
})

export default async function voiceRoutes(app) {
  // Accept raw audio bodies for the transcribe endpoint. Fastify parses
  // JSON by default and would reject a binary upload.
  app.addContentTypeParser(
    ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES },
    (_req, body, done) => done(null, body),
  )

  /**
   * What voice is configured.
   *
   * `available` means the provider will actually work, not merely that
   * a key is set — a key with no credit fails on every call, and the
   * client should fall back to browser speech rather than offering a
   * mic that always errors.
   *
   * The check is a real synthesis call, so it is cached: it costs money
   * and the answer rarely changes within a session.
   */
  let cachedProbe = null

  app.get('/api/voice-config', async () => {
    if (!hasCredentials()) {
      return { available: false, provider: null, reason: 'no key configured' }
    }

    if (!cachedProbe) {
      try {
        await speak('Test.')
        cachedProbe = { available: true, provider: 'fish', ttsModel, clonedVoice: Boolean(voiceId) }
      } catch (err) {
        cachedProbe = { available: false, provider: null, reason: err.message }
      }
    }

    return cachedProbe
  })

  /**
   * Speech → text.
   *
   * Body is the raw recording; content-type says what the browser
   * produced. Returns the transcript for the client to send on as a
   * normal intake message, rather than routing it to the agent here —
   * the claimant should see what was heard before it is acted on.
   */
  app.post('/api/voice/transcribe', async (req, reply) => {
    if (!hasCredentials()) {
      return reply.code(503).send({ error: 'Voice is not configured. Set FISH_AUDIO_API_KEY.' })
    }

    const audio = req.body
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({ error: 'Send the recording as a raw audio body' })
    }

    const ext = (req.headers['content-type'] ?? '').includes('ogg') ? 'ogg' : 'webm'

    try {
      const result = await transcribe(audio, `speech.${ext}`)
      if (!result.text) {
        return reply
          .code(422)
          .send({ error: 'Nothing was picked up. Try again, closer to the microphone.' })
      }
      return result
    } catch (err) {
      req.log.error({ err }, 'transcription failed')
      return reply.code(502).send({ error: err.message })
    }
  })

  /**
   * Text → speech.
   *
   * Returns MP3 bytes. The text is cleaned first: markdown and claim
   * references read badly aloud.
   */
  app.post('/api/voice/speak', async (req, reply) => {
    if (!hasCredentials()) {
      return reply.code(503).send({ error: 'Voice is not configured. Set FISH_AUDIO_API_KEY.' })
    }

    const parsed = SpeakSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', issues: parsed.error.issues })
    }

    const spoken = forSpeech(parsed.data.text)
    if (!spoken) return reply.code(400).send({ error: 'Nothing to say' })

    try {
      const { audio, contentType } = await speak(spoken)
      return reply
        .header('Content-Type', contentType)
        .header('Content-Length', audio.length)
        // Same reply is often replayed; let the browser keep it briefly.
        .header('Cache-Control', 'private, max-age=300')
        .send(audio)
    } catch (err) {
      req.log.error({ err }, 'speech synthesis failed')
      return reply.code(502).send({ error: err.message })
    }
  })
}
