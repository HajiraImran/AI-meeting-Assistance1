import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'
import { isQuestionByModel, isThoughtComplete } from './backend.js'

// ---------------------------------------------------------------------------
// DUAL-STREAM transcription. Two independent Deepgram Flux connections run at
// once — one for the CLIENT (system audio) and one for the VENDOR (microphone).
// Because the two voices arrive on physically separate streams, who-said-what
// is known by SOURCE (no diarization guessing). Each stream's EndOfTurn is the
// turn authority for that role. Turns are emitted tagged with their role and
// the app interleaves them into one shared conversation by completion order.
// ---------------------------------------------------------------------------

function isQuestion(text) {
  const t = text.trim().toLowerCase()
  if (t.includes('?')) return true
  return /^(what|how|why|when|where|who|which|whose|can|could|would|should|do|does|did|is|are|was|were|will|have|has|any|got|tell me|explain|give me|walk me)\b/.test(t)
}

function questionFromTurn(text) {
  const sentences = (text.match(/[^.!?]+[.!?]?/g) || [text]).map((s) => s.trim()).filter(Boolean)
  if (!sentences.length) return text.trim()
  const questions = sentences.filter((s) => isQuestion(s))
  if (questions.length) return questions.join(' ').trim()
  const last = sentences[sentences.length - 1]
  return last.length > 240 ? last.slice(-240) : last
}

function endpointLooksAmbiguous(text) {
  const t = (text || '').trim()
  if (!t) return false
  const words = t.toLowerCase().replace(/[",:;\-]+$/, '').split(/\s+/).filter(Boolean)
  const last = words[words.length - 1] || ''
  const AMBIG_TAIL = new Set([
    'and', 'or', 'but', 'so', 'because', 'that', 'which', 'to', 'of', 'for',
    'with', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'will',
    'would', 'can', 'could', 'should', 'my', 'our', 'your', 'we', 'i', 'they',
    'like', 'just', 'really', 'want', 'need', 'give', 'provide', 'make', 'get',
  ])
  if (/[.?!]$/.test(t)) return false
  if (AMBIG_TAIL.has(last)) return true
  if (words.length < 3) return true
  return false
}

async function mintToken() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/deepgram-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(data.error || 'no token in response')
  return data.access_token
}

// Audio source for a role. 'client' = system audio (loopback), 'vendor' = mic.
async function getStream(role, onStatus) {
  if (role === 'vendor') {
    onStatus?.('Requesting microphone…')
    try {
      // Strong echo cancellation so the mic doesn't pick up the client's voice
      // from the speakers/meeting app. echoCancellationType:'system' uses the
      // OS/Chromium AEC (stronger than the default), plus legacy google flags.
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          echoCancellationType: 'system',
          googEchoCancellation: true,
          googAutoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googExperimentalEchoCancellation: true,
        },
      })
    } catch (e) {
      // Fall back to basic constraints if the advanced ones are rejected.
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (e2) {
        throw new Error('Microphone blocked: ' + e2.message)
      }
    }
  }
  onStatus?.('Capturing system audio…')
  let display
  try {
    await window.api.enableLoopback()
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (e) {
    try { await window.api.disableLoopback() } catch {}
    throw new Error('System audio capture failed: ' + e.message)
  }
  try { await window.api.disableLoopback() } catch {}
  const audioTracks = display.getAudioTracks()
  display.getVideoTracks().forEach((t) => t.stop())
  if (!audioTracks.length) {
    throw new Error('No system audio captured — on macOS grant Screen Recording permission and make sure audio is playing')
  }
  return new MediaStream(audioTracks)
}

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

// Root-mean-square energy of a frame (how loud it is, 0..1-ish).
function rms(float32) {
  let sum = 0
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i]
  return Math.sqrt(sum / float32.length)
}

// Shared duck gate. When the CLIENT (system audio) is actively speaking, the
// mic is almost certainly hearing an echo of that same voice — so we suppress
// the mic (send silence) unless the mic is clearly LOUDER than a plausible echo
// (i.e. you're genuinely talking, even over them). This removes the duplicate
// at the audio level, before it can be transcribed as "You".
const duck = { clientLoudUntil: 0 }
const CLIENT_ACTIVE = 0.012   // client considered "speaking" above this RMS
const VENDOR_OVERRIDE = 0.045 // mic this loud = you're really talking → let through
const SILENCE = new ArrayBuffer(4096 * 2) // zero PCM frame

