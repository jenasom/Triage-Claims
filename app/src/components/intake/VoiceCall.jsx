import { useEffect, useRef } from 'react'
import { Warn, Check } from '../Icons'

/**
 * Live voice conversation panel.
 *
 * Shown while a call is running. The transcript is here rather than in
 * the main thread because a spoken exchange is far more turn-dense than
 * a typed one — interleaving them would bury the typed conversation.
 */

function PhoneGlyph({ size = 15, down = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 3h3l1.5 4-2 1.5a13 13 0 006.5 6.5L17 13l4 1.5v3a2 2 0 01-2.2 2A17.5 17.5 0 013.5 5.2 2 2 0 015.5 3z" />
      {down && <path d="M3 3l18 18" />}
    </svg>
  )
}

/**
 * What the agent just did, in the claimant's language.
 *
 * Tool names are ours, not theirs. A refused submission is the case
 * that matters most: the agent will say so aloud, but a caller who
 * mishears needs it on screen too.
 */
function describe(activity) {
  if (!activity) return null
  const { tool, result } = activity

  switch (tool) {
    case 'record_details':
      return { text: 'Saved what you told me', tone: 'ok' }
    case 'read_document':
      return result?.readable === false
        ? { text: 'That document could not be read', tone: 'warn' }
        : { text: 'Read your document', tone: 'ok' }
    case 'check_claim':
      return { text: 'Checked your claim', tone: 'ok' }

    // Claim-status agent.
    case 'find_claim':
      return result?.found
        ? { text: `Found claim ${result.reference}`, tone: 'ok' }
        : { text: 'Could not find that claim — check the reference', tone: 'warn' }
    case 'get_status':
      return { text: 'Looked up your claim', tone: 'ok' }
    case 'list_outstanding':
      return { text: 'Checked what is outstanding', tone: 'ok' }
    case 'get_history':
      return { text: 'Looked up your claim history', tone: 'ok' }
    case 'open_uploads':
      return result?.opened
        ? {
            text: result.highlighted
              ? `Opened uploads — ${result.highlighted}`
              : 'Opened your uploads',
            tone: 'ok',
          }
        : { text: 'Nothing outstanding to upload', tone: 'warn' }

    case 'submit_claim':
      if (result?.submitted) {
        return {
          text: result.provisional
            ? `Claim saved — reference ${result.claimId}`
            : `Claim submitted — reference ${result.claimId}`,
          tone: 'ok',
        }
      }
      return { text: 'Not submitted yet — something is still needed', tone: 'warn' }
    default:
      return null
  }
}

/** Level meter — a live mic should look live. */
function Level({ value }) {
  return (
    <span className="flex items-center gap-[2px]" aria-hidden="true">
      {[0.2, 0.45, 0.7, 0.9].map((threshold, i) => (
        <span
          key={i}
          className={[
            'w-[3px] rounded-full transition-all duration-75',
            value >= threshold ? 'bg-accent' : 'bg-line',
          ].join(' ')}
          style={{ height: `${6 + i * 3}px` }}
        />
      ))}
    </span>
  )
}

export function CallButton({ live, connecting, onStart, onStop, disabled }) {
  if (live || connecting) {
    return (
      <button
        type="button"
        onClick={onStop}
        className="inline-flex items-center gap-1.5 rounded-lg border border-inv bg-invbg px-3 py-[7px] text-[12.5px] font-medium text-invink transition-colors hover:brightness-95"
      >
        <PhoneGlyph down />
        {connecting ? 'Connecting…' : 'End call'}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-[7px] text-[12.5px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:cursor-not-allowed disabled:opacity-50"
    >
      <PhoneGlyph />
      Talk instead
    </button>
  )
}

export default function VoiceCall({ voice, onEnd, tall = false }) {
  const scroller = useRef(null)

  /**
   * Follow the conversation as it happens.
   *
   * A spoken exchange is turn-dense — without this the newest line
   * lands below the fold while the caller is still listening to it.
   *
   * It stops following if they have scrolled up, so re-reading an
   * earlier answer is not interrupted by the next turn yanking the
   * view back down. Coming back to the bottom resumes it.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el) return

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom > 60) return

    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [voice.transcript])

  if (voice.status === 'idle') return null

  const action = describe(voice.activity)

  return (
    <div className="rounded-card border border-line bg-card p-4">
      <div className="flex items-center gap-3">
        <span
          className={[
            'grid h-[30px] w-[30px] place-items-center rounded-full',
            voice.live ? 'bg-accentsoft text-accentink' : 'bg-linesoft text-faint',
          ].join(' ')}
        >
          <PhoneGlyph size={14} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            {voice.connecting
              ? 'Connecting…'
              : voice.live
                ? voice.speaking
                  ? 'Clearing is speaking'
                  : 'Listening'
                : 'Call ended'}
          </div>
          <div className="text-[11.5px] text-muted">
            {voice.live
              ? 'Speak naturally — you can interrupt at any time'
              : voice.connecting
                ? 'Setting up your microphone'
                : 'You can carry on by typing'}
          </div>
        </div>

        {voice.live && !voice.speaking && <Level value={voice.level} />}
      </div>

      {voice.error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-invbg px-3 py-2 text-[12px] text-invink">
          <Warn size={13} className="mt-0.5 shrink-0" />
          <span>{voice.error}</span>
        </div>
      )}

      {action && (
        <div
          className={[
            'mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px]',
            action.tone === 'warn' ? 'bg-stdbg text-stdink' : 'bg-fastbg text-fastink',
          ].join(' ')}
        >
          {action.tone === 'warn' ? (
            <Warn size={13} className="shrink-0" />
          ) : (
            <Check size={13} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1">{action.text}</span>
        </div>
      )}

      {voice.transcript.length > 0 && (
        <div
          ref={scroller}
          className={[
            'mt-3 overflow-y-auto border-t border-line pt-3',
            // In a side column there is real height to use; stacked
            // above content, a long transcript would push the claim
            // off the screen.
            tall ? 'max-h-[180px] lg:max-h-[52vh]' : 'max-h-[180px]',
          ].join(' ')}
        >
          <div className="flex flex-col gap-2">
            {voice.transcript.map((t, i) => (
              <div key={i} className="flex gap-2 text-[12.5px] leading-[1.5]">
                <span
                  className={[
                    'w-[52px] shrink-0 text-[11px]',
                    t.role === 'user' ? 'text-faint' : 'text-accentink',
                  ].join(' ')}
                >
                  {t.role === 'user' ? 'You' : 'Clearing'}
                </span>
                <span className="min-w-0 flex-1 text-ink2">{t.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {voice.status === 'ended' && (
        <button
          type="button"
          onClick={onEnd}
          className="mt-3 rounded-lg border border-line bg-card px-3 py-[6px] text-[12px] font-medium text-ink2 transition-colors hover:border-faint"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}
