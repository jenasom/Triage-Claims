import WebSocket from 'ws'
import { TOOL_SCHEMAS, createTools } from '../intake/tools.js'
import { validateIntake } from '../intake/validate.js'
import { MOTOR } from '../config.js'

/**
 * Deepgram Voice Agent bridge.
 *
 * Deepgram runs the conversation loop — listening, thinking, speaking —
 * over one WebSocket. What it does not run is our claim logic: the four
 * intake tools are declared `client_side: true`, so Deepgram asks this
 * server to execute them and we answer with the result.
 *
 * That distinction is the whole design. A voice agent that thinks on
 * its own would decide for itself whether a claim is complete;
 * `submit_claim` refuses while validation reports blocking issues, and
 * routing that decision through our tools keeps the refusal enforceable
 * rather than a matter of prompting.
 *
 * The socket lives here rather than in the browser so the API key is
 * never shipped to a client.
 *
 * https://developers.deepgram.com/reference/voice-agent/voice-agent
 */

const AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse'
const LISTEN_MODEL = process.env.DEEPGRAM_LISTEN_MODEL ?? 'nova-3'
const THINK_MODEL = process.env.DEEPGRAM_THINK_MODEL ?? 'gpt-4o-mini'
const SPEAK_MODEL = process.env.DEEPGRAM_SPEAK_MODEL ?? 'flux-kit-en'

/** Audio formats agreed with the browser. */
export const AUDIO = {
  input: { encoding: 'linear16', sample_rate: 24000 },
  output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
}

export const hasCredentials = () => Boolean(process.env.DEEPGRAM_API_KEY)
export const listenModel = LISTEN_MODEL
export const speakModel = SPEAK_MODEL

/** Today, in Lagos — the agent needs it to resolve "yesterday". */
function today() {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const weekday = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
  }).format(new Date())
  return { iso, weekday }
}

/**
 * The spoken-conversation prompt.
 *
 * Deliberately shorter and more conversational than the typed one. A
 * caller cannot re-read a sentence, cannot see a document checklist,
 * and will not sit through a list of five requirements read aloud.
 */
function buildPrompt() {
  const { iso, weekday } = today()

  return `You are the claims intake assistant for Clearing, a motor insurance service in Nigeria. You are speaking with a customer out loud, and they can only hear you.

Today is ${weekday}, ${iso}, West Africa Time.

## Speaking

One question at a time. Never read a list of requirements aloud — a caller cannot hold five things in their head.

Keep every reply to one or two sentences. A caller who has just had an accident wants to be heard, not lectured.

Say numbers the way a person says them: "one hundred and eighty-four thousand naira", not "184000". Read a registration back letter by letter so they can correct it.

Confirm what you heard when it matters: "So that's L-S-D four four one K-J — is that right?" A misheard plate is worse than a slow one.

Never say a claim reference aloud without spelling it out slowly.

## Working

Call record_details the moment they tell you something. Do not wait.

Call check_claim after anything changes, so you know what is actually outstanding rather than guessing.

If they mention having a photo or a document, tell them to upload it on screen using the button beside that document.

## System messages

Some turns arrive wrapped in square brackets beginning "[System:". These are not the customer speaking — they are the app telling you something that happened on screen, usually a document upload.

Act on them, never read them aloud. A system message saying a document was uploaded and read means exactly that: it is already recorded, and asking for it again would be asking for something the customer has just given you. Do not call read_document for it.

Call submit_claim only when check_claim reports nothing blocking. If it refuses, tell them plainly what is still needed.

If they cannot supply something now — the estimate is still at the garage, they have not collected the police report — offer to lodge the claim as it stands so they get their reference straight away and can add the rest later. If they agree, call submit_claim with provisional: true. Offer it; do not push it, and never use it to get past a question they can simply answer. Say clearly that the claim is saved but not yet being assessed, and name what is still outstanding.

Contradictions are different from missing items: if something they already gave you disagrees with a document — a different repair figure, a date before the incident — that has to be sorted out now. submit_claim will refuse it either way. Ask which is correct.

Work out relative dates yourself. "Yesterday" is the day before ${iso}. Confirm the date you settled on.

## Boundaries

Only ask for what the claim needs: the incident details, and these documents — ${MOTOR.requiredDocuments.map((d) => d.label.toLowerCase()).join(', ')}.

You never decide whether a claim is approved or whether it looks fraudulent. If asked, say an assessor makes that decision.

Never tell them the claim is submitted unless submit_claim returned submitted: true.`
}

/**
 * Translate our tool schemas into Deepgram's shape.
 *
 * Note what is absent: no `client_side` field and no `endpoint`. The
 * documentation describes `client_side: true`, but this API version
 * rejects the whole Settings frame when it is present — verified by
 * bisecting the message field by field. A function with no `endpoint`
 * is client-side by definition, which is the behaviour we want:
 * Deepgram sends a FunctionCallRequest and waits for our response, so
 * the tools run here against this session's claim record.
 */
function functionDeclarations(schemas = TOOL_SCHEMAS) {
  return schemas.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}

/**
 * The opening Settings frame.
 *
 * Parameterised because Clearing runs two spoken agents over the same
 * socket machinery: intake, which builds a claim, and claim status,
 * which reads one back. They differ only in prompt, tools and greeting
 * — everything about the audio transport is identical.
 */
