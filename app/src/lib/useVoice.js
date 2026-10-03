import { useCallback, useEffect, useRef, useState } from 'react'
import { transcribeAudio, speakText } from './api'

/**
 * Recording and playback for the intake conversation.
 *
 * Recording uses MediaRecorder, which every current browser supports —
 * unlike the Web Speech API, which is Chrome-only. The audio goes to
 * our server and on to Fish Audio, so the API key is never in the page.
 *
 * Playback is deliberately one utterance at a time: a new reply stops
 * the previous one rather than talking over it.
 */

/** Pick a container the browser will actually produce. */
function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? ''
}

export default function useVoice({ enabled = true } = {}) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState(null)
  const [level, setLevel] = useState(0)

  const recorder = useRef(null)
  const chunks = useRef([])
  const stream = useRef(null)
  const audioCtx = useRef(null)
  const raf = useRef(null)
  const player = useRef(null)
  const cancelled = useRef(false)

  const supported =
    typeof window !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'

  /** Release the microphone and stop the level meter. */
  const teardown = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = null
    audioCtx.current?.close().catch(() => {})
    audioCtx.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    setLevel(0)
  }, [])

  useEffect(() => () => {
    teardown()
    player.current?.pause()
  }, [teardown])

  /**
   * Drive a simple input-level meter, so the claimant can see the mic
   * is live. Without it a silent recording looks identical to a broken
   * one.
   */
  function meter(src) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    audioCtx.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(src).connect(analyser)

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
      setLevel(Math.min(1, peak / 64))
      raf.current = requestAnimationFrame(tick)
    }
    tick()
  }

  const start = useCallback(async () => {
    if (!supported || !enabled || recording) return
    setError(null)
    cancelled.current = false

    try {
      const src = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      stream.current = src

      const mimeType = pickMimeType()
      const rec = new MediaRecorder(src, mimeType ? { mimeType } : undefined)
      recorder.current = rec
      chunks.current = []

      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data)
      }
      rec.start()
      meter(src)
      setRecording(true)
    } catch (err) {
      // The common case by far is the permission prompt being declined.
      setError(
        err.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser settings to use voice.'
          : 'Could not start recording.',
      )
      teardown()
    }
  }, [supported, enabled, recording, teardown])

  /**
   * Stop and transcribe. Resolves with the text, or null if the
   * recording was cancelled or nothing was heard.
   */
  const stop = useCallback(async () => {
    const rec = recorder.current
    if (!rec || rec.state === 'inactive') return null

    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' }))
      rec.stop()
    })

    teardown()
    setRecording(false)
    recorder.current = null

    if (cancelled.current) return null

    // A tap rather than a hold — too short to contain speech.
    if (blob.size < 2000) {
      setError('That was too short. Hold the button while you speak.')
      return null
    }

    setTranscribing(true)
    try {
      const { text } = await transcribeAudio(blob)
      return text || null
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setTranscribing(false)
    }
  }, [teardown])

  /** Abandon the recording without transcribing it. */
  const cancel = useCallback(() => {
    cancelled.current = true
    if (recorder.current?.state !== 'inactive') recorder.current?.stop()
    teardown()
    setRecording(false)
    recorder.current = null
  }, [teardown])

  /** Speak a reply, replacing anything already playing. */
  const say = useCallback(async (text) => {
    if (!text) return
    player.current?.pause()

    try {
      const blob = await speakText(text)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      player.current = audio

      audio.onended = () => {
        setSpeaking(false)
        URL.revokeObjectURL(url)
      }
      audio.onerror = () => {
        setSpeaking(false)
        URL.revokeObjectURL(url)
      }

      setSpeaking(true)
      await audio.play()
    } catch (err) {
      // Playback failing should never interrupt the conversation — the
      // reply is on screen either way.
      setSpeaking(false)
      if (err.name !== 'NotAllowedError') setError(err.message)
    }
  }, [])

  const hush = useCallback(() => {
    player.current?.pause()
    setSpeaking(false)
  }, [])

  return {
    supported,
    recording,
    transcribing,
    speaking,
    level,
    error,
    clearError: () => setError(null),
    start,
    stop,
    cancel,
    say,
    hush,
  }
}
