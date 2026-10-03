import { useCallback, useEffect, useRef, useState } from 'react'
import { lookupClaim, refreshStatus, supplyDocument } from '../../lib/api'
import { naira } from '../../lib/triage'
import { Check, Warn, Plus, Search, Chevron } from '../Icons'
import AskPanel from './AskPanel'
import useVoiceAgent from '../../lib/useVoiceAgent'
import VoiceCall, { CallButton } from '../intake/VoiceCall'
import { fetchVoiceAgentConfig } from '../../lib/api'

/**
 * Claim status, for the person who filed it.
 *
 * The point of this screen is to answer "has anyone looked at my
 * claim?" without a phone call — and, where something is outstanding,
 * to let them fix it here rather than being told to call.
 *
 * It deliberately shows nothing about fraud scoring. The server sends a
 * claimant-facing view with those fields already stripped; this screen
 * could not display them if it wanted to.
 */

const STORAGE_KEY = 'clearing.status.session'
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/**
 * How long the "searching" state stays up before the claim replaces it.
 *
 * Not an artificial delay for its own sake: the lookup itself is
 * sub-millisecond, and a result that appears in the same frame as the
 * request reads as a glitch. This is the shortest pause that lets a
 * caller see their reference being looked up.
 */
const MIN_SEARCH_MS = 750

const store = {
  get() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  },
  set(v) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
    } catch {
      /* private mode — lookup still works, it just will not persist */
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

function toDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('Could not read that file'))
    r.readAsDataURL(file)
  })
}

