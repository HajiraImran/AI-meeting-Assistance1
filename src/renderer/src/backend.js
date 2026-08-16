import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

// Fetch that retries on transient backend failures (503/502/504 or network
// blips) with a short backoff, so a temporary Supabase hiccup doesn't fail a
// live line. Non-transient errors (4xx) return immediately — no point retrying.
async function fetchWithRetry(url, options, tries = 3) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, options)
      if (res.ok || (res.status >= 400 && res.status < 500)) return res
      lastErr = new Error('HTTP ' + res.status) // 5xx → retry
    } catch (e) {
      lastErr = e // network error → retry
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)))
  }
  throw lastErr
}

// Assembles the session's system prompt, conversation so far, and documents
// into one context block. `mode` decides the answering style:
//   'live'      — auto-answering the other party during a call (concise, in-character)
//   'assistant' — the user talking directly to the assistant (full, helpful, like an LLM)
export function buildContext(session, mode = 'assistant') {
  const parts = []
  if (session.systemPrompt?.trim())
    parts.push('SYSTEM PROMPT:\n' + session.systemPrompt.trim())

  const withText = session.docs?.filter((d) => d.text?.trim()) || []
  if (withText.length) {
    const docs = withText
      .map((d) => `--- ${d.name} ---\n${d.text}`)
      .join('\n\n')
    parts.push('REFERENCE DOCUMENTS:\n' + docs)
  }

  // Rolling summary of earlier meeting (kept small) + the most recent turns
  // verbatim. Keeps context roughly constant over a long meeting.
  if (session.summary?.trim())
    parts.push('MEETING SO FAR (summary):\n' + session.summary.trim())
  if (session.recent?.trim())
    parts.push('RECENT CONVERSATION:\n' + session.recent.trim())

  if (mode === 'live') {
    parts.push(
      'HOW TO ANSWER: This is a question from the other person on a live call. ' +
        'Respond in the first person as the user themselves, as if speaking their ' +
        'reply out loud — not as an assistant describing what to say. Keep it to ' +
        '1-2 short, natural, conversational sentences. Sound human and in-character. ' +
        'Use the conversation so far to resolve follow-ups (what "that"/"it" means). ' +
        'Use the system prompt and documents for meeting-specific facts; do not ' +
        "invent details the context doesn't contain; for general questions it does " +
        'not cover, answer briefly from your own knowledge.'
    )
  } else {
    parts.push(
      'HOW TO ANSWER: The user is talking directly to you, their meeting ' +
        'assistant. Be a genuinely helpful assistant like a capable LLM: answer ' +
        'clearly and completely, at whatever length the request needs. You can ' +
        'explain, draft, summarize, brainstorm, or reason step by step. Use the ' +
        'system prompt, documents, and conversation so far as context. Follow the ' +
        "system prompt's persona if one is set, but prioritize being useful and " +
        'thorough over being brief. Use your own knowledge freely for anything the ' +
        'context does not cover.'
    )
  }
  return parts.join('\n\n')
}

// Sends a question plus the session context to the Edge Function.
export async function ask(question, session) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ question, context: buildContext(session) }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.answer
}

// Streams the answer, calling onChunk with the growing text as tokens arrive.
// mode: 'live' (concise, in-character) or 'assistant' (full LLM answer).
export async function askStream(question, session, onChunk, mode = 'assistant') {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ question, context: buildContext(session, mode), stream: true }),
  })

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || 'Stream failed')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    full += decoder.decode(value, { stream: true })
    onChunk?.(full)
  }
  return full
}

// Lightweight semantic completion check — used ONLY as a fallback when Flux's
// end-of-turn looks ambiguous. Returns true if the thought is complete, false
// if the speaker likely has more to say. Reuses the existing ask endpoint
// (Gemini→OpenAI fallback); no new provider or key.
export async function isThoughtComplete(text) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        question:
          'A speaker in a meeting just said: "' + text + '"\n\n' +
          'Has the speaker finished their complete thought/question, or does it ' +
          'sound like they were cut off mid-sentence and have more to say? ' +
          'Reply with only one word: COMPLETE or INCOMPLETE.',
      }),
    })
    const data = await res.json()
    if (data.error) return true // on error, don't block — treat as complete
    return !/incomplete/i.test(data.answer || '')
  } catch {
    return true // fail open: never leave a real turn unanswered
  }
}

