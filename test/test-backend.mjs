// Backend smoke test — runs outside Electron so you can prove the server side
// works on its own. Reads your Supabase URL + anon key from config.js.
//
//   node test/test-backend.mjs
//
// A pass means: Supabase functions are deployed, and your Gemini + Deepgram
// keys are set correctly. A fail points you straight at what's broken.

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = readFileSync(join(here, '../src/renderer/src/config.js'), 'utf8')

const URL = cfg.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1]
const KEY = cfg.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1]

function line(ok, label, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

console.log('\nMeeting Assistant — backend test\n')

// 0. Config present?
if (!URL || URL.includes('YOUR_PROJECT') || !KEY || KEY.includes('YOUR_ANON')) {
  line(false, 'config.js', 'SUPABASE_URL / SUPABASE_ANON_KEY not filled in')
  console.log('\nFill in src/renderer/src/config.js first, then re-run.\n')
  process.exit(1)
}
line(true, 'config.js loaded', URL)

let failures = 0

// 1. ask() — general knowledge (no context). Proves Gemini works.
try {
  const res = await fetch(`${URL}/functions/v1/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ question: 'In one sentence, what is a torque wrench?' }),
  })
  const data = await res.json()
  if (data.answer) line(true, 'ask (general knowledge)', data.answer.slice(0, 60) + '…')
  else { line(false, 'ask (general knowledge)', JSON.stringify(data)); failures++ }
} catch (e) {
  line(false, 'ask (general knowledge)', e.message); failures++
}

// 2. ask() — with context. Proves the session-context path works.
try {
  const res = await fetch(`${URL}/functions/v1/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      question: 'What is the agreed tolerance?',
      context: 'MEETING BACKGROUND:\nProject X500.\n\nREFERENCE DOCUMENTS:\nThe agreed tolerance is 0.05mm.\n\nAnswer from the context.',
    }),
  })
  const data = await res.json()
  const ok = data.answer && data.answer.includes('0.05')
  line(ok, 'ask (with context)', data.answer ? data.answer.slice(0, 60) + '…' : JSON.stringify(data))
  if (!ok) failures++
} catch (e) {
  line(false, 'ask (with context)', e.message); failures++
}

// 3. deepgram-token — proves the Deepgram key + token minting works.
try {
  const res = await fetch(`${URL}/functions/v1/deepgram-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
  })
  const data = await res.json()
  if (data.access_token) line(true, 'deepgram-token', 'token received (expires in ' + (data.expires_in ?? '?') + 's)')
  else { line(false, 'deepgram-token', JSON.stringify(data)); failures++ }
} catch (e) {
  line(false, 'deepgram-token', e.message); failures++
}

console.log(
  failures === 0
    ? '\nAll backend checks passed. The server side is healthy.\n'
    : `\n${failures} check(s) failed — see above. Fix these before testing the app.\n`
)
process.exit(failures === 0 ? 0 : 1)
