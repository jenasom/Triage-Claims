import { MOTOR } from './config.js'
import * as deepseek from './providers/deepseek.js'
import * as claude from './providers/claude.js'

/**
 * Fraud risk scoring.
 *
 * This is the one place in the pipeline that needs judgment rather
 * than a rule. Everything else — complexity, documentation, routing —
 * is deterministic in rules.js.
 *
 * The scorer returns a score AND the reasoning behind it, because a
 * bare number is not actionable: a claims supervisor has to be able to
 * read why a claim was flagged, disagree, and override.
 *
 * Provider is chosen by SCORING_PROVIDER (deepseek | claude). Both are
 * given the identical prompt from providers/prompt.js, so a difference
 * in output is the models differing, not the instructions.
 *
 * Note on production: with labelled historical claims you would train a
 * gradient-boosted tabular model for this — it scores in milliseconds
 * and costs nothing per call. That data does not exist for this
 * prototype, so a language model reasons over the signals instead. The
 * realistic end state is both: the tabular model for high-frequency
 * scoring, this for the ambiguous middle band where the written
 * justification earns its cost.
 */

const PROVIDERS = { deepseek, claude }
const PREFERRED = process.env.SCORING_PROVIDER ?? 'deepseek'

/**
 * The provider that will actually be used.
 *
 * Falls through to any configured provider if the preferred one has no
 * key, so setting only DEEPSEEK_API_KEY works without also setting
 * SCORING_PROVIDER. Returns null when nothing is configured.
 */
export function activeProvider() {
  const preferred = PROVIDERS[PREFERRED]
  if (preferred?.hasCredentials()) return preferred
  return Object.values(PROVIDERS).find((p) => p.hasCredentials()) ?? null
}

/** True when some provider has credentials to work with. */
export function hasCredentials() {
  return activeProvider() !== null
}

/** Human-readable scoring mode, surfaced at /health and /api/stats. */
export function scoringMode() {
  const p = activeProvider()
  return p ? `${p.id}/${p.model}` : 'rules-fallback'
}

/**
 * Deterministic fallback — sums the weights of signals that fired.
 *
 * Used when no provider is configured, and when a live call fails so
 * one bad request cannot take down a seed run. It is genuinely a
 * fallback, not the product: it produces a defensible number and an
 * assembled sentence, but none of the actual reasoning.
 */
export function scoreWithRules(claim) {
  const fired = []

  if (claim.policyAgeDays < 30) fired.push('new_policy')
  if (claim.amount / claim.insuredValue > 0.6) fired.push('estimate_ratio')
  if (claim.garageFlaggedCount >= 3) fired.push('repeat_garage')
  if (claim.documentDateInconsistent) fired.push('date_inconsistent')
  if (claim.priorClaims12m >= 2) fired.push('claim_frequency')
  if (!claim.addressMatches) fired.push('address_mismatch')
  if (claim.missingDocuments.includes('vehicle_papers')) fired.push('missing_ownership')
  if (claim.incidentHour >= 0 && claim.incidentHour <= 4) fired.push('odd_hours')

  const byId = Object.fromEntries(MOTOR.fraudSignals.map((s) => [s.id, s]))
  const raw = fired.reduce((n, id) => n + (byId[id]?.weight ?? 0), 0)
  const score = Math.min(raw, 100)

  const reasoning = fired.length
    ? `Scored ${score} on ${fired.length} triggered signal${fired.length > 1 ? 's' : ''}: ${fired
        .map((id) => byId[id].label.toLowerCase())
        .join('; ')}. This is a rules-based score — no written assessment was produced because live scoring was unavailable.`
    : `No fraud signals triggered. Policy age ${claim.policyAgeDays} days, ${claim.priorClaims} prior claim(s), documentation ${
        claim.missingDocuments.length ? 'incomplete' : 'complete'
      }. This is a rules-based score — no written assessment was produced because live scoring was unavailable.`

  return {
    score,
    reasoning,
    signals: fired,
    confidence: 'low',
    scoredBy: 'rules-fallback',
    usage: null,
  }
}

/**
 * Score with the active provider, falling back to rules on any failure.
 * One malformed response or rate limit must not abort a 500-claim seed.
 */
export async function scoreClaim(claim, { preferStub = false } = {}) {
  const provider = preferStub ? null : activeProvider()
  if (!provider) return scoreWithRules(claim)

  try {
    return await provider.score(claim)
  } catch (err) {
    const fallback = scoreWithRules(claim)
    fallback.error = err.message
    return fallback
  }
}

/** Per-MTok pricing for whichever provider is active, for cost estimates. */
export function activePricing() {
  return activeProvider()?.pricing ?? null
}
