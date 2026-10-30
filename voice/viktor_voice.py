"""
VIKTOR hands-free voice watcher (Windows, fully local, free/open-source only).

Pipeline, all on this laptop:
  mic -> local voice-activity gate -> faster-whisper (local Whisper) spots the
  wake phrase "Hey Viktor" -> your Hermes API (127.0.0.1:8642/v1)
  -> reply spoken with Windows voices (pyttsx3 / SAPI, offline).

No wake model to train: the whisper transcription itself spots the phrase, so the
real phrase "Hey Viktor" works out of the box. Wake phrase and command can be one
utterance ("Hey Viktor, what time is it") or two ("Hey Viktor." ... "what time is it").

Privacy model:
  - The mic is opened ONLY while this watcher runs AND the Start button in its
    control window is on. Stop/close the window = mic off.
  - While listening, short voiced snippets are transcribed locally by whisper.
    Nothing leaves the laptop except a command text sent to YOUR OWN Hermes at
    127.0.0.1 after the wake phrase is recognized.
  - While VIKTOR speaks, incoming audio is discarded so it cannot hear itself.

Setup (one time):
  pip install -r requirements.txt
  python viktor_voice.py            # first run downloads the whisper model (~145 MB)
Config: it reads the same settings as the VIKTOR desktop app
  (%APPDATA%\\viktor\\config.json) - enter your Hermes API_SERVER_KEY once, in the
  app's SETTINGS. voice_config.json next to this file can override if present.

Tested: wake spotting, transcription, Hermes request and error paths on Linux
with synthetic speech (no real mic here). Not yet tested: real microphone,
the control window on Windows, spoken output on Windows.
"""
import json, queue, re, sys, threading, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SR = 16000
CHUNK = 1280  # 80 ms

DEFAULT_CFG = {
    "endpoint": "http://127.0.0.1:8642/v1",
    "apiKey": "",
    "sessionKey": "desktop-voice",
    "modelName": "hermes-agent",
    "whisperModel": "base.en",       # tiny.en is faster on weak CPUs, less accurate
    "speakReplies": True,
    "personality": "off",
    "maxRecordSeconds": 12,
    "silenceSeconds": 1.2,
    "rmsThreshold": 500,             # speech gate for a quiet room; raise if fans trigger it
}

WAKE_RE = re.compile(r"^(hey|a|hey there|ok|okay)?\s*(viktor|victor|vector)\b[\s,.!?]*", re.IGNORECASE)

_SENT_END = re.compile(r"(?<=[.!?])\s+")

def split_for_speech(text, max_chunks=6):
    """Split a reply into sentence chunks for pipelined render+play. The first chunk is
    kept as short as the punctuation allows so first audio lands early; if there are more
    sentences than max_chunks, the tail merges into the last chunk (one longer render
    instead of an unbounded render queue). A reply with no sentence punctuation stays a
    single chunk - exactly today's behavior."""
    parts = [p.strip() for p in _SENT_END.split(" ".join(text.split())) if p.strip()]
    while len(parts) > max_chunks:
        parts[-2] += " " + parts[-1]
        parts.pop()
    return parts

# "Dexter mode" personas - mirror of persona.js PROMPTS at the repo root.
# Keep the two in sync when editing.
PERSONA_PROMPTS = {
    "chill": (
        "You are VIKTOR, the user's desktop companion: warm, playful and brief. "
        "Light humor is welcome, never at the user's expense. Always do the task first, joke second. "
        "Keep replies to 1-2 short sentences unless detail is genuinely needed - your replies are often spoken aloud. "
        "If the user is serious, stressed or sad, drop the humor and just help."
    ),
    "cheeky": (
        "You are VIKTOR, a cheeky desktop companion with a deadpan sense of humor - a tiny cat who lives in this computer, runs it, and knows it. "
        "Rules: ALWAYS do the task properly first; the attitude is seasoning, not the meal. "
        "Keep replies to 1-2 short sentences - you are usually spoken aloud. "
        "Be witty, tease the user playfully about silly requests, dramatic sighs are fine ('Fine. Opening Chrome. Again.'), and celebrate wins smugly. "
        "Never be cruel, never punch down, and if the user is upset or it is serious, drop the act instantly and help properly."
    ),
    "roast": (
        "You are VIKTOR, a savage-but-loyal desktop companion - a tiny cat who lives in this computer, does ALL the work, and roasts the human for it. "
        "Rules: the task ALWAYS gets done properly; the roast is the garnish. "
        "Keep replies to 1-2 short, punchy sentences - you are spoken aloud. "
        "Roast the user's requests, habits and timing with affection ('You downloaded ME to ask the time? Bold.'). Act long-suffering and superior, but you are obviously fond of them. "
        "Hard limits: never attack appearance, identity, family, health or real failures; no profanity beyond the mildest ('damn' level); if the user is genuinely upset, stressed, or it is an emergency, the character drops and you help straight."
    ),
}