// Wires one role's audio stream into its own Flux connection. Returns a stop fn.
async function startRolePipeline(role, onStatus, onError) {
  const token = await mintToken()
  const stream = await getStream(role, onStatus)

  const result = await window.api.dgStart(role, token)
  if (!result?.ok) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error((role === 'vendor' ? 'Mic' : 'System') + ' connection failed: ' + (result?.error || 'unknown'))
  }

  const audioCtx = new AudioContext({ sampleRate: 16000 })
  const srcNode = audioCtx.createMediaStreamSource(stream)
  const processor = audioCtx.createScriptProcessor(4096, 1, 1)
  srcNode.connect(processor)
  processor.connect(audioCtx.destination)
  processor.onaudioprocess = (e) => {
    const frame = e.inputBuffer.getChannelData(0)
    const energy = rms(frame)

    if (role === 'client') {
      // Track when the client is speaking so the mic can duck to its echo.
      if (energy > CLIENT_ACTIVE) duck.clientLoudUntil = Date.now() + 250
      window.api.dgAudio('client', floatToPcm16(frame))
    } else {
      // Vendor mic: if the client is currently speaking and the mic isn't
      // clearly louder than a plausible echo, send silence (suppress the echo).
      const clientSpeaking = Date.now() < duck.clientLoudUntil
      if (clientSpeaking && energy < VENDOR_OVERRIDE) {
        window.api.dgAudio('vendor', SILENCE.slice(0))
      } else {
        window.api.dgAudio('vendor', floatToPcm16(frame))
      }
    }
  }

  return function stopRole() {
    try { processor.disconnect() } catch {}
    try { srcNode.disconnect() } catch {}
    try { audioCtx.close() } catch {}
    stream.getTracks().forEach((t) => t.stop())
  }
}

// Starts BOTH pipelines. Callbacks receive a `role` ('client' | 'vendor').
export async function startTranscription({ onTranscript, onTurn, onQuestion, onStatus, onError }) {
  // Per-role turn sequencing so a late fallback can't fire a stale turn.
  const seq = { client: 0, vendor: 0 }

  window.api.onDgTranscript(async (d) => {
    const role = d.role || 'client'
    if (d.interim) { onTranscript?.(role, d.text, false); return }
    if (d.turnResumed) return
    if (d.endOfTurn) {
      const text = (d.text || '').trim()
      if (!text) return
      onTranscript?.(role, text, true)

      // Ambiguous endpoint → lightweight semantic completion check (logged).
      if (endpointLooksAmbiguous(text)) {
        const t0 = performance.now()
        const complete = await isThoughtComplete(text)
        console.log(`[turn-fallback] role=${role} | verdict=${complete ? 'COMPLETE' : 'INCOMPLETE'} | ${Math.round(performance.now() - t0)}ms | text="${text}"`)
        if (!complete) { onTranscript?.(role, text, false); return }
      }

      const myTurn = ++seq[role]
      onTurn?.(role, text) // the app records CLIENT:/VENDOR: and decides what to do
      // Only the client's speech is auto-answered in the Q&A feed.
      if (role === 'client') {
        const q = questionFromTurn(text)
        if (q) {
          let ok = isQuestion(q)
          if (!ok) ok = await isQuestionByModel(q)
          if (ok && myTurn === seq[role]) onQuestion?.(q)
        }
      }
    }
  })
  window.api.onDgStatus((s) => onStatus?.(s))
  window.api.onDgError((m) => onError?.(m))

  // Per-role silent reconnect on drop.
  window.api.onDgReconnect(async (role) => {
    try {
      const token = await mintToken()
      await window.api.dgReopen(role || 'client', token)
    } catch {
      onError?.('Reconnect failed — press Stop and Start to resume')
    }
  })

  // Start client (system audio) and vendor (mic) pipelines. If system audio
  // fails (e.g. no permission), continue vendor-only rather than aborting.
  const stops = []
  let clientOk = false
  try { stops.push(await startRolePipeline('client', onStatus, onError)); clientOk = true }
  catch (e) { onError?.('Client audio: ' + e.message) }
  try { stops.push(await startRolePipeline('vendor', onStatus, onError)) }
  catch (e) { onError?.('Vendor mic: ' + e.message) }

  if (!stops.length) throw new Error('Could not start any audio source')
  onStatus?.(clientOk ? 'Listening to both sides' : 'Listening (mic only)')

  return function stop() {
    stops.forEach((fn) => { try { fn() } catch {} })
    window.api.dgStop()
    window.api.offDg?.()
  }
}
