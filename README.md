# V.I.K.T.O.R.

**V**irtual **I**ntelligence for **K**nowledge, **T**asks, **O**rganisation and **R**easoning.

A floating desktop companion (pixel mascot overlay + full console) that puts a face and voice on your local Hermes Agent. Concept: "Midnight Command" - dark grid canvas, purple glass, dot-matrix voice orb, Dexter-style pixel mascot.

## What it is

- **Overlay (launch view):** a transparent, always-on-top mascot that floats on your desktop. Drag to move, click to open the console, right-click for the menu. It reacts: idle / listening / speaking / working / happy / offline.
- **Console (Ctrl+B or click the mascot):** the full dashboard - dot-matrix voice orb, command chips, command history with streaming replies, notes, skills, settings.
- **Brain:** your running Hermes Agent, via its local API server (OpenAI-compatible). All tools, memory and PC control stay with Hermes - this app is only its face. Nothing is simulated: if Hermes is unreachable the console says OFFLINE and shows the real error.

## Requirements

- Windows 10/11, Node.js 18+
- Hermes Agent running locally (the thing that already answers you on Telegram)

## Setup

1. Install dependencies: `npm install`
2. Start: `npm start` (the mascot appears bottom-right; nothing else opens)
3. **Connect your Hermes (one time):**
   - If your Hermes is the Nous Research Hermes Agent: open `%LOCALAPPDATA%\hermes\.env` and add:
     ```
     API_SERVER_ENABLED=true
     API_SERVER_KEY=<pick any long random string>
     ```
     then restart the gateway (`hermes gateway`). Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
   - The API key never leaves your laptop. Do not share it in chats.
4. Open the console (click the mascot), go to SETTINGS, paste the same key, keep the endpoint `http://127.0.0.1:8642/v1`, press TEST CONNECTION. Green HERMES LIVE = done.

If your assistant is a different "Hermes", just point the endpoint at any OpenAI-compatible local server - the console is honest about whatever answers.

## Voice

- **Mic input:** this app intentionally has no cloud speech-to-text. Use your OpenWhispr hotkey - it types straight into the command bar (works everywhere on Windows).
- **Spoken replies:** on by default, uses Windows voices (offline). Pick a voice in SETTINGS. Say/type "stop" or hit STOP to cut it off.

## Auto-start with Windows

Win+R → `shell:startup` → paste a shortcut to a `start.bat` containing:
```
cd /d %~dp0
npm start
```

## Notes

- The console conversation is a separate Hermes session (`X-Hermes-Session-Key: desktop-console`) - your Telegram chats are untouched.
- GPU/VRAM readouts show `--`: browsers can't probe hardware honestly. A local status bridge can fill them later.
- The name shows as VIKTOR by default; change "Assistant name" in SETTINGS anytime.
