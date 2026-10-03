import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createSession, runTurn, greet, hasCredentials, agentModel } from '../lib/intake/agent.js'
import { validateIntake } from '../lib/intake/validate.js'
import { visionModel } from '../lib/intake/extract.js'
import {
  saveClaim,
  getClaim,
  provisionalFacts,
  finaliseClaim,
  recordAudit,
  applyProvisionalDocument,
} from '../lib/db.js'
import { route as decideRoute, documentationScore, missingDocuments, complexityScore } from '../lib/rules.js'
import { scoreClaim } from '../lib/score.js'
import { MOTOR } from '../lib/config.js'
import { getLiveVoice } from '../lib/voice/live.js'
// status.js also imports from here; both are only called at request
// time, so the cycle resolves before either runs.
import { resolveToken as resolveStatusToken } from './status.js'
import { confirmDocument } from '../lib/intake/confirm.js'

/**
 * Customer-facing intake.
 *
 * Sessions live in memory: this is a conversation in progress, not a
 * record. Only a completed claim reaches the database, via the same
 * scoring and routing path a directly-submitted claim takes.
 */

/**
 * Live intake conversations.
 *
 * Exported so the voice route shares them: a claimant can start by
 * speaking and finish by typing, against one claim record.
 */
export const SESSIONS = new Map()
const SESSION_TTL_MS = 60 * 60 * 1000

/** Drop abandoned conversations rather than growing without bound. */
function sweep() {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, s] of SESSIONS) {
    if (new Date(s.createdAt).getTime() < cutoff) SESSIONS.delete(id)
  }
}
setInterval(sweep, 10 * 60 * 1000).unref()

const MessageSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(4000),
})

const ContinueSchema = z.object({
  token: z.string().min(8).max(200),
  // Which outstanding document they came back to send, if they said.
  documentType: z.enum(MOTOR.requiredDocuments.map((d) => d.id)).optional(),
})

/** Last word of a filed name — what a claimant gives as their surname. */
const surnameOf = (fullName) =>
  String(fullName ?? '').trim().split(/\s+/).filter(Boolean).pop() ?? ''

const UploadSchema = z.object({
  sessionId: z.string().min(1),
  documentType: z.enum(MOTOR.requiredDocuments.map((d) => d.id)),
  filename: z.string().min(1).max(300),
  // data URI — capped so a large upload cannot exhaust memory.
  dataUri: z.string().min(32).max(8_000_000),
})

/**
 * Hand a completed intake to the triage engine.
 *
 * Everything downstream of this point is the path a directly-submitted
 * claim already takes: the same scoring, the same routing rules, the
 * same audit trail.
 */
export async function submitToTriage(session, { provisional = false } = {}) {
  const c = session.claim
  const documents = Object.keys(session.extracted).filter(
    (d) => session.extracted[d].readable !== false,
  )
  const missing = missingDocuments(documents)

  // Fall back to what the documents show when the claimant did not say.
  const papers = session.extracted.vehicle_papers?.fields ?? {}
  const estimate = session.extracted.repair_estimate?.fields ?? {}

  const claim = {
    id: `CLM-2401-${String(Date.now()).slice(-4)}`,
    // A provisional claim may still be missing required fields. The
    // columns are NOT NULL, so they take a marker rather than a blank —
    // and the claimant is told exactly which ones are outstanding.
    claimant: c.claimant ?? 'Not yet supplied',
    vehicleMake: c.vehicleMake ?? papers.make ?? 'Unknown',
    vehicleModel: c.vehicleModel ?? papers.model ?? 'Unknown',
    vehicleYear: Number(c.vehicleYear ?? papers.year) || 2015,
    plate: c.plate ?? papers.plate ?? 'Unknown',
    insuredValue: Number(c.insuredValue) || Number(c.amount) * 4 || 0,
    amount: Number(c.amount) || 0,
    incidentType: c.incidentType ?? 'Collision',
    incidentHour: Number(c.incidentHour) || 12,
    reportDelayDays: Number(c.reportDelayDays) || 0,
    policyAgeDays: Number(c.policyAgeDays) || 365,
    priorClaims: Number(c.priorClaims) || 0,
    priorClaims12m: Number(c.priorClaims12m) || 0,
    garage: c.garage ?? estimate.garage_name ?? 'Unspecified',
    garageFlaggedCount: 0,
    addressMatches: c.addressMatches !== false,
    documentDateInconsistent: false,
    thirdPartyInvolved: Boolean(c.thirdPartyInvolved),
    injuryReported: Boolean(c.injuryReported),
    totalLoss: Boolean(c.totalLoss),
    liabilityDisputed: false,
    submittedAt: new Date().toISOString(),
    documents,
    missingDocuments: missing.map((d) => d.id),
    scores: {
      complexity: complexityScore({
        amount: Number(c.amount),
        thirdPartyInvolved: Boolean(c.thirdPartyInvolved),
        injuryReported: Boolean(c.injuryReported),
        totalLoss: Boolean(c.totalLoss),
        liabilityDisputed: false,
      }),
      documentation: documentationScore(documents),
    },
  }

  /**
   * A provisional claim is lodged, not assessed.
   *
   * Scoring it now would mean running the fraud model over documents
   * the claimant has told us they do not have yet — and missing
   * documents already drag the documentation score down, so the claim
   * would land in investigation for the sole offence of being
   * incomplete. It is held instead, and scored by finaliseClaim() once
   * the outstanding items arrive.
   *
   * The placeholders below never reach a caller: toApi() nulls every
   * scoring field while `provisional` is set.
   */
  if (provisional) {
    saveClaim(
      claim,
      {
        score: 0,
        reasoning: 'Not yet assessed — lodged with items outstanding.',
        confidence: 'none',
        scoredBy: 'pending',
        signals: [],
      },
      { route: 'std', rule: 'Held pending outstanding items' },
      { provisional: true },
    )
    return getClaim(claim.id)
  }

  const assessment = await scoreClaim(claim)
  const decision = decideRoute({
    amount: claim.amount,
    complexity: claim.scores.complexity,
    documentation: claim.scores.documentation,
    fraud: assessment.score,
  })

  saveClaim(claim, assessment, decision)
  return getClaim(claim.id)
}

