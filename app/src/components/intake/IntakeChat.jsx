import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startIntake,
  continueClaim,
  sendIntakeMessage,
  uploadIntakeDocument,
  fetchIntakeSession,
} from '../../lib/api'
import { naira } from '../../lib/triage'
import { MOTOR } from '../../data/motorConfig'
import ToolTrace from './ToolTrace'
import { DocumentList, Progress } from './DocumentRail'
import ClaimSummary from './ClaimSummary'
import RoutePill from '../RoutePill'
import { Warn, Chevron } from '../Icons'
import VoiceCall, { CallButton } from './VoiceCall'
import useVoiceAgent from '../../lib/useVoiceAgent'
import { fetchVoiceAgentConfig } from '../../lib/api'

/**
 * Customer claim intake.
 *
 * A conversation, not a form. The agent decides what to ask; this
 * screen renders the exchange, keeps the document checklist and the
 * recorded details visible, and shows what the agent did between turns.
 */

const STORAGE_KEY = 'clearing.intake.session'
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** Read a File into a data URI the API accepts. */
function toDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read that file'))
    r.readAsDataURL(file)
  })
}

const store = {
  get() {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  },
  set(v) {
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      /* private mode — the conversation still works, it just cannot resume */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* nothing to do */
    }
  },
}

function Bubble({ role, children }) {
  const mine = role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[78%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-[1.55]',
          mine
            ? 'rounded-br-sm bg-accentfill text-white'
            : 'rounded-bl-sm border border-line bg-card text-ink2',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  )
}

function Thinking({ label }) {
  return (
    <div className="flex items-center gap-2.5 pl-1">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="ai-dot h-[6px] w-[6px] rounded-full bg-accent"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      <span className="text-[11.5px] text-faint">{label}</span>
    </div>
  )
}

/**
 * Shown once the claim is in. Gives the claimant something to keep —
 * a reference and what happens next — and a way to start another.
 */
