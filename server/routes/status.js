import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getClaim, getAudit, recordAudit, applyProvisionalDocument } from '../lib/db.js'
import { finaliseProvisional } from './intake.js'
import { getLiveVoice } from '../lib/voice/live.js'
import { claimantView } from '../lib/status.js'
import { MOTOR } from '../lib/config.js'
import { extractDocument } from '../lib/intake/extract.js'
import { confirmDocument } from '../lib/intake/confirm.js'
import {
  createSession as createAskSession,
  ask,
  hasCredentials as canAsk,
} from '../lib/status/agent.js'

/**
 * Claim status, for the person who filed the claim.
 *
 * Claim references are sequential and guessable, so a reference alone
 * does not grant access: the surname on the claim must match too. That
 * is a weak check by design — this is a prototype without accounts, and
 * a real deployment would send a one-time code to the phone number on
 * the policy. It is stated rather than pretended otherwise.
 *
 * What it does prevent is the obvious attack: walking CLM-2401-0001
 * upward and reading strangers' claims.
 */

const LookupSchema = z.object({
  reference: z.string().min(4).max(40),
  surname: z.string().min(1).max(80),
})

const UploadSchema = z.object({
  reference: z.string().min(4).max(40),
  surname: z.string().min(1).max(80),
  documentType: z.enum(MOTOR.requiredDocuments.map((d) => d.id)),
  filename: z.string().min(1).max(300),
  dataUri: z.string().min(32).max(8_000_000),
})

const AskSchema = z.object({
  question: z.string().min(1).max(500),
})

/** Loose surname match — claimants do not type their own name exactly. */
function nameMatches(fullName, given) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '')
  const parts = fullName.split(/\s+/).map(norm).filter(Boolean)
  return parts.includes(norm(given))
}

/**
 * Short-lived tokens, so the claimant is not re-typing their surname on
 * every request. In-memory: a lost token just means looking up again.
 */
const TOKENS = new Map()
const TOKEN_TTL_MS = 30 * 60 * 1000

/**
 * Exported so a voice lookup can issue one too.
 *
 * A caller who gave the right reference and surname over the phone has
 * proved exactly what the form proves, so they get the same access —
 * otherwise the agent could tell them what is outstanding but the page
 * could not let them upload it.
 */
export function issueToken(reference) {
  const token = randomUUID()
  TOKENS.set(token, { reference, expires: Date.now() + TOKEN_TTL_MS })
  return token
}

/**
 * Exported so intake can resume a claim the claimant has already
 * proved access to, rather than asking for the reference twice.
 */
export function resolveToken(token) {
  const entry = TOKENS.get(token)
  if (!entry) return null
  if (entry.expires < Date.now()) {
    TOKENS.delete(token)
    return null
  }
  return entry.reference
}

/** Question-and-answer sessions, keyed by the same access token. */
const ASK_SESSIONS = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [t, e] of TOKENS) {
    if (e.expires < now) {
      TOKENS.delete(t)
      ASK_SESSIONS.delete(t)
    }
  }
}, 10 * 60 * 1000).unref()