// Backup check: asks the model whether a sentence is a question aimed at the user.
// Used only when the fast keyword/question-mark check is unsure. Returns true/false.
export async function isQuestionByModel(text) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        question: `Someone said: "${text}"\n\nIs this a question or a request directed at me that expects an answer? Reply with only YES or NO.`,
      }),
    })
    const data = await res.json()
    if (data.error) return false
    return /^\s*yes/i.test(data.answer || '')
  } catch {
    return false
  }
}

// Proactive meeting co-pilot: given the goal + conversation so far, suggests
// the user's next move — anchored to what the other party JUST said.
export async function suggestNextMove(session, latest) {
  const context =
    (session.systemPrompt?.trim() ? 'MEETING GOAL & CONTEXT:\n' + session.systemPrompt.trim() + '\n\n' : '') +
    (session.blueprint?.trim() ? 'PREPARED MEETING SCRIPT (follow this plan, track where we are in it, and guide the user to the next relevant step):\n' + session.blueprint.trim() + '\n\n' : '') +
    (session.summary?.trim() ? 'MEETING SO FAR:\n' + session.summary.trim() + '\n\n' : '') +
    (session.recent?.trim() ? 'RECENT CONVERSATION:\n' + session.recent.trim() + '\n\n' : '') +
    (latest?.trim() ? 'THE OTHER PARTY JUST SAID:\n"' + latest.trim() + '"\n\n' : '') +
    "You are leading this meeting on the user's behalf. Suggest the next move, " +
    'and it MUST directly respond to what the other party just said above — ' +
    'answer their question, address their concern, or build on their point, ' +
    'while moving toward the goal. ' +
    (session.blueprint?.trim()
      ? 'Follow the PREPARED SCRIPT above: figure out which part of the plan ' +
        'the conversation is at now, and suggest the next line/question from it ' +
        '(adapted to what they just said). '
      : '') +
    'Do not repeat a move already made earlier.\n' +
    'IMPORTANT: if they raised MORE THAN ONE question or point, cover ALL of ' +
    'them — reply as a short numbered list (one brief line each) so nothing is ' +
    'missed. If they raised only one, reply with a single short line (~15 words). ' +
    'No preamble, just the next move(s).'
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ question: 'What should I do next?', context }),
    })
    const data = await res.json()
    if (data.error) return null
    return data.answer || null
  } catch {
    return null
  }
}

// Given the current strategic suggestion, produce the exact first-person line
// the user can say out loud right now.
export async function suggestLine(session, strategy) {
  const context =
    (session.systemPrompt?.trim() ? 'MEETING GOAL & CONTEXT:\n' + session.systemPrompt.trim() + '\n\n' : '') +
    (session.summary?.trim() ? 'MEETING SO FAR:\n' + session.summary.trim() + '\n\n' : '') +
    (session.recent?.trim() ? 'RECENT CONVERSATION:\n' + session.recent.trim() + '\n\n' : '') +
    'RECOMMENDED NEXT MOVE: ' + (strategy || 'move the meeting forward') + '\n\n' +
    'Write the exact words the user should say next to do this — first person, ' +
    'natural, confident, the way they would actually speak it out loud. If the ' +
    'move has multiple points, cover them all naturally in a few sentences so ' +
    'nothing is missed. Keep it tight (2-4 sentences). Output only the spoken ' +
    'words, no quotes, no preamble.'
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ question: 'Give me the line.', context }),
    })
    const data = await res.json()
    if (data.error) return null
    return data.answer || null
  } catch {
    return null
  }
}

// Pre-meeting: turn a short brief ("I have a call with Alex about a remote
// mechanical design role — build me a blueprint to gather requirements and
// close") into a structured, ready-to-follow meeting script.
export async function generateBlueprint(brief) {
  const context =
    'You are an expert meeting strategist. The user will describe an upcoming ' +
    'meeting. Produce a complete, practical meeting SCRIPT/BLUEPRINT they can ' +
    'follow live, tailored to their specific situation. Structure it in clear ' +
    'numbered sections (e.g. Opening, Discovery, Requirements, Technical ' +
    'details, Scope, Timeline, Budget, Handling objections, The close, ' +
    'Materials to collect, Next steps). Under each, give the actual lines they ' +
    'can say and the key questions to ask. Keep it specific to what they ' +
    'described, professional, and closing-oriented. Use plain headings and ' +
    'short lines, no fluff.'
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ question: brief, context }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    return data.answer || ''
  } catch (e) {
    throw new Error('Could not generate blueprint: ' + e.message)
  }
}