function Submitted({ claim, onNew, onExit, onTrack }) {
  /**
   * A provisionally lodged claim has a reference but no route. Saying
   * "submitted" and showing a queue would overstate what has happened:
   * nothing is assessed until the outstanding items arrive.
   */
  const outstanding = claim.missingDocuments ?? []

  const next = claim.provisional
    ? 'Your claim is saved, but it has not gone for assessment yet — we still need the documents below. You can add them any time from your claim page using the reference and your surname.'
    : {
        fast: 'Your claim met the conditions for fast-track settlement and is being processed now. You should hear from us within 48 hours.',
        std: 'Your claim is with an assessor. They may contact you if they need anything further.',
        inv: 'Your claim needs a closer look before assessment. Someone will be in touch to go through it with you.',
      }[claim.route]

  return (
    <div className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="m-0 text-[14px] font-semibold">
          {claim.provisional ? 'Claim saved' : 'Claim submitted'}
        </h3>
        <span className="ml-auto">
          <RoutePill route={claim.route} />
        </span>
      </div>

      <div className="mt-3 rounded-lg bg-linesoft px-3 py-2.5">
        <div className="text-[11px] text-faint">Your reference</div>
        <div className="font-display text-[17px] font-semibold tabular-nums tracking-[-.01em]">
          {claim.id}
        </div>
        <div className="mt-0.5 text-[11.5px] text-muted">{naira(claim.amount)}</div>
        <div className="mt-1.5 text-[11px] text-muted">
          Keep this reference — you can check your claim any time with it and your surname.
        </div>
      </div>

      <p className="m-0 mt-3 text-[12.5px] leading-[1.55] text-muted">{next}</p>

      {claim.provisional && outstanding.length > 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-line px-3 py-2.5">
          <div className="text-[11px] font-medium text-ink2">Still needed</div>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {outstanding.map((id) => (
              <li key={id} className="flex items-start gap-2 text-[11.5px] text-muted">
                <span className="mt-[6px] h-[3px] w-[3px] shrink-0 rounded-full bg-faint" />
                {MOTOR.requiredDocuments.find((d) => d.id === id)?.label ?? id.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onTrack}
          className="rounded-lg border border-accentfill bg-accentfill px-3 py-[7px] text-[12.5px] font-medium text-white transition-colors hover:brightness-95"
        >
          Track this claim
        </button>
        <button
          type="button"
          onClick={onNew}
          className="rounded-lg border border-line bg-card px-3 py-[7px] text-[12.5px] font-medium text-ink2 transition-colors hover:border-faint"
        >
          Make another claim
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg border border-line bg-card px-3 py-[7px] text-[12.5px] font-medium text-ink2 transition-colors hover:border-faint"
        >
          Done
        </button>
      </div>
    </div>
  )
}

export default function IntakeChat({ onExit, onTrack, continuing }) {
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [extracted, setExtracted] = useState({})
  const [recorded, setRecorded] = useState({})
  const [completeness, setCompleteness] = useState(0)
  const [claim, setClaim] = useState(null)
  /** Set when this conversation is finishing an existing claim. */
  const [resuming, setResuming] = useState(null)
  const [busy, setBusy] = useState('starting')
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)

  const [voiceReady, setVoiceReady] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  /**
   * A voice turn changes the same claim record the typed conversation
   * uses, so the panel and progress bar have to follow it.
   */
  const submittedOnCall = useRef(false)

  const onVoiceState = useCallback((s) => {
    if (s.completeness != null) setCompleteness(s.completeness)
    if (s.recorded) setRecorded(s.recorded)
    if (s.submitted) {
      setClaim(s.submitted)
      store.clear()
      // The claim is in; the call has nothing left to do. Flagged here
      // and ended in an effect rather than called directly, because
      // `voice` is not in scope until the hook below has run.
      submittedOnCall.current = true
    }
  }, [])

  const voice = useVoiceAgent({ sessionId, onStateChange: onVoiceState })

  /**
   * End the call once the claim is submitted.
   *
   * The agent says the reference aloud and then has nothing further to
   * ask. Leaving the call open holds the claimant on a live microphone
   * while the confirmation — with the reference in writing — sits
   * behind the call panel.
   */
  useEffect(() => {
    if (!claim || !submittedOnCall.current) return
    submittedOnCall.current = false
    if (voice.live || voice.connecting) voice.stop()
  }, [claim, voice])

  const scroller = useRef(null)
  const input = useRef(null)
  const started = useRef(false)

  /** Begin a new conversation, discarding any stored one. */
  const begin = useCallback(async () => {
    setBusy('starting')
    setError(null)
    setMessages([])
    setExtracted({})
    setRecorded({})
    setCompleteness(0)
    setClaim(null)
    store.clear()

    try {
      /**
       * Resuming an existing claim rather than starting one.
       *
       * The server builds the session around the claim the token
       * unlocks, without `submit_claim` — a claim already in the book
       * must not be filed twice.
       */
      const res = continuing?.token
        ? await continueClaim(continuing.token, continuing.documentType)
        : await startIntake()

      setSessionId(res.sessionId)
      store.set(res.sessionId)
      setMessages([{ role: 'assistant', content: res.reply, trace: res.trace }])
      setCompleteness(res.completeness ?? 0)
      setRecorded(res.recorded ?? {})
      setResuming(res.reference ? { reference: res.reference, claimant: res.claimant } : null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }, [continuing])

  /**
   * Abandon this claim and start a fresh one.
   *
   * Ends any live voice call first — a Deepgram session holds its own
   * conversation state, so leaving it open would have the agent still
   * talking about a claim that no longer exists.
   */
  const reset = useCallback(() => {
    setConfirmReset(false)
    if (voice.live || voice.connecting) voice.stop()
    begin()
  }, [voice, begin])

  // Resume a stored session if it is still alive, else start fresh.
  // The ref guards against StrictMode's double-invoke.
  useEffect(() => {
    if (started.current) return
    started.current = true

    // A continuation always wins over a stored session: the claimant
    // has just asked to finish a specific claim, and resuming some
    // half-typed earlier conversation instead would be baffling.
    const saved = continuing?.token ? null : store.get()
    if (!saved) {
      begin()
      return
    }

    fetchIntakeSession(saved)
      .then((s) => {
        setSessionId(s.sessionId)
        setMessages(
          (s.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
        )
        setExtracted(s.extracted ?? {})
        setRecorded(s.claim ?? {})
        setCompleteness(s.completeness ?? 0)
        if (s.submitted) setClaim(s.submitted)
        setBusy(null)
      })
      .catch(() => {
        // Expired or gone — start over rather than showing an error the
        // claimant can do nothing about.
        begin()
      })
  }, [begin, continuing])

  // Hide the call button entirely when voice is not configured, rather
  // than offering one that cannot connect.
  useEffect(() => {
    fetchVoiceAgentConfig()
      .then((cfg) => setVoiceReady(Boolean(cfg.available)))
      .catch(() => setVoiceReady(false))
  }, [])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  function applyTurn(res) {
    // While a call is live the voice agent is told about the upload and
    // speaks its own acknowledgement. Adding the typed agent's reply too
    // would put the same thing on screen twice, one of them stale.
    if (!res.voiceActive) {
      setMessages((m) => [...m, { role: 'assistant', content: res.reply, trace: res.trace }])
    }
    setCompleteness(res.completeness ?? 0)
    if (res.recorded) setRecorded(res.recorded)
    if (res.claim) {
      setClaim(res.claim)
      store.clear()
    }
  }

  async function send(e) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || busy || !sessionId) return

    setDraft('')
    setMessages((m) => [...m, { role: 'user', content: text }])
    setBusy('thinking')
    setError(null)

    try {
      applyTurn(await sendIntakeMessage(sessionId, text))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }


  async function upload(documentType, file) {
    if (busy || !sessionId) return

    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is larger than 5MB. Please use a smaller photo.')
      return
    }

    setSheetOpen(false)
    setMessages((m) => [...m, { role: 'user', content: `Uploaded ${file.name}` }])
    setBusy('reading')
    setError(null)

    try {
      const dataUri = await toDataUri(file)
      const res = await uploadIntakeDocument(sessionId, documentType, file.name, dataUri)

      // A rejected document is removed server-side, so it must not stay
      // ticked here either — a green check on a licence uploaded as a
      // police report is the exact confusion this check exists to stop.
      if (res.confirmation?.verdict === 'rejected') {
        setExtracted((e) => {
          const next = { ...e }
          delete next[documentType]
          return next
        })
        setError(res.confirmation.summary)
      } else if (res.extracted) {
        setExtracted((e) => ({ ...e, [documentType]: res.extracted }))
      }

      applyTurn(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  /** Tapping a recorded value drafts a correction and focuses the input. */
  function correct(label) {
    setSheetOpen(false)
    setDraft(`The ${label.toLowerCase()} is wrong — it should be `)
    requestAnimationFrame(() => {
      input.current?.focus()
      const len = input.current?.value.length ?? 0
      input.current?.setSelectionRange(len, len)
    })
  }

  const locked = Boolean(busy) || Boolean(claim)

  /**
   * Whether there is anything worth discarding.
   *
   * The opening greeting alone is not progress — offering 'Start over'
   * on a conversation that has not started is noise. Anything the
   * claimant has actually contributed counts.
   */
  const hasProgress =
    messages.some((m) => m.role === 'user') ||
    Object.keys(recorded).length > 0 ||
    Object.keys(extracted).length > 0

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-rail px-4 py-3">
        <span className="grid h-[28px] w-[28px] place-items-center rounded-lg bg-accent font-display text-[14px] font-bold text-white">
          C
        </span>
        <div className="min-w-0">
          {/* Saying which claim they are finishing — otherwise this
              screen is indistinguishable from starting a new one. */}
          <div className="text-[13.5px] font-semibold">
            {resuming ? 'Finish your claim' : 'Make a claim'}
          </div>
          <div className="truncate text-[11.5px] text-muted">
            {resuming ? `Clearing · ${resuming.reference}` : 'Clearing · Motor claims'}
          </div>
        </div>

        {/* On small screens the rail is a sheet, opened from here. */}
        <button
          type="button"
          onClick={() => setSheetOpen((o) => !o)}
          aria-expanded={sheetOpen}
          className="ml-auto flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12px] font-medium text-ink2 transition-colors hover:border-faint lg:hidden"
        >
          <span className="tabular-nums text-accentink">{completeness}%</span>
          <Chevron size={12} className={`transition-transform ${sheetOpen ? 'rotate-90' : ''}`} />
        </button>

        {voiceReady && !claim && (
          <div className="ml-auto lg:ml-0">
            <CallButton
              live={voice.live}
              connecting={voice.connecting}
              onStart={voice.start}
              onStop={voice.stop}
              disabled={Boolean(busy)}
            />
          </div>
        )}

        {/* Start over, once there is something to lose. Two taps
            rather than one: this discards documents that took minutes
            to photograph, and a mis-tap here is expensive. */}
        {hasProgress && !claim && (
          <button
            type="button"
            onClick={() => (confirmReset ? reset() : setConfirmReset(true))}
            onBlur={() => setConfirmReset(false)}
            disabled={Boolean(busy)}
            className={[
              'rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              confirmReset
                ? 'border-inv bg-invbg text-invink'
                : 'border-line bg-card text-ink2 hover:not-disabled:border-faint',
              voiceReady ? '' : 'ml-auto lg:ml-0',
            ].join(' ')}
          >
            {confirmReset ? 'Discard and start over?' : 'Start over'}
          </button>
        )}

        <button
          type="button"
          onClick={onExit}
          className={[
            'rounded-lg border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-ink2 transition-colors hover:border-faint',
            (voiceReady && !claim) || (hasProgress && !claim) ? '' : 'ml-auto lg:ml-0',
          ].join(' ')}
        >
          Exit
        </button>
      </header>

      {/* Mobile sheet: progress, documents, and what has been recorded. */}
      {sheetOpen && (
        <div className="max-h-[58vh] overflow-y-auto border-b border-line bg-rail px-4 py-3.5 lg:hidden">
          <div className="flex flex-col gap-4">
            <Progress extracted={extracted} completeness={completeness} />
            <DocumentList extracted={extracted} onPick={upload} busy={locked} />
            <div>
              <h3 className="m-0 mb-2 text-[12px] font-semibold text-ink2">Recorded so far</h3>
              <ClaimSummary claim={recorded} onCorrect={correct} disabled={locked} />
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-5">
            <div className="mx-auto flex max-w-[640px] flex-col gap-3">
              {messages.map((m, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <Bubble role={m.role}>{m.content}</Bubble>
                  {m.role === 'assistant' && <ToolTrace trace={m.trace} />}
                </div>
              ))}

              {busy === 'starting' && <Thinking label="Starting…" />}
              {busy === 'thinking' && <Thinking label="Thinking…" />}
              {busy === 'reading' && (
                <Thinking label="Reading your document — this takes a moment" />
              )}

              <VoiceCall voice={voice} onEnd={() => voice.stop()} />

              {claim && <Submitted claim={claim} onNew={begin} onExit={onExit} onTrack={onTrack} />}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2.5 text-[12.5px] text-invink">
                  <Warn size={14} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={send} className="border-t border-line bg-rail px-4 py-3">
            <div className="mx-auto flex max-w-[640px] items-end gap-2">
              <textarea
                ref={input}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e)
                }}
                disabled={locked}
                placeholder={claim ? 'Your claim has been submitted' : 'Type your reply…'}
                className="max-h-[120px] min-h-[38px] flex-1 resize-none rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60"
              />

              <button
                type="submit"
                disabled={locked || !draft.trim()}
                className="h-[38px] shrink-0 rounded-lg border border-accentfill bg-accentfill px-4 text-[12.5px] font-medium text-white transition-colors hover:not-disabled:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </form>
        </div>

        {/* Desktop: documents and recorded details, always visible. */}
        <aside className="hidden w-[268px] shrink-0 flex-col overflow-y-auto border-l border-line bg-rail lg:flex">
          <div className="flex flex-col gap-4 p-4">
            <div>
              <h2 className="m-0 mb-2 text-[13px] font-semibold">Your claim</h2>
              <Progress extracted={extracted} completeness={completeness} />
            </div>
            <DocumentList extracted={extracted} onPick={upload} busy={locked} />
          </div>
          <div className="border-t border-line p-4">
            <h3 className="m-0 mb-2 text-[12px] font-semibold text-ink2">Recorded so far</h3>
            <ClaimSummary claim={recorded} onCorrect={correct} disabled={locked} />
          </div>
        </aside>
      </div>
    </div>
  )
}