/**
 * Score a provisional claim now that its outstanding items have arrived.
 *
 * Same scoring and routing path as a complete submission — the claim
 * simply took a detour through being incomplete. Returns null if the
 * claim does not exist or was never provisional.
 */
export async function finaliseProvisional(claimId, actor = 'claimant') {
  const held = provisionalFacts(claimId)
  if (!held) return null

  const documents = held.documents
  const missing = missingDocuments(documents)

  const claim = {
    ...held.facts,
    documents,
    missingDocuments: missing.map((d) => d.id),
    scores: {
      complexity: complexityScore(held.facts),
      documentation: documentationScore(documents),
    },
  }

  const assessment = await scoreClaim(claim)
  const decision = decideRoute({
    amount: claim.amount,
    complexity: claim.scores.complexity,
    documentation: claim.scores.documentation,
    fraud: assessment.score,
  })

  return finaliseClaim(claimId, claim, assessment, decision, actor)
}

export default async function intakeRoutes(app) {
  /** Start a conversation. Returns the opening message. */
  app.post('/api/intake/start', async (req, reply) => {
    if (!hasCredentials()) {
      return reply
        .code(503)
        .send({ error: 'Intake requires a provider key. Set DEEPSEEK_API_KEY in server/.env.' })
    }

    const id = randomUUID()
    const session = createSession(id)
    SESSIONS.set(id, session)

    const turn = await greet(session)
    const check = validateIntake(session.claim, session.extracted)

    return {
      sessionId: id,
      reply: turn.reply,
      trace: turn.trace,
      recorded: session.claim,
      completeness: check.completeness,
      outstanding: check.blocking.map((i) => i.message),
    }
  })

  /**
   * Continue a claim that was already lodged.
   *
   * The claimant filed earlier — by chat, by voice, or at a counter —
   * and is coming back to supply what was outstanding. This is not a
   * new claim and must never become one: the reference already exists,
   * the claim is already in the book, and submitting again would
   * duplicate it.
   *
   * So the session is built without `submit_claim`. Uploads go through
   * the ordinary authenticated status endpoint, which is also what
   * finalises a provisional claim once the last item lands.
   *
   * Access is the status token the claimant already holds — they
   * proved the reference and surname to get it, by form or by voice.
   */
  app.post('/api/intake/continue', async (req, reply) => {
    if (!hasCredentials()) {
      return reply
        .code(503)
        .send({ error: 'Intake requires a provider key. Set DEEPSEEK_API_KEY in server/.env.' })
    }

    const parsed = ContinueSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A claim reference and access token are required.' })
    }

    const { token, documentType } = parsed.data
    const reference = resolveStatusToken(token)
    if (!reference) {
      return reply.code(401).send({ error: 'That session has expired. Look up your claim again.' })
    }

    const claim = getClaim(reference)
    if (!claim) return reply.code(404).send({ error: 'Claim not found' })

    const outstanding = claim.missingDocuments.map((id) => ({
      id,
      label: MOTOR.requiredDocuments.find((d) => d.id === id)?.label ?? id.replace(/_/g, ' '),
    }))

    const id = randomUUID()
    const session = createSession(id)

    // Marked so the turn handler knows this session may not submit.
    session.continuing = { reference, surname: surnameOf(claim.claimant) }
    session.claim = { claimant: claim.claimant, plate: claim.plate }

    SESSIONS.set(id, session)

    const wanted = outstanding.find((o) => o.id === documentType) ?? null
    const opening = wanted
      ? `Continuing claim ${reference} for ${claim.claimant}. Outstanding: ${outstanding.map((o) => o.label).join(', ')}. They want to send their ${wanted.label.toLowerCase()} now — greet them by name in one sentence, confirm the reference, and ask them to upload it.`
      : outstanding.length > 0
        ? `Continuing claim ${reference} for ${claim.claimant}. Outstanding: ${outstanding.map((o) => o.label).join(', ')}. Greet them by name in one sentence, confirm the reference, and ask for the first outstanding document.`
        : `Continuing claim ${reference} for ${claim.claimant}. Nothing is outstanding. Greet them and say everything has been received.`

    const turn = await runTurn(session, `[System: ${opening}]`)

    return {
      sessionId: id,
      reference,
      claimant: claim.claimant,
      reply: turn.reply,
      trace: turn.trace,
      outstanding,
      provisional: claim.provisional,
    }
  })

  /** One customer turn. */
  app.post('/api/intake/message', async (req, reply) => {
    const parsed = MessageSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid message', issues: parsed.error.issues })
    }

    const session = SESSIONS.get(parsed.data.sessionId)
    if (!session) return reply.code(404).send({ error: 'Session not found or expired' })

    const turn = await runTurn(session, parsed.data.message, { onSubmit: submitToTriage })
    const check = validateIntake(session.claim, session.extracted)

    return {
      reply: turn.reply,
      trace: turn.trace,
      recorded: session.claim,
      completeness: check.completeness,
      outstanding: check.blocking.map((i) => i.message),
      claim: session.submitted,
    }
  })

  /**
   * Upload a document.
   *
   * The file is held against the session and the agent is told it
   * arrived; the agent then calls read_document itself. Extraction is
   * the agent's decision, not the endpoint's.
   */
  app.post('/api/intake/upload', async (req, reply) => {
    const parsed = UploadSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid upload', issues: parsed.error.issues })
    }

    const { sessionId, documentType, filename, dataUri } = parsed.data
    const session = SESSIONS.get(sessionId)
    if (!session) return reply.code(404).send({ error: 'Session not found or expired' })

    // PDFs are accepted too: extraction renders the first page to an
    // image before reading it (lib/intake/pdf.js).
    if (!/^data:(image\/(png|jpe?g|webp|heic)|application\/pdf);base64,/i.test(dataUri)) {
      return reply.code(400).send({ error: 'Upload a photo or a PDF' })
    }

    const uploadId = randomUUID().slice(0, 8)
    session.uploads[uploadId] = { documentType, filename, dataUri }

    const label =
      MOTOR.requiredDocuments.find((d) => d.id === documentType)?.label ?? documentType

    const turn = await runTurn(
      session,
      `[The customer uploaded a file named "${filename}" as their ${label.toLowerCase()}. Its uploadId is ${uploadId}. Read it now.]`,
      { onSubmit: submitToTriage },
    )
    const check = validateIntake(session.claim, session.extracted)

    /**
     * Tell a live voice agent what just happened.
     *
     * Deepgram keeps its own conversation state, so a document uploaded
     * on screen is invisible to it — the claimant would upload a photo,
     * watch the system read it, and still be asked for it. The typed
     * agent above has already done the reading; this only informs.
     */
    /**
     * Confirm the document is the one we asked for.
     *
     * Extraction says whether text could be read; this says whether
     * what was read is acceptable. A rejected document is removed from
     * the session rather than left in place — otherwise a licence
     * uploaded as a police report would tick the checklist green and
     * an assessor would find it days later.
     */
    const extracted = session.extracted[documentType]
    const verdict = confirmDocument(documentType, extracted, session.claim)

    if (verdict.verdict === 'rejected') {
      delete session.extracted[documentType]
    }

    // Re-check after a possible removal, so completeness is honest.
    const finalCheck = validateIntake(session.claim, session.extracted)

    /**
     * A continuing session writes to the claim, not just the session.
     *
     * Without this the claimant would upload their estimate, watch the
     * agent read and accept it, and find the claim still listing it as
     * outstanding — the session would hold it and the record would
     * not. The same rules as the status upload apply: only provisional
     * claims take a document this way, and the last one in finalises
     * the claim through the ordinary scoring path.
     */
    let continued = null
    if (session.continuing && verdict.verdict !== 'rejected') {
      const reference = session.continuing.reference

      recordAudit(reference, 'document_supplied', `claimant:${session.continuing.surname}`, {
        documentType,
        label,
        filename,
        fields: extracted?.fields,
        extractedBy: extracted?.extractedBy,
      })

      const claimNow = getClaim(reference)
      if (claimNow?.provisional) {
        const applied = applyProvisionalDocument(reference, documentType)
        if (applied && applied.remaining.length === 0) {
          continued = await finaliseProvisional(reference, `claimant:${session.continuing.surname}`)
        }
      }
    }

    const voice = getLiveVoice(sessionId)
    if (voice) {
      const stillNeeded = finalCheck.blocking
        .filter((i) => i.type === 'missing_document')
        .map((i) => MOTOR.requiredDocuments.find((d) => d.id === i.field)?.label)
        .filter(Boolean)
        .map((l) => l.toLowerCase())

      /**
       * Written as a system event the agent reasons about, not a line
       * to read out. It arrives as a user turn, so the agent will
       * respond in its own words and — crucially — remember it.
       */
      const next =
        verdict.verdict === 'accepted'
          ? stillNeeded.length > 0
            ? `It is recorded — do not ask for it again. Still outstanding: ${stillNeeded.join(', ')}. Confirm briefly what you read back to them, then ask for one of the outstanding ones.`
            : `It is recorded and every required document is now in. Confirm what you read back to them, then call check_claim.`
          : verdict.ask

      voice.notify(
        `[System: the customer uploaded a ${label.toLowerCase()} on screen. ${verdict.summary} ${next}]`,
      )
    }

    return {
      reply: turn.reply,
      trace: turn.trace,
      recorded: session.claim,
      completeness: finalCheck.completeness,
      outstanding: finalCheck.blocking.map((i) => i.message),
      extracted: session.extracted[documentType] ?? null,
      claim: session.submitted,
      // What the check decided, so the UI can show it rather than a
      // bare tick that may not be deserved.
      confirmation: {
        verdict: verdict.verdict,
        reason: verdict.reason,
        summary: verdict.summary,
        confirmed: verdict.confirmed ?? [],
      },
      // So the UI can avoid showing a typed reply the agent just spoke.
      voiceActive: Boolean(voice),

      // Continuation only: what is left on the real claim, and whether
      // that upload completed it.
      ...(session.continuing
        ? {
            continuing: {
              reference: session.continuing.reference,
              outstanding: (getClaim(session.continuing.reference)?.missingDocuments ?? []).map(
                (id) => ({
                  id,
                  label:
                    MOTOR.requiredDocuments.find((d) => d.id === id)?.label ??
                    id.replace(/_/g, ' '),
                }),
              ),
              completed: Boolean(continued),
            },
          }
        : {}),
    }
  })

  /** Current state of a session, for reconnecting UI. */
  app.get('/api/intake/:sessionId', async (req, reply) => {
    const session = SESSIONS.get(req.params.sessionId)
    if (!session) return reply.code(404).send({ error: 'Session not found or expired' })

    const check = validateIntake(session.claim, session.extracted)
    return {
      sessionId: session.id,
      claim: session.claim,
      extracted: session.extracted,
      recorded: session.claim,
      completeness: check.completeness,
      blocking: check.blocking,
      warnings: check.warnings,
      complete: check.complete,
      submitted: session.submitted,
      messages: session.messages
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map((m) => ({ role: m.role, content: m.content })),
    }
  })

  /** What intake is configured to use. Not nested under /api/intake/
   *  so it cannot collide with the :sessionId route. */
  app.get('/api/intake-config', async () => ({
    available: hasCredentials(),
    agentModel,
    visionModel,
    requiredDocuments: MOTOR.requiredDocuments,
  }))
}