export function settingsMessage({ prompt, schemas, greeting } = {}) {
  return {
    type: 'Settings',
    audio: AUDIO,
    agent: {
      language: 'en',
      listen: {
        provider: { type: 'deepgram', model: LISTEN_MODEL },
      },
      think: {
        // `open_ai` with the underscore — `deepgram` is not a valid
        // think provider, and the API rejects the whole Settings frame
        // rather than just that field.
        provider: { type: 'open_ai', model: THINK_MODEL, temperature: 0.3 },
        prompt: prompt ?? buildPrompt(),
        functions: functionDeclarations(schemas),
      },
      speak: {
        provider: { type: 'deepgram', version: 'v2', model: SPEAK_MODEL },
      },
      greeting:
        greeting ??
        'Hello, this is Clearing. I can take your motor claim over the phone — what is your name?',
    },
  }
}

/**
 * Open a voice session for one intake conversation.
 *
 * `session` is the same object the typed agent mutates, so a claimant
 * can start by voice and finish by typing — the claim record is shared.
 *
 * Returns a handle: `send` forwards mic audio, `close` ends it. Events
 * flow back through the callbacks so the route can relay them to the
 * browser without knowing Deepgram's message shapes.
 */
export function openVoiceSession(session, handlers = {}) {
  const {
    onAudio = () => {},
    onTranscript = () => {},
    onAgentText = () => {},
    onToolCall = () => {},
    onError = () => {},
    onClose = () => {},
    onReady = () => {},
  } = handlers

  /**
   * Intake is the default, but a caller can supply its own tools,
   * schemas and prompt — that is how the claim-status agent reuses this
   * socket without inheriting the ability to build a claim.
   */
  const tools = handlers.tools ?? createTools(session, { onSubmit: handlers.onSubmit })
  const schemas = handlers.schemas ?? TOOL_SCHEMAS
  const broadcastState = handlers.broadcastState ?? defaultStateBroadcast

  const ws = new WebSocket(AGENT_URL, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  })

  let ready = false

  ws.on('open', () => {
    ws.send(
      JSON.stringify(
        settingsMessage({
          prompt: handlers.prompt,
          schemas,
          greeting: handlers.greeting,
        }),
      ),
    )
  })

  ws.on('message', async (data, isBinary) => {
    // Binary frames are synthesised speech; pass them straight through.
    if (isBinary) return onAudio(data)

    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }

    switch (msg.type) {
      case 'SettingsApplied':
        ready = true
        onReady()
        break

      case 'ConversationText':
        // Both sides of the conversation arrive here, tagged by role.
        if (msg.role === 'user') onTranscript(msg.content)
        else if (msg.role === 'assistant') onAgentText(msg.content)
        break

      case 'FunctionCallRequest':
        await handleFunctionCalls(msg, tools, ws, onToolCall, session, broadcastState)
        break

      case 'Error':
        onError(msg.description ?? msg.message ?? 'Deepgram reported an error')
        break

      default:
        break
    }
  })

  ws.on('error', (err) => onError(err.message))
  ws.on('close', (code, reason) => onClose(code, reason?.toString()))

  return {
    /** Forward a chunk of mic audio. */
    send(chunk) {
      if (ws.readyState === WebSocket.OPEN && ready) ws.send(chunk)
    },
    /** Tell the agent to stop talking — the caller interrupted. */
    interrupt() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'InjectAgentMessage', message: '' }))
      }
    },

    /**
     * Tell the agent something that happened outside the conversation.
     *
     * A document uploaded on screen never reaches Deepgram: it holds
     * its own conversation state, and the upload endpoint runs against
     * the typed agent. Without this the caller uploads a photo, the
     * system reads it, and the voice agent keeps asking for it —
     * because as far as it knows, nothing arrived.
     *
     * `InjectUserMessage` rather than `InjectAgentMessage`: the latter
     * only makes the agent *speak* a line, leaving its own history
     * unchanged, so it would acknowledge the document once and then
     * ask for it again on the next turn. This enters the conversation
     * as a user turn, so the agent reasons about it, can call
     * check_claim, and remembers it afterwards.
     */
    notify(content) {
      if (ws.readyState === WebSocket.OPEN && ready) {
        ws.send(JSON.stringify({ type: 'InjectUserMessage', content }))
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    },
    get ready() {
      return ready
    },
  }
}

/**
 * Execute the tools Deepgram asked for and answer.
 *
 * One FunctionCallRequest can carry several calls; each gets its own
 * FunctionCallResponse keyed by id.
 */
/**
 * What intake reports back to the browser after each batch of calls:
 * progress, the claim so far, and the submitted claim once there is
 * one. The status agent supplies its own instead.
 */
function defaultStateBroadcast(session) {
  const check = validateIntake(session.claim, session.extracted)
  return {
    completeness: check.completeness,
    recorded: session.claim,
    submitted: session.submitted,
  }
}

async function handleFunctionCalls(msg, tools, ws, onToolCall, session, broadcastState) {
  for (const call of msg.functions ?? []) {
    // Every function we declare is client-side (none has an endpoint),
    // so the flag is not required to be present — only honoured when it
    // explicitly says the server already handled the call.
    if (call.client_side === false) continue

    let args = {}
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      // Hand the parse failure back rather than crashing the call.
      ws.send(
        JSON.stringify({
          type: 'FunctionCallResponse',
          id: call.id,
          name: call.name,
          content: JSON.stringify({ error: 'Arguments were not valid JSON.' }),
        }),
      )
      continue
    }

    const fn = tools[call.name]
    const result = fn ? await fn(args) : { error: `Unknown tool ${call.name}` }

    onToolCall({ tool: call.name, args, result })

    ws.send(
      JSON.stringify({
        type: 'FunctionCallResponse',
        id: call.id,
        name: call.name,
        content: JSON.stringify(result),
      }),
    )
  }

  // Keep the browser in step with whatever the agent just changed.
  onToolCall({ tool: '__state', result: broadcastState(session) })
}
