import { naira } from '../../lib/triage'

/**
 * What the agent has recorded so far.
 *
 * Without this the claimant has no way to check a detail short of
 * asking, and no way to notice a misheard plate until it contradicts a
 * document. Correcting is done by saying so — tapping a row drops a
 * correction into the message box rather than opening an edit form,
 * because the agent already handles corrections in conversation and a
 * second editing path would be a second source of truth.
 */

const FIELDS = [
  { id: 'claimant', label: 'Name' },
  { id: 'plate', label: 'Registration' },
  { id: 'incidentDate', label: 'Incident date' },
  { id: 'amount', label: 'Repair cost', format: (v) => naira(Number(v)) },
  { id: 'vehicleMake', label: 'Make' },
  { id: 'vehicleModel', label: 'Model' },
  { id: 'vehicleYear', label: 'Year' },
  { id: 'insuredValue', label: 'Insured value', format: (v) => naira(Number(v)) },
  { id: 'incidentDescription', label: 'What happened' },
]

export default function ClaimSummary({ claim = {}, onCorrect, disabled }) {
  const rows = FIELDS.filter(
    (f) => claim[f.id] !== undefined && String(claim[f.id]).trim() !== '',
  )

  if (rows.length === 0) {
    return (
      <p className="m-0 text-[12px] leading-[1.5] text-faint">
        Nothing recorded yet. Details appear here as you give them, and you can
        tap any of them to correct it.
      </p>
    )
  }

  return (
    <dl className="m-0 flex flex-col gap-1.5">
      {rows.map((f) => {
        const raw = claim[f.id]
        const shown = f.format ? f.format(raw) : String(raw)
        return (
          <div key={f.id} className="flex items-baseline gap-2">
            <dt className="w-[92px] shrink-0 text-[11px] text-faint">{f.label}</dt>
            <dd className="m-0 min-w-0 flex-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCorrect?.(f.label)}
                title={disabled ? undefined : `Correct ${f.label.toLowerCase()}`}
                className="w-full truncate rounded px-1 py-0.5 text-left text-[12px] text-ink2 transition-colors hover:not-disabled:bg-linesoft disabled:cursor-default"
              >
                {shown}
              </button>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
