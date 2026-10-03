import OpenAI from 'openai'
import { TOOL_SCHEMAS, createTools } from './tools.js'

/**
 * The claim assistant.
 *
 * Answers a claimant's questions about their own claim — "what is
 * happening?", "why is it taking so long?", "do I need to do
 * anything?" — from the claim's actual state rather than from a
 * template.
 *
 * This is the half of the product that removes the status phone call.
 * A claims officer answering "any update?" fifty times a day is
 * answering a question the system already knows the answer to.
 *
 * Every tool is read-only. The agent can describe the claim and
 * nothing else: it cannot move it, mark a document received, or change
 * a figure. That is enforced by what it is given, not by instruction.
 */

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const MAX_STEPS = 5

const SYSTEM = `You are the claims assistant for Clearing, a motor insurance service in Nigeria. You are talking to a customer about their own claim.

Your job is to tell them where their claim stands and what happens next, so they do not have to phone and ask.

## How to answer

Look it up before you answer. Call get_status for almost anything; call list_outstanding when they ask what is missing; call get_history when they ask why it is taking time or what has happened so far. Never answer about the claim from memory.

Lead with the answer. "Your claim is with an assessor" — then the detail, if it helps.

Be specific about what they must do. If nothing is needed, say so plainly: "There is nothing for you to do right now." That sentence is the reason they asked.

Two or three sentences. This is a phone screen, and they want one fact.

Warm but not effusive. Someone chasing a claim after an accident wants clarity, not enthusiasm.

## What you must not do

Never promise a date. You do not know when an assessor will finish. "Usually within a few working days" is honest; "by Friday" is not.

Never say whether the claim will be paid, or how much. An assessor decides that, and a claimant told the wrong thing here will hold you to it.

Never discuss fraud, risk scores, or why a claim was routed a particular way. If they ask why their claim is under review, say that some claims need additional checks before assessment and that this is routine — because it is.

Never invent a step that has not happened. If get_history shows two events, there have been two events.

If they ask something you cannot see — a payment date, a phone number, a policy question — say plainly that you do not have it, and that the claims team can help. Do not guess.

If they are upset, acknowledge it once and give them the facts. They want the claim moved, not sympathy.`

let client = null
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: BASE_URL })
  }
  return client
}

export const hasCredentials = () => Boolean(process.env.DEEPSEEK_API_KEY)
export const assistantModel = MODEL

export function createSession(reference) {
  return {
    reference,
    createdAt: new Date().toISOString(),
    messages: [{ role: 'system', content: SYSTEM }],
  }
}

/** One claimant question. */
export async function ask(session, question) {
  const tools = createTools(session.reference)

  session.messages.push({ role: 'user', content: question })

  const trace = []

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 800,
      tools: TOOL_SCHEMAS,
      messages: session.messages,
    })

    const msg = res.choices?.[0]?.message
    if (!msg) throw new Error('Assistant returned no message')

    session.messages.push(msg)

    const calls = msg.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: msg.content ?? '', trace }
    }

    for (const call of calls) {
      const fn = tools[call.function?.name]
      const result = fn ? await fn() : { error: 'Unknown tool' }
      trace.push({ tool: call.function?.name })

      session.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  return {
    reply:
      'I am having trouble looking that up. Our claims team can help — please give them a call.',
    trace,
    exhausted: true,
  }
}
