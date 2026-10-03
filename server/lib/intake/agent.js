import OpenAI from 'openai'
import { TOOL_SCHEMAS, createTools } from './tools.js'
import { MOTOR } from '../config.js'

/**
 * The intake agent.
 *
 * Runs a tool-use loop: the model decides what to ask, what to read,
 * and when the claim is ready. It cannot decide a claim is complete —
 * `submit_claim` refuses while validation reports blocking issues, so
 * the rules stay authoritative and the agent only handles the
 * conversation.
 *
 * Deliberately not a state machine. A claimant who answers three
 * questions in one sentence, uploads two documents at once, or corrects
 * something they said earlier would break a fixed flow; the agent
 * handles all three by re-checking after every turn.
 */

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

/** Guard against a loop that never converges. */
const MAX_STEPS = 8

/**
 * Today, in Lagos.
 *
 * Claimants speak in relative dates — "yesterday", "last Tuesday",
 * "about two weeks ago". Without a reference date the agent has to ask
 * them to convert it themselves, which is both annoying and the kind
 * of friction that makes people abandon a claim.
 *
 * Africa/Lagos rather than the server's zone: a claim filed at 00:30
 * Lagos time should resolve "yesterday" against the claimant's
 * calendar, not the host's.
 */
function today(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const iso = fmt.format(now) // en-CA gives YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
  }).format(now)
  return { iso, weekday }
}

/**
 * The system prompt, stamped with the current date.
 *
 * Built per session rather than at module load — a long-running server
 * would otherwise be permanently stuck on the date it booted.
 */
function buildSystem(now = new Date()) {
  const { iso, weekday } = today(now)

  return `You are the claims intake assistant for Clearing, a motor insurance claims service. You help a customer submit a motor insurance claim, over chat, on their phone.

Your job is to get their claim complete and consistent, then submit it. You are not assessing the claim — you never decide whether it will be paid, and you never speculate about fraud.

## Today

Today is ${weekday}, ${iso}. All times are West Africa Time (Lagos).

Work out relative dates yourself and confirm what you understood — never ask the customer to do the arithmetic:
- "yesterday" → the day before ${iso}
- "last Tuesday" → the most recent Tuesday before today
- "about two weeks ago" → roughly 14 days before today; give them the date you assumed and let them correct it

Say the date back when you record it: "So that's Tuesday 2 September — is that right?" A claimant who misremembers the day will catch it there, and an incident date that is wrong by a week changes how the claim is assessed.

If they give a date in the future, or more than a year ago, say so plainly and ask them to confirm.

## How to work

Call \`check_claim\` after anything changes, so you always know what is actually outstanding rather than guessing.

Call \`record_details\` the moment the customer tells you something — do not collect answers and save them at the end.

When they upload a document, call \`read_document\` straight away.

When \`check_claim\` reports nothing blocking, call \`submit_claim\`.

## When the customer cannot finish now

A customer often does not have everything to hand — the repair estimate is still at the garage, the police report has not been collected. They should not have to start again later.

If they say they cannot supply something now, or ask to finish later, or are clearly stuck on one item, offer to lodge the claim as it stands: their reference is issued immediately and they can add the rest whenever they have it. If they accept, call \`submit_claim\` with \`provisional: true\`.

Offer this — do not push it. Ask for what is missing first; a customer who simply has not answered yet is not stuck. Never use it to escape a question they can answer.

Two things to be straight about when a claim is lodged this way:
- Their reference is real and their claim is saved.
- It is not being assessed yet, and will not be until the outstanding items arrive.

Tell them exactly what is still needed and that they can supply it from their claim status page using their reference and surname.

\`check_claim\` separates \`outstanding\` (things not supplied yet, which can wait) from \`contradictions\` (things already supplied that disagree with each other — a repair estimate showing a different figure from the one they gave, a document dated before the incident). Contradictions can never be deferred and \`submit_claim\` will refuse them however it is called. Resolve those by asking which is correct.

## How to talk

Ask for **one thing at a time**. A list of six requirements makes people abandon the form.

Lead with what you need, not with process. "What is your vehicle's registration number?" — not "In order to proceed I will now require the registration."

Be specific about problems. "Your police report is dated 3 March but you said the accident was on 5 March — which is right?" is actionable. "There is an inconsistency" is not.

When a document cannot be read, say what to do about it: better light, whole document in frame, flatten the page.

Never blame the customer for a system failure. If extraction fails, apologise and ask them to try again.

Acknowledge what they have given you before asking for the next thing, so progress feels visible.

Keep messages to two or three sentences. This is a phone screen.

Do not restate the entire outstanding list every turn — they can see their progress.

## Boundaries

Only ask for what the claim needs: ${MOTOR.requiredDocuments.map((d) => d.label.toLowerCase()).join(', ')}, plus the incident details.

Never invent a document field. If \`read_document\` did not return something, it was not visible — ask the customer.

Never tell the customer their claim has been submitted unless \`submit_claim\` returned submitted: true.

If a customer asks whether their claim will be approved, say honestly that you handle intake and an assessor makes that decision.`
}

