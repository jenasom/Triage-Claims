/**
 * Motor claim type configuration.
 *
 * Everything claim-type-specific lives here: the document checklist,
 * the routing thresholds, and the fraud signals the engine looks for.
 * Adding a new claim type (health, travel) means adding a sibling file
 * to this one — not editing the engine or any component.
 */

export const MOTOR = {
  id: 'motor',
  label: 'Motor',

  /** Documents required before a claim is considered complete. */
  requiredDocuments: [
    { id: 'police_report',   label: 'Police report',       weight: 25 },
    { id: 'damage_photos',   label: 'Damage photos',       weight: 25 },
    { id: 'drivers_licence', label: "Driver's licence",    weight: 15 },
    { id: 'vehicle_papers',  label: 'Vehicle particulars', weight: 20 },
    { id: 'repair_estimate', label: 'Repair estimate',     weight: 15 },
  ],

  /**
   * Routing thresholds. These are the numbers a claims supervisor
   * should be able to tune without a developer — which is why they
   * are data rather than branches in code.
   */
  routing: {
    /** Naira ceiling for automatic settlement. */
    fastTrackCeiling: 500_000,
    /** Fraud score at or above this always goes to investigation. */
    investigationFraudScore: 55,
    /** Fast-track additionally requires fraud below this... */
    fastTrackMaxFraud: 20,
    /** ...documentation at or above this... */
    fastTrackMinDocs: 100,
    /** ...and complexity below this. */
    fastTrackMaxComplexity: 25,
  },

  /**
   * Fraud signals, each with the weight it contributes to the score.
   * Written out so the reasoning shown to a reviewer can cite them
   * by name rather than producing an unexplained number.
   */
  fraudSignals: [
    { id: 'new_policy',        label: 'Policy age under 30 days at loss',      weight: 22 },
    { id: 'estimate_ratio',    label: 'Estimate high against insured value',   weight: 18 },
    { id: 'repeat_garage',     label: 'Garage repeats across flagged claims',  weight: 16 },
    { id: 'date_inconsistent', label: 'Document dates inconsistent',           weight: 20 },
    { id: 'claim_frequency',   label: 'Multiple claims in a short window',     weight: 18 },
    { id: 'address_mismatch',  label: 'Loss address differs from policy',      weight: 14 },
    { id: 'missing_ownership', label: 'Ownership documents absent',            weight: 12 },
    { id: 'odd_hours',         label: 'Loss reported at unusual hours',        weight: 6 },
  ],

  /**
   * Attributes the fraud score must never consider. Stated explicitly
   * so the exclusion is reviewable rather than implied.
   */
  prohibitedFactors: [
    'name', 'ethnicity', 'religion', 'gender', 'age',
    'residential area beyond documented risk rating',
  ],
}

/** Baseline the "time saved" figures are measured against. */
export const BASELINE = {
  manualTriageHours: 48,
  label: 'assumed 48h manual baseline',
}
