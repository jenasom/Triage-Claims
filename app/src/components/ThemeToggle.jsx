import { Sun, Moon, Monitor } from './Icons'

const OPTIONS = [
  { key: 'light', icon: Sun, label: 'Light' },
  { key: 'dark', icon: Moon, label: 'Dark' },
  { key: 'system', icon: Monitor, label: 'System' },
]

/**
 * Three-state theme control.
 *
 * System is a real option, not an absence of one — most people want the
 * app to follow their OS, and making that explicit means the choice is
 * visible rather than inferred from "neither button is active".
 */
export default function ThemeToggle({ theme, onChange }) {
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex gap-[3px] rounded-[9px] bg-linesoft p-[3px]"
    >
      {OPTIONS.map(({ key, icon: Icon, label }) => {
        const active = theme === key
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={active}
            title={`${label} theme`}
            className={[
              'grid h-[26px] w-[28px] place-items-center rounded-md transition-colors',
              active
                ? 'bg-card text-ink shadow-[0_1px_2px_rgba(20,16,15,.06)]'
                : 'text-muted hover:text-ink',
            ].join(' ')}
          >
            <Icon size={14} />
            <span className="sr-only">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