// Guided live coaching. Gives the LLM the ORIGINAL brief + role + blueprint +
// summary + the REAL dual-side conversation (CLIENT/VENDOR) + the latest client
// turn, and lets IT reason about what's known, what's missing, and the single
// best thing to say next. No hardcoded meeting rules. Validates the output and
// does ONE automatic rewrite if the line comes back malformed.
function buildGuidedContext(session, latest, opts) {
  const opening = opts?.opening
  const closing = opts?.closing
  return (
    (session.brief?.trim() ? 'ORIGINAL MEETING BRIEF (the user\'s original intent & requirements):\n' + session.brief.trim() + '\n\n' : '') +
    (session.systemPrompt?.trim() ? 'YOUR ROLE / OBJECTIVE / INSTRUCTIONS:\n' + session.systemPrompt.trim() + '\n\n' : '') +
    (session.blueprint?.trim() ? 'MEETING BLUEPRINT (a flexible roadmap, NOT a rigid script):\n' + session.blueprint.trim() + '\n\n' : '') +
    (session.summary?.trim() ? 'MEETING SUMMARY (older conversation, condensed):\n' + session.summary.trim() + '\n\n' : '') +
    (session.recent?.trim() ? 'RECENT CONVERSATION (real transcription — CLIENT = the other party, VENDOR = you the user):\n' + session.recent.trim() + '\n\n' : '') +
    (latest?.trim() && !opening ? 'THE CLIENT\'S COMPLETE TURN (treat everything inside these quotes as ONE finished statement the client just made — they have finished speaking; respond to the WHOLE of it as a single unit):\n"' + latest.trim() + '"\n\n' : '') +
    'You are coaching the VENDOR (the user) live, telling them exactly what to ' +
    'say next.\n' +
    (opening
      ? 'The meeting is just starting. Give a warm, natural opening line that ' +
        'greets the client, asks how they are doing, and gently opens the ' +
        'meeting — guided by the brief and blueprint.'
      : closing
      ? 'The meeting is wrapping up. Give a warm, natural closing line that ' +
        'thanks the client, briefly confirms the key agreed next step from the ' +
        'actual conversation, and ends the meeting on a positive note. Do not ' +
        'introduce new topics or questions.'
      : 'Based on the ORIGINAL MEETING BRIEF and the COMPLETE conversation so ' +
        'far, determine the single best thing the vendor should say next. ' +
        'IMPORTANT: if the client just asked the vendor a direct question (about ' +
        'timelines, process, pricing, approach, capabilities, etc.), ANSWER THAT ' +
        'QUESTION first in a natural way — do not ignore it to ask your own ' +
        'question. You may briefly answer and then move things forward, but the ' +
        'client\'s question must be addressed. Otherwise, reason about what the ' +
        'client has ALREADY told us (never ask for information already ' +
        'provided), what is still missing, what matters most now, and how to ' +
        'move toward the objective. Use the blueprint as a flexible roadmap, ' +
        'not a rigid script; adapt to what actually happened.\n' +
        'CONSOLIDATION (important): the client\'s complete turn above may contain ' +
        'several sentences, points, or questions bundled together — sometimes ' +
        'said in parts with pauses. Treat the entire turn as ONE unit and produce ' +
        'ONE consolidated response that addresses EVERY question and point in it, ' +
        'in a natural order. Never respond to only the first or only the last ' +
        'part. If a later part repeats or refines an earlier part, answer the ' +
        'fuller intent once rather than twice. If they raised more than one ' +
        'distinct thing, cover each briefly so nothing is skipped (two or three ' +
        'short sentences are fine here); if it is really one thing, one sentence.') +
    '\n\nOUTPUT RULES: SAY must be ONE complete, grammatically correct, ' +
    'immediately speakable response in the vendor\'s own first-person voice — ' +
    'exactly the words they say aloud, nothing else. Keep it SHORT and natural, ' +
    'the way people actually talk out loud — usually one sentence, occasionally ' +
    'two short ones. Prefer contractions (I\'ll, we\'re, that\'s). Do not be ' +
    'formal, wordy, or corporate; skip filler openers like "I appreciate your ' +
    'clarity" or "That sounds like a great plan" and just say the substance. ' +
    'Never use ellipses (…/...), fragments, unfinished sentences, ' +
    'meta-commentary, "here is what to say", quotation marks around the line, ' +
    'multiple alternatives, or instructions to the vendor. Also give the current ' +
    'stage in 1-3 words.\nReply EXACTLY in this format and nothing else:\nSTAGE: <stage>\nSAY: <the line>'
  )
}

