import { band } from '../lib/triage'

const TONE = {
  lo: { bar: 'bg-fast', text: 'text-fastink' },
  md: { bar: 'bg-std',  text: 'text-stdink' },
  hi: { bar: 'bg-inv',  text: 'text-invink' },
}

/**
 * A score as number plus meter. The meter lets a reviewer scan a
 * column without reading every digit; the number is there when the
 * exact value matters.
 */
export default function ScoreCell({ value, label }) {
  /**
   * Not scored yet — a provisional claim held pending documents.
   * A dash rather than a zero: zero would read as "no risk found",
   * which is a conclusion nobody has reached.
   */
  if (value === null || value === undefined) {
    return (
      <span
        className="inline-flex min-w-[38px] justify-center text-[12.5px] font-semibold leading-none text-faint"
        title={label ? `${label}: not assessed yet` : 'Not assessed yet'}
      >
        —
      </span>
    )
  }

  const tone = TONE[band(value)]
  return (
    <span className="inline-flex min-w-[38px] flex-col items-center gap-1" title={label ? `${label}: ${value}` : undefined}>
      <span className={`text-[12.5px] font-semibold leading-none tabular-nums ${tone.text}`}>{value}</span>
      <span className="h-[3px] w-[38px] overflow-hidden rounded-sm bg-line">
        <span className={`block h-full rounded-sm ${tone.bar}`} style={{ width: `${value}%` }} />
      </span>
    </span>
  )
}
