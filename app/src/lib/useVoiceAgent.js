import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live voice conversation with the intake agent.
 *
 * Opens one WebSocket to our server, streams microphone audio up, and
 * plays synthesised speech back. Our server holds the Deepgram
 * connection and runs the claim tools, so nothing here needs a key and
 * the agent's guardrails stay server-side.
 *
 * Audio is linear16 PCM at 24kHz in both directions — the format agreed
 * in the Settings frame. The browser gives Float32 at the device's own
 * rate, so both conversion and resampling happen here.
 */

const SAMPLE_RATE = 24000

/** Float32 [-1,1] → linear16 PCM, which is what Deepgram expects. */
function toPCM16(float32) {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/**
 * Queue for incoming speech.
 *
 * Audio arrives faster than it plays, so chunks are scheduled back to
 * back on the AudioContext clock rather than played on arrival — which
 * would overlap them into noise.
 */
function createPlayer(ctx) {
  let nextStart = 0

  return {
    play(pcm16) {
      const float32 = new Float32Array(pcm16.length)
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768

      const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE)
      buffer.copyToChannel(float32, 0)

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)

      // Never schedule in the past; a late chunk starts now.
      nextStart = Math.max(nextStart, ctx.currentTime)
      source.start(nextStart)
      nextStart += buffer.duration

      return source
    },
    /** Drop anything queued — the caller interrupted. */
    reset() {
      nextStart = 0
    },
    get speaking() {
      return nextStart > ctx.currentTime
    },
  }
}

/**
 * @param sessionId   Intake session to attach to. Omit for agents that
 *                    identify the caller during the call instead.
 * @param path        WebSocket endpoint. Defaults to voice intake.
 * @param requireSession  Whether a sessionId is needed before dialling.
 * @param onMessage   Messages this hook does not itself handle, so a
 *                    caller can act on agent-specific ones.
 */
export default function useVoiceAgent({
  sessionId,
  onStateChange,
  onMessage,
  path = '/api/voice-agent',
  requireSession = true,
} = {}) {
  const [status, setStatus] = useState('idle') // idle | connecting | live | ended
  const [error, setError] = useState(null)
  const [level, setLevel] = useState(0)
  const [transcript, setTranscript] = useState([])
  const [speaking, setSpeaking] = useState(false)
  /** The most recent tool the agent called, for the call panel. */
  const [activity, setActivity] = useState(null)

  const ws = useRef(null)
  const stream = useRef(null)
  const inputCtx = useRef(null)
  const outputCtx = useRef(null)
  const player = useRef(null)
  const processor = useRef(null)
  const sources = useRef([])

  const teardown = useCallback(() => {
    sources.current.forEach((s) => {
      try {
        s.stop()
      } catch {
        /* already finished */
      }
    })
    sources.current = []

    processor.current?.disconnect()
    processor.current = null

    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null

    inputCtx.current?.close().catch(() => {})
    inputCtx.current = null
    outputCtx.current?.close().catch(() => {})
    outputCtx.current = null
    player.current = null

    if (ws.current?.readyState === WebSocket.OPEN) ws.current.close()
    ws.current = null

    setLevel(0)
    setSpeaking(false)
  }, [])

  useEffect(() => () => teardown(), [teardown])

  const start = useCallback(async () => {
    if (status === 'connecting' || status === 'live') return
    if (requireSession && !sessionId) return

    setStatus('connecting')
    setError(null)
    setTranscript([])
    setActivity(null)

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      stream.current = mic

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      const socket = new WebSocket(`${proto}://${window.location.host}${path}${query}`)
      socket.binaryType = 'arraybuffer'
      ws.current = socket

      const outCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      })
      outputCtx.current = outCtx
      player.current = createPlayer(outCtx)

      socket.onopen = () => {
        // Capture at the agreed rate so no resampling is needed.
        const inCtx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: SAMPLE_RATE,
        })
        inputCtx.current = inCtx

        const source = inCtx.createMediaStreamSource(mic)
        // ScriptProcessor is deprecated but universally supported;
        // AudioWorklet needs a separate module file and buys little here.
        const node = inCtx.createScriptProcessor(4096, 1, 1)
        processor.current = node

        node.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0)

          let peak = 0
          for (const v of input) peak = Math.max(peak, Math.abs(v))
          setLevel(Math.min(1, peak * 3))

          // Talking over the agent stops its playback, the way a person
          // stops when interrupted.
          if (peak > 0.15 && player.current?.speaking) {
            socket.send(JSON.stringify({ type: 'interrupt' }))
            sources.current.forEach((s) => {
              try {
                s.stop()
              } catch {
                /* already finished */
              }
            })
            sources.current = []
            player.current.reset()
          }

          if (socket.readyState === WebSocket.OPEN) socket.send(toPCM16(input).buffer)
        }

        source.connect(node)
        node.connect(inCtx.destination)
      }

      socket.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          const src = player.current?.play(new Int16Array(e.data))
          if (src) {
            sources.current.push(src)
            setSpeaking(true)
            src.onended = () => {
              sources.current = sources.current.filter((s) => s !== src)
              if (!player.current?.speaking) setSpeaking(false)
            }
          }
          return
        }

        let msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }

        switch (msg.type) {
          case 'ready':
            setStatus('live')
            break
          case 'transcript':
            setTranscript((t) => [...t, { role: msg.role, text: msg.text }])
            break
          case 'state':
            onStateChange?.(msg)
            break
          /**
           * What the agent did, not just what it said.
           *
           * A spoken "let me submit that for you" is the only signal a
           * caller otherwise gets, and speech is easy to mishear or
           * miss entirely. Showing the actual tool call means the
           * claimant can see a submission happened — and, when it was
           * refused, that it did not.
           */
          case 'tool':
            setActivity({ tool: msg.tool, result: msg.result, at: Date.now() })
            onMessage?.(msg)
            break
          case 'error':
            setError(msg.message)
            break
          case 'closed':
            setStatus('ended')
            break
          default:
            // Agent-specific messages — the status agent's `claim`,
            // for one — are handed on rather than dropped.
            onMessage?.(msg)
            break
        }
      }

      socket.onerror = () => setError('The voice connection failed.')
      socket.onclose = () => {
        setStatus((s) => (s === 'ended' ? s : 'ended'))
        teardown()
      }
    } catch (err) {
      setError(
        err.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser settings to use voice.'
          : 'Could not start the voice conversation.',
      )
      setStatus('idle')
      teardown()
    }
  }, [status, sessionId, teardown, onStateChange, onMessage, path, requireSession])

  const stop = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'stop' }))
    }
    setStatus('ended')
    teardown()
  }, [teardown])

  return {
    status,
    live: status === 'live',
    connecting: status === 'connecting',
    speaking,
    level,
    transcript,
    activity,
    error,
    clearError: () => setError(null),
    start,
    stop,
  }
}
