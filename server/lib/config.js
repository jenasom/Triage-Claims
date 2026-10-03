/**
 * Motor claim type configuration — the server's copy.
 *
 * Mirrors app/src/data/motorConfig.js. The two are kept in sync by
 * hand for now; if a third consumer appears, promote this to a shared
 * package rather than adding a third copy.
 *
 * Everything a claims supervisor should be able to tune without a
 * developer lives here: the document checklist, the routing
 * thresholds, and the fraud signals the engine reasons about.
 */

export const MOTOR = {
  id: 'motor',
  label: 'Motor',

  /**
   * Incident types the scoring model has seen.
   *
   * Staff intake offers exactly these rather than a free-text box: a
   * claim typed in as "bashed at Oshodi" scores against a category the
   * model has no calibration for, and the officer taking it down has
   * no way of knowing that.
   */
  incidentTypes: [
    'Minor collision',
    'Collision',
    'Major collision',
    'Windscreen damage',
    'Theft',
    'Fire damage',
  ],

  requiredDocuments: [
    { id: 'police_report', label: 'Police report', weight: 25 },
    { id: 'damage_photos', label: 'Damage photos', weight: 25 },
    { id: 'drivers_licence', label: "Driver's licence", weight: 15 },
    { id: 'vehicle_papers', label: 'Vehicle particulars', weight: 20 },
    { id: 'repair_estimate', label: 'Repair estimate', weight: 15 },
  ],

  routing: {
    fastTrackCeiling: 500_000,
    /**
     * Set at 55 rather than 65 after reviewing a scored book: claims
     * carrying three or more corroborating signals were clustering at
     * 60-62 and falling just short of referral. 55 puts referrals at
     * ~1.6% of volume, in line with the fraud rate this book is
     * generated at.
     */
    investigationFraudScore: 55,
    fastTrackMaxFraud: 20,
    fastTrackMinDocs: 100,
    fastTrackMaxComplexity: 25,
  },

  /**
   * Fraud signals. `weight` is what a triggered signal contributes to
   * the deterministic stub score; the Claude scorer receives these as
   * the vocabulary it must reason within, so its justification cites
   * named signals rather than inventing its own.
   */
  fraudSignals: [
    { id: 'new_policy', label: 'Policy age under 30 days at loss', weight: 22 },
    { id: 'estimate_ratio', label: 'Estimate high against insured value', weight: 18 },
    { id: 'repeat_garage', label: 'Garage repeats across flagged claims', weight: 16 },
    { id: 'date_inconsistent', label: 'Document dates inconsistent', weight: 20 },
    { id: 'claim_frequency', label: 'Multiple claims in a short window', weight: 18 },
    { id: 'address_mismatch', label: 'Loss address differs from policy', weight: 14 },
    { id: 'missing_ownership', label: 'Ownership documents absent', weight: 12 },
    { id: 'odd_hours', label: 'Loss reported at unusual hours', weight: 6 },
  ],

  /**
   * Attributes the fraud score must never consider. Passed to the
   * model as an explicit prohibition and stated in the API's own
   * /api/config response so the exclusion is externally reviewable.
   */
  prohibitedFactors: [
    'name',
    'ethnicity',
    'religion',
    'gender',
    'age',
    'residential area beyond documented risk rating',
  ],
}

export const BASELINE = {
  manualTriageHours: 48,
  label: 'assumed 48h manual baseline',
}

/** Complexity drivers, weighted. Deterministic — no model involved. */
export const COMPLEXITY_FACTORS = [
  { id: 'high_value', label: 'High claim value', weight: 30 },
  { id: 'third_party', label: 'Third party involved', weight: 20 },
  { id: 'injury', label: 'Injury reported', weight: 25 },
  { id: 'total_loss', label: 'Total loss or theft', weight: 15 },
  { id: 'disputed_liability', label: 'Liability disputed', weight: 10 },
]
