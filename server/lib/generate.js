import { MOTOR } from './config.js'
import { documentationScore, missingDocuments, complexityScore } from './rules.js'

/**
 * Synthetic motor claims.
 *
 * Solves the cold-start problem: there is no historical claims data to
 * work from, so the queue is populated with claims that have realistic
 * shape — a long tail of small clean ones, a middle band needing
 * review, and a small minority carrying deliberate fraud patterns.
 *
 * Names are drawn from a broad spread of Nigerian naming traditions on
 * purpose. The fraud scorer is prohibited from considering them, and a
 * mixed set makes that testable: swap a name, the score must not move.
 */

// Deterministic PRNG so a given seed always yields the same book.
function mulberry32(seed) {
  return function rng() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST = [
  'Adaeze', 'Chinedu', 'Fatima', 'Emeka', 'Blessing', 'Yusuf', 'Ngozi', 'Ibrahim',
  'Chiamaka', 'Oluwaseun', 'Aisha', 'Tunde', 'Amaka', 'Musa', 'Folake', 'Chukwudi',
  'Zainab', 'Bolaji', 'Ifeoma', 'Suleiman', 'Temitope', 'Uche', 'Halima', 'Segun',
  'Chidinma', 'Abubakar', 'Yewande', 'Obinna', 'Maryam', 'Kunle',
]
const LAST = [
  'Okonkwo', 'Balogun', 'Abubakar', 'Nwosu', 'Adeyemi', 'Ibrahim', 'Eze', 'Bello',
  'Okafor', 'Adebayo', 'Mohammed', 'Nwachukwu', 'Ogunleye', 'Sani', 'Chukwu',
  'Oyelaran', 'Danjuma', 'Iheanacho', 'Aliyu', 'Ademola',
]

const VEHICLES = [
  { make: 'Toyota', model: 'Corolla', value: 4_000_000 },
  { make: 'Toyota', model: 'Camry', value: 5_500_000 },
  { make: 'Toyota', model: 'Hilux', value: 12_000_000 },
  { make: 'Honda', model: 'Accord', value: 4_800_000 },
  { make: 'Honda', model: 'CR-V', value: 7_500_000 },
  { make: 'Kia', model: 'Rio', value: 3_200_000 },
  { make: 'Hyundai', model: 'Elantra', value: 3_800_000 },
  { make: 'Lexus', model: 'RX350', value: 14_000_000 },
  { make: 'Mercedes', model: 'C300', value: 16_000_000 },
  { make: 'Nissan', model: 'Almera', value: 3_000_000 },
  { make: 'Ford', model: 'Ranger', value: 9_500_000 },
  { make: 'Peugeot', model: '301', value: 2_800_000 },
]

const GARAGES = [
  'Elite Autoworks Lekki', 'Precision Motors Ikeja', 'Crown Auto Surulere',
  'Summit Garage Wuse', 'Northgate Motors Kano', 'Riverside Auto PH',
  'Apex Panelbeaters Yaba', 'Trustline Motors Enugu',
]

const STATE_CODES = ['LSD', 'ABC', 'KJA', 'EKY', 'GGE', 'AKD', 'FST', 'KNO', 'RVS', 'ENU']

const INCIDENT_TYPES = [
  { id: 'minor_collision', label: 'Minor collision', share: 0.34, band: [60_000, 450_000] },
  { id: 'collision', label: 'Collision', share: 0.28, band: [400_000, 2_200_000] },
  { id: 'windscreen', label: 'Windscreen damage', share: 0.12, band: [55_000, 180_000] },
  { id: 'major_collision', label: 'Major collision', share: 0.14, band: [1_800_000, 5_500_000] },
  { id: 'theft', label: 'Theft', share: 0.07, band: [2_500_000, 9_000_000] },
  { id: 'fire', label: 'Fire damage', share: 0.05, band: [1_500_000, 7_000_000] },
]

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const between = (rng, lo, hi) => Math.floor(lo + rng() * (hi - lo))

function pickIncident(rng) {
  let r = rng()
  for (const t of INCIDENT_TYPES) {
    if (r < t.share) return t
    r -= t.share
  }
  return INCIDENT_TYPES[0]
}

/**
 * One claim. `fraudulent` shapes it toward the patterns the scorer is
 * meant to catch — it is a generation instruction, never stored on the
 * claim and never shown to the scorer.
 */
function makeClaim(rng, i, fraudulent) {
  const v = pick(rng, VEHICLES)
  const year = between(rng, 2012, 2023)
  const age = 2026 - year
  const insuredValue = Math.round(v.value * Math.max(0.45, 1 - age * 0.06))

  const incident = pickIncident(rng)
  let amount = between(rng, incident.band[0], incident.band[1])

  let policyAgeDays = between(rng, 45, 2200)
  let priorClaims = rng() < 0.55 ? 0 : between(rng, 1, 3)
  let priorClaims12m = priorClaims > 0 && rng() < 0.4 ? 1 : 0
  let garageFlaggedCount = rng() < 0.12 ? between(rng, 1, 2) : 0
  let addressMatches = rng() < 0.94
  let documentDateInconsistent = false
  let incidentHour = between(rng, 6, 23)

  // Documentation: most claims are complete, a third are missing something.
  let docs = MOTOR.requiredDocuments.map((d) => d.id)
  if (rng() < 0.34) {
    const drop = between(rng, 1, 3)
    for (let k = 0; k < drop; k++) {
      docs = docs.filter((_, idx) => idx !== between(rng, 0, docs.length))
    }
  }

  if (fraudulent) {
    // Apply two or three patterns, not all of them — real fraud is not
    // maximally suspicious on every axis at once.
    const patterns = ['new_policy', 'inflated', 'garage', 'dates', 'frequency', 'address']
    const chosen = new Set()
    const n = between(rng, 2, 4)
    while (chosen.size < n) chosen.add(pick(rng, patterns))

    if (chosen.has('new_policy')) policyAgeDays = between(rng, 4, 28)
    if (chosen.has('inflated')) amount = Math.round(insuredValue * (0.62 + rng() * 0.28))
    if (chosen.has('garage')) garageFlaggedCount = between(rng, 3, 6)
    if (chosen.has('dates')) documentDateInconsistent = true
    if (chosen.has('frequency')) {
      priorClaims = between(rng, 2, 4)
      priorClaims12m = between(rng, 2, 3)
    }
    if (chosen.has('address')) addressMatches = false
    if (rng() < 0.5) incidentHour = between(rng, 0, 4)
    if (rng() < 0.6) docs = docs.filter((d) => d !== 'vehicle_papers')
  }

  amount = Math.min(amount, insuredValue)

  const missing = missingDocuments(docs)
  const claim = {
    id: `CLM-2401-${String(1000 + i).slice(1)}`,
    claimant: `${pick(rng, FIRST)} ${pick(rng, LAST)}`,
    vehicleMake: v.make,
    vehicleModel: v.model,
    vehicleYear: year,
    plate: `${pick(rng, STATE_CODES)}-${between(rng, 100, 999)}-${String.fromCharCode(65 + between(rng, 0, 26))}${String.fromCharCode(65 + between(rng, 0, 26))}`,
    insuredValue,
    amount,
    incidentType: incident.label,
    incidentHour,
    reportDelayDays: fraudulent && rng() < 0.4 ? between(rng, 8, 30) : between(rng, 0, 5),
    policyAgeDays,
    priorClaims,
    priorClaims12m,
    garage: pick(rng, GARAGES),
    garageFlaggedCount,
    addressMatches,
    documentDateInconsistent,
    thirdPartyInvolved: rng() < 0.38,
    injuryReported: rng() < 0.14,
    totalLoss: incident.id === 'theft' || incident.id === 'fire',
    liabilityDisputed: rng() < 0.11,
    documents: docs,
    missingDocuments: missing.map((d) => d.id),
    submittedAt: new Date(Date.now() - between(rng, 0, 36) * 600_000).toISOString(),
  }

  claim.scores = {
    complexity: complexityScore(claim),
    documentation: documentationScore(docs),
  }
  return claim
}

/**
 * Generate a book of claims.
 * `fraudRate` defaults to 5% — roughly the industry figure, and low
 * enough that the investigation queue stays small the way a real one does.
 */
export function generateClaims({ count = 500, fraudRate = 0.05, seed = 20260830 } = {}) {
  const rng = mulberry32(seed)
  const claims = []
  for (let i = 0; i < count; i++) {
    claims.push(makeClaim(rng, i, rng() < fraudRate))
  }
  return claims
}
