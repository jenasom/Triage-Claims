import { getClaim, getAudit } from '../db.js'
import { claimantView } from '../status.js'
import { MOTOR } from '../config.js'

/**
 * Tools the claim assistant can call.
 *
 * Every one is read-only and scoped to a single claim. There is no
 * write path here at all — not a guarded one, not a confirmed one. A
 * claimant asking questions about their claim must not be able to move
 * it between queues, mark a document received, or change an amount,
 * and the safest way to guarantee that is to give the agent nothing
 * that could.
 *
 * The claim is also passed through `claimantView` before the agent
 * sees it, so the fraud score and the analyst's reasoning are stripped
 * before they can reach a prompt. The agent cannot leak what it was
 * never given.
 */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'get_status',
      description:
        "The claim's current state: stage, what happens next, whether anything is needed from the claimant, and when it was submitted. Call this first for almost any question.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_outstanding',
      description:
        'What the claimant still needs to supply, and what has already been received. Use when they ask what is missing or why the claim has not moved.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_history',
      description:
        'Everything that has happened on the claim, most recent last. Use when they ask why it is taking time, or what has been done so far.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
]

/**
 * Build the tools for one claim.
 *
 * `reference` is fixed at construction — the agent has no parameter it
 * could use to reach a different claim.
 */
export function createTools(reference) {
  const load = () => {
    const claim = getClaim(reference)
    return claim ? claimantView(claim, getAudit(reference)) : null
  }

  return {
    async get_status() {
      const v = load()
      if (!v) return { error: 'That claim could not be found.' }

      return {
        reference: v.reference,
        stage: v.stage,
        whatItMeans: v.detail,
        submitted: v.submittedAgo,
        progress: `${v.currentStage + 1} of ${v.stages.length} — ${v.stages[v.currentStage]}`,
        nextStep: v.stages[v.currentStage + 1] ?? 'Decision',
        actionNeededFromClaimant:
          v.outstanding.length > 0
            ? v.outstanding.map((o) => o.label)
            : 'None — nothing is needed from you right now',
        vehicle: v.vehicle,
        amount: v.amount,
      }
    },

    async list_outstanding() {
      const v = load()
      if (!v) return { error: 'That claim could not be found.' }

      const received = MOTOR.requiredDocuments
        .filter((d) => !v.outstanding.some((o) => o.id === d.id))
        .map((d) => d.label)

      return {
        outstanding: v.outstanding.map((o) => o.label),
        received,
        complete: v.outstanding.length === 0,
        howToSupply:
          v.outstanding.length > 0
            ? 'They can upload each one on this page — there is an upload button beside every outstanding document.'
            : null,
      }
    },

    async get_history() {
      const v = load()
      if (!v) return { error: 'That claim could not be found.' }
      return {
        events: v.timeline.map((e) => ({ what: e.title, detail: e.detail, when: e.when })),
        submitted: v.submittedAgo,
      }
    },
  }
}
