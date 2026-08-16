import { useEffect, useRef, useState } from 'react'
import { ask, askStream, generateNotes, summarizeMemory, guidedLine } from './backend.js'
import { parseFile } from './parse.js'
import { startTranscription } from './transcription.js'
import { downloadNotesPdf } from './pdf.js'

export default function App() {
  const [view, setView] = useState('setup') // 'setup' | 'session'

  // Session setup: one combined system prompt (like a ChatGPT system prompt).
  const [systemPrompt, setSystemPrompt] = useState('')
  const [docs, setDocs] = useState([])
  const [parsing, setParsing] = useState(false)
  const blueprintRef = useRef('') // reserved (blueprint feature retired from UI)
  const briefRef = useRef('')

  // Manual ask.
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loading, setLoading] = useState(false)

  // Transcription + auto-answers.
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [feed, setFeed] = useState([]) // [{ id, q, a, loading }]
  const [micStatus, setMicStatus] = useState('')
  const [micError, setMicError] = useState('')
  const [notes, setNotes] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)
  const [sessions, setSessions] = useState([]) // saved session list
  const [saved, setSaved] = useState(null)      // opened saved session
  const [guidedMode, setGuidedMode] = useState(false) // live word-for-word coaching
  const [stage, setStage] = useState('')          // current meeting stage
  const [guidedScript, setGuidedScript] = useState([]) // all lines this session, in order
  const [convo, setConvo] = useState([]) // running both-sided transcript for display
  const [clientSaid, setClientSaid] = useState('')// what the client just said
  const [sayLoading, setSayLoading] = useState(false)
  const guidedModeRef = useRef(false)
  const clientBufferRef = useRef('') // accumulates a long client turn's chunks
  const genThisTurnRef = useRef(false) // already generated for the current client turn
  const turnCloseRef = useRef(null) // closes a client turn after silence (vendor-independent)
  const echoGuardRef = useRef([]) // recent turns per stream, to drop cross-stream echo
  const suggestTimerRef = useRef(null)
  const suggSeqRef = useRef(0) // discards stale suggestions when speech resumes
  const suggestionLogRef = useRef([]) // all guided lines for the saved session
  const feedEndRef = useRef(null)     // scroll anchor to keep newest answer in view
  const guideEndRef = useRef(null)    // scroll anchor for the live script
  const convoEndRef = useRef(null)    // scroll anchor for the transcript
  guidedModeRef.current = guidedMode

  // Generate the exact next line to say (guided mode). opts.opening=true at the
  // very start, opts.closing=true to wrap up; otherwise it responds to the
  // client's latest turn. Each line is appended to the session script (kept
  // visible and auto-scrolled), never replacing the earlier ones.
  async function produceGuidedLine(latest, opts) {
    setSayLoading(true)
    const mySeq = ++suggSeqRef.current
    const t0 = performance.now()
    try {
      const r = await guidedLine({
        systemPrompt,
        brief: briefRef.current,
        blueprint: blueprintRef.current,
        summary: summaryRef.current,
        recent: turnsRef.current.join('\n'),
      }, latest, opts)
      const ms = Math.round(performance.now() - t0)
      console.log(`[guided] line generated in ${ms}ms${ms > 3500 ? ' (SLOW — likely model latency or large context)' : ''}`)
      if (r && mySeq === suggSeqRef.current) {
        if (r.malformed || !r.say) {
          console.warn('[guided] suppressed malformed line; kept previous')
        } else {
          const st = opts?.closing ? 'Closing' : (r.stage || '')
          setStage(st)
          const entry = {
            client: (opts?.opening || opts?.closing) ? '' : (latest || ''),
            stage: st,
            say: r.say,
          }
          setGuidedScript((prev) => (
            opts?.replaceLast && prev.length
              ? [...prev.slice(0, -1), entry]   // revise the current turn's line
              : [...prev, entry]                // new line
          ))
          suggestionLogRef.current.push(r.say)
        }
      }
    } finally {
      setSayLoading(false)
    }
  }

  // A suggestion should only be replaced by a genuinely NEW, meaningful client
  // turn — never by filler, acknowledgements, or very short/incomplete speech.
  const ACK = new Set([
    'okay', 'ok', 'right', 'yeah', 'yes', 'sure', 'alright', 'cool', 'fine',
    'thanks', 'thank you', 'yep', 'yup', 'mm', 'mhm', 'uh huh', 'got it', 'no',
    'nope', 'sounds good', 'makes sense', 'perfect', 'great', 'nice', 'good',
  ])
  function isMeaningfulTurn(text) {
    const t = (text || '').trim().toLowerCase().replace(/[.!,]+$/, '')
    if (!t) return false
    if (t.includes('?')) return true            // even short questions matter
    if (ACK.has(t)) return false                // acknowledgement, not a new turn
    const w = t.split(/\s+/).filter(Boolean)
    if (w.length < 3) return false              // too short to warrant a new move
    return true
  }

  // Scroll a container to its own bottom — scoped to the scroll container so it
  // never yanks the whole panel/layout (that caused the jerk), but ALWAYS keeps
  // the newest line in view so the user never has to scroll down manually.
  function scrollToBottom(anchorRef) {
    const anchor = anchorRef.current
    const box = anchor?.parentElement
    if (box) box.scrollTop = box.scrollHeight
  }

  // Auto-scroll the answer feed (normal mode) to the newest card.
  useEffect(() => { scrollToBottom(feedEndRef) }, [feed])

  // Auto-scroll the live guided script to the newest line as the meeting moves.
  useEffect(() => { scrollToBottom(guideEndRef) }, [guidedScript])

  // Auto-scroll the transcript to the newest turn.
  useEffect(() => { scrollToBottom(convoEndRef) }, [convo, transcript])

  const stopRef = useRef(null)
  const sessionRef = useRef({})
  const transcriptLogRef = useRef('') // full running transcript for the summary
  const turnsRef = useRef([])         // recent turns kept verbatim
  const summaryRef = useRef('')       // rolling summary of older turns
  const foldingRef = useRef(false)
  sessionRef.current = {
    systemPrompt,
    docs,
    summary: summaryRef.current,
    recent: turnsRef.current.join('\n'),
  }

  async function handleFiles(fileList) {
    setParsing(true)
    for (const file of Array.from(fileList)) {
      try {
        const text = await parseFile(file)
        setDocs((d) => [...d, { name: file.name, text }])
      } catch (err) {
        setDocs((d) => [...d, { name: `${file.name} — ${err.message}`, text: '', failed: true }])
      }
    }
    setParsing(false)
  }

  // Keep recent turns verbatim; fold older ones into a rolling summary so the
  // context stays small and answer speed stays constant over a long meeting.
  const RECENT_KEEP = 6   // ~3 recent exchanges kept word-for-word
  const FOLD_WHEN = 10    // once this many pile up, summarize the oldest

  function appendTurn(line) {
    turnsRef.current = [...turnsRef.current, line]
    maybeFold()
  }

  async function maybeFold() {
    if (foldingRef.current) return
    if (turnsRef.current.length <= FOLD_WHEN) return
    foldingRef.current = true
    const older = turnsRef.current.slice(0, turnsRef.current.length - RECENT_KEEP)
    const keep = turnsRef.current.slice(turnsRef.current.length - RECENT_KEEP)
    try {
      const newSummary = await summarizeMemory(summaryRef.current, older.join('\n'))
      summaryRef.current = newSummary
      // Drop only the turns we folded (keep any that arrived meanwhile).
      turnsRef.current = turnsRef.current.slice(-Math.max(RECENT_KEEP, turnsRef.current.length - older.length))
    } catch {
      // if summarizing fails, just cap the raw turns so it can't grow forever
      turnsRef.current = keep
    } finally {
      foldingRef.current = false
    }
  }

  async function handleAsk() {
    if (!question.trim() || loading) return
    setLoading(true)
    setAnswer('')
    try {
      const session = { systemPrompt, docs, summary: summaryRef.current, recent: turnsRef.current.join('\n') }
      const a = await askStream(question, session, (partial) => setAnswer(partial), 'assistant')
      appendTurn('Asked: ' + question)
      appendTurn('Me: ' + a)
    } catch (err) {
      setAnswer('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleAsk()
    }
  }

  // A question was detected in the transcript — answer it automatically.
  async function handleAutoQuestion(q, speaker) {
    const id = Date.now() + Math.random()
    const who = speaker != null ? 'Speaker ' + (speaker + 1) : null
    setFeed((f) => [...f, { id, q, a: '', loading: true, who }])
    try {
      const session = { systemPrompt, docs, summary: summaryRef.current, recent: turnsRef.current.join('\n') }
      const a = await askStream(q, session, (partial) => {
        setFeed((f) => f.map((x) => (x.id === id ? { ...x, a: partial, loading: false } : x)))
      }, 'live')
      appendTurn('Me: ' + a) // the question is already recorded via onUtterance
    } catch (err) {
      setFeed((f) => f.map((x) => (x.id === id ? { ...x, a: 'Error: ' + err.message, loading: false } : x)))
    }
  }

  async function toggleListening() {
    if (listening) {
      stopRef.current?.()
      stopRef.current = null
      setListening(false)
      setTranscript('')
      setMicStatus('')
      // Clean up so a pending line-generation timer can't fire after stop, and
      // no stale buffer/echo state leaks into the next Start. (The session's
      // script/transcript are kept — you're only pausing, not ending.)
      clearTimeout(suggestTimerRef.current)
      clearTimeout(turnCloseRef.current)
      clientBufferRef.current = ''
      genThisTurnRef.current = false
      echoGuardRef.current = []
      suggSeqRef.current++ // invalidate any in-flight generation
      return
    }
    setMicError('')
    setMicStatus('Starting…')
    setListening(true)
    try {
      stopRef.current = await startTranscription({
        onTranscript: (role, t) => setTranscript((role === 'vendor' ? 'You: ' : 'Client: ') + t),
        onTurn: (role, text) => {
          // Cross-stream echo filter. In a call (e.g. Google Meet), the client's
          // voice can leak into BOTH the system-audio stream (correctly CLIENT)
          // and the microphone stream (wrongly VENDOR), so the same words get
          // transcribed twice. If this turn closely matches something the OTHER
          // stream just produced, it's an echo — drop it.
          const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
          const nt = norm(text)
          const now = Date.now()
          const recent = echoGuardRef.current.filter((e) => now - e.at < 6000)
          echoGuardRef.current = recent
          const isEcho = recent.some((e) => e.role !== role && (
            e.nt === nt ||
            (nt.length > 12 && (e.nt.includes(nt) || nt.includes(e.nt)))
          ))
          echoGuardRef.current.push({ role, nt, at: now })
          if (isEcho) return // duplicate of the other stream — ignore

          const label = role === 'vendor' ? 'VENDOR' : 'CLIENT'
          transcriptLogRef.current += (transcriptLogRef.current ? '\n' : '') + label + ': ' + text
          appendTurn(label + ': ' + text) // real both-sided conversation memory
          setConvo((c) => [...c, { role, text }]) // running transcript for display

          // A vendor turn (you spoke) closes the client's current turn so the
          // next one starts fresh.
          if (role === 'vendor') {
            clientBufferRef.current = ''
            genThisTurnRef.current = false
            clearTimeout(turnCloseRef.current)
            return
          }

          // CLIENT turn. The principle: DON'T answer at the first little pause.
          // Keep collecting everything the client says — through short mid-thought
          // gaps (breaths, "um", brief stops) — and only generate the line once
          // they've TRULY stopped (a longer silence). So a multi-part question
          // said in flowing parts becomes ONE turn and gets ONE complete line,
          // instead of the first part being answered and the tail answered
          // separately. A genuinely new turn (after the line was given) starts a
          // fresh line and all past lines stay on screen.
          clearTimeout(turnCloseRef.current)
          const meaningful = isMeaningfulTurn(text)
          if (guidedModeRef.current && (meaningful || clientBufferRef.current)) {
            clientBufferRef.current = clientBufferRef.current
              ? clientBufferRef.current + ' ' + text
              : text
            setClientSaid(clientBufferRef.current)
            clearTimeout(suggestTimerRef.current)
            // Each new chunk RESETS this timer — so it only fires once the client
            // has actually been silent for the full window (a real stop).
            suggestTimerRef.current = setTimeout(() => {
              const fullTurn = clientBufferRef.current
              const replaceLast = genThisTurnRef.current // same ongoing turn → revise
              genThisTurnRef.current = true
              produceGuidedLine(fullTurn, { opening: false, replaceLast })
              // After the line is given, a short grace: if the client resumes
              // within it, we revise the same line (still the same thought).
              // After it, the turn closes and the next speech is a NEW line.
              clearTimeout(turnCloseRef.current)
              turnCloseRef.current = setTimeout(() => {
                clientBufferRef.current = ''
                genThisTurnRef.current = false
              }, 3200)
            }, 3200) // only answer once the client has truly stopped talking
          }
        },
        onQuestion: (q) => handleAutoQuestion(q, null),
        onStatus: (s) => setMicStatus(s),
        onError: (e) => setMicError(e),
      })
      // Guided mode: greet with the opening line before the client speaks.
      if (guidedModeRef.current) produceGuidedLine('', { opening: true })
    } catch (err) {
      console.error('Transcription failed:', err)
      setMicError(err.message)
      setMicStatus('')
      setListening(false)
    }
  }

  async function openHistory() {
    const list = (await window.api?.listSessions()) || []
    setSessions(list)
    setView('history')
  }
  async function openSaved(id) {
    const s = await window.api?.getSession(id)
    if (s) { setSaved(s); setView('saved') }
  }
  async function removeSaved(id) {
    await window.api?.deleteSession(id)
    openHistory()
  }

  function resetAll() {
    stopRef.current?.()
    stopRef.current = null
    transcriptLogRef.current = ''
    turnsRef.current = []
    summaryRef.current = ''
    foldingRef.current = false
    setSystemPrompt(''); setDocs([])
    briefRef.current = ''; blueprintRef.current = ''
    setQuestion(''); setAnswer('')
    setListening(false); setTranscript(''); setFeed([])
    setMicStatus(''); setMicError(''); setNotes('')
    clearTimeout(suggestTimerRef.current)
    setGuidedMode(false); setGuidedScript([]); setConvo([]); setStage(''); setClientSaid(''); guidedModeRef.current = false; clientBufferRef.current = ''; genThisTurnRef.current = false; clearTimeout(turnCloseRef.current); echoGuardRef.current = []
    suggestionLogRef.current = []
    setView('setup')
  }

  async function endSession() {
    stopRef.current?.()
    stopRef.current = null
    setListening(false)

    // Summarize both what was said and the questions answered during the meeting.
    const log = transcriptLogRef.current
    const qa = feed.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')
    const content = [
      log && 'TRANSCRIPT:\n' + log,
      qa && 'QUESTIONS ANSWERED:\n' + qa,
    ].filter(Boolean).join('\n\n')

    if (!content.trim()) { resetAll(); return } // nothing happened — just reset

    setView('notes')
    setNotesLoading(true)
    try {
      const result = await generateNotes(content, sessionRef.current)
      setNotes(result)
      try { downloadNotesPdf(result) } catch {} // auto-save a PDF copy
      // Persist the whole meeting so it can be reviewed later.
      try {
        await window.api?.saveSession({
          title: (systemPrompt.trim().split('\n')[0] || 'Meeting').slice(0, 60),
          date: new Date().toLocaleString(),
          when: Date.now(),
          systemPrompt,
          transcript: log,
          qa: feed.map((f) => ({ q: f.q, a: f.a })),
          summary: summaryRef.current,
          suggestions: suggestionLogRef.current,
          script: guidedScript, // the exact SAY-THIS script as shown live
          convo, // the both-sided transcript turns
          notes: result,
        })
      } catch {}
    } catch (err) {
      setNotes('Could not generate notes: ' + err.message)
    } finally {
      setNotesLoading(false)
    }
  }

  const modifier = window.api?.platform === 'darwin' ? 'Cmd' : 'Ctrl'

  return (
    <div className="overlay">
      <div className="drag-bar">
        <span className="dot" />
        <span className="title">Meeting Assistant</span>
        <button className="close" onClick={() => window.api?.hide()}>hide</button>
      </div>

      {view === 'setup' && (
        <div className="body setup">
          <p className="hint">Set up this meeting. Write one prompt with the context and how the assistant should answer, then add any documents.</p>

          <label>System prompt</label>
          <textarea className="field tall" placeholder="Who the assistant is, the meeting context, and how to answer. e.g. 'You are me, the founder pitching our product to an investor. The product is X, priced at Y. Answer confidently in first person, in my voice, keeping replies short and natural.'"
            value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />

          <label>Documents (PDF, Word, CSV, TXT — multiple allowed)</label>
          <input type="file" accept=".pdf,.docx,.csv,.tsv,.txt,.md,.json,.xml,.yaml,.yml" multiple onChange={(e) => handleFiles(e.target.files)} />
          {parsing && <p className="note">Reading files…</p>}
          {docs.length > 0 && (
            <ul className="doclist">{docs.map((d, i) => <li key={i}>{d.name}</li>)}</ul>
          )}

          <button className="ask-btn" onClick={() => setView('session')}
            disabled={!systemPrompt.trim() && docs.length === 0}>
            Start session
          </button>
          <button className="ghost-btn" onClick={openHistory}>View past sessions</button>
        </div>
      )}

      {view === 'session' && (
        <div className="body">
          <div className="session-bar">
            <span className={listening ? 'live on' : 'live'}>{listening ? 'listening' : 'session ready'}</span>
            <div>
              <span className="dual-badge" title="Client via system audio, you via microphone">Both sides</span>
              <button className={guidedMode ? 'listen on' : 'listen'} onClick={() => { setGuidedMode(!guidedMode); if (guidedMode) { setStage(''); setClientSaid('') } }} title="Coach me word-for-word through the meeting">
                {guidedMode ? 'Guide ✓' : 'Guide'}
              </button>
              <button className={listening ? 'listen on' : 'listen'} onClick={toggleListening}>
                {listening ? 'Stop listening' : 'Start listening'}
              </button>
              <button className="close" onClick={endSession}>end</button>
            </div>
          </div>

          {guidedMode && (
            <div className="guide">
              <div className="guide-head">
                <span className="guide-title">Your script</span>
                {stage && <span className="guide-stage">{stage}</span>}
              </div>

              <div className="guide-script">
                {guidedScript.length === 0 && (
                  <div className="guide-block say">
                    <span className="guide-label">Say this</span>
                    <span className="guide-say">{sayLoading ? 'Thinking of your line…' : 'Start listening — I\'ll give you the opening line.'}</span>
                  </div>
                )}
                {guidedScript.map((entry, i) => {
                  const isLatest = i === guidedScript.length - 1
                  return (
                    <div className={'guide-entry' + (isLatest ? ' latest' : '')} key={i}>
                      {entry.client && (
                        <div className="guide-block">
                          <span className="guide-label">Client said</span>
                          <span className="guide-client">{entry.client}</span>
                        </div>
                      )}
                      <div className="guide-block say">
                        <span className="guide-label">Say this{entry.stage ? ' · ' + entry.stage : ''}</span>
                        <span className="guide-say">{entry.say}</span>
                      </div>
                    </div>
                  )
                })}
                {sayLoading && guidedScript.length > 0 && (
                  <div className="guide-writing">Thinking of your next line…</div>
                )}
                <div ref={guideEndRef} />
              </div>

              <div className="guide-actions">
                <button className="line-btn" onClick={() => produceGuidedLine(clientSaid, { opening: !clientSaid })} disabled={sayLoading}>
                  {sayLoading ? 'Writing…' : 'Give me the line'}
                </button>
                <button className="line-btn subtle" onClick={() => produceGuidedLine('', { closing: true })} disabled={sayLoading} title="Draft a warm line to end the meeting">
                  Wrap up meeting
                </button>
              </div>

              <div className="transcript-panel">
                <div className="transcript-head">Live transcript</div>
                <div className="transcript-body">
                  {convo.length === 0 && !transcript && (
                    <div className="transcript-empty">{listening ? 'Listening to both sides…' : 'Start listening to see the conversation.'}</div>
                  )}
                  {convo.map((turn, i) => (
                    <div className={'t-line ' + turn.role} key={i}>
                      <span className="t-who">{turn.role === 'vendor' ? 'You' : 'Client'}</span>
                      <span className="t-text">{turn.text}</span>
                    </div>
                  ))}
                  {listening && transcript && (
                    <div className="t-line interim">
                      <span className="t-text">{transcript}</span>
                    </div>
                  )}
                  <div ref={convoEndRef} />
                </div>
              </div>
            </div>
          )}

          {micStatus && <div className="mic-status">{micStatus}</div>}
          {micError && <div className="mic-error">⚠ {micError}</div>}

          {!guidedMode && (
          <div className="live-area">
            {listening && (
              <div className="transcript">{transcript || 'Listening…'}</div>
            )}

            <div className="feed">
              {feed.map((item) => (
                <div className="qa" key={item.id}>
                  {item.who && <div className="qa-who">{item.who}</div>}
                  <div className="qa-tag">Client's question</div>
                  <div className="q">{item.q}</div>
                  <div className="qa-tag">Suggested answer</div>
                  <div className="a">{item.loading ? 'Thinking…' : item.a}</div>
                </div>
              ))}
              {listening && feed.length === 0 && (
                <p className="empty">Detected questions will be answered here automatically.</p>
              )}
              <div ref={feedEndRef} />
            </div>
          </div>
          )}

          {guidedMode ? (
            <details className="ask-collapsed">
              <summary>Ask your assistant</summary>
              <div className="manual">
                <textarea className="ask-box" placeholder={`Ask anything, draft, summarize… ${modifier} + Enter`}
                  value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={handleKeyDown} />
                <button className="ask-btn" onClick={handleAsk} disabled={loading}>
                  {loading ? 'Thinking…' : 'Ask'}
                </button>
                {answer && <div className="answer">{answer}</div>}
              </div>
            </details>
          ) : (
          <div className="manual">
            <div className="manual-label">Ask your assistant</div>
            <textarea className="ask-box" placeholder={`Ask anything, draft, summarize… ${modifier} + Enter`}
              value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={handleKeyDown} />
            <button className="ask-btn" onClick={handleAsk} disabled={loading}>
              {loading ? 'Thinking…' : 'Ask'}
            </button>
            {answer && <div className="answer">{answer}</div>}
          </div>
          )}
        </div>
      )}

      {view === 'notes' && (
        <div className="body">
          <div className="session-bar">
            <span className="live">Meeting notes</span>
            <div>
              {!notesLoading && notes && (
                <button className="listen" onClick={() => downloadNotesPdf(notes)}>Download PDF</button>
              )}
              <button className="ask-btn small" onClick={resetAll}>New session</button>
            </div>
          </div>
          {notesLoading
            ? <p className="note">Generating notes from the transcript…</p>
            : <div className="answer notes">{notes}</div>}
        </div>
      )}

      {view === 'history' && (
        <div className="body">
          <div className="session-bar">
            <span className="live">Past sessions</span>
            <button className="ask-btn small" onClick={() => setView('setup')}>Back</button>
          </div>
          {sessions.length === 0
            ? <p className="empty">No saved sessions yet. Finished meetings appear here.</p>
            : (
              <div className="feed">
                {sessions.map((s) => (
                  <div className="qa session-item" key={s.id}>
                    <div className="si-main" onClick={() => openSaved(s.id)}>
                      <div className="q">{s.title || 'Meeting'}</div>
                      <div className="si-date">{s.date}</div>
                    </div>
                    <button className="si-del" onClick={() => removeSaved(s.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {view === 'saved' && saved && (
        <div className="body">
          <div className="session-bar">
            <span className="live">{(saved.title || 'Meeting').slice(0, 26)}</span>
            <div>
              <button className="listen" onClick={() => downloadNotesPdf(saved.notes || '')}>PDF</button>
              <button className="ask-btn small" onClick={openHistory}>Back</button>
            </div>
          </div>
          <div className="si-date" style={{ marginBottom: 12 }}>{saved.date}</div>

          {saved.notes && (<><div className="manual-label">Notes</div>
            <div className="answer notes" style={{ marginBottom: 14 }}>{saved.notes}</div></>)}

          {saved.qa?.length > 0 && (<><div className="manual-label">Questions & answers</div>
            <div className="feed" style={{ marginBottom: 14 }}>
              {saved.qa.map((item, i) => (
                <div className="qa" key={i}>
                  <div className="q">{item.q}</div>
                  <div className="a">{item.a}</div>
                </div>
              ))}
            </div></>)}

          {saved.script?.length > 0 ? (<><div className="manual-label">Your script (as shown live)</div>
            <div className="feed" style={{ marginBottom: 14 }}>
              {saved.script.map((entry, i) => (
                <div className="guide-entry" key={i} style={{ opacity: 1, marginBottom: 8 }}>
                  {entry.client && (
                    <div className="guide-block">
                      <span className="guide-label">Client said</span>
                      <span className="guide-client">{entry.client}</span>
                    </div>
                  )}
                  <div className="guide-block say">
                    <span className="guide-label">Say this{entry.stage ? ' · ' + entry.stage : ''}</span>
                    <span className="guide-say">{entry.say}</span>
                  </div>
                </div>
              ))}
            </div></>) : saved.suggestions?.length > 0 && (<><div className="manual-label">Meeting script (lines said)</div>
            <div className="feed" style={{ marginBottom: 14 }}>
              {saved.suggestions.map((s, i) => (
                <div className="qa" key={i}><div className="a">{s}</div></div>
              ))}
            </div></>)}

          {saved.convo?.length > 0 ? (<><div className="manual-label">Live transcript</div>
            <div className="transcript-panel" style={{ marginBottom: 14 }}>
              <div className="transcript-body" style={{ maxHeight: 240 }}>
                {saved.convo.map((turn, i) => (
                  <div className={'t-line ' + turn.role} key={i}>
                    <span className="t-who">{turn.role === 'vendor' ? 'You' : 'Client'}</span>
                    <span className="t-text">{turn.text}</span>
                  </div>
                ))}
              </div>
            </div></>) : saved.transcript && (<><div className="manual-label">Full transcript</div>
            <div className="transcript" style={{ maxHeight: 220, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{saved.transcript}</div></>)}
        </div>
      )}

      <div className="footer">
        <span className="tip"><kbd>{modifier}</kbd> + <kbd>\</kbd> show / hide</span>
        <button onClick={() => window.api?.quit()}>quit</button>
      </div>
    </div>
  )
}
