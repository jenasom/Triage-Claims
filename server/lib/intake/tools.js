import { validateIntake, REQUIRED_FIELDS } from './validate.js'
import { extractDocument } from './extract.js'
import { MOTOR } from '../config.js'

/**
 * Tools the intake agent can call.
 *
 * Each tool is a real operation against the claim record, not a
 * description of one. The agent decides which to call and when; these
 * functions decide what actually happens, and enforce the rules the
 * agent must not be able to talk its way around.
 *
 * The important boundary: `submit_claim` refuses while blocking issues
 * remain. The agent cannot decide a claim is good enough — validation
 * decides, and the tool reports the refusal back so the agent can tell
 * the claimant what is still needed.
 */

const FIELD_IDS = REQUIRED_FIELDS.map((f) => f.id)
const OPTIONAL_FIELDS = [
  'vehicleMake',
  'vehicleModel',
  'vehicleYear',
  'insuredValue',
  'policyAgeDays',
  'garage',
  'thirdPartyInvolved',
  'injuryReported',
]
const SETTABLE = [...FIELD_IDS, ...OPTIONAL_FIELDS]

/** JSON Schema definitions handed to the model. */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'record_details',
      description:
        'Save claim details the claimant has given you. Call this as soon as they tell you something — do not wait until the end. Only pass fields you actually have; omit the rest.',
      parameters: {
        type: 'object',
        properties: {
          claimant: { type: 'string', description: "The claimant's full name" },
          plate: { type: 'string', description: 'Vehicle registration, as printed' },
          incidentDate: { type: 'string', description: 'Date of the incident, YYYY-MM-DD' },
          incidentDescription: { type: 'string', description: 'What happened, in the claimant\'s words' },
          amount: { type: 'number', description: 'Estimated repair cost in naira, digits only' },
          vehicleMake: { type: 'string' },
          vehicleModel: { type: 'string' },
          vehicleYear: { type: 'integer' },
          insuredValue: { type: 'number', description: 'Insured value in naira' },
          policyAgeDays: { type: 'integer', description: 'How long the policy has been active, in days' },
          garage: { type: 'string', description: 'Repair garage name' },
          thirdPartyInvolved: { type: 'boolean' },
          injuryReported: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description:
        'Read a document the claimant has uploaded and extract its fields. Call this immediately after an upload. Returns the fields found, or says the document could not be read and why.',
      parameters: {
        type: 'object',
        properties: {
          documentType: {
            type: 'string',
            enum: MOTOR.requiredDocuments.map((d) => d.id),
            description: 'Which required document this upload is',
          },
          uploadId: {
            type: 'string',
            description: 'The id of the pending upload, given to you when the claimant uploaded it',
          },
        },
        required: ['documentType', 'uploadId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_claim',
      description:
        'Check the claim as it currently stands. Returns everything still missing, unreadable or inconsistent, and whether the claim is ready to submit. Call this after recording details or reading a document, so you know what to ask for next.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_claim',
      description:
        'Submit the claim. Normally call this with no arguments once the claim is complete. If the claimant cannot supply something right now — a document still at the garage, a figure they need to look up — call it with provisional: true to lodge the claim anyway; they can finish it later from their claim status page. A provisional claim is held and not assessed until the outstanding items arrive. Contradictions in what they have already given you can never be submitted either way: resolve those by asking.',
      parameters: {
        type: 'object',
        properties: {
          provisional: {
            type: 'boolean',
            description:
              'True to lodge the claim with items still outstanding. Only do this when the claimant has said they cannot supply something now, or has asked to finish later — never to get past a question they can simply answer.',
          },
        },
        additionalProperties: false,
      },
    },
  },
]

/**
 * Build the executable tools for one session.
 *
 * `session` is mutated in place — it is the claim record being built.
 * `onSubmit` is the handover into the existing triage engine.
 */
export function createTools(session, { onSubmit } = {}) {
  return {
    async record_details(args) {
      const saved = {}
      const rejected = []

      for (const [k, v] of Object.entries(args ?? {})) {
        if (!SETTABLE.includes(k)) {
          rejected.push(k)
          continue
        }
        if (v === null || v === undefined || String(v).trim?.() === '') continue
        session.claim[k] = v
        saved[k] = v
      }

      const check = validateIntake(session.claim, session.extracted)
      return {
        saved,
        ...(rejected.length ? { ignoredUnknownFields: rejected } : {}),
        completeness: check.completeness,
        stillNeeded: check.blocking.map((i) => i.message),
      }
    },

    async read_document(args) {
      const { documentType, uploadId } = args ?? {}

      const upload = session.uploads?.[uploadId]
      if (!upload) {
        return {
          error: `No upload found with id ${uploadId}. Ask the claimant to upload the document again.`,
        }
      }

      try {
        const result = await extractDocument(documentType, upload.dataUri)
        session.extracted[documentType] = result

        const check = validateIntake(session.claim, session.extracted)
        return {
          readable: result.readable,
          ...(result.readable ? {} : { reason: result.reason }),
          documentType: result.documentType,
          fields: result.fields,
          missingFields: result.missingFields,
          ...(result.notes ? { notes: result.notes } : {}),
          completeness: check.completeness,
          newIssues: check.blocking
            .filter((i) => String(i.field).startsWith(documentType))
            .map((i) => i.message),
        }
      } catch (err) {
        // Extraction failure is not the claimant's fault — say so
        // rather than letting the agent blame their photo.
        return {
          error: `The document could not be processed (${err.message}). Apologise and ask the claimant to try uploading it again.`,
        }
      }
    },

    async check_claim() {
      const check = validateIntake(session.claim, session.extracted)
      return {
        complete: check.complete,
        completeness: check.completeness,
        // Split so the agent knows what may be deferred and what may not.
        outstanding: check.gaps.map((i) => ({ field: i.field, problem: i.message, ask: i.ask })),
        contradictions: check.contradictions.map((i) => ({
          field: i.field,
          problem: i.message,
          ask: i.ask,
        })),
        canSubmitProvisionally: check.submittable && !check.complete,
        warnings: check.warnings.map((i) => ({ field: i.field, problem: i.message, ask: i.ask })),
        documentsReceived: Object.keys(session.extracted),
        documentsOutstanding: MOTOR.requiredDocuments
          .filter((d) => !session.extracted[d.id])
          .map((d) => d.id),
      }
    },

    async submit_claim(args) {
      const check = validateIntake(session.claim, session.extracted)
      const provisional = args?.provisional === true

      /**
       * The agent does not get to decide this. Validation does.
       *
       * Contradictions refuse regardless of `provisional`: a claim whose
       * own documents disagree with it is not incomplete, it is wrong,
       * and lodging it would put a knowingly false figure into triage.
       */
      if (check.contradictions.length > 0) {
        return {
          submitted: false,
          reason:
            'The claim cannot be submitted — these contradict what has already been supplied, and must be resolved first. They cannot be deferred.',
          blocking: check.contradictions.map((i) => ({
            field: i.field,
            problem: i.message,
            ask: i.ask,
          })),
        }
      }

      // Gaps refuse only when the agent has not asked for a provisional
      // lodgement — the claimant may simply not have the document yet.
      if (check.gaps.length > 0 && !provisional) {
        return {
          submitted: false,
          reason:
            'The claim is not complete. Ask the claimant for what is missing. If they cannot supply it now, call submit_claim again with provisional: true to lodge it and let them finish later.',
          blocking: check.gaps.map((i) => ({ field: i.field, problem: i.message, ask: i.ask })),
        }
      }

      if (!onSubmit) {
        return { submitted: false, reason: 'Submission is not wired up in this environment.' }
      }

      const incomplete = check.gaps.length > 0
      const claim = await onSubmit(session, { provisional: incomplete })
      session.submitted = claim

      if (incomplete) {
        return {
          submitted: true,
          provisional: true,
          claimId: claim.id,
          outstanding: check.gaps.map((i) => i.message),
          message: `Claim ${claim.id} has been lodged provisionally. It is held until the outstanding items arrive, and is not assessed yet. Tell the claimant their reference is ${claim.id}, say exactly what is still outstanding, and tell them they can supply it later from the claim status page using that reference and their surname.`,
        }
      }

      return {
        submitted: true,
        provisional: false,
        claimId: claim.id,
        route: claim.route,
        message: `Claim ${claim.id} has been submitted for assessment.`,
      }
    },
  }
}
