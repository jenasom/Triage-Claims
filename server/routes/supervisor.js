import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  createSession,
  runTurn,
  hasCredentials,
  supervisorModel,
} from '../lib/supervisor/agent.js'

/**
 * The supervisor agent's endpoints.
 *
 * Sessions are in-memory conversation state. Nothing about a claim
 * lives here — every change the agent makes goes through the same
 * database functions the rest of the API uses, and lands in the same
 * audit trail.
 */

const SESSIONS = new Map()
const SESSION_TTL_MS = 4 * 60 * 60 * 1000

function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, s] of SESSIONS) {
    if (new Date(s.createdAt).getTime() < cutoff) SESSIONS.delete(id)
  }
}
setInterval(sweep, 15 * 60 * 1000).unref()

const AskSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1).max(4000),
  actor: z.string().min(1).max(80).default('prince.essandoh'),
})

export default async function supervisorRoutes(app) {
  /**
   * Ask the agent something.
   *
   * A session is created on the first call and reused after, so the
   * supervisor can say "reroute that one" and be understood.
   */
  app.post('/api/supervisor/ask', async (req, reply) => {
    if (!hasCredentials()) {
      return reply
        .code(503)
        .send({ error: 'The assistant needs a provider key. Set DEEPSEEK_API_KEY in server/.env.' })
    }

    const parsed = AskSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', issues: parsed.error.issues })
    }

    const { sessionId, message, actor } = parsed.data

    let session = sessionId ? SESSIONS.get(sessionId) : null
    if (!session) {
      const id = randomUUID()
      session = createSession(id, actor)
      SESSIONS.set(id, session)
    }

    const turn = await runTurn(session, message)

    return {
      sessionId: session.id,
      reply: turn.reply,
      trace: turn.trace,
      // Tells the dashboard to refetch — a reroute or withdrawal has
      // changed what the queue should show.
      changed: turn.changed,
    }
  })

  app.get('/api/supervisor-config', async () => ({
    available: hasCredentials(),
    model: supervisorModel,
  }))
}
