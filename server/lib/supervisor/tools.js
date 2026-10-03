import {
  searchClaims,
  aggregate,
  getClaim,
  getAudit,
  overrideRoute,
  editClaim,
  withdrawClaim,
  restoreClaim,
  stats,
  EDITABLE_FIELDS,
} from '../db.js'
import { MOTOR } from '../config.js'

/**
 * Tools the supervisor agent can call.
 *
 * Every write is append-only. An edit records the previous value before
 * overwriting; a withdrawal sets a flag and can be undone. Nothing here
 * deletes a row, because the audit trail is what makes an automated
 * settlement decision defensible — a claim that vanishes cannot be
 * explained to a regulator, and "the supervisor asked me to" is not an
 * answer.
 *
 * Writes are also gated: `confirm` must be true, so the agent has to
 * state what it is about to do and get a yes before anything changes.
 */

const ROUTES = ['fast', 'std', 'inv']

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_claims',
      description:
        'Find claims matching filters. All filters are optional and combine. Use this for "show me", "which claims", "how many" questions that need the claims themselves rather than just a count.',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string', enum: [...ROUTES, 'all'], description: 'Queue to filter to' },
          minAmount: { type: 'number', description: 'Minimum claim amount in naira' },
          maxAmount: { type: 'number', description: 'Maximum claim amount in naira' },
          minFraud: { type: 'integer', description: 'Minimum fraud score, 0-100' },
          maxFraud: { type: 'integer', description: 'Maximum fraud score, 0-100' },
          claimant: { type: 'string', description: 'Partial claimant name' },
          garage: { type: 'string', description: 'Partial garage name' },
          signal: {
            type: 'string',
            enum: MOTOR.fraudSignals.map((s) => s.id),
            description: 'Only claims where this fraud signal fired',
          },
          overriddenOnly: { type: 'boolean', description: 'Only claims a reviewer has rerouted' },
          includeWithdrawn: { type: 'boolean', description: 'Include withdrawn claims (default false)' },
          limit: { type: 'integer', description: 'Max claims to return, up to 100. Default 20.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_claims',
      description:
        'Group the book and count. Use for "how many per queue", "which garages come up most", "what is the average claim by incident type".',
      parameters: {
        type: 'object',
        properties: {
          groupBy: {
            type: 'string',
            enum: ['route', 'garage', 'incidentType', 'confidence', 'scoredBy'],
            description: 'What to group by',
          },
          includeWithdrawn: { type: 'boolean' },
        },
        required: ['groupBy'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_claim',
      description: 'Full detail for one claim, including its scores, reasoning and decision history.',
      parameters: {
        type: 'object',
        properties: { claimId: { type: 'string' } },
        required: ['claimId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reroute_claim',
      description:
        'Move a claim to a different queue. The original decision is preserved and the change is attributed. Set confirm true only after the supervisor has agreed to the specific change.',
      parameters: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          route: { type: 'string', enum: ROUTES },
          reason: { type: 'string', description: "Why — goes into the audit trail" },
          confirm: { type: 'boolean', description: 'True once the supervisor has confirmed' },
        },
        required: ['claimId', 'route', 'reason', 'confirm'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_claim',
      description: `Correct a field on a claim. The previous value is kept in the audit trail. Editable: ${Object.keys(EDITABLE_FIELDS).join(', ')}. Set confirm true only after the supervisor has agreed.`,
      parameters: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          field: { type: 'string', enum: Object.keys(EDITABLE_FIELDS) },
          value: { type: ['string', 'number'], description: 'The corrected value' },
          reason: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['claimId', 'field', 'value', 'reason', 'confirm'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'withdraw_claim',
      description:
        'Take a claim out of the queue — a duplicate, or one the claimant withdrew. The record is kept and can be restored. This is what "delete" means here; nothing is destroyed. Set confirm true only after the supervisor has agreed.',
      parameters: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          reason: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['claimId', 'reason', 'confirm'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_claim',
      description: 'Put a withdrawn claim back into the queue.',
      parameters: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          reason: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        required: ['claimId', 'confirm'],
        additionalProperties: false,
      },
    },
  },
]

/** Trim a claim to what the agent needs, so a 20-claim result stays readable. */
function brief(c) {
  return {
    id: c.id,
    claimant: c.claimant,
    amount: c.amount,
    route: c.route,
    fraud: c.scores.fraud,
    signals: c.signals,
    withdrawn: Boolean(c.withdrawn),
    overridden: Boolean(c.overridden),
  }
}

/**
 * Build the tools for one session.
 *
 * `actor` is who the audit trail will name. Real auth would supply it;
 * here it is the logged-in supervisor from the dashboard.
 */
export function createTools({ actor = 'supervisor' } = {}) {
  /** Writes refuse until the agent passes confirm. */
  const needsConfirmation = (what) => ({
    applied: false,
    needsConfirmation: true,
    message: `Not done yet. Tell the supervisor exactly this and wait for a yes: "${what}"`,
  })

  return {
    async search_claims(args = {}) {
      const res = searchClaims(args)
      return {
        total: res.total,
        showing: res.returned,
        claims: res.claims.map(brief),
      }
    },

    async count_claims(args = {}) {
      try {
        return { groups: aggregate(args), overall: stats() }
      } catch (err) {
        return { error: err.message }
      }
    },

    async get_claim({ claimId }) {
      const claim = getClaim(claimId)
      if (!claim) return { error: `No claim ${claimId}` }
      return { claim, history: getAudit(claimId) }
    },

    async reroute_claim({ claimId, route, reason, confirm }) {
      const claim = getClaim(claimId)
      if (!claim) return { error: `No claim ${claimId}` }
      if (claim.route === route) {
        return { applied: false, message: `${claimId} is already in that queue.` }
      }
      if (!confirm) {
        return needsConfirmation(
          `Move ${claimId} (${claim.claimant}, fraud ${claim.scores.fraud}) from ${claim.route} to ${route}? Reason: ${reason}`,
        )
      }

      const updated = overrideRoute(claimId, route, actor, reason)
      return {
        applied: true,
        claimId,
        from: claim.route,
        to: updated.route,
        message: `${claimId} moved to ${route}. The original decision is preserved in the audit trail.`,
      }
    },

    async edit_claim({ claimId, field, value, reason, confirm }) {
      const claim = getClaim(claimId)
      if (!claim) return { error: `No claim ${claimId}` }

      const spec = EDITABLE_FIELDS[field]
      if (!spec) {
        return { error: `${field} cannot be edited. Editable: ${Object.keys(EDITABLE_FIELDS).join(', ')}` }
      }

      if (!confirm) {
        const current =
          field === 'amount' || field === 'insuredValue'
            ? `₦${Number(claim[field] ?? claim.amount).toLocaleString('en-NG')}`
            : (claim[field] ?? '—')
        return needsConfirmation(
          `Change the ${spec.label} on ${claimId} from ${current} to ${value}? Reason: ${reason}`,
        )
      }

      try {
        const updated = editClaim(claimId, field, value, actor, reason)
        return {
          applied: true,
          claimId,
          field,
          message: `${spec.label} updated on ${claimId}. The previous value is in the audit trail.`,
          claim: brief(updated),
          note:
            field === 'amount'
              ? 'The amount changed but the claim was not re-scored — its route still reflects the original figure. Mention this.'
              : undefined,
        }
      } catch (err) {
        return { error: err.message }
      }
    },

    async withdraw_claim({ claimId, reason, confirm }) {
      const claim = getClaim(claimId)
      if (!claim) return { error: `No claim ${claimId}` }
      if (claim.withdrawn) {
        return { applied: false, message: `${claimId} was already withdrawn (${claim.withdrawn.reason}).` }
      }
      if (!confirm) {
        return needsConfirmation(
          `Withdraw ${claimId} (${claim.claimant}, ₦${claim.amount.toLocaleString('en-NG')})? It leaves the queue but stays in the record and can be restored. Reason: ${reason}`,
        )
      }

      const res = withdrawClaim(claimId, actor, reason)
      return {
        applied: true,
        claimId,
        message: `${claimId} withdrawn. It is out of the queue but still in the record — say "restore ${claimId}" to undo.`,
      }
    },

    async restore_claim({ claimId, reason = '', confirm }) {
      const claim = getClaim(claimId)
      if (!claim) return { error: `No claim ${claimId}` }
      if (!claim.withdrawn) {
        return { applied: false, message: `${claimId} is not withdrawn.` }
      }
      if (!confirm) {
        return needsConfirmation(`Restore ${claimId} to the queue?`)
      }

      restoreClaim(claimId, actor, reason)
      return { applied: true, claimId, message: `${claimId} is back in the queue.` }
    },
  }
}