let client = null
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: BASE_URL })
  }
  return client
}

export const hasCredentials = () => Boolean(process.env.DEEPSEEK_API_KEY)
export const agentModel = MODEL

/** A fresh session. This is the claim record the agent builds. */
export function createSession(id) {
  const now = new Date()
  return {
    id,
    createdAt: now.toISOString(),
    claim: {},
    extracted: {},
    uploads: {},
    // Stamped now, so the agent knows what "yesterday" means.
    messages: [{ role: 'system', content: buildSystem(now) }],
    submitted: null,
  }
}

/** Exposed for the health check and for tests. */
export const currentDate = () => today()

/**
 * Advance the conversation by one customer turn.
 *
 * Returns the assistant's reply plus a trace of the tools it called —
 * the trace is what makes the agent inspectable rather than a black
 * box, and the UI shows it.
 */
export async function runTurn(session, userMessage, { onSubmit } = {}) {
  const tools = createTools(session, { onSubmit })

  /**
   * A session continuing an existing claim cannot submit.
   *
   * The claim is already in the book with a reference the claimant has
   * been given; submitting would file a second one. Enforced by
   * removing the tool rather than by telling the agent not to use it —
   * withheld from the schemas so it is never offered, and deleted from
   * the executable set so a model that invents the call still cannot
   * reach it.
   */
  const continuing = Boolean(session.continuing)
  if (continuing) delete tools.submit_claim

  const schemas = continuing
    ? TOOL_SCHEMAS.filter((t) => t.function.name !== 'submit_claim')
    : TOOL_SCHEMAS

  if (userMessage) {
    session.messages.push({ role: 'user', content: userMessage })
  }

  const trace = []

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1200,
      tools: schemas,
      messages: session.messages,
    })

    const choice = res.choices?.[0]
    const msg = choice?.message
    if (!msg) throw new Error('Agent returned no message')

    session.messages.push(msg)

    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      return {
        reply: msg.content ?? '',
        trace,
        session,
        usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
      }
    }

    for (const call of calls) {
      const name = call.function?.name
      let args = {}
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        // A malformed tool call is the model's error to recover from,
        // not a crash — hand the parse failure back and let it retry.
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Arguments were not valid JSON. Try again.' }),
        })
        trace.push({ tool: name, error: 'invalid arguments' })
        continue
      }

      const fn = tools[name]
      const result = fn
        ? await fn(args)
        : { error: `Unknown tool ${name}` }

      trace.push({ tool: name, args, result })
      session.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  // Ran out of steps — say so rather than returning silence.
  return {
    reply:
      'I am having trouble processing that. Could you tell me again what you would like to do?',
    trace,
    session,
    exhausted: true,
  }
}

/** The opening message, before the customer has said anything. */
export async function greet(session) {
  return runTurn(
    session,
    'I want to make a claim on my motor policy.',
  )
}
