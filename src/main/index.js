import { app, BrowserWindow, globalShortcut, ipcMain, screen, session } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import WebSocket from 'ws'
import { initMain } from 'electron-audio-loopback'

// Where saved meetings live (on the user's own machine).
const sessionsDir = () => {
  const dir = join(app.getPath('userData'), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Registers the enable/disable-loopback IPC handlers used for system audio
// capture on both Windows and macOS (no third-party audio drivers needed).
initMain()

let overlay = null

function createOverlay() {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  overlay = new BrowserWindow({
    width: 460,
    height: 620,
    x: width - 480,        // dock to the top-right by default
    y: 40,
    frame: false,          // no title bar or chrome
    transparent: true,     // let the page control its own background
    alwaysOnTop: true,     // float above meeting windows
    skipTaskbar: true,     // don't show in the taskbar / dock switcher
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // THE Cluely trick: hide this window from screen capture and screen share.
  // Verify this works before building anything on top of it.
  overlay.setContentProtection(true)

  // Stay above full-screen apps too, not just normal windows.
  overlay.setAlwaysOnTop(true, 'screen-saver')

  // Show the overlay on every virtual desktop / space (macOS + Windows).
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env['ELECTRON_RENDERER_URL']) {
    overlay.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // In dev, open the console automatically so timing logs are visible.
    overlay.webContents.openDevTools({ mode: 'detach' })
  } else {
    overlay.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleOverlay() {
  if (!overlay) return
  if (overlay.isVisible()) overlay.hide()
  else overlay.show()
}

app.whenReady().then(() => {
  // Allow the overlay to use the microphone for transcription.
  const allow = (permission) => permission === 'media' || permission === 'audioCapture'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission))

  createOverlay()

  // Show / hide the overlay. Change this to whatever feels natural.
  globalShortcut.register('CommandOrControl+\\', toggleOverlay)
  // Open/close the developer console (to see timing logs) on Ctrl/Cmd+Shift+D.
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (overlay?.webContents.isDevToolsOpened()) overlay.webContents.closeDevTools()
    else overlay?.webContents.openDevTools({ mode: 'detach' })
  })
  // Note: "ask" (Ctrl/Cmd + Enter) is handled inside the question box in the
  // UI, so it works reliably while you're typing. We add a global voice-driven
  // trigger later in step 6.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay()
  })
})

// Let the renderer move / hide the window through the preload bridge.
ipcMain.on('overlay:hide', () => overlay?.hide())
ipcMain.on('overlay:quit', () => app.quit())

// --- Deepgram transcription: TWO Flux connections, one per role -------------
// 'client' = other person (system audio), 'vendor' = you (microphone). Each
// stream feeds its own connection, so who-said-what is known by source (no
// diarization guessing). Transcripts are tagged with their role.
const dgConns = {}          // role -> WebSocket
const dgReconnectTimers = {} // role -> timer
let dgClosedByUser = false

function openDeepgram(token, role) {
  const url =
    'wss://api.deepgram.com/v2/listen?model=flux-general-en' +
    '&encoding=linear16&sample_rate=16000' +
    '&eot_threshold=0.9&eot_timeout_ms=6000'
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
  dgConns[role] = ws

  ws.on('open', () => {
    overlay?.webContents.send('dg:status', 'Listening')
  })
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString())
      const type = m.type || m.event
      const transcript = m.transcript ?? m.channel?.alternatives?.[0]?.transcript ?? ''
      if (type === 'TurnInfo' || m.event) {
        const ev = m.event || m.turn_event // StartOfTurn | Update | EndOfTurn | TurnResumed
        if (ev === 'EndOfTurn') {
          overlay?.webContents.send('dg:transcript', { role, text: transcript, endOfTurn: true })
        } else if (ev === 'Update' || ev === 'StartOfTurn') {
          if (transcript) overlay?.webContents.send('dg:transcript', { role, text: transcript, interim: true })
        } else if (ev === 'TurnResumed') {
          overlay?.webContents.send('dg:transcript', { role, turnResumed: true })
        }
        return
      }
      if (transcript) overlay?.webContents.send('dg:transcript', { role, text: transcript, interim: !m.is_final, endOfTurn: !!m.is_final })
    } catch {}
  })
  ws.on('error', () => {})
  ws.on('close', () => {
    if (dgClosedByUser) return
    overlay?.webContents.send('dg:status', 'Reconnecting…')
    if (dgReconnectTimers[role]) clearTimeout(dgReconnectTimers[role])
    dgReconnectTimers[role] = setTimeout(() => overlay?.webContents.send('dg:reconnect', role), 800)
  })
  return ws
}

// Open a role's connection with its own token.
ipcMain.handle('dg:start', async (_e, { role, token }) => {
  return new Promise((resolve) => {
    dgClosedByUser = false
    try {
      const ws = openDeepgram(token, role)
      ws.once('open', () => resolve({ ok: true }))
      ws.once('error', (err) => resolve({ ok: false, error: err.message }))
    } catch (err) {
      resolve({ ok: false, error: String(err) })
    }
  })
})

// Reopen a role's connection with a fresh token after a drop.
ipcMain.handle('dg:reopen', async (_e, { role, token }) => {
  return new Promise((resolve) => {
    try {
      const ws = openDeepgram(token, role)
      ws.once('open', () => resolve({ ok: true }))
      ws.once('error', (err) => resolve({ ok: false, error: err.message }))
    } catch (err) {
      resolve({ ok: false, error: String(err) })
    }
  })
})

// Route audio frames to the matching role's connection.
ipcMain.on('dg:audio', (_e, { role, buf }) => {
  const ws = dgConns[role]
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(buf))
})

ipcMain.on('dg:stop', () => {
  dgClosedByUser = true
  for (const role of Object.keys(dgConns)) {
    if (dgReconnectTimers[role]) { clearTimeout(dgReconnectTimers[role]); delete dgReconnectTimers[role] }
    const ws = dgConns[role]
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'CloseStream' })) } catch {}
    }
    ws?.close()
    delete dgConns[role]
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// --- Saved sessions (stored as JSON files on disk) ---
ipcMain.handle('sessions:save', (_e, record) => {
  try {
    const id = record.id || String(Date.now())
    writeFileSync(join(sessionsDir(), id + '.json'), JSON.stringify({ ...record, id }, null, 2))
    return { ok: true, id }
  } catch (err) { return { ok: false, error: String(err) } }
})

ipcMain.handle('sessions:list', () => {
  try {
    const files = readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'))
    const items = files.map((f) => {
      try {
        const r = JSON.parse(readFileSync(join(sessionsDir(), f), 'utf8'))
        return { id: r.id, title: r.title, date: r.date, when: r.when } // list metadata only
      } catch { return null }
    }).filter(Boolean)
    items.sort((a, b) => (b.when || 0) - (a.when || 0)) // newest first
    return items
  } catch { return [] }
})

ipcMain.handle('sessions:get', (_e, id) => {
  try { return JSON.parse(readFileSync(join(sessionsDir(), id + '.json'), 'utf8')) }
  catch { return null }
})

ipcMain.handle('sessions:delete', (_e, id) => {
  try { unlinkSync(join(sessionsDir(), id + '.json')); return { ok: true } }
  catch (err) { return { ok: false, error: String(err) } }
})

// Keep running when all windows are closed on macOS (menu-bar style app).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
