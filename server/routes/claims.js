import { z } from 'zod'
import { listClaims, getClaim, getAudit, overrideRoute, saveClaim, stats } from '../lib/db.js'
import { route as decideRoute, documentationScore, missingDocuments, complexityScore } from '../lib/rules.js'
import { scoreClaim, scoringMode } from '../lib/score.js'
import { MOTOR, BASELINE } from '../lib/config.js'

const SubmitSchema = z.object({
  claimant: z.string().min(1),
  vehicleMake: z.string().min(1),
  vehicleModel: z.string().min(1),
  vehicleYear: z.number().int().min(1990).max(2027),
  plate: z.string().min(1),
  insuredValue: z.number().positive(),
  amount: z.number().positive(),
  incidentType: z.string().min(1),
  incidentHour: z.number().int().min(0).max(23).default(12),
  reportDelayDays: z.number().int().min(0).default(0),
  policyAgeDays: z.number().int().min(0),
  priorClaims: z.number().int().min(0).default(0),
  priorClaims12m: z.number().int().min(0).default(0),
  garage: z.string().default('Unspecified'),
  garageFlaggedCount: z.number().int().min(0).default(0),
  addressMatches: z.boolean().default(true),
  documentDateInconsistent: z.boolean().default(false),
  thirdPartyInvolved: z.boolean().default(false),
  injuryReported: z.boolean().default(false),
  totalLoss: z.boolean().default(false),
  liabilityDisputed: z.boolean().default(false),
  documents: z.array(z.string()).default([]),
})

const OverrideSchema = z.object({
  route: z.enum(['fast', 'std', 'inv']),
  actor: z.string().min(1),
  note: z.string().default(''),
})

export default async function claimRoutes(app) {
  /** The queue. */
  app.get('/api/claims', async (req) => {
    const route = req.query.route ?? 'all'
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const offset = Number(req.query.offset) || 0
    return listClaims({ route, limit, offset })
  })

  /** Queue counts for the stat band. */
  app.get('/api/stats', async () => ({
    ...stats(),
    baseline: BASELINE,
    scoring: scoringMode(),
  }))

  /**
   * The claim-type configuration, served so the thresholds and the
   * prohibited-factors list are externally inspectable rather than
   * buried in the source.
   */
  app.get('/api/config', async () => ({
    claimType: MOTOR.id,
    label: MOTOR.label,
    routing: MOTOR.routing,
    requiredDocuments: MOTOR.requiredDocuments,
    fraudSignals: MOTOR.fraudSignals,
    prohibitedFactors: MOTOR.prohibitedFactors,
  }))

  app.get('/api/claims/:id', async (req, reply) => {
    const claim = getClaim(req.params.id)
    if (!claim) return reply.code(404).send({ error: 'Claim not found' })
    return claim
  })

  app.get('/api/claims/:id/audit', async (req, reply) => {
    const claim = getClaim(req.params.id)
    if (!claim) return reply.code(404).send({ error: 'Claim not found' })
    return { claimId: req.params.id, entries: getAudit(req.params.id) }
  })

  /**
   * Submit a claim: score it, route it, persist it, return the
   * decision. This is the live path — one provider call, a few seconds.
   */
  app.post('/api/claims', async (req, reply) => {
    const parsed = SubmitSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid claim',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const input = parsed.data
    const missing = missingDocuments(input.documents)

    const claim = {
      ...input,
      id: `CLM-2401-${String(Date.now()).slice(-4)}`,
      submittedAt: new Date().toISOString(),
      missingDocuments: missing.map((d) => d.id),
      scores: {
        complexity: complexityScore(input),
        documentation: documentationScore(input.documents),
      },
    }

    const assessment = await scoreClaim(claim)
    const decision = decideRoute({
      amount: claim.amount,
      complexity: claim.scores.complexity,
      documentation: claim.scores.documentation,
      fraud: assessment.score,
    })

    saveClaim(claim, assessment, decision)
    return reply.code(201).send(getClaim(claim.id))
  })

  /** Human override. Always recorded, never silent. */
  app.post('/api/claims/:id/override', async (req, reply) => {
    const parsed = OverrideSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid override',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const updated = overrideRoute(req.params.id, parsed.data.route, parsed.data.actor, parsed.data.note)
    if (!updated) return reply.code(404).send({ error: 'Claim not found' })
    return updated
  })
}
