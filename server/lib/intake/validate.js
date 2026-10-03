import { MOTOR } from '../config.js'

/**
 * Deterministic intake validation.
 *
 * Runs before any model call. Everything here is a rule a claims clerk
 * would apply by eye: is this field present, is this date possible, do
 * these two numbers contradict each other.
 *
 * Keeping it separate from the model means the obvious problems are
 * caught for free and reported identically every time — and the model
 * is left to do only what rules cannot: read a photograph, and judge
 * whether an extracted document actually supports the claim.
 */

/** A required field the claimant must supply directly. */
const REQUIRED_FIELDS = [
  { id: 'claimant', label: 'your full name' },
  { id: 'plate', label: 'the vehicle registration number' },
  { id: 'incidentDate', label: 'the date of the incident' },
  { id: 'incidentDescription', label: 'a description of what happened' },
  { id: 'amount', label: 'the estimated repair cost' },
]

export const ISSUE = {
  MISSING_FIELD: 'missing_field',
  MISSING_DOCUMENT: 'missing_document',
  UNREADABLE: 'unreadable_document',
  INCONSISTENT: 'inconsistent',
  IMPLAUSIBLE: 'implausible',
}

/** Severity decides whether intake can proceed: blocking issues cannot. */
export const SEVERITY = { BLOCKING: 'blocking', WARNING: 'warning' }

/**
 * Which blocking issues a provisional submission may carry.
 *
 * A gap is something the claimant does not have yet — a document still
 * at the garage, a field they need to look up. It can be finished later
 * without anyone having decided anything wrong.
 *
 * A contradiction is different in kind: the estimate says ₦800,000 and
 * they typed ₦2,000,000, or the police report predates the incident it
 * describes. Nothing is missing there — two things we already hold
 * disagree, and submitting means scoring a claim on figures known to be
 * wrong. Those stay blocking, because the agent can resolve them with
 * one question while the claimant is still in the conversation.
 */
const GAP_TYPES = new Set([ISSUE.MISSING_FIELD, ISSUE.MISSING_DOCUMENT, ISSUE.UNREADABLE])

export const isGap = (i) => GAP_TYPES.has(i.type)

function issue(type, severity, field, message, ask) {
  return { type, severity, field, message, ask }
}

