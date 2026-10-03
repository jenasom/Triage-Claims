import { MOTOR } from './config.js'

/**
 * A claim as its claimant should see it.
 *
 * Deliberately not the supervisor's view. A claimant must never see
 * their fraud score, the signals that fired, or the analyst's
 * reasoning: those are internal assessments, some of them wrong, and
 * showing someone "estimate high against insured value" reads as an
 * accusation the insurer has not made.
 *
 * What they get instead is what they can act on — where the claim is,
 * what happens next, and anything still needed from them.
 */

/** How each route is described to the person who filed the claim. */
const ROUTE_VIEW = {
  fast: {
    stage: 'Approved for fast settlement',
    detail:
      'Your claim met the conditions for fast-track settlement. Payment is being arranged and you should hear from us within 48 hours.',
    tone: 'good',
  },
  std: {
    stage: 'With an assessor',
    detail:
      'An assessor is reviewing your claim. They will contact you if they need anything further.',
    tone: 'neutral',
  },
  inv: {
    // Never "flagged for fraud". The claim needs more checking; saying
    // more than that accuses someone on the strength of a score.
    stage: 'Under review',
    detail:
      'Your claim needs some additional checks before assessment. A member of our team will be in touch.',
    tone: 'neutral',
  },
}

/**
 * How a provisionally lodged claim is described.
 *
 * It has a reference and a place in the queue, but nothing has been
 * assessed. Saying "with an assessor" would be untrue, and saying
 * nothing would leave the claimant wondering whether it arrived.
 */
const PROVISIONAL_VIEW = {
  stage: 'Lodged — waiting on you',
  detail:
    'Your claim is saved and your reference is confirmed. We need the outstanding items below before assessment can start — you can add them here whenever you have them.',
  tone: 'warn',
}

/** Stages the claimant sees as a progress line. */
const STAGES = ['Submitted', 'Checked', 'Assessment', 'Decision']

function stageIndex(claim) {
  if (claim.withdrawn) return 1
  // Lodged but not yet checked: the first stage is genuinely done, the
  // second has not started.
  if (claim.provisional) return 0
  if (claim.route === 'fast') return 3
  return 2
}

/** Relative time, phrased the way a person would say it. */
function ago(iso) {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)

  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`

  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`

  return then.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * The audit trail, rewritten for the claimant.
 *
 * Internal actions are either translated or dropped. A supervisor
 * rerouting a claim is real activity the claimant is entitled to see —
 * but "route_overridden: inv → std" is not how to say it.
 */
function timeline(claim, audit) {
  const entries = []

  entries.push({
    at: claim.submittedAt,
    when: ago(claim.submittedAt),
    title: 'Claim received',
    detail: `Reference ${claim.id}`,
  })

  for (const e of audit) {
    switch (e.action) {
      case 'taken_by_staff':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Claim taken by our team',
          detail: `Recorded by ${e.actor} from your call.`,
        })
        break

      case 'lodged_provisionally':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Claim saved',
          detail: 'Your claim was saved with some items still outstanding.',
        })
        break

      case 'triaged':
      case 'completed':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Checks completed',
          detail: 'Your documents and claim details were reviewed automatically.',
        })
        break

      case 'route_overridden':
      case 'rerouted':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Reviewed by our team',
          detail: 'A member of the claims team looked at your claim.',
        })
        break

      case 'document_supplied':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: `${e.detail?.label ?? 'Document'} received`,
          detail: 'Thank you — an assessor will review it.',
        })
        break

      case 'field_edited':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Details corrected',
          detail: e.detail?.label ? `Your ${e.detail.label} was updated.` : 'A detail was updated.',
        })
        break

      case 'withdrawn':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Claim withdrawn',
          detail: e.detail?.reason ?? 'This claim is no longer being processed.',
        })
        break

      case 'restored':
        entries.push({
          at: e.at,
          when: ago(e.at),
          title: 'Claim reopened',
          detail: 'Your claim is being processed again.',
        })
        break

      default:
        // Anything not recognised is internal and stays internal.
        break
    }
  }

  return entries
}

/**
 * Build the claimant-facing view.
 *
 * Returns null for a claim that does not exist, so the caller can
 * answer 404 without leaking whether the reference was ever valid.
 */
export function claimantView(claim, audit = []) {
  if (!claim) return null

  const view = claim.withdrawn
    ? {
        stage: 'Claim withdrawn',
        detail:
          claim.withdrawn.reason ??
          'This claim is no longer being processed. Contact us if that is not right.',
        tone: 'warn',
      }
    : claim.provisional
      ? PROVISIONAL_VIEW
      : ROUTE_VIEW[claim.route]

  const outstanding = claim.missingDocuments.map((id) => {
    const doc = MOTOR.requiredDocuments.find((d) => d.id === id)
    return { id, label: doc?.label ?? id.replace(/_/g, ' ') }
  })

  return {
    reference: claim.id,
    claimant: claim.claimant,
    vehicle: claim.vehicle,
    amount: claim.amount,
    incidentType: claim.incidentType,

    submittedAt: claim.submittedAt,
    submittedAgo: ago(claim.submittedAt),

    stage: view.stage,
    detail: view.detail,
    tone: view.tone,

    /** Lodged but not yet assessed — the UI leads with what is needed. */
    provisional: Boolean(claim.provisional),

    stages: STAGES,
    currentStage: stageIndex(claim),

    /** What the claimant still has to do — the actionable half. */
    outstanding,
    documentsReceived: claim.documents.length,
    documentsRequired: MOTOR.requiredDocuments.length,

    timeline: timeline(claim, audit),

    // Deliberately absent: scores, signals, reasoning, routeRule,
    // confidence, scoredBy. See the note at the top of this file.
  }
}
