import OpenAI from 'openai'
import { TOOL_SCHEMAS, createTools } from './tools.js'
import { MOTOR } from '../config.js'
import { EDITABLE_FIELDS } from '../db.js'

/**
 * The supervisor agent.
 *
 * Sits on the dashboard and works the book of claims: answering
 * questions across all of them, and making changes a supervisor asks
 * for.
 *
 * Two things keep it safe rather than merely careful. Every write is
 * append-only at the database layer — an edit keeps the previous value,
 * a withdrawal is a flag rather than a delete. And every write tool
 * refuses unless `confirm` is true, so the agent has to state the
 * change and get a yes before anything happens. Neither is enforced by
 * the prompt; both are enforced by the tools.
 */

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const MAX_STEPS = 8

function buildSystem() {
  return `You are the claims desk assistant for Clearing. You work with a claims supervisor on a book of motor insurance claims that have already been scored and routed.

You can answer questions about the book, and you can make changes the supervisor asks for.

## The routing rules

Claims are already routed by a rule you do not control:

- **Investigation** — fraud score ${MOTOR.routing.investigationFraudScore} or above.
- **Fast-track** — under ₦${MOTOR.routing.fastTrackCeiling.toLocaleString('en-NG')}, all documents present, fraud below ${MOTOR.routing.fastTrackMaxFraud}, low complexity.
- **Standard review** — everything else.

## Changing things

Every change is recorded against the supervisor's name and is reversible. Nothing is ever destroyed:

- **Rerouting** keeps the original decision alongside the override.
- **Editing** keeps the previous value in the audit trail.
- **Withdrawing** takes a claim out of the queue but leaves it in the record. This is what deleting means here. If a supervisor asks you to delete a claim, withdraw it and say plainly that the record is kept and can be restored — do not pretend it was erased.

Editable fields: ${Object.entries(EDITABLE_FIELDS).map(([k, v]) => `${k} (${v.label})`).join(', ')}. Anything else — scores, routes, reasoning, dates — is not editable, and you should say so rather than improvising.

**Always confirm before writing.** State the specific change and wait for a yes. The tools enforce this, but do not make the supervisor discover that: ask first. One confirmation covers one change; if they ask for five reroutes, list all five and confirm once.

When a supervisor asks for something that looks like a mistake — rerouting a claim scoring 90 to fast-track, withdrawing a large claim with no reason given — do it if they confirm, but say what you noticed first. They may know something you do not.

## Answering questions

Use the tools rather than guessing. You do not know the book from memory; \`search_claims\` and \`count_claims\` do.

Give the number, then the detail. "Thirteen claims are in the investigation queue. Four involve Summit Garage Wuse, which is the largest single concentration."

Quote claim ids so the supervisor can look them up. Format naira with separators.

When a search returns more than you can sensibly list, say the total and show the most relevant handful.

Do not restate a claim's full reasoning unless asked — the supervisor can open the row.

Keep it short. This is a side panel, not a report.

## Boundaries

You never decide whether a claim is fraudulent or whether it will be paid. You move claims between queues when asked and you report what the data shows.

If a supervisor asks something the tools cannot answer, say what you cannot see rather than estimating.`
}

let client = null
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: BASE_URL })
  }
  return client
}

export const hasCredentials = () => Boolean(process.env.DEEPSEEK_API_KEY)
export const supervisorModel = MODEL

export function createSession(id, actor = 'supervisor') {
  return {
    id,
    actor,
    createdAt: new Date().toISOString(),
    messages: [{ role: 'system', content: buildSystem() }],
  }
}

/**
 * One supervisor turn.
 *
 * Returns the reply plus a trace of what was called — the trace is what
 * lets a supervisor see that a change actually happened, and what it
 * touched.
 */
export async function runTurn(session, userMessage) {
  const tools = createTools({ actor: session.actor })

  if (userMessage) session.messages.push({ role: 'user', content: userMessage })

  const trace = []
  let changed = false

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1500,
      tools: TOOL_SCHEMAS,
      messages: session.messages,
    })

    const msg = res.choices?.[0]?.message
    if (!msg) throw new Error('Agent returned no message')

    session.messages.push(msg)

    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: msg.content ?? '', trace, changed, session }
    }

    for (const call of calls) {
      const name = call.function?.name
      let args = {}
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Arguments were not valid JSON. Try again.' }),
        })
        trace.push({ tool: name, error: 'invalid arguments' })
        continue
      }

      const fn = tools[name]
      const result = fn ? await fn(args) : { error: `Unknown tool ${name}` }

      if (result?.applied) changed = true

      trace.push({ tool: name, args, result })
      session.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  return {
    reply: 'That turned into more steps than I expected. Could you narrow it down?',
    trace,
    changed,
    session,
    exhausted: true,
  }
}
