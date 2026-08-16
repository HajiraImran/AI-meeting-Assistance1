# Building installers

Each installer is built on its own OS. Build the Windows `.exe` on Windows,
the Mac `.dmg` on a Mac. Output lands in the `release/` folder.

## Windows (.exe)

```powershell
npm install
npm run build:win
```

Result: `release/Meeting Assistant Setup 1.0.0.exe` — a normal installer your
team can double-click. It lets them choose the install location.

## macOS (.dmg)

```bash
npm install
npm run build:mac
```

Result: `release/Meeting Assistant-1.0.0.dmg` — drag-to-Applications installer.

## Notes

- **Icons** are optional. Without them the app uses Electron's default icon.
  To brand it, add `build/icon.ico` (Windows, 256×256) and
  `build/icon.icns` (Mac), then rebuild.
- **Config still ships with the app.** `src/renderer/src/config.js` (your
  Supabase URL + anon key) is bundled in, so installed copies talk to your
  backend with no setup. The Gemini / Deepgram / OpenAI keys stay server-side
  in Supabase and are never in the installer.
- **macOS Gatekeeper.** An unsigned `.dmg` opens with a right-click → Open the
  first time (or the app is blocked). For smooth distribution to others,
  code-sign and notarize with an Apple Developer account — add
  `mac.identity` and notarization credentials to the build config later.
- **Windows SmartScreen** may warn on an unsigned `.exe`. Click "More info →
  Run anyway", or sign it with a code-signing certificate for a clean install.
