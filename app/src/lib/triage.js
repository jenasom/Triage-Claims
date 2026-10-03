import { MOTOR } from '../data/motorConfig'

/**
 * Routing decision.
 *
 * Deliberately deterministic and readable: given the three scores and
 * the claim amount, this returns the route plus the rule that decided
 * it. The rule string is what the audit trail records — "the model
 * said so" is not an acceptable answer for an automated settlement.
 *
 * In the full system the fraud score arrives from the scoring service;
 * the routing rules stay exactly as they are here.
 */
export function route({ amount, complexity, documentation, fraud }, cfg = MOTOR) {
  const r = cfg.routing

  if (fraud >= r.investigationFraudScore) {
    return { route: 'inv', rule: `Fraud score ${fraud} at or above investigation threshold ${r.investigationFraudScore}` }
  }

  if (
    amount <= r.fastTrackCeiling &&
    fraud < r.fastTrackMaxFraud &&
    documentation >= r.fastTrackMinDocs &&
    complexity < r.fastTrackMaxComplexity
  ) {
    return { route: 'fast', rule: `Under ₦${r.fastTrackCeiling.toLocaleString('en-NG')}, documents complete, fraud ${fraud} below ${r.fastTrackMaxFraud}` }
  }

  if (amount > r.fastTrackCeiling) {
    return { route: 'std', rule: `Amount above ₦${r.fastTrackCeiling.toLocaleString('en-NG')} fast-track ceiling` }
  }
  if (documentation < r.fastTrackMinDocs) {
    return { route: 'std', rule: `Documentation ${documentation}% below the ${r.fastTrackMinDocs}% required for fast-track` }
  }
  return { route: 'std', rule: 'Complexity or risk above fast-track band' }
}

/** Documentation completeness from a set of supplied document ids. */
export function documentationScore(suppliedIds, cfg = MOTOR) {
  const total = cfg.requiredDocuments.reduce((n, d) => n + d.weight, 0)
  const have = cfg.requiredDocuments
    .filter((d) => suppliedIds.includes(d.id))
    .reduce((n, d) => n + d.weight, 0)
  return Math.round((have / total) * 100)
}

export const ROUTE_LABEL = {
  fast: 'Fast-Track',
  std: 'Standard Review',
  inv: 'Investigation',
}

export const ROUTE_ACTION = {
  fast: 'Approve settlement',
  std: 'Assign assessor',
  inv: 'Assign to fraud unit',
}

/** Score band, used for the meter colour. */
export function band(v) {
  return v < 34 ? 'lo' : v < 67 ? 'md' : 'hi'
}

export const naira = (n) => `₦${n.toLocaleString('en-NG')}`