/** Parse a YYYY-MM-DD string to a UTC date, or null. */
function parseDate(s) {
  if (!s || typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

const daysBetween = (a, b) => Math.round((b - a) / 86_400_000)

/**
 * Validate a claim in progress.
 *
 * `claim` holds what the claimant has supplied so far; `extracted` holds
 * per-document fields read from their uploads (see extract.js). Both may
 * be partial — this runs after every turn of the conversation.
 */
export function validateIntake(claim = {}, extracted = {}) {
  const issues = []
  const today = new Date()

  // ---- required fields -------------------------------------------------
  for (const f of REQUIRED_FIELDS) {
    const v = claim[f.id]
    if (v === undefined || v === null || String(v).trim() === '') {
      issues.push(
        issue(
          ISSUE.MISSING_FIELD,
          SEVERITY.BLOCKING,
          f.id,
          `${f.label} has not been provided`,
          `Could you tell me ${f.label}?`,
        ),
      )
    }
  }

  // ---- required documents ----------------------------------------------
  const supplied = new Set(Object.keys(extracted))
  for (const doc of MOTOR.requiredDocuments) {
    if (!supplied.has(doc.id)) {
      issues.push(
        issue(
          ISSUE.MISSING_DOCUMENT,
          SEVERITY.BLOCKING,
          doc.id,
          `${doc.label} has not been uploaded`,
          `Please upload your ${doc.label.toLowerCase()}.`,
        ),
      )
    }
  }

  // ---- documents that were uploaded but could not be read --------------
  for (const [docId, data] of Object.entries(extracted)) {
    const doc = MOTOR.requiredDocuments.find((d) => d.id === docId)
    const label = doc?.label ?? docId.replace(/_/g, ' ')

    if (data?.readable === false) {
      issues.push(
        issue(
          ISSUE.UNREADABLE,
          SEVERITY.BLOCKING,
          docId,
          `the ${label.toLowerCase()} could not be read${data.reason ? ` — ${data.reason}` : ''}`,
          `The ${label.toLowerCase()} you uploaded is not legible${data.reason ? ` (${data.reason})` : ''}. Could you take another photo in better light, with the whole document in frame?`,
        ),
      )
      continue
    }

    // Fields the document should carry but does not.
    for (const missing of data?.missingFields ?? []) {
      issues.push(
        issue(
          ISSUE.UNREADABLE,
          SEVERITY.WARNING,
          `${docId}.${missing}`,
          `the ${label.toLowerCase()} does not show ${missing.replace(/_/g, ' ')}`,
          `I could not find ${missing.replace(/_/g, ' ')} on your ${label.toLowerCase()}. Is it visible on the document?`,
        ),
      )
    }
  }

  // ---- cross-field consistency ----------------------------------------
  const incident = parseDate(claim.incidentDate)

  if (claim.incidentDate && !incident) {
    issues.push(
      issue(
        ISSUE.INCONSISTENT,
        SEVERITY.BLOCKING,
        'incidentDate',
        'the incident date is not a valid date',
        'I could not read the incident date. What date did this happen, as day, month and year?',
      ),
    )
  }

  if (incident) {
    if (incident > today) {
      issues.push(
        issue(
          ISSUE.IMPLAUSIBLE,
          SEVERITY.BLOCKING,
          'incidentDate',
          'the incident date is in the future',
          'The incident date you gave is in the future. Could you confirm the correct date?',
        ),
      )
    }

    const age = daysBetween(incident, today)
    if (age > 365) {
      issues.push(
        issue(
          ISSUE.IMPLAUSIBLE,
          SEVERITY.WARNING,
          'incidentDate',
          `the incident was ${age} days ago, outside the usual reporting window`,
          `This incident was ${age} days ago. Claims are normally reported within 30 days — can you tell me why it is being reported now?`,
        ),
      )
    }

    // A document dated before the incident it describes is the single
    // strongest paper-trail inconsistency in motor claims.
    for (const [docId, data] of Object.entries(extracted)) {
      const docDate = parseDate(data?.fields?.date)
      if (!docDate) continue
      const doc = MOTOR.requiredDocuments.find((d) => d.id === docId)
      const label = doc?.label ?? docId.replace(/_/g, ' ')

      if (daysBetween(docDate, incident) > 0) {
        issues.push(
          issue(
            ISSUE.INCONSISTENT,
            SEVERITY.BLOCKING,
            `${docId}.date`,
            `the ${label.toLowerCase()} is dated ${data.fields.date}, before the incident on ${claim.incidentDate}`,
            `Your ${label.toLowerCase()} is dated ${data.fields.date}, but you said the incident happened on ${claim.incidentDate}. One of those dates looks wrong — which is correct?`,
          ),
        )
      }
    }
  }

  // ---- plate consistency across documents ------------------------------
  if (claim.plate) {
    const norm = (p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')
    const claimed = norm(claim.plate)

    for (const [docId, data] of Object.entries(extracted)) {
      const onDoc = data?.fields?.plate
      if (!onDoc) continue
      if (norm(onDoc) !== claimed) {
        const doc = MOTOR.requiredDocuments.find((d) => d.id === docId)
        const label = doc?.label ?? docId.replace(/_/g, ' ')
        issues.push(
          issue(
            ISSUE.INCONSISTENT,
            SEVERITY.BLOCKING,
            `${docId}.plate`,
            `the ${label.toLowerCase()} shows plate ${onDoc}, not ${claim.plate}`,
            `Your ${label.toLowerCase()} shows registration ${onDoc}, but you gave ${claim.plate}. Which vehicle is this claim for?`,
          ),
        )
      }
    }
  }

  // ---- amount plausibility --------------------------------------------
  const amount = Number(claim.amount)
  const insured = Number(claim.insuredValue)

  if (claim.amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    issues.push(
      issue(
        ISSUE.IMPLAUSIBLE,
        SEVERITY.BLOCKING,
        'amount',
        'the repair cost is not a valid amount',
        'I could not read the repair cost. Roughly how much is the repair estimated at, in naira?',
      ),
    )
  }

  if (Number.isFinite(amount) && Number.isFinite(insured) && insured > 0 && amount > insured) {
    issues.push(
      issue(
        ISSUE.IMPLAUSIBLE,
        SEVERITY.WARNING,
        'amount',
        `the repair estimate (₦${amount.toLocaleString('en-NG')}) exceeds the insured value (₦${insured.toLocaleString('en-NG')})`,
        `Your repair estimate of ₦${amount.toLocaleString('en-NG')} is more than the vehicle's insured value of ₦${insured.toLocaleString('en-NG')}. This is usually treated as a total loss — can you confirm the estimate?`,
      ),
    )
  }

  // Estimate on the document versus the amount claimed.
  const estimateDoc = extracted.repair_estimate?.fields?.amount
  if (estimateDoc != null && Number.isFinite(amount)) {
    const onDoc = Number(String(estimateDoc).replace(/[^\d.]/g, ''))
    if (Number.isFinite(onDoc) && onDoc > 0) {
      const drift = Math.abs(onDoc - amount) / Math.max(onDoc, amount)
      if (drift > 0.05) {
        issues.push(
          issue(
            ISSUE.INCONSISTENT,
            SEVERITY.BLOCKING,
            'amount',
            `the claim states ₦${amount.toLocaleString('en-NG')} but the estimate document shows ₦${onDoc.toLocaleString('en-NG')}`,
            `You entered ₦${amount.toLocaleString('en-NG')}, but the repair estimate you uploaded shows ₦${onDoc.toLocaleString('en-NG')}. Which figure should we use?`,
          ),
        )
      }
    }
  }

  const blocking = issues.filter((i) => i.severity === SEVERITY.BLOCKING)
  const gaps = blocking.filter(isGap)
  const contradictions = blocking.filter((i) => !isGap(i))

  return {
    issues,
    blocking,
    warnings: issues.filter((i) => i.severity === SEVERITY.WARNING),
    complete: blocking.length === 0,

    /** Outstanding pieces the claimant can supply later. */
    gaps,
    /** Disagreements between things already supplied. Must be resolved now. */
    contradictions,
    /**
     * Whether the claim can be submitted provisionally: nothing
     * contradicts, but something is still missing.
     */
    submittable: contradictions.length === 0,

    /** 0–100, for the progress indicator the claimant sees. */
    completeness: completeness(claim, extracted),
  }
}

/** How far through intake the claimant is. */
function completeness(claim, extracted) {
  const fieldsTotal = REQUIRED_FIELDS.length
  const fieldsHave = REQUIRED_FIELDS.filter(
    (f) => claim[f.id] !== undefined && String(claim[f.id]).trim() !== '',
  ).length

  const docsTotal = MOTOR.requiredDocuments.reduce((n, d) => n + d.weight, 0)
  const docsHave = MOTOR.requiredDocuments
    .filter((d) => extracted[d.id] && extracted[d.id].readable !== false)
    .reduce((n, d) => n + d.weight, 0)

  // Fields and documents weighted equally — a claimant with every field
  // and no documents is halfway, not nearly done.
  return Math.round(((fieldsHave / fieldsTotal) * 50) + ((docsHave / docsTotal) * 50))
}

export { REQUIRED_FIELDS }
