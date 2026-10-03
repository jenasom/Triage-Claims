import { openVoiceSession, hasCredentials, listenModel, speakModel, AUDIO } from '../lib/voice/deepgram.js'
import { SESSIONS, submitToTriage } from './intake.js'
import { setLiveVoice, clearLiveVoice } from '../lib/voice/live.js'

/**
 * Voice intake over a WebSocket.
 *
 * The browser opens one socket here and streams microphone audio; this
 * server holds the Deepgram connection and relays synthesised speech
 * back. Two hops rather than one, and the reason is the API key: a
 * browser-held Deepgram socket means shipping the credential to every
 * visitor.
 *
 * Claim tools execute here too, against the same session the typed
 * conversation uses — so a claimant can speak part of a claim and type
 * the rest.
 */

/**
 * Frames from the browser are either binary audio or a small JSON
 * control message. Anything else is ignored rather than trusted.
 */
function parseControl(raw) {
  try {
    const msg = JSON.parse(raw.toString())
    return typeof msg?.type === 'string' ? msg : null
  } catch {
    return null
  }
}

export default async function voiceAgentRoutes(app) {

  /**
   * Whether voice intake is available, and on what.
   *
   * Deliberately not nested under /api/voice-agent/ — Vite proxies that
   * prefix as a WebSocket, and an HTTP request there would fail the
   * upgrade handshake.
   */
  app.get('/api/voiceagent-config', async () => ({
    available: hasCredentials(),
    provider: hasCredentials() ? 'deepgram' : null,
    listenModel,
    speakModel,
    audio: AUDIO,
  }))

  app.get('/api/voice-agent', { websocket: true }, (socket, req) => {
    if (!hasCredentials()) {
      socket.send(
        JSON.stringify({ type: 'error', message: 'Voice is not configured. Set DEEPGRAM_API_KEY.' }),
      )
      return socket.close()
    }

    const sessionId = req.query?.sessionId
    const session = sessionId ? SESSIONS.get(sessionId) : null

    if (!session) {
      socket.send(
        JSON.stringify({ type: 'error', message: 'Start a claim first, then switch to voice.' }),
      )
      return socket.close()
    }

    /**
     * Every write to the browser goes through these.
     *
     * The Deepgram socket outlives the browser's — a dropped mobile
     * connection or a closed tab — and its close and error handlers
     * then fire against a socket that may be gone. An unguarded call
     * there throws inside an event handler with no catch above it,
     * taking the whole process down rather than ending one call.
     */
    const alive = () =>
      typeof socket.send === 'function' && socket.readyState === socket.OPEN

    const say = (msg) => {
      try {
        if (alive()) socket.send(JSON.stringify(msg))
      } catch {
        /* caller gone; the agent is closed on socket close */
      }
    }

    const endCall = () => {
      try {
        if (typeof socket.close === 'function' && socket.readyState === socket.OPEN) {
          socket.close()
        }
      } catch {
        /* already gone */
      }
    }

    const agent = openVoiceSession(session, {
      onSubmit: submitToTriage,

      onReady: () => say({ type: 'ready' }),

      // Synthesised speech: forwarded as-is for the browser to play.
      onAudio: (chunk) => {
        try {
          if (alive()) socket.send(chunk, { binary: true })
        } catch {
          /* caller gone */
        }
      },

      onTranscript: (text) => say({ type: 'transcript', role: 'user', text }),
      onAgentText: (text) => say({ type: 'transcript', role: 'assistant', text }),

      // Tool activity, so the UI can show what the agent did and keep
      // the progress bar in step.
      onToolCall: (call) => {
        if (call.tool === '__state') say({ type: 'state', ...call.result })
        else say({ type: 'tool', tool: call.tool, args: call.args, result: call.result })
      },

      onError: (message) => {
        req.log.error({ message }, 'voice agent error')
        say({ type: 'error', message })
      },

      onClose: (code, reason) => {
        say({ type: 'closed', code, reason })
        endCall()
      },
    })

    setLiveVoice(sessionId, agent)

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return agent.send(raw)

      const control = parseControl(raw)
      if (!control) return

      // The caller started speaking over the agent.
      if (control.type === 'interrupt') agent.interrupt()
      if (control.type === 'stop') agent.close()
    })

    const cleanup = () => {
      clearLiveVoice(sessionId, agent)
      agent.close()
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })
}
