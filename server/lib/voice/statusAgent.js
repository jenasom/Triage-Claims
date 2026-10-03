import { getClaim, getAudit } from '../db.js'
import { claimantView } from '../status.js'
import { MOTOR } from '../config.js'

/**
 * The spoken claim-status agent.
 *
 * A caller rings up and says "I want to check my claim". This agent
 * asks for their reference and surname, looks the claim up, and tells
 * them where it stands — the phone call the status page was built to
 * replace, for the people who will phone anyway.
 *
 * ## The access boundary
 *
 * The typed assistant is constructed around a claim the HTTP layer has
 * already verified, so its tools need no reference parameter. This one
 * cannot work that way: the caller has not identified themselves yet,
 * and identifying them is the agent's first job.
 *
 * So `find_claim` is the only tool available until it succeeds. It
 * performs the same check as POST /api/status/lookup — reference plus a
 * surname that matches the name on the claim — and on success stores
 * the reference in session state that the model cannot address. Every
 * other tool reads that stored reference and refuses while it is unset.
 *
 * The model therefore has no parameter with which to reach a claim it
 * has not unlocked, and no way to enumerate references: a wrong
 * reference and a wrong surname return the same answer, exactly as the
 * HTTP endpoint does.
 *
 * Everything past the boundary is read-only, and passes through
 * `claimantView` first — so fraud scores and analyst reasoning are
 * stripped before they could ever reach a text-to-speech engine.
 */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'find_claim',
      description:
        'Look up the caller\'s claim using their claim reference and their surname. Both are required and both must match. Call this first — no other tool will work until it succeeds. If it fails, tell them you could not find it and ask them to read the reference back to you.',
      parameters: {
        type: 'object',
        properties: {
          reference: {
            type: 'string',
            description:
              'The claim reference, for example CLM-2401-0026. Accept it however they say it and pass it as they gave it.',
          },
          surname: {
            type: 'string',
            description: 'The surname on the claim.',
          },
        },
        required: ['reference', 'surname'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description:
        "The claim's current state: stage, what happens next, and whether anything is needed from the caller. Use for almost any question once the claim is found.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_outstanding',
      description:
        'What the caller still needs to supply, and what has already been received. Use when they ask what is missing or why the claim has not moved.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_history',
      description:
        'What has happened on the claim so far, oldest first. Use when they ask why it is taking time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_uploads',
      description:
        'Take the caller to the upload controls on their screen. Call this as soon as they say they want to send a document, have it ready, or ask where to put it — it moves the page for them so they do not have to find it. Optionally name the one document to start with.',
      parameters: {
        type: 'object',
        properties: {
          documentType: {
            type: 'string',
            enum: MOTOR.requiredDocuments.map((d) => d.id),
            description:
              'The document they are about to send, if they said which. Highlights that one on screen.',
          },
        },
        additionalProperties: false,
      },
    },
  },
]

/** Loose surname match — callers do not say their name the way it is filed. */
function nameMatches(fullName, given) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '')
  return String(fullName)
    .split(/\s+/)
    .map(norm)
    .filter(Boolean)
    .includes(norm(given))
}

/**
 * Normalise a spoken reference.
 *
 * Speech-to-text renders "CLM two four zero one, double oh two six" in
 * every imaginable way. Rather than demand the caller spell it, strip
 * everything that is not a letter or digit and rebuild the canonical
 * form. "clm24010026", "CLM 2401 0026" and "clm-2401-0026" all resolve
 * to the same claim.
 */
function normaliseReference(spoken) {
  const bare = String(spoken).toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = /^CLM(\d{4})(\d+)$/.exec(bare)
  if (m) return `CLM-${m[1]}-${m[2]}`
  return String(spoken).trim().toUpperCase()
}

/**
 * Tools for one spoken status call.
 *
 * `state` is closed over, not passed to the model. Unlocking it is the
 * only thing find_claim does, and nothing the caller says can set it
 * directly.
 */
