import { openVoiceSession, hasCredentials } from '../lib/voice/deepgram.js'
import {
  TOOL_SCHEMAS,
  createStatusTools,
  buildStatusPrompt,
  STATUS_GREETING,
} from '../lib/voice/statusAgent.js'
import { issueToken } from './status.js'
import { setLiveVoice, clearLiveVoice } from '../lib/voice/live.js'

/**
 * Spoken claim status.
 *
 * Unlike voice intake, this socket carries no session id: the caller
 * has not identified themselves yet, and doing so is the first thing
 * the conversation is for. The agent asks for a reference and surname,
 * `find_claim` verifies them, and only then does any claim data exist
 * in the call.
 *
 * The reference lives in `state` here on the server. The browser is
 * told which claim was found so it can display it, but it never
 * supplies one — a client that could name a claim could name any
 * claim.
 */

function parseControl(raw) {
  try {
    const msg = JSON.parse(raw.toString())
    return typeof msg?.type === 'string' ? msg : null
  } catch {
    return null
  }
}

export default async function statusVoiceRoutes(app) {
  // @fastify/websocket is registered once in index.js, in the scope
  // both voice routes share.
  app.get('/api/status-voice', { websocket: true }, (socket, req) => {
    const notConfigured = !hasCredentials()

    /**
     * Every write to the browser goes through these.
     *
     * The Deepgram socket outlives the browser's — a dropped mobile
     * connection, a closed tab, or an upgrade that never completed.
     * Its close and error handlers then fire against a socket that may
     * be gone, and an unguarded call there throws inside an event
     * handler with no catch above it, which takes the whole process
     * down rather than ending one call.
     *
     * Guarded once here so no individual call site can forget.
     */
    const alive = () =>
      typeof socket.send === 'function' && socket.readyState === socket.OPEN

    const say = (msg) => {
      try {
        if (alive()) socket.send(JSON.stringify(msg))
      } catch {
        /* the caller has gone; the agent is closed below */
      }
    }

    const sendAudio = (chunk) => {
      try {
        if (alive()) socket.send(chunk, { binary: true })
      } catch {
        /* caller gone */
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

    if (notConfigured) {
      say({ type: 'error', message: 'Voice is not configured. Set DEEPGRAM_API_KEY.' })
      return endCall()
    }

    /** Unlocked by find_claim, never by the browser. */
    const state = { reference: null }

    /**
     * Filled in once `openVoiceSession` returns, below.
     *
     * `onFound` closes over this rather than the agent itself: the
     * tools have to be built before the session exists, but they only
     * ever run once a call is under way, by which time it does.
     */
    const live = { agent: null, key: null }

    const tools = createStatusTools(state, {
      /**
       * The moment a claim is verified, push it to the page so the
       * caller sees it while the agent is still speaking.
       *
       * A token goes with it: saying the reference and surname aloud
       * proves what typing them proves, so the page can then let them
       * upload an outstanding document rather than making them look
       * the claim up a second time by hand.
       */
      onFound: (view) => {
        say({ type: 'claim', claim: view, token: issueToken(view.reference) })

        /**
         * Register the call against the claim it just unlocked.
         *
         * This is what lets an upload reach the agent. Deepgram keeps
         * its own conversation state, so a document supplied on the
         * page is invisible to it — without this the caller uploads
         * their repair estimate, watches it tick green, and is told it
         * is still outstanding.
         */
        if (live.agent) {
          live.key = view.reference
          setLiveVoice(view.reference, live.agent)
        }
      },

      // Emitted as the lookup starts, and again if it fails, so the
      // page can show the search rather than jumping straight to a
      // result.
      onSearching: ({ reference, failed }) =>
        say({ type: 'searching', reference, failed: Boolean(failed) }),

      // The agent moving the caller's page to the upload controls.
      onOpenUploads: ({ documentType }) => say({ type: 'open_uploads', documentType }),
    })

    const agent = openVoiceSession(state, {
      tools,
      schemas: TOOL_SCHEMAS,
      prompt: buildStatusPrompt(),
      greeting: STATUS_GREETING,

      /**
       * Re-read the claim after every batch of tool calls.
       *
       * Nothing here writes, so this is only about the page keeping
       * step with a claim the caller may also be uploading to in
       * another tab.
       */
      broadcastState: () => ({ reference: state.reference }),

      onReady: () => say({ type: 'ready' }),

      onAudio: sendAudio,

      onTranscript: (text) => say({ type: 'transcript', role: 'user', text }),
      onAgentText: (text) => say({ type: 'transcript', role: 'assistant', text }),

      onToolCall: (call) => {
        if (call.tool === '__state') say({ type: 'state', ...call.result })
        else say({ type: 'tool', tool: call.tool, args: call.args, result: call.result })
      },

      onError: (message) => {
        req.log.error({ message }, 'status voice agent error')
        say({ type: 'error', message })
      },

      onClose: (code, reason) => {
        say({ type: 'closed', code, reason })
        endCall()
      },
    })

    live.agent = agent

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return agent.send(raw)

      const control = parseControl(raw)
      if (!control) return

      if (control.type === 'interrupt') agent.interrupt()
      if (control.type === 'stop') agent.close()
    })

    const cleanup = () => {
      if (live.key) clearLiveVoice(live.key, agent)
      agent.close()
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })
}
