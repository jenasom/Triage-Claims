/**
 * Line icons, 24-grid, inheriting currentColor.
 * Kept in one file so stroke weight and grid stay consistent.
 */
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

const make = (path, sw) => function Icon({ size = 16, className = '' }) {
  return (
    <svg {...base} strokeWidth={sw ?? base.strokeWidth} width={size} height={size} className={className} aria-hidden="true">
      {path}
    </svg>
  )
}

export const Grid = make(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
)

export const List = make(<path d="M4 6h10M4 12h16M4 18h7" />)


export const Shield = make(<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />)


export const Gear = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4l2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </>,
)

export const Doc = make(
  <>
    <path d="M4 19V6a2 2 0 012-2h8l6 6v9a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    <path d="M14 4v6h6" />
  </>,
)
export const Check = make(<path d="M5 13l4 4L19 7" />)
export const Clock = make(<><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /></>)
export const Search = make(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>)
export const Chevron = make(<path d="M9 6l6 6-6 6" />)
export const UpDown = make(<path d="M8 9l4-4 4 4M8 15l4 4 4-4" />)
export const Plus = make(<path d="M12 5v14M5 12h14" />)
export const Warn = make(<><path d="M12 3.5L21.5 20H2.5z" /><path d="M12 10v4M12 17h.01" /></>, 2.2)
export const CheckCircle = make(<><circle cx="12" cy="12" r="9" /><path d="M8 12.2l2.8 2.8L16 9.5" /></>, 2.2)
export const Monitor = make(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
)
export const Sun = make(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
)
export const Moon = make(<path d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" />)
