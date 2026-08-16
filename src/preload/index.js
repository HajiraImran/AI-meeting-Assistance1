import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('overlay:quit'),

  // Deepgram transcription bridge.
  dgStart: (role, token) => ipcRenderer.invoke('dg:start', { role, token }),
  dgReopen: (role, token) => ipcRenderer.invoke('dg:reopen', { role, token }),
  dgAudio: (role, buf) => ipcRenderer.send('dg:audio', { role, buf }),
  dgStop: () => ipcRenderer.send('dg:stop'),
  onDgReconnect: (cb) => ipcRenderer.on('dg:reconnect', (_e, role) => cb(role)),

  // System-audio loopback (works on Windows + macOS via electron-audio-loopback).
  enableLoopback: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopback: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Saved sessions (stored on disk).
  saveSession: (record) => ipcRenderer.invoke('sessions:save', record),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  onDgTranscript: (cb) => ipcRenderer.on('dg:transcript', (_e, d) => cb(d)),
  onDgStatus: (cb) => ipcRenderer.on('dg:status', (_e, s) => cb(s)),
  onDgError: (cb) => ipcRenderer.on('dg:error', (_e, m) => cb(m)),
  offDg: () => {
    ipcRenderer.removeAllListeners('dg:transcript')
    ipcRenderer.removeAllListeners('dg:status')
    ipcRenderer.removeAllListeners('dg:error')
    ipcRenderer.removeAllListeners('dg:reconnect')
  },
})
