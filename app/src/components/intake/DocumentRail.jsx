import { useRef, useState } from 'react'
import { Check, Plus, Warn, Chevron } from '../Icons'
import { MOTOR } from '../../data/motorConfig'

/**
 * The document checklist.
 *
 * Always visible, so the customer can see what remains without asking.
 * Each row is its own upload target — tapping one opens the picker for
 * that specific document, which is clearer on a phone than a single
 * generic button plus a question about what was just sent.
 *
 * Rows expand to show what was actually read from the document. A
 * claimant whose plate was misread should be able to see that by
 * looking, not by waiting for the agent to contradict them.
 */

/** Field ids → what a person calls them. */
const FIELD_LABELS = {
  date: 'Date',
  reference_number: 'Reference',
  station: 'Station',
  plate: 'Plate',
  description: 'Description',
  visible_damage: 'Damage',
  name: 'Name',
  licence_number: 'Licence no.',
  expiry_date: 'Expires',
  owner_name: 'Owner',
  make: 'Make',
  model: 'Model',
  year: 'Year',
  garage_name: 'Garage',
  amount: 'Amount',
}

const label = (id) => FIELD_LABELS[id] ?? id.replace(/_/g, ' ')

function Row({ doc, state, onPick, disabled }) {
  const gallery = useRef(null)
  const camera = useRef(null)
  const [open, setOpen] = useState(false)

  const status = state?.readable === false ? 'unreadable' : state ? 'ok' : 'missing'
  const fields = Object.entries(state?.fields ?? {})

  const tone = {
    ok: 'border-line bg-card',
    unreadable: 'border-stdink/40 bg-stdbg',
    missing: 'border-dashed border-line bg-card',
  }[status]

  const Icon = status === 'ok' ? Check : status === 'unreadable' ? Warn : Plus
  const iconTone = {
    ok: 'text-fast',
    unreadable: 'text-stdink',
    missing: 'text-faint',
  }[status]

  const pick = (e) => {
    const file = e.target.files?.[0]
    if (file) onPick(doc.id, file)
    e.target.value = ''
  }

  return (
    <li className={`rounded-[9px] border ${tone}`}>
      {/* Gallery picker, and a separate camera input — `capture` on a
          single input would remove the option to choose an existing
          photo, which matters when the damage was photographed earlier. */}
      <input ref={gallery} type="file" accept="image/*,application/pdf" className="hidden" onChange={pick} />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={pick}
      />

      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Icon size={14} className={`mt-0.5 shrink-0 ${iconTone}`} />

        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink2">{doc.label}</div>

          {status === 'ok' && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="mt-0.5 flex items-center gap-1 text-[11px] text-faint hover:text-ink2"
            >
              <Chevron
                size={10}
                className={`transition-transform ${open ? 'rotate-90' : ''}`}
              />
              {fields.length} field{fields.length === 1 ? '' : 's'} read
            </button>
          )}
          {status === 'unreadable' && (
            <div className="mt-0.5 text-[11px] text-stdink">
              {state.reason ?? 'Could not be read'}
            </div>
          )}
          {status === 'missing' && (
            <div className="mt-0.5 text-[11px] text-faint">Not uploaded yet</div>
          )}
        </div>

        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => camera.current?.click()}
            title="Take a photo"
            aria-label={`Take a photo of your ${doc.label.toLowerCase()}`}
            className="grid h-[26px] w-[26px] place-items-center rounded-md border border-line bg-card text-muted transition-colors hover:not-disabled:border-faint hover:not-disabled:text-ink2 disabled:cursor-not-allowed disabled:opacity-50 sm:hidden"
          >
            <CameraGlyph />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => gallery.current?.click()}
            className="rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink2 transition-colors hover:not-disabled:border-faint disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state ? 'Replace' : 'Upload'}
          </button>
        </div>
      </div>

      {open && fields.length > 0 && (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-line px-3 py-2.5">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[11px] text-faint">{label(k)}</dt>
              <dd className="m-0 truncate text-[11px] text-ink2" title={String(v)}>
                {String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

function CameraGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </svg>
  )
}

/**
 * Shared by the desktop rail and the mobile sheet.
 */
export function DocumentList({ extracted = {}, onPick, busy }) {
  return (
    <ul className="flex list-none flex-col gap-1.5 p-0">
      {MOTOR.requiredDocuments.map((doc) => (
        <Row key={doc.id} doc={doc} state={extracted[doc.id]} onPick={onPick} disabled={busy} />
      ))}
    </ul>
  )
}

/** Progress bar plus counts — shared by both layouts. */
export function Progress({ extracted = {}, completeness = 0 }) {
  const done = MOTOR.requiredDocuments.filter(
    (d) => extracted[d.id] && extracted[d.id].readable !== false,
  ).length

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink2">
          {done} of {MOTOR.requiredDocuments.length} documents
        </span>
        <span className="text-[12px] font-semibold tabular-nums text-accentink">
          {completeness}%
        </span>
      </div>
      <div className="mt-2 h-[5px] overflow-hidden rounded-full bg-linesoft">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${completeness}%` }}
        />
      </div>
    </div>
  )
}

