import { z } from 'zod'
import { validateIntake } from '../lib/intake/validate.js'
import { extractDocument } from '../lib/intake/extract.js'
import { confirmDocument } from '../lib/intake/confirm.js'
import { MOTOR } from '../lib/config.js'
import { recordAudit } from '../lib/db.js'
import { submitToTriage } from './intake.js'

/**
 * First notice of loss, taken by staff.
 *
 * The same claim, the same validation and the same triage path as a
 * claimant-filed claim — but a different way in. A claims officer with
 * a caller on the line is transcribing, not conversing: they need every
 * field at once and the ability to tab between them, not an assistant
 * asking one question at a time.
 *
 * Two things distinguish this from claimant intake:
 *
 *  - The claim records who took it. A claim created by staff and a
 *    claim filed by its claimant are different events, and the audit
 *    trail has to say which this was.
 *
 *  - There is no agent. The form posts once; validation runs
 *    server-side and comes back as field errors. Nothing here can
 *    submit a claim that validateIntake() rejects, which is the same
 *    boundary the agent's submit_claim tool enforces.
 */

/** Documents attached at the counter, read before the claim is saved. */
const AttachmentSchema = z.object({
  documentType: z.enum(MOTOR.requiredDocuments.map((d) => d.id)),
  filename: z.string().min(1).max(300),
  dataUri: z.string().min(32).max(8_000_000),
})

const StaffClaimSchema = z.object({
  takenBy: z.string().min(2).max(80),

  claimant: z.string().min(2).max(120),
  plate: z.string().min(3).max(20),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker'),
  incidentDescription: z.string().min(10).max(2000),
  amount: z.number().positive().max(1_000_000_000),

  vehicleMake: z.string().max(60).optional(),
  vehicleModel: z.string().max(60).optional(),
  vehicleYear: z.number().int().min(1950).max(2100).optional(),
  insuredValue: z.number().positive().max(10_000_000_000).optional(),
  policyAgeDays: z.number().int().min(0).max(40_000).optional(),
  garage: z.string().max(120).optional(),
  incidentType: z.enum(MOTOR.incidentTypes).optional(),
  thirdPartyInvolved: z.boolean().optional(),
  injuryReported: z.boolean().optional(),

  attachments: z.array(AttachmentSchema).max(MOTOR.requiredDocuments.length).optional(),

  /**
   * Lodge the claim with items outstanding.
   *
   * The counter equivalent of the agent's provisional path: a caller
   * reporting an accident this morning will not have a repair estimate
   * yet, and refusing the claim until they do is how a claim becomes a
   * phone call instead.
   */
  provisional: z.boolean().optional(),
})

export default async function staffIntakeRoutes(app) {
  /**
   * Take a claim.
   *
   * Returns 422 with per-field problems rather than a flat message, so
   * the form can mark the fields that need attention instead of making
   * the officer re-read the whole thing with a caller waiting.
   */
  app.post('/api/staff/claims', async (req, reply) => {
    const parsed = StaffClaimSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Some details need correcting.',
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      })
    }

    const { takenBy, attachments = [], provisional = false, ...claim } = parsed.data

    /**
     * Read any documents brought to the counter.
     *
     * Same extraction and same confirmation as the claimant path: a
     * licence handed over as a police report is caught here rather
     * than by an assessor next week. A document that fails
     * confirmation is dropped, so it cannot tick the checklist.
     */
    const extracted = {}
    const rejected = []

    for (const a of attachments) {
      if (!/^data:(image\/(png|jpe?g|webp|heic)|application\/pdf);base64,/i.test(a.dataUri)) {
        rejected.push({ documentType: a.documentType, reason: 'Not a photo or PDF' })
        continue
      }

      try {
        const read = await extractDocument(a.documentType, a.dataUri)
        const verdict = confirmDocument(a.documentType, read, claim)

        if (verdict.verdict === 'rejected') {
          rejected.push({ documentType: a.documentType, reason: verdict.summary })
          continue
        }
        extracted[a.documentType] = read
      } catch (err) {
        req.log.error({ err }, 'staff intake extraction failed')
        rejected.push({ documentType: a.documentType, reason: 'Could not be processed' })
      }
    }

    /**
     * The same gate the agent faces.
     *
     * Contradictions block outright; gaps block unless the officer
     * asked to lodge provisionally. A form cannot talk its way past
     * this any more than the agent can.
     */
    const check = validateIntake(claim, extracted)

    if (check.contradictions.length > 0) {
      return reply.code(422).send({
        error: 'These details contradict the documents attached and must be resolved.',
        contradictions: check.contradictions.map((i) => ({
          field: i.field,
          problem: i.message,
        })),
        rejectedDocuments: rejected,
      })
    }

    if (check.gaps.length > 0 && !provisional) {
      return reply.code(422).send({
        error: 'The claim is not complete.',
        gaps: check.gaps.map((i) => ({ field: i.field, problem: i.message })),
        rejectedDocuments: rejected,
        // So the UI can offer the provisional route rather than
        // leaving the officer stuck with a caller on the line.
        canLodgeProvisionally: true,
      })
    }

    const session = { claim, extracted }
    const saved = await submitToTriage(session, { provisional: check.gaps.length > 0 })

    // Who took this claim. Without it the audit trail cannot tell a
    // staff-created claim from a claimant-filed one.
    recordAudit(saved.id, 'taken_by_staff', takenBy, {
      channel: 'counter',
      documentsAttached: Object.keys(extracted),
      ...(rejected.length ? { rejectedDocuments: rejected } : {}),
    })

    return {
      claim: saved,
      provisional: saved.provisional,
      outstanding: saved.missingDocuments,
      rejectedDocuments: rejected,
    }
  })

  /** What the form needs to render. */
  app.get('/api/staff/intake-config', async () => ({
    requiredDocuments: MOTOR.requiredDocuments,
    incidentTypes: MOTOR.incidentTypes,
  }))
}