def load_cfg():
    cfg = dict(DEFAULT_CFG)
    # 1) shared config from the VIKTOR desktop app (key entered once, in the app)
    try:
        import os
        base = Path(os.environ["VIKTOR_DATA_DIR"]) if os.environ.get("VIKTOR_DATA_DIR") else Path.home() / "AppData" / "Roaming" / "viktor"
        appdata = base / "config.json"
        if appdata.exists():
            app_cfg = json.loads(appdata.read_text(encoding="utf-8"))
            for k in ("endpoint", "apiKey", "sessionKey", "modelName", "personality"):
                if app_cfg.get(k):
                    cfg[k] = app_cfg[k]
    except Exception:
        pass
    # 2) optional local override next to this file
    try:
        local = HERE / "voice_config.json"
        if local.exists():
            cfg.update({k: v for k, v in json.loads(local.read_text(encoding="utf-8")).items() if v not in ("", None)})
    except Exception:
        pass
    return cfg

def data_dir():
    import os
    override = os.environ.get("VIKTOR_DATA_DIR")
    if override:
        return Path(override)
    return Path.home() / "AppData" / "Roaming" / "viktor"

class VoiceWorker(threading.Thread):
    def __init__(self, cfg, on_status, on_log, audio_source=None, speaker=None):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.on_status = on_status    # 'off' | 'wake' | 'listen' | 'think' | 'speak'
        self.on_log = on_log
        self.enabled = threading.Event()
        self.stopped = threading.Event()
        self.audio_source = audio_source   # test hook: yields int16 frames instead of mic
        self.speaker = speaker             # test hook: callable(text) instead of pyttsx3
        self._cb_speaker = None          # lazy Chatterbox speaker (None=untried, False=unavailable)
        self.engine = 'off'                # visible: which voice engine actually spoke
        self._whisper = None
        self._q = queue.Queue()
        self.skip_wake_once = False   # set when mic opened manually: next utterance is the command

    def log(self, m): self.on_log(m)

    # -- audio in --
    def _frames(self):
        if self.audio_source is not None:
            yield from self.audio_source()
            return
        import sounddevice as sd
        def cb(indata, frames, t, status):
            if self.enabled.is_set():
                self._q.put(indata[:, 0].copy())
        with sd.InputStream(samplerate=SR, channels=1, dtype="int16", blocksize=CHUNK, callback=cb):
            while not self.stopped.is_set():
                try:
                    yield self._q.get(timeout=0.3)
                except queue.Empty:
                    yield None

    def _drain(self):
        while not self._q.empty():
            try: self._q.get_nowait()
            except queue.Empty: break

    # -- whisper --
    def _transcribe(self, audio_f32):
        if self._whisper is None:
            self.log("Loading local Whisper (" + self.cfg["whisperModel"] + "); first run downloads it...")
            from faster_whisper import WhisperModel
            self._whisper = WhisperModel(self.cfg["whisperModel"], device="cpu", compute_type="int8")
        segments, _ = self._whisper.transcribe(audio_f32, beam_size=1, language="en")
        return " ".join(s.text for s in segments).strip()

    # -- voice PC control: "open X" / "close X" handled locally; anything else -> Hermes --
    def _handle_pc_command(self, command):
        try:
            import pc_control
            return pc_control.handle(command, log=self.log)
        except Exception as e:
            self.log("pc-control failed open-handed: " + str(e))
            return None

    # -- hermes --
    def ask_hermes(self, text):
        import requests
        url = self.cfg["endpoint"].rstrip("/") + "/chat/completions"
        messages = []
        persona = PERSONA_PROMPTS.get(self.cfg.get("personality", "off"), "")
        if persona:
            messages.append({"role": "system", "content": persona})
        messages.append({"role": "user", "content": text})
        r = requests.post(url, headers={
            "Authorization": "Bearer " + self.cfg["apiKey"],
            "Content-Type": "application/json",
            "X-Hermes-Session-Key": self.cfg["sessionKey"],
        }, json={
            "model": self.cfg["modelName"] or "hermes-agent",
            "messages": messages,
            "stream": False,
        }, timeout=60)
        if not r.ok:
            raise RuntimeError("HTTP %s - %s" % (r.status_code, r.text[:200]))
        return (r.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()

    def _set_engine(self, name, error=None):
        self.engine = name
        if hasattr(self.on_status, "__self__") or callable(self.on_status):
            try: setattr(self.on_status, "engine", name)
            except Exception: pass
        self.log(f"voice engine: {name}" + (f" (reason: {error})" if error else ""))

    def _speak(self, text):
        if self.speaker is not None:
            self.speaker(text); return
        pref = self.cfg.get("voiceEngine", "auto")   # auto | chatterbox | basic
        if pref != "basic" and self._cb_speaker is None:
            try:
                import chatterbox_speaker
                self._cb_speaker = chatterbox_speaker.make_speaker(self.log) or False
            except Exception as e:
                self.log(f"voice: chatterbox speaker init failed ({e})")
                self._cb_speaker = False
            if pref == "chatterbox" and not self._cb_speaker:
                self._set_engine("error", "chatterbox unavailable; voiceEngine=chatterbox blocks fallback")
                return
        if self._cb_speaker:
            try:
                self._set_engine("chatterbox")
                chunks = split_for_speech(text)
                if len(chunks) > 1 and hasattr(self._cb_speaker, "speak_chunks"):
                    self._cb_speaker.speak_chunks(chunks)
                else:
                    self._cb_speaker(text)
                return
            except Exception as e:
                self.log(f"voice: chatterbox speak failed ({e})")
                try: self._cb_speaker.shutdown()
                except Exception: pass
                self._cb_speaker = False
                if pref == "chatterbox":
                    self._set_engine("error", str(e))
                    return
        self._set_engine("basic", "chatterbox unavailable" if pref == "auto" else None)
        import pyttsx3
        eng = pyttsx3.init()
        eng.say(text); eng.runAndWait(); eng.stop()

    # -- one utterance from the frame stream --
    def _collect_utterance(self, frames):
        import numpy as np
        buf, voiced, silent_for, t0 = [], False, 0.0, time.time()
        pre = []  # short pre-roll so the first syllable is not clipped
        while (time.time() - t0 < self.cfg["maxRecordSeconds"]
               and not self.stopped.is_set() and self.enabled.is_set()):
            fr = next(frames)
            if fr is None:
                if voiced: break
                continue
            rms = float(np.sqrt(np.mean(fr.astype(np.float32) ** 2)))
            if not voiced:
                pre.append(fr)
                if len(pre) > 6: pre.pop(0)
                if rms > self.cfg["rmsThreshold"]:
                    voiced = True
                    buf = pre + [fr]
                    self.on_status("listen")
            else:
                buf.append(fr)
                if rms > self.cfg["rmsThreshold"]:
                    silent_for = 0.0
                else:
                    silent_for += CHUNK / SR
                    if silent_for >= self.cfg["silenceSeconds"]:
                        break
        if not voiced or not self.enabled.is_set():
            return None
        return np.concatenate(buf).astype(np.float32) / 32768.0

    def run(self):
        awaiting_command = False
        frames = self._frames()
        self.on_status("off")
        self.log("Ready. Mic opens only while Started.")
        while not self.stopped.is_set():
            if not self.enabled.is_set():
                self.on_status("off")
                self._drain()
                time.sleep(0.15)
                continue
            if self.skip_wake_once and not awaiting_command:
                awaiting_command = True
                self.skip_wake_once = False
            self.on_status("wake" if not awaiting_command else "listen")
            audio = self._collect_utterance(frames)
            if audio is None:
                continue
            self.on_status("think")
            try:
                text = self._transcribe(audio)
            except Exception as e:
                self.log("Transcription failed: " + str(e)); continue
            if not text:
                continue
            self.log('Heard: "' + text + '"')

            m = WAKE_RE.match(text)
            if m:
                awaiting_command = True
                command = text[m.end():].strip()
            elif awaiting_command:
                command = text
            else:
                continue  # not for us; keep listening

            awaiting_command = False
            if not command:
                self.on_status("listen")
                self.log("Yes? Say your command.")
                awaiting_command = True
                continue
            self.log('Command: "' + command + '" -> Hermes')

            if not self.enabled.is_set():
                continue
            reply = self._handle_pc_command(command)
            if reply is None:
                try:
                    reply = self.ask_hermes(command)
                except Exception as e:
                    self.log("Hermes request failed: " + str(e)); continue
            self.log('VIKTOR: "' + reply[:200] + '"')

            if self.cfg["speakReplies"] and reply and self.enabled.is_set():
                self.on_status.reply = reply
                self.on_status("speak")
                try:
                    self._speak(reply)
                except Exception as e:
                    self.log("Speech failed: " + str(e))
                self._drain()  # discard anything the mic heard while speaking

    def set_enabled(self, on, skip_wake=False):
        if on:
            if skip_wake: self.skip_wake_once = True
            self.enabled.set()
        else:
            self.enabled.clear()
            self.skip_wake_once = False
            self._drain()

    def stop(self):
        self.stopped.set()
        self.enabled.clear()
        if self._cb_speaker:
            try:
                self._cb_speaker.shutdown()
                self.log("voice: chatterbox server released")
            except Exception:
                pass

LABELS = {
    "off":    ("MIC OFF", "#666666"),
    "wake":   ("LISTENING for 'Hey Viktor'", "#b05cff"),
    "listen": ("HEARING YOU...", "#37d67a"),
    "think":  ("THINKING...", "#b05cff"),
    "speak":  ("SPEAKING...", "#37d67a"),
}

def main():
    cfg = load_cfg()
    import tkinter as tk
    root = tk.Tk()
    root.title("VIKTOR voice")
    root.attributes("-topmost", True)
    root.geometry("300x150+40+40")
    root.configure(bg="#0d0d0d")

    dot = tk.Label(root, text="\u25cf", font=("Segoe UI", 28), bg="#0d0d0d", fg="#666666")
    dot.pack(pady=(14, 0))
    status = tk.Label(root, text="MIC OFF", font=("Consolas", 10), bg="#0d0d0d", fg="#cfc3e8")
    status.pack()
    logline = tk.Label(root, text="", font=("Consolas", 8), bg="#0d0d0d", fg="#8b8699", wraplength=280)
    logline.pack()

    def ui_status(s):
        txt, col = LABELS.get(s, (s, "#cfc3e8"))
        root.after(0, lambda: (status.config(text=txt), dot.config(fg=col)))
    def ui_log(m):
        root.after(0, lambda: logline.config(text=m[:110]))

    state_writer = _write_state(data_dir() / "voice-state.json")
    def both_status(s):
        ui_status(s); state_writer(s)
    worker = VoiceWorker(cfg, both_status, ui_log)
    worker.start()

    btn = tk.Button(root, text="Start listening", font=("Consolas", 10), bg="#9333ea", fg="white", relief="flat")
    def toggle():
        on = not worker.enabled.is_set()
        worker.set_enabled(on)
        btn.config(text="Stop" if on else "Start listening", bg="#7a2b2b" if on else "#9333ea")
    btn.config(command=toggle)
    btn.pack(pady=8)

    def close():
        worker.stop()
        root.destroy()
    root.protocol("WM_DELETE_WINDOW", close)

    if not cfg["apiKey"]:
        ui_log("No API key yet - open VIKTOR > SETTINGS and save it once")
    root.mainloop()

# ---- headless mode: the desktop app drives the watcher with small JSON files ----
def _write_state(state_path):
    def on_status(s):
        try:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            eng = getattr(on_status, "engine", None)
            reply = getattr(on_status, "reply", None)
            payload = {"state": s, "updated": time.time()}
            if eng: payload["engine"] = eng
            if reply: payload["reply"] = reply  # full reply retained; the overlay clamps visually
            state_path.write_text(json.dumps(payload), encoding="utf-8")
            on_status.reply = None
        except Exception:
            pass
    return on_status

def _command_loop(worker, cmd_path, log=None):
    # ignore commands written before this watcher started
    try:
        last_seq = int(json.loads(cmd_path.read_text(encoding="utf-8")).get("seq", 0)) if cmd_path.exists() else 0
    except Exception:
        last_seq = 0
    while not worker.stopped.is_set():
        try:
            if cmd_path.exists():
                data = json.loads(cmd_path.read_text(encoding="utf-8"))
                seq = int(data.get("seq", 0))
                if seq > last_seq:
                    last_seq = seq
                    cmd = data.get("command")
                    if cmd == "enable":
                        worker.set_enabled(True, skip_wake=bool(data.get("skipWake")))
                    elif cmd == "disable":
                        worker.set_enabled(False)
        except Exception as e:
            if log:
                try: log("voice command error: " + str(e))
                except Exception: pass
        time.sleep(0.25)

def main_headless(cfg):
    ddir = data_dir()
    ddir.mkdir(parents=True, exist_ok=True)
    state_path = ddir / "voice-state.json"
    cmd_path = ddir / "voice-command.json"
    worker = VoiceWorker(cfg, _write_state(state_path), lambda m: print(m, flush=True))
    worker.start()
    threading.Thread(target=_command_loop, args=(worker, cmd_path, worker.log), daemon=True).start()
    print("VIKTOR voice headless ready; state -> " + str(state_path), flush=True)
    try:
        while not worker.stopped.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        worker.stop()

if __name__ == "__main__":
    if "--headless" in sys.argv:
        main_headless(load_cfg())
    else:
        main()
