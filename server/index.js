import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import claimRoutes from './routes/claims.js'
import intakeRoutes from './routes/intake.js'
import supervisorRoutes from './routes/supervisor.js'
import voiceRoutes from './routes/voice.js'
import voiceAgentRoutes from './routes/voiceAgent.js'
import statusRoutes from './routes/status.js'
import staffIntakeRoutes from './routes/staffIntake.js'
import statusVoiceRoutes from './routes/statusVoice.js'
import { claimCount } from './lib/db.js'
import { hasCredentials, scoringMode } from './lib/score.js'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
  },
})

// The Vite dev server proxies /api, so CORS matters only if the
// frontend is served from a different origin in deployment.
await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true })

/**
 * Registered here rather than inside a route plugin.
 *
 * Fastify plugins are encapsulated: a plugin registered inside one
 * route file is invisible to another, so `{ websocket: true }` there
 * would silently serve the route as plain HTTP and hand the handler a
 * reply object instead of a socket. Both voice routes need it, so it
 * belongs in the scope they share.
 */
await app.register(websocket)

await app.register(claimRoutes)
await app.register(intakeRoutes)
await app.register(supervisorRoutes)
await app.register(voiceRoutes)
await app.register(voiceAgentRoutes)
await app.register(statusRoutes)
await app.register(staffIntakeRoutes)
await app.register(statusVoiceRoutes)

app.get('/health', async () => ({
  ok: true,
  claims: claimCount(),
  scoring: scoringMode(),
}))

const port = Number(process.env.PORT) || 8000

try {
  await app.listen({ port, host: '127.0.0.1' })

  const n = claimCount()
  if (n === 0) {
    app.log.warn('No claims in the database. Run `npm run seed` to populate the queue.')
  }
  if (!hasCredentials()) {
    app.log.warn(
      'No provider key set (DEEPSEEK_API_KEY / ANTHROPIC_API_KEY) — fraud scoring will use the deterministic fallback.',
    )
  }
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
