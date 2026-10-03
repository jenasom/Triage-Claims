import { MOTOR, COMPLEXITY_FACTORS } from './config.js'

/**
 * Deterministic scoring and routing.
 *
 * Nothing here calls a model. Complexity, documentation completeness
 * and the routing decision are rules, which makes them fast, free,
 * reproducible, and explainable in a regulatory review. Only the
 * fraud score needs judgment — see score.js.
 */

/** Documentation completeness, 0–100, weighted by document importance. */
export function documentationScore(suppliedIds, cfg = MOTOR) {
  const total = cfg.requiredDocuments.reduce((n, d) => n + d.weight, 0)
  const have = cfg.requiredDocuments
    .filter((d) => suppliedIds.includes(d.id))
    .reduce((n, d) => n + d.weight, 0)
  return Math.round((have / total) * 100)
}

/** Which required documents are still outstanding. */
export function missingDocuments(suppliedIds, cfg = MOTOR) {
  return cfg.requiredDocuments.filter((d) => !suppliedIds.includes(d.id))
}

/**
 * Complexity, 0–100. Claim amount contributes on a curve rather than a
 * step, so a ₦600k claim is not treated the same as a ₦6m one.
 */
export function complexityScore(claim, cfg = MOTOR) {
  const amountShare = Math.min(claim.amount / 5_000_000, 1)
  let score = amountShare * COMPLEXITY_FACTORS[0].weight

  if (claim.thirdPartyInvolved) score += COMPLEXITY_FACTORS[1].weight
  if (claim.injuryReported) score += COMPLEXITY_FACTORS[2].weight
  if (claim.totalLoss) score += COMPLEXITY_FACTORS[3].weight
  if (claim.liabilityDisputed) score += COMPLEXITY_FACTORS[4].weight

  return Math.min(Math.round(score), 100)
}

/**
 * Routing decision.
 *
 * Returns the route AND the rule that produced it. The rule string is
 * what the audit trail records — for an automated settlement decision,
 * "the model said so" is not an acceptable answer to a regulator.
 *
 * Order matters: the investigation check runs first so a high fraud
 * score can never be overridden by a low amount.
 */
export function route({ amount, complexity, documentation, fraud }, cfg = MOTOR) {
  const r = cfg.routing
  const ceiling = `₦${r.fastTrackCeiling.toLocaleString('en-NG')}`

  if (fraud >= r.investigationFraudScore) {
    return {
      route: 'inv',
      rule: `Fraud score ${fraud} at or above investigation threshold ${r.investigationFraudScore}`,
    }
  }

  if (
    amount <= r.fastTrackCeiling &&
    fraud < r.fastTrackMaxFraud &&
    documentation >= r.fastTrackMinDocs &&
    complexity < r.fastTrackMaxComplexity
  ) {
    return {
      route: 'fast',
      rule: `Under ${ceiling}, documents complete, fraud ${fraud} below ${r.fastTrackMaxFraud}`,
    }
  }

  if (amount > r.fastTrackCeiling) {
    return { route: 'std', rule: `Amount above ${ceiling} fast-track ceiling` }
  }
  if (documentation < r.fastTrackMinDocs) {
    return {
      route: 'std',
      rule: `Documentation ${documentation}% below the ${r.fastTrackMinDocs}% required for fast-track`,
    }
  }
  if (complexity >= r.fastTrackMaxComplexity) {
    return {
      route: 'std',
      rule: `Complexity ${complexity} at or above the fast-track limit of ${r.fastTrackMaxComplexity}`,
    }
  }
  return {
    route: 'std',
    rule: `Fraud score ${fraud} above the fast-track limit of ${r.fastTrackMaxFraud}`,
  }
}

export const ROUTE_LABEL = {
  fast: 'Fast-Track',
  std: 'Standard Review',
  inv: 'Investigation',
}