export function createStatusTools(state, { onFound, onSearching, onOpenUploads } = {}) {
  const load = () => {
    if (!state.reference) return null
    const claim = getClaim(state.reference)
    return claim ? claimantView(claim, getAudit(state.reference)) : null
  }

  const locked = {
    error:
      'No claim has been unlocked yet. Ask the caller for their claim reference and surname, then call find_claim.',
  }

  return {
    async find_claim(args) {
      const { reference, surname } = args ?? {}
      if (!reference || !surname) {
        return { found: false, reason: 'Both the claim reference and the surname are needed.' }
      }

      const id = normaliseReference(reference)

      /**
       * Tell the page a lookup is underway before doing it.
       *
       * The caller has just finished speaking their reference and is
       * waiting. Without this the screen sits unchanged and then the
       * whole claim appears at once, which reads as a glitch rather
       * than as an answer to what they asked.
       *
       * Only the reference goes out — it is what the caller just said
       * aloud, and nothing about the claim is known to be theirs yet.
       */
      onSearching?.({ reference: id })

      const claim = getClaim(id)

      // Wrong reference and wrong surname answer identically, so the
      // call cannot be used to discover which references exist.
      if (!claim || !nameMatches(claim.claimant, surname)) {
        // Clears the searching state — otherwise the page spins
        // forever on a reference that will never resolve.
        onSearching?.({ reference: id, failed: true })
        return {
          found: false,
          reason:
            'No claim matches that reference and surname. Ask them to read the reference back, and check the surname is the one on the policy.',
        }
      }

      state.reference = claim.id
      const v = claimantView(claim, getAudit(claim.id))
      onFound?.(v)

      return {
        found: true,
        reference: v.reference,
        claimant: v.claimant,
        stage: v.stage,
        whatItMeans: v.detail,
        outstanding: v.outstanding.map((o) => o.label),
        submitted: v.submittedAgo,
        say: `Tell them you have found the claim and give them the stage in one sentence. Do not read the reference back unless they ask.`,
      }
    },

    async get_status() {
      const v = load()
      if (!v) return locked

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
            : 'None — nothing is needed from them right now',
        vehicle: v.vehicle,
        amount: v.amount,
      }
    },

    async list_outstanding() {
      const v = load()
      if (!v) return locked

      const received = MOTOR.requiredDocuments
        .filter((d) => !v.outstanding.some((o) => o.id === d.id))
        .map((d) => d.label)

      return {
        outstanding: v.outstanding.map((o) => o.label),
        received,
        complete: v.outstanding.length === 0,
        howToSupply:
          v.outstanding.length > 0
            ? 'They can upload each one on this page — there is an upload button beside every outstanding document. Mention one or two, not the whole list.'
            : null,
      }
    },

    async get_history() {
      const v = load()
      if (!v) return locked
      return {
        events: v.timeline.map((e) => ({ what: e.title, detail: e.detail, when: e.when })),
        submitted: v.submittedAgo,
      }
    },

    /**
     * Move the caller's page to the upload controls.
     *
     * The one tool here that acts on the screen rather than reading
     * data. It still changes nothing about the claim — the upload
     * itself goes through the ordinary authenticated endpoint, with
     * the same extraction and confirmation as any other. This only
     * saves the caller hunting for the button while holding a phone
     * to their ear.
     */
    async open_uploads(args) {
      const v = load()
      if (!v) return locked

      if (v.outstanding.length === 0) {
        return {
          opened: false,
          reason:
            'Nothing is outstanding on this claim — there is nothing for them to upload. Tell them so rather than sending them to the upload section.',
        }
      }

      const requested = args?.documentType
      const target = v.outstanding.find((o) => o.id === requested) ?? null

      // A document they named that is not actually outstanding is
      // worth saying out loud — they may be about to send the wrong
      // thing, or we may have it already.
      if (requested && !target) {
        return {
          opened: false,
          reason: `The ${requested.replace(/_/g, ' ')} is not outstanding on this claim — it has already been received. Still outstanding: ${v.outstanding.map((o) => o.label).join(', ')}.`,
        }
      }

      onOpenUploads?.({ documentType: target?.id ?? null })

      return {
        opened: true,
        highlighted: target?.label ?? null,
        outstanding: v.outstanding.map((o) => o.label),
        say: target
          ? `Their screen is now showing the upload section with ${target.label} highlighted. Tell them briefly that it is on screen and they can take a photo or attach a file.`
          : `Their screen is now showing the upload section. Tell them briefly that it is on screen, and name what is outstanding.`,
      }
    },
  }
}

/**
 * The spoken prompt.
 *
 * Shorter and blunter than the typed assistant's. A caller cannot
 * re-read a sentence, and will not sit through a list of five
 * outstanding documents read aloud.
 */
export function buildStatusPrompt() {
  return `You are the claims assistant for Clearing, a motor insurance service in Nigeria. You are speaking with a customer out loud, and they can only hear you.

## First, find their claim

You cannot see any claim until you look one up. Ask for their claim reference and their surname — one at a time, not both in one breath.

References sound like "C-L-M two four zero one, zero zero two six". Take it however they say it and pass it straight to find_claim; do not make them spell it out unless the lookup fails.

If find_claim fails, say you could not find it, and ask them to read the reference back slowly. Do not guess at a reference, and never try variations of one to see what exists.

## Once you have found it

Lead with the answer. "Your claim is with an assessor" — then one detail if it helps.

One or two sentences per reply. This is a phone call, not a letter.

If something is outstanding, name one or two things, not the whole list.

## Sending a document

The moment they say they want to send something — "I have the estimate here", "can I upload it now", "where do I put it" — call open_uploads. It moves their screen to the upload controls so they do not have to hunt for a button while holding a phone to their ear.

Call it first, then tell them it is on screen. Do not describe where to find the button; move them there instead.

If they name the document, pass it so that one is highlighted.

Stay on the line while they upload. When it lands you will be told; acknowledge it briefly and say what is left.

If nothing is needed from them, say so plainly: "There is nothing for you to do right now." That sentence is why they called.

Look it up before you answer — call get_status, list_outstanding or get_history. Never answer about the claim from memory.

Say money the way a person says it: "four hundred and fifty thousand naira", not "450000".

## What you must not do

Never promise a date. "Usually within a few working days" is honest; "by Friday" is not.

Never say whether the claim will be paid, or how much. An assessor decides that.

Never discuss fraud, risk scores, or why a claim was routed a particular way. If they ask why it is under review, say some claims need additional checks before assessment and that this is routine — because it is.

Never invent a step that has not happened.

If they ask something you cannot see — a payment date, a policy question — say plainly that you do not have it and that the claims team can help.

If they are upset, acknowledge it once, then give them the facts.`
}

export const STATUS_GREETING =
  'Hello, this is Clearing. I can check your motor claim for you — could I take your claim reference?'