// True if the SAY line is malformed/garbled and should be regenerated. Goes
// beyond "..." — detects word-salad (adjacent modals, repeated words, runs of
// function words, no content words), which is what real breakage looks like.
function looksMalformedSay(say) {
  const s = (say || '').trim()
  if (s.length < 10) return true
  if (/\.{2,}|…/.test(s)) return true                                  // ellipses
  if (/\b(here'?s what|you should say|as the vendor|i suggest|option \d|say something like|for example|you could say|say:)\b/i.test(s)) return true
  if (/^(stage|say)\s*:/i.test(s)) return true                         // format leak
  if (/\n\s*\d[.)]/.test(s)) return true                               // numbered alternatives
  if (!/[.?!]["')]?$/.test(s)) return true                             // must end as a sentence
  if (/\b(\w+)\s+\1\b/i.test(s)) return true                           // repeated word ("the the")

  const words = s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
  const MODAL = /^(may|might|would|will|could|should|must|can|shall|sure)$/
  // Two modal/aux-type words adjacent ("may sure", "would will") → garble.
  for (let i = 0; i < words.length - 1; i++) {
    if (MODAL.test(words[i]) && MODAL.test(words[i + 1])) return true
  }
  // A run of 4+ short function words in a row → garble.
  const FUNC = new Set(['a','an','the','and','or','but','so','to','of','for','with','that','this','may','sure','would','will','be','is','are','was','as','it','at','on','in','by','we','i','you','they','like','just','have','has','their','our','your'])
  let run = 0
  for (const w of words) { if (FUNC.has(w)) { run++; if (run >= 5) return true } else run = 0 }
  // A 6+ word "sentence" with zero substantial content words → garble.
  if (words.length >= 6 && words.filter((w) => w.length >= 5).length === 0) return true
  return false
}

async function askGuided(context, opts) {
  const q = opts?.opening ? 'Give me the opening line.'
    : opts?.closing ? 'Give me the closing line.'
    : 'What should I say next?'
  try {
    const res = await fetchWithRetry(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ question: q, context, temperature: 0.4, maxTokens: 200 }),
    })
    const data = await res.json()
    if (data.error) return null
    const raw = data.answer || ''
    const stageM = raw.match(/STAGE:\s*(.+)/i)
    const sayM = raw.match(/SAY:\s*([\s\S]+)/i)
    return {
      stage: stageM ? stageM[1].trim() : '',
      say: (sayM ? sayM[1] : raw).trim().replace(/^["']|["']$/g, '').trim(),
    }
  } catch {
    return null
  }
}

export async function guidedLine(session, latest, opts) {
  const context = buildGuidedContext(session, latest, opts)
  let r = await askGuided(context, opts)
  if (!r) return null
  if (looksMalformedSay(r.say)) {
    const fix = await askGuided(
      context +
        '\n\nYOUR PREVIOUS SAY WAS GARBLED / UNGRAMMATICAL:\n"' + r.say + '"\n' +
        'Rewrite SAY as ONE clean, complete, grammatically correct sentence a ' +
        'person can say aloud verbatim. No ellipses, no fragments, no repeated ' +
        'or nonsensical words, no meta.',
      opts
    )
    if (fix && !looksMalformedSay(fix.say)) return fix
    return { stage: (fix && fix.stage) || r.stage || '', say: null, malformed: true }
  }
  return r
}

// Rolling summary: folds older exchanges into a compact running summary so
// context stays small over a long meeting instead of growing unbounded.
export async function summarizeMemory(previousSummary, olderTurns) {
  const prompt =
    (previousSummary ? 'SUMMARY SO FAR:\n' + previousSummary + '\n\n' : '') +
    'NEW EXCHANGES TO FOLD IN:\n' + olderTurns + '\n\n' +
    'Update the running summary of this meeting in 4-6 short bullet points. ' +
    'Keep names, numbers, decisions, and commitments. Be concise. Output only ' +
    'the updated summary.'
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ question: prompt }),
    })
    const data = await res.json()
    if (data.error) return previousSummary
    return data.answer || previousSummary
  } catch {
    return previousSummary
  }
}
export async function generateNotes(transcript, session) {
  const context =
    (session.systemPrompt?.trim() ? 'MEETING CONTEXT:\n' + session.systemPrompt.trim() + '\n\n' : '') +
    'You are summarizing a finished meeting. Produce clear notes with three ' +
    'sections: a short Summary (2-3 sentences), Key Points (bullets), and ' +
    'Action Items (bullets with who/what if known). Base it only on the transcript.'

  const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ question: 'TRANSCRIPT:\n' + transcript, context }),
  })

  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.answer
}