export default async function statusRoutes(app) {
  /**
   * Look up a claim.
   *
   * Wrong reference and wrong surname return the same message, so the
   * response cannot be used to discover which references exist.
   */
  app.post('/api/status/lookup', async (req, reply) => {
    const parsed = LookupSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Enter your claim reference and surname.' })
    }

    const { reference, surname } = parsed.data
    const claim = getClaim(reference.trim().toUpperCase())

    if (!claim || !nameMatches(claim.claimant, surname)) {
      return reply.code(404).send({
        error:
          'We could not find a claim with that reference and surname. Check both and try again.',
      })
    }

    return {
      token: issueToken(claim.id),
      claim: claimantView(claim, getAudit(claim.id)),
    }
  })

  /** Refresh a claim the caller has already proved access to. */
  app.get('/api/status/:token', async (req, reply) => {
    const reference = resolveToken(req.params.token)
    if (!reference) {
      return reply.code(401).send({ error: 'That link has expired. Look up your claim again.' })
    }

    const claim = getClaim(reference)
    if (!claim) return reply.code(404).send({ error: 'Claim not found' })

    return { claim: claimantView(claim, getAudit(reference)) }
  })

  /**
   * Supply a document that is still outstanding.
   *
   * This is the point of the whole feature: a claimant who is missing a
   * repair estimate can add it here instead of phoning to ask why
   * nothing is happening.
   */
  app.post('/api/status/upload', async (req, reply) => {
    const parsed = UploadSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid upload', issues: parsed.error.issues })
    }

    const { reference, surname, documentType, filename, dataUri } = parsed.data
    const claim = getClaim(reference.trim().toUpperCase())

    if (!claim || !nameMatches(claim.claimant, surname)) {
      return reply.code(404).send({ error: 'Claim not found' })
    }

    // PDFs are accepted too: extraction renders the first page to an
    // image before reading it (lib/intake/pdf.js).
    if (!/^data:(image\/(png|jpe?g|webp|heic)|application\/pdf);base64,/i.test(dataUri)) {
      return reply.code(400).send({ error: 'Upload a photo or a PDF.' })
    }

    if (!claim.missingDocuments.includes(documentType)) {
      return reply.code(400).send({ error: 'That document is not outstanding on this claim.' })
    }

    // `claim.amount` is 0 on a provisional claim lodged before the
    // figure was given — don't check an estimate against a placeholder.
    const expectAmount = claim.provisional && !claim.amount ? undefined : claim.amount

    const label = MOTOR.requiredDocuments.find((d) => d.id === documentType)?.label ?? documentType

    try {
      const extracted = await extractDocument(documentType, dataUri)

      /**
       * Check the document is the one asked for before accepting it.
       *
       * Readable is not the same as acceptable — a licence photographed
       * clearly and uploaded as a police report reads perfectly. The
       * claimant needs to hear that now, while they still have the
       * document in hand, not from an assessor next week.
       */
      // `claim.vehicle` is "Toyota Corolla 2018 · LSD-441-KJ"; the
      // plate is the part after the separator.
      const verdict = confirmDocument(documentType, extracted, {
        plate: claim.vehicle?.split('·').pop()?.trim(),
        amount: expectAmount,
      })

      if (verdict.verdict === 'rejected') {
        // The agent needs to hear about a rejection too — otherwise it
        // carries on believing the document is still to come, while
        // the caller is looking at an error telling them it was not
        // accepted.
        const rejectedVoice = getLiveVoice(claim.id)
        if (rejectedVoice) {
          rejectedVoice.notify(
            `[System: the customer uploaded a ${label.toLowerCase()} on screen but it was not accepted. ${verdict.summary} It is still outstanding. Tell them briefly what was wrong and ask them to try again.]`,
          )
        }

        return reply.code(422).send({
          error: `${verdict.summary} Please try again — make sure the whole document is in frame and well lit.`,
          verdict: verdict.reason,
        })
      }

      recordAudit(claim.id, 'document_supplied', `claimant:${claim.claimant}`, {
        documentType,
        label,
        filename,
        fields: extracted.fields,
        extractedBy: extracted.extractedBy,
      })

      /**
       * A provisional claim is the one case where a claimant's upload
       * does change the record.
       *
       * On an already-triaged claim the document is recorded but not
       * applied — a supervisor decides whether it changes the routing,
       * and re-scoring on a claimant's upload would let anyone move
       * their own claim between queues.
       *
       * A provisional claim has no routing to move between. It was
       * lodged on the explicit promise that supplying the outstanding
       * items would complete it, so supplying them must do exactly
       * that — and once the last one lands, the claim is scored for the
       * first time by the normal path.
       */
      let finalised = null
      if (claim.provisional) {
        const applied = applyProvisionalDocument(claim.id, documentType)

        if (applied && applied.remaining.length === 0) {
          finalised = await finaliseProvisional(claim.id, `claimant:${claim.claimant}`)
        }
      }

      const updated = getClaim(claim.id)
      const stillOutstanding = updated.missingDocuments.map((id) => ({
        id,
        label: MOTOR.requiredDocuments.find((d) => d.id === id)?.label ?? id.replace(/_/g, ' '),
      }))

      const message = finalised
        ? `Thank you — that was the last item we needed. Your claim is now complete and has gone forward for assessment.`
        : verdict.verdict === 'queried'
          ? `${verdict.summary} We have added it to your claim and an assessor will check this.`
          : stillOutstanding.length > 0 && claim.provisional
            ? `Thank you — your ${label.toLowerCase()} has been added. We still need your ${stillOutstanding.map((d) => d.label.toLowerCase()).join(', ')}.`
            : `Thank you — your ${label.toLowerCase()} has been added to the claim. An assessor will review it.`

      /**
       * Tell a live voice agent what just happened on screen.
       *
       * Deepgram keeps its own conversation state, so an upload made
       * during a call is invisible to it: without this the caller
       * uploads their repair estimate, watches it accepted, and is
       * then told it is still outstanding.
       *
       * Written as a system event the agent reasons about rather than
       * a line to read out — it arrives as a user turn, so the agent
       * answers in its own words and, crucially, remembers it.
       */
      const voice = getLiveVoice(claim.id)
      if (voice) {
        const remaining = stillOutstanding.map((d) => d.label.toLowerCase())
        const next = finalised
          ? 'That was the last outstanding item, and the claim has now gone forward for assessment. Tell them so.'
          : remaining.length > 0
            ? `Still outstanding: ${remaining.join(', ')}. Do not ask for the ${label.toLowerCase()} again. Acknowledge it briefly and say what is left.`
            : 'Nothing further is outstanding. Acknowledge it briefly.'

        voice.notify(
          `[System: the customer uploaded their ${label.toLowerCase()} on screen and it was accepted. ${next}]`,
        )
      }

      return {
        accepted: true,
        documentType,
        label,
        verdict: verdict.verdict,
        // Say what was actually read back, so the claimant can see the
        // document was checked rather than merely received.
        confirmed: verdict.confirmed ?? [],
        outstanding: stillOutstanding,
        completed: Boolean(finalised),
        message,
      }
    } catch (err) {
      req.log.error({ err }, 'status upload extraction failed')

      // The third way an upload can end, and the agent has to hear
      // about this one too — the caller is looking at an error while
      // the agent waits for a document it thinks is still coming.
      const failedVoice = getLiveVoice(claim.id)
      if (failedVoice) {
        failedVoice.notify(
          `[System: the customer uploaded their ${label.toLowerCase()} on screen but it could not be processed — a technical problem on our side, not their photo. It is still outstanding. Apologise briefly and ask them to try again.]`,
        )
      }

      return reply
        .code(502)
        .send({ error: 'We could not process that file. Please try uploading it again.' })
    }
  })

  /**
   * Ask about the claim.
   *
   * This is the endpoint that replaces the status phone call. The token
   * scopes the assistant to one claim, and every tool it has is
   * read-only — a claimant asking questions cannot change anything.
   */
  app.post('/api/status/:token/ask', async (req, reply) => {
    if (!canAsk()) {
      return reply.code(503).send({ error: 'The assistant is unavailable right now.' })
    }

    const parsed = AskSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Ask a question about your claim.' })
    }

    const { token } = req.params
    const reference = resolveToken(token)
    if (!reference) {
      return reply.code(401).send({ error: 'That link has expired. Look up your claim again.' })
    }

    let session = ASK_SESSIONS.get(token)
    if (!session) {
      session = createAskSession(reference)
      ASK_SESSIONS.set(token, session)
    }

    try {
      const turn = await ask(session, parsed.data.question)
      return { reply: turn.reply, trace: turn.trace }
    } catch (err) {
      req.log.error({ err }, 'claim assistant failed')
      return reply.code(502).send({
        error: 'I could not look that up just now. Please try again in a moment.',
      })
    }
  })
}
