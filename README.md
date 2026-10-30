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
   - If your Hermes is the Nous Research Hermes Agent: open the `.env` in your Hermes home (default `%LOCALAPPDATA%\hermes\.env`, or `%HERMES_HOME%\.env` if you set one - the install folder like D:\hermes is NOT the config home) and add:
     ```
     API_SERVER_ENABLED=true
     API_SERVER_KEY=<any random string of 16+ characters>
     ```
     then restart the gateway (`hermes gateway`). Source: hermes-agent repo, gateway/platforms/api_server.py (key min length 16, defaults 127.0.0.1:8642, auto-enables on key presence). Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
   - Quick check that the server is up, no secrets needed, in PowerShell: `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8642/v1/models` → `401` = running and correctly asking for the key; `000` = not enabled yet.
   - The API key never leaves your laptop. Do not share it in chats.
4. Open the console (click the mascot), go to SETTINGS, paste the same key, keep the endpoint `http://127.0.0.1:8642/v1`, press TEST CONNECTION. Green HERMES LIVE = done.

If your assistant is a different "Hermes", just point the endpoint at any OpenAI-compatible local server - the console is honest about whatever answers.

## Voice

- **Hands-free ("Hey Viktor"):** see `voice/` - a fully local watcher (faster-whisper + Windows voices, no cloud, no signups). Say "Hey Viktor" and your command - one breath ("Hey Viktor, what time is it") or two ("Hey Viktor." ... "what time is it"). It stops recording by itself when you go quiet, sends the command to your Hermes and speaks the reply. The control window starts with the mic OFF; press Start to listen, Stop or close to shut the mic off. While it speaks, it ignores the mic so it can't hear itself. It reads the same settings as this app - the API key is entered once, in SETTINGS. Run: `pip install -r voice\requirements.txt` (Python 3.10-3.12), then `voice\start-voice.bat`.
- **Mic input (push-to-talk):** your OpenWhispr hotkey types straight into the command bar (works everywhere on Windows).
- **Spoken replies:** on by default, uses Windows voices (offline). Pick a voice in SETTINGS. Say/type "stop" or hit STOP to cut it off.

## Auto-start with Windows

Win+R → `shell:startup` → paste a shortcut to a `start.bat` containing:
```
cd /d %~dp0
npm start
```

## Dexter mode (opt-in, OFF by default)

In SETTINGS you can give the mascot a personality (`mild` / `cheeky`) and switch on proactive mode. With proactive on, the mascot occasionally checks public tech/gaming news (two fixed Google News RSS queries, fetched and parsed locally - no agent, no tools, no LLM involved) and may offer a link. The bubble always shows the exact hostname it will open; a click only ever opens that one verified https URL in your browser - nothing else runs. Both settings default to OFF.

## Notes

- The console conversation is a separate Hermes session (`X-Hermes-Session-Key: desktop-console`) - your Telegram chats are untouched.
- GPU/VRAM readouts show `--`: browsers can't probe hardware honestly. A local status bridge can fill them later.
- The name shows as VIKTOR by default; change "Assistant name" in SETTINGS anytime.

## Mascot: the Shiba (or the pixel cat)

The default mascot is now a cool Shiba Inu in anime-sticker style (sunglasses,
purple bandana, "V" tag) with a pose for every state: sitting smug (idle),
paw-at-ear (listening), paw-on-chin (thinking/working), mid-speech, victory
jump (happy), reclined (sitting around), curled up asleep, dramatic defeat
(Hermes offline), an unimpressed glare (annoyed), a two-frame walk when he
wanders, and a peek over the edge when the proactive scout has an offer.
Poses live in `assets/shiba/`; the engine is `mascot-sprite.js` and exposes
the same `setState()` interface as the pixel mascot.

Prefer the original? Settings -> Mascot -> "Pixel cat" switches back, live.

## Viktor Core — Viktor's own brain (Phase 2)

Viktor normally talks to a local Hermes Agent. **Viktor Core** is a small
built-in brain that speaks the same OpenAI-style API, so Viktor can run
standalone — no Hermes required.

**Run it:** double-click `start-core.bat` (needs Node.js), then in Viktor's
Settings set **Endpoint** to `http://127.0.0.1:8731/v1`. The API key field can
hold anything; Core ignores it.

**Switchable brain** — open http://127.0.0.1:8731/ in a browser:
- **Groq** (cloud): fastest replies for voice. Free key at console.groq.com → API Keys, paste it on the settings page.
- **Ollama** (local): fully offline and private. Install from ollama.com, run `ollama pull llama3.1:8b` once, pick your model on the settings page.

Changes apply to the next message; no restart. Hermes stays available — just
point the Endpoint back at it (127.0.0.1:8642) whenever you want.

**What Core can do:** a simple agent loop (up to 6 tool rounds per message)
with tools to open apps and web pages, run shell commands, read/write files,
list folders, search and fetch the web, send media keys (Windows), and keep
long-term notes (`remember`/`recall`, stored in `core/data/notes.txt`).
Conversations persist as JSONL in `core/data/` so a crash loses nothing.

**Safety:** Core listens on 127.0.0.1 only — never the network — because it
can run commands. A denylist refuses destructive command patterns (formatting,
recursive system deletes, shutdown, registry deletes). It is still your PC and
your assistant: review what you ask it to run, the way you would with any agent.
