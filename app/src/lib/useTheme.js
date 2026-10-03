import { useEffect, useState } from 'react'

/**
 * Theme preference, remembered per browser.
 *
 * Three states, matching how the CSS is structured:
 *   'light'  → stamps data-theme="light", beats a dark OS
 *   'dark'   → stamps data-theme="dark", beats a light OS
 *   'system' → stamps nothing, so prefers-color-scheme decides
 *
 * Returns the raw preference (what the toggle highlights) and the
 * resolved theme (what is actually on screen), because they differ
 * whenever the preference is 'system'.
 */
export default function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('theme')
      return saved === 'light' || saved === 'dark' ? saved : 'system'
    } catch {
      return 'system'
    }
  })

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  )

  // Track the OS preference so 'system' updates live rather than only
  // on reload.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* private mode — the page still renders correctly */
    }
  }, [theme])

  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  return { theme, resolved, setTheme }
}