/** Where the claim has got to, as four steps. */
function Progress({ stages, current }) {
  return (
    <ol className="m-0 flex list-none gap-1 p-0">
      {stages.map((label, i) => {
        const done = i < current
        const here = i === current
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className={[
                'h-[4px] rounded-full',
                done || here ? 'bg-accent' : 'bg-line',
              ].join(' ')}
            />
            <span
              className={[
                'truncate text-[11px]',
                here ? 'font-semibold text-ink' : done ? 'text-muted' : 'text-faint',
              ].join(' ')}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** One outstanding document, with its own upload control. */
function Outstanding({ doc, onUpload, busy, highlighted }) {
  const picker = useRef(null)
  const camera = useRef(null)

  const pick = (e) => {
    const file = e.target.files?.[0]
    if (file) onUpload(doc.id, file)
    e.target.value = ''
  }

  return (
    <li
      className={[
        'flex items-center gap-2.5 rounded-[9px] border px-3 py-2.5 transition-colors',
        highlighted
          ? 'border-accent bg-accentsoft'
          : 'border-dashed border-line bg-card',
      ].join(' ')}
    >
      <input ref={picker} type="file" accept="image/*,application/pdf" className="hidden" onChange={pick} />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={pick}
      />

      <Plus size={14} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 text-[12.5px] text-ink2">{doc.label}</span>

      <button
        type="button"
        disabled={busy}
        onClick={() => camera.current?.click()}
        className="shrink-0 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50 sm:hidden"
      >
        Photo
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => picker.current?.click()}
        className="shrink-0 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:opacity-50"
      >
        Upload
      </button>
    </li>
  )
}

/**
 * The agent looking a claim up.
 *
 * Shown between the caller finishing their reference and the claim
 * appearing. It names the reference being searched, so a misheard one
 * is visible immediately — the caller can correct it aloud rather than
 * waiting to be told it was not found.
 */
function Searching({ reference }) {
  return (
    <div className="rounded-card border border-line bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="relative grid h-[30px] w-[30px] shrink-0 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-accentsoft opacity-75" />
          <span className="relative grid h-[30px] w-[30px] place-items-center rounded-full bg-accentsoft text-accentink">
            <Search size={15} />
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Looking up your claim…</div>
          <div className="mt-0.5 truncate font-display text-[12.5px] tabular-nums text-muted">
            {reference}
          </div>
        </div>
      </div>

      {/* An indeterminate bar — the lookup has no measurable progress,
          and a fake percentage would be a lie about a real thing. */}
      <div className="mt-4 h-[4px] overflow-hidden rounded-full bg-linesoft">
        <div className="h-full w-1/3 animate-[slide_1.1s_ease-in-out_infinite] rounded-full bg-accent" />
      </div>

      <style>{`
        @keyframes slide {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  )
}

function Lookup({ onFound, onNewClaim }) {
  const [reference, setReference] = useState('')
  const [surname, setSurname] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!reference.trim() || !surname.trim() || busy) return

    setBusy(true)
    setError(null)
    try {
      const res = await lookupClaim(reference.trim(), surname.trim())
      store.set({ token: res.token, reference: reference.trim().toUpperCase(), surname: surname.trim() })
      onFound(res.claim, res.token)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-[400px]">
      <h1 className="m-0 font-display text-[20px] font-semibold tracking-[-.015em]">
        Track your claim
      </h1>
      <p className="m-0 mt-1.5 text-[13px] leading-[1.55] text-muted">
        Enter the reference we gave you and the surname on the claim.
      </p>

      <div className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink2">Claim reference</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="CLM-2401-0026"
            autoComplete="off"
            className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] tabular-nums text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink2">Surname</span>
          <input
            value={surname}
            onChange={(e) => setSurname(e.target.value)}
            placeholder="Okonkwo"
            autoComplete="family-name"
            className="w-full rounded-lg border border-line bg-card px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2.5 text-[12.5px] text-invink">
            <Warn size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !reference.trim() || !surname.trim()}
          className="mt-1 rounded-lg border border-accentfill bg-accentfill px-4 py-2 text-[13px] font-medium text-white transition-colors hover:not-disabled:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Looking up…' : 'Find my claim'}
        </button>

        {/* Someone with no reference has not filed yet — without this
            the lookup form is a dead end for exactly the person the
            service most wants to help. */}
        {onNewClaim && (
          <p className="m-0 mt-1 text-center text-[12px] text-muted">
            Not filed a claim yet?{' '}
            <button
              type="button"
              onClick={onNewClaim}
              className="font-medium text-accentink underline underline-offset-2"
            >
              Start one now
            </button>
          </p>
        )}
      </div>
    </form>
  )
}

export default function ClaimStatus({ onExit, onNewClaim, onContinue }) {
  const [claim, setClaim] = useState(null)
  const [token, setToken] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)
  const restored = useRef(false)
  const [voiceReady, setVoiceReady] = useState(false)

  /** A spoken lookup in flight, and its result waiting to be shown. */
  const [searching, setSearching] = useState(null)
  const [pending, setPending] = useState(null)

  /** The scrolling region, so a found claim can be brought into view. */
  const scroll = useRef(null)
  /** The outstanding-documents card, for the jump from the claim card. */
  const uploads = useRef(null)
  /** One outstanding document the agent asked us to single out. */
  const [highlight, setHighlight] = useState(null)

  /**
   * Take the claimant to the page where they finish the claim.
   *
   * The same guided flow that took the claim in the first place, but
   * resuming an existing one — the agent knows the reference and what
   * is outstanding, and cannot file a second claim.
   */
  const goToUploads = useCallback(
    (documentType) => {
      const saved = store.get()
      if (saved?.token) onContinue?.(saved.token, documentType ?? null)
    },
    [onContinue],
  )

  useEffect(() => {
    fetchVoiceAgentConfig()
      .then((c) => setVoiceReady(Boolean(c.available)))
      .catch(() => setVoiceReady(false))
  }, [])

  /**
   * The spoken agent finds the claim itself.
   *
   * It asks for the reference and surname, verifies them server-side,
   * and pushes the claim here with an access token — the same result a
   * typed lookup produces, so everything downstream (uploads, the
   * timeline, the ask panel) works identically.
   *
   * The surname is not stored: the voice path never sent one from the
   * browser. Uploading needs it, so that is read back off the claim.
   */
  const onVoiceMessage = useCallback((msg) => {
    if (msg.type === 'searching') {
      if (msg.failed) {
        // Stop searching, stay on the lookup screen. The agent is
        // already asking them to read the reference back.
        setSearching(null)
        return
      }
      setSearching({ reference: msg.reference, at: Date.now() })
      return
    }

    /**
     * The agent taking them to the upload controls.
     *
     * Deferred a frame: the claim may have only just arrived, and the
     * upload card will not be in the DOM until it has rendered.
     */
    if (msg.type === 'open_uploads') {
      const saved = store.get()
      if (saved?.token) onContinue?.(saved.token, msg.documentType ?? null)
      return
    }

    if (msg.type !== 'claim' || !msg.claim) return

    const surname = String(msg.claim.claimant ?? '').split(/\s+/).filter(Boolean).pop() ?? ''
    store.set({ token: msg.token, reference: msg.claim.reference, surname })

    /**
     * Let the search be seen before the claim replaces it.
     *
     * A SQLite lookup returns in under a millisecond, so without this
     * the "searching" state would render for a single frame — the
     * caller would see the screen flicker and change, with no sense
     * that their reference was looked up at all.
     *
     * The delay is capped against when the search actually started, so
     * a genuinely slow lookup does not add a wait on top of itself.
     */
    setPending({ claim: msg.claim, token: msg.token })
  }, [onContinue])

  const voice = useVoiceAgent({
    path: '/api/status-voice',
    requireSession: false,
    onMessage: onVoiceMessage,
  })

  /**
   * Bring a newly found claim into view.
   *
   * The scroll container may be part-way down from a previous claim or
   * a long call transcript, and a claim that arrives below the fold
   * looks like nothing happened. Only on arrival — a claimant who has
   * scrolled down to read their timeline is left alone.
   */
  const reference = claim?.reference
  useEffect(() => {
    if (!reference) return
    scroll.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [reference])

  /**
   * Show the claim once the search has been on screen long enough to
   * register — about three quarters of a second, measured from when
   * the lookup began rather than from now.
   */
  useEffect(() => {
    if (!pending) return

    const elapsed = searching ? Date.now() - searching.at : MIN_SEARCH_MS
    const wait = Math.max(0, MIN_SEARCH_MS - elapsed)

    const id = setTimeout(() => {
      setClaim(pending.claim)
      setToken(pending.token)
      setError(null)
      setSearching(null)
      setPending(null)
    }, wait)

    return () => clearTimeout(id)
  }, [pending, searching])

  // Come straight back to the claim on a return visit.
  useEffect(() => {
    if (restored.current) return
    restored.current = true

    const saved = store.get()
    if (!saved?.token) return

    setToken(saved.token)
    refreshStatus(saved.token)
      .then((res) => setClaim(res.claim))
      .catch(() => {
        store.clear()
        setToken(null)
      })
  }, [])

  const reload = useCallback(async () => {
    const saved = store.get()
    if (!saved?.token) return
    try {
      const res = await refreshStatus(saved.token)
      setClaim(res.claim)
    } catch {
      /* the view stays as it was; the next action will surface it */
    }
  }, [])

  /**
   * Keep the page live while it is open.
   *
   * A claimant watching this page should see a change when it happens
   * rather than having to reload — that is the difference between a
   * status page and a status *update*. Paused when the tab is hidden,
   * so a forgotten tab is not polling all day.
   */
  useEffect(() => {
    if (!claim) return

    const tick = () => {
      if (document.visibilityState === 'visible') reload()
    }
    const id = setInterval(tick, 20000)
    document.addEventListener('visibilitychange', tick)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [claim, reload])

  async function upload(documentType, file) {
    const saved = store.get()
    if (!saved || busy) return

    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That file is larger than 5MB. Please use a smaller photo.')
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const dataUri = await toDataUri(file)
      const res = await supplyDocument(
        saved.reference,
        saved.surname,
        documentType,
        file.name,
        dataUri,
      )
      setNotice(res.message)
      // It is no longer outstanding, so singling it out would point at
      // a row that has gone.
      if (documentType === highlight) setHighlight(null)
      await reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function signOut() {
    store.clear()
    setClaim(null)
    setToken(null)
    setNotice(null)
    setError(null)
  }

  const toneClass = {
    good: 'bg-fastbg text-fastink',
    warn: 'bg-stdbg text-stdink',
    neutral: 'bg-linesoft text-ink2',
  }

  /** Whether the call panel is on screen at all. */
  const onCall = voice.live || voice.connecting || voice.status === 'ended'

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-rail px-4 py-3">
        <span className="grid h-[28px] w-[28px] place-items-center rounded-lg bg-accent font-display text-[14px] font-bold text-white">
          C
        </span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">Your claim</div>
          <div className="text-[11.5px] text-muted">Clearing · Motor claims</div>
        </div>


        {claim && (
          <button
            type="button"
            onClick={signOut}
            className="ml-auto rounded-lg border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-ink2 transition-colors hover:border-faint"
          >
            Sign out
          </button>
        )}
        <button
          type="button"
          onClick={onExit}
          className={[
            'rounded-lg border border-line bg-card px-3 py-1.5 text-[12px] font-medium text-ink2 transition-colors hover:border-faint',
            claim ? '' : 'ml-auto',
          ].join(' ')}
        >
          Exit
        </button>
      </header>

      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        {!claim ? (
          <div className="mx-auto flex w-full max-w-[400px] flex-col gap-4">
            {searching ? (
              <Searching reference={searching.reference} />
            ) : (
              <Lookup onFound={(c, t) => { setClaim(c); setToken(t) }} onNewClaim={onNewClaim} />
            )}

            {voiceReady && (
              <div className="border-t border-line pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    {/* Once the call is live the panel below says what
                        is happening; repeating the invitation here
                        would be talking over it. */}
                    {!voice.live && !voice.connecting && (
                      <>
                        <div className="text-[12.5px] font-medium text-ink2">
                          Would you rather just ask?
                        </div>
                        <div className="text-[11.5px] text-muted">
                          Tell us your reference and surname out loud.
                        </div>
                      </>
                    )}
                  </div>
                  <CallButton
                    live={voice.live}
                    connecting={voice.connecting}
                    onStart={voice.start}
                    onStop={voice.stop}
                  />
                </div>

                <div className="mt-3">
                  <VoiceCall voice={voice} onEnd={voice.clearError} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            className={[
              'mx-auto flex w-full gap-4',
              // Two columns only while a call is up: the claim alone
              // does not need the width, and an empty rail beside it
              // would just push the content off-centre.
              onCall ? 'max-w-[980px] flex-col lg:flex-row' : 'max-w-[560px] flex-col',
            ].join(' ')}
          >
            {onCall && (
              /* The live call, held beside the claim rather than above
                 it. Sticky so it stays in view as the claimant scrolls
                 the claim — the conversation is the thing they are in
                 the middle of. */
              <aside className="w-full shrink-0 lg:order-2 lg:w-[320px]">
                <div className="lg:sticky lg:top-0">
                  <VoiceCall voice={voice} onEnd={voice.clearError} tall />
                </div>
              </aside>
            )}

            <div className="flex min-w-0 flex-1 flex-col gap-4 lg:order-1">
            <div className="rounded-card border border-line bg-card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-faint">Reference</div>
                  <div className="font-display text-[17px] font-semibold tabular-nums tracking-[-.01em]">
                    {claim.reference}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${toneClass[claim.tone]}`}
                >
                  {claim.stage}
                </span>
              </div>

              <p className="m-0 mt-3 text-[13px] leading-[1.55] text-ink2">{claim.detail}</p>

              {/* The one thing they can act on, put where they land
                  rather than halfway down the page. After a spoken
                  lookup especially, the agent has just told them what
                  is missing — this is the button that answers it. */}
              {claim.outstanding.length > 0 && (
                <button
                  type="button"
                  onClick={() => goToUploads(null)}
                  className="mt-3 flex w-full items-center gap-2.5 rounded-lg border border-accent bg-accentsoft px-3 py-2.5 text-left transition-colors hover:brightness-[0.98]"
                >
                  <Plus size={15} className="shrink-0 text-accentink" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-semibold text-accentink">
                      Upload {claim.outstanding.length === 1 ? 'the document' : `${claim.outstanding.length} documents`} we still need
                    </span>
                    <span className="block truncate text-[11.5px] text-accentink opacity-80">
                      {claim.outstanding.map((o) => o.label).join(', ')}
                    </span>
                  </span>
                  <Chevron size={13} className="shrink-0 rotate-90 text-accentink" />
                </button>
              )}

              <div className="mt-4">
                <Progress stages={claim.stages} current={claim.currentStage} />
              </div>

              <dl className="m-0 mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3">
                {[
                  ['Vehicle', claim.vehicle],
                  ['Amount', naira(claim.amount)],
                  ['Incident', claim.incidentType],
                  ['Submitted', claim.submittedAgo],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-faint">{label}</dt>
                    <dd className="m-0 truncate text-[12.5px] text-ink2" title={String(value)}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {claim.outstanding.length > 0 && (
              <div ref={uploads} className="rounded-card border border-line bg-card p-4">
                <h2 className="m-0 text-[13px] font-semibold">We still need</h2>
                <p className="m-0 mt-1 text-[12px] leading-[1.5] text-muted">
                  Adding these now will keep your claim moving.
                </p>
                <ul className="mt-3 flex list-none flex-col gap-1.5 p-0">
                  {claim.outstanding.map((doc) => (
                    <Outstanding
                      key={doc.id}
                      doc={doc}
                      onUpload={upload}
                      busy={busy}
                      highlighted={doc.id === highlight}
                    />
                  ))}
                </ul>
              </div>
            )}

            {token && <AskPanel token={token} />}

            {notice && (
              <div className="flex items-start gap-2 rounded-lg border border-line bg-fastbg px-3 py-2.5 text-[12.5px] text-fastink">
                <Check size={14} className="mt-0.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2.5 text-[12.5px] text-invink">
                <Warn size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="rounded-card border border-line bg-card p-4">
              <h2 className="m-0 mb-3 text-[13px] font-semibold">What has happened</h2>
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {claim.timeline.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium text-ink2">{e.title}</span>
                      <span className="block text-[11.5px] text-muted">{e.detail}</span>
                      <span className="mt-0.5 block text-[11px] text-faint">{e.when}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
