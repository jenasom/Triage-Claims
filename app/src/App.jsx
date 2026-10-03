import { useEffect, useState } from 'react'
import Dashboard from './Dashboard'
import IntakeChat from './components/intake/IntakeChat'
import ClaimStatus from './components/status/ClaimStatus'
import Landing from './components/Landing'
import useTheme from './lib/useTheme'

/**
 * Four views, one app.
 *
 * Clearing has two dashboards because it has two audiences: the
 * claimant tracking one claim, and the supervisor working the queue.
 * The app opens on a chooser rather than dropping either of them into
 * the other's tool.
 *
 * Routing is a hash check rather than a router dependency — the view
 * count is small, and a library to switch between them would be more
 * machinery than the problem needs. The hash means a claimant can
 * bookmark #/status and a supervisor #/staff.
 */

const VIEWS = {
  '#/claim': 'intake',
  '#/status': 'status',
  '#/staff': 'staff',
}

function currentView() {
  return VIEWS[window.location.hash] ?? 'landing'
}

const HASHES = {
  intake: '#/claim',
  status: '#/status',
  staff: '#/staff',
  landing: '',
}

export default function App() {
  const [view, setView] = useState(currentView)

  /**
   * A claim being finished rather than started.
   *
   * Set when the claimant chooses to supply an outstanding document
   * from their claim page — by tapping the prompt, or by telling the
   * voice agent they want to send one. Carries the access token they
   * already hold, so intake resumes the existing claim instead of
   * opening a new one.
   */
  const [continuing, setContinuing] = useState(null)

  // Mounted once here so every view shares one instance and the
  // preference survives switching between them.
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    const onHash = () => setView(currentView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (next) => {
    const hash = HASHES[next] ?? ''
    // Clearing the hash with `location.hash = ''` leaves a bare '#'
    // behind and fires no hashchange, so the history entry is replaced
    // instead — otherwise "back to home" leaves the URL looking used.
    if (hash) window.location.hash = hash
    else window.history.replaceState(null, '', window.location.pathname)
    setView(next)
  }

  if (view === 'intake') {
    return (
      <IntakeChat
        continuing={continuing}
        onExit={() => {
          setContinuing(null)
          go('landing')
        }}
        onTrack={() => {
          setContinuing(null)
          go('status')
        }}
      />
    )
  }

  if (view === 'status') {
    return (
      <ClaimStatus
        onExit={() => go('landing')}
        onNewClaim={() => {
          setContinuing(null)
          go('intake')
        }}
        onContinue={(token, documentType) => {
          setContinuing({ token, documentType })
          go('intake')
        }}
      />
    )
  }

  if (view === 'staff') {
    return (
      <Dashboard onExit={() => go('landing')} theme={theme} setTheme={setTheme} />
    )
  }

  return (
    <Landing
      onClaimant={() => go('status')}
      onStaff={() => go('staff')}
      onNewClaim={() => go('intake')}
      theme={theme}
      setTheme={setTheme}
    />
  )
}
