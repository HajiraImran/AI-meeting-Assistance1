# Meeting Assistant — Step 1: the overlay skeleton

This is the foundation everything else sits on: a frameless, transparent,
always-on-top window that is **hidden from screen capture and screen share**,
controlled by a global hotkey. Nothing joins the call.

## Run it

```bash
npm install
npm run dev
```

An overlay card appears in the top-right of your screen.

## Hotkeys

- `Ctrl/Cmd + \` — show / hide the overlay
- `Ctrl/Cmd + Enter` — the "ask" action (increments a counter for now,
  wired to real answers in a later step)

## The one thing to verify before moving on

Content protection is the make-or-break feature. Test it:

1. Start a screen recording (Windows Game Bar, macOS QuickTime) **or** share
   your screen in a Zoom/Meet/Teams call.
2. The overlay should **not** appear in the recording or the shared view,
   even though you can see it on your own screen.

If it shows up in the capture, stop and fix that first. On some Linux setups
`setContentProtection` is a no-op — this feature is reliable on Windows and
macOS, which is the target for a Cluely-style tool.

## Where this fits

```
Step 1  →  overlay skeleton + content protection   ← YOU ARE HERE
Step 2  →  Supabase backend + keys
Step 3  →  RAG ingestion (docs → pgvector)
Step 4  →  pre-meeting screen (category, brief, role)
Step 5  →  live transcription (Deepgram)
Step 6  →  answer engine (router → Gemini → stream into overlay)
Step 7  →  post-meeting notes
Step 8  →  polish + package
```

## Structure

```
src/
  main/index.js       Electron main: window, content protection, hotkeys
  preload/index.js     safe IPC bridge to the UI
  renderer/            React overlay UI
    index.html
    src/App.jsx
    src/main.jsx
    src/index.css
```
