"""
VIKTOR hands-free voice watcher (Windows, fully local, free/open-source only).

Pipeline, all on this laptop:
  mic -> openWakeWord (wake phrase) -> local recording with silence end-of-speech
      -> faster-whisper (local Whisper) -> your Hermes API (127.0.0.1:8642/v1)
      -> reply spoken with Windows voices (pyttsx3 / SAPI, offline).

Privacy model:
  - The mic is opened ONLY while this watcher is running AND the big Start button
    in its control window is on. Close the window or press Stop = mic off.
  - Wake listening, transcription and speaking all run locally. The only network
    call is the command text to YOUR Hermes at 127.0.0.1 after you say something.

Setup (one time):
  pip install -r requirements.txt
  python viktor_voice.py            # first run downloads models (~200 MB), then fill the config it creates
Config: voice_config.json next to this file (endpoint + your Hermes API_SERVER_KEY; key stays on this laptop).

Wake phrase: default model is the pre-trained "hey jarvis" (no training needed).
A custom "hey viktor" model can be trained later with openWakeWord's notebook.

Tested: module imports and pipeline logic on Linux (CI-style), not on a real mic
or Windows audio stack yet - first real-mic run is on the user's laptop.
"""
import json, os, queue, sys, threading, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG_PATH = HERE / "voice_config.json"
DEFAULT_CFG = {
    "endpoint": "http://127.0.0.1:8642/v1",
    "apiKey": "",                       # paste your Hermes API_SERVER_KEY here (min 16 chars)
    "sessionKey": "desktop-voice",
    "modelName": "hermes-agent",
    "wakeModel": "hey_jarvis",          # pre-trained; custom 'hey viktor' can be trained later
    "wakeThreshold": 0.5,
    "whisperModel": "base.en",
    "speakReplies": True,
    "maxRecordSeconds": 12,
    "silenceSeconds": 1.2,
}

def load_cfg():
    if not CFG_PATH.exists():
        CFG_PATH.write_text(json.dumps(DEFAULT_CFG, indent=2), encoding="utf-8")
    cfg = dict(DEFAULT_CFG)
    try:
        cfg.update(json.loads(CFG_PATH.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg

# ---------------- audio pipeline (runs in a worker thread) ----------------
class VoiceWorker(threading.Thread):
    def __init__(self, cfg, on_status, on_log):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.on_status = on_status      # 'off' | 'wake' | 'listen' | 'think' | 'speak'
        self.on_log = on_log
        self.enabled = threading.Event()
        self.stopped = threading.Event()

    def log(self, msg):
        self.on_log(msg)

    def run(self):
        import numpy as np
        import sounddevice as sd
        from openwakeword.model import Model as WakeModel

        self.on_status("off"); self.log("Loading wake-word model: " + self.cfg["wakeModel"])
        try:
            from openwakeword.utils import download_models
            download_models([self.cfg["wakeModel"]])  # no-op when already present
            wake = WakeModel(wakeword_models=[self.cfg["wakeModel"]], inference_framework="onnx")
        except Exception as e:
            self.log("Wake model failed to load: " + str(e)); self.on_status("off"); return
        whisper = None  # lazy-load on first command

        SR = 16000
        CHUNK = 1280  # 80 ms, openwakeword's expected frame
        q = queue.Queue()

        def cb(indata, frames, t, status):
            if self.enabled.is_set():
                q.put(indata[:, 0].copy())

        self.log("Mic opens only while Started.")
        with sd.InputStream(samplerate=SR, channels=1, dtype="int16", blocksize=CHUNK, callback=cb):
            while not self.stopped.is_set():
                if not self.enabled.is_set():
                    self.on_status("off")
                    time.sleep(0.15)
                    continue
                self.on_status("wake")
                try:
                    frame = q.get(timeout=0.5)
                except queue.Empty:
                    continue
                pred = wake.predict(frame)
                score = max(pred.values()) if pred else 0.0
                if score < self.cfg["wakeThreshold"]:
                    continue

                # --- wake word heard: record one command with silence end-of-speech ---
                self.on_status("listen"); self.log("Wake heard (score %.2f) - listening..." % score)
                buf = [frame]
                voiced = False
                silent_for = 0.0
                t0 = time.time()
                while time.time() - t0 < self.cfg["maxRecordSeconds"]:
                    try:
                        fr = q.get(timeout=0.5)
                    except queue.Empty:
                        break
                    buf.append(fr)
                    rms = float(np.sqrt(np.mean(fr.astype(np.float32) ** 2)))
                    if rms > 400:          # crude but effective speech gate for a quiet room
                        voiced = True
                        silent_for = 0.0
                    elif voiced:
                        silent_for += CHUNK / SR
                        if silent_for >= self.cfg["silenceSeconds"]:
                            break           # automatic end-of-speech: no key press needed
                audio = np.concatenate(buf).astype(np.float32) / 32768.0
                if not voiced:
                    self.log("Heard wake but no speech after it."); continue

                # --- transcribe locally ---
                self.on_status("think")
                try:
                    if whisper is None:
                        self.log("Loading local Whisper (" + self.cfg["whisperModel"] + "), first time downloads it...")
                        from faster_whisper import WhisperModel
                        whisper = WhisperModel(self.cfg["whisperModel"], device="cpu", compute_type="int8")
                    segments, _ = whisper.transcribe(audio, beam_size=1, language="en")
                    text = " ".join(s.text for s in segments).strip()
                except Exception as e:
                    self.log("Transcription failed: " + str(e)); continue
                if not text:
                    self.log("Heard nothing intelligible."); continue
                self.log('You said: "' + text + '"')

                # --- send to Hermes ---
                try:
                    reply = self.ask_hermes(text)
                except Exception as e:
                    self.log("Hermes request failed: " + str(e)); continue
                self.log('VIKTOR: "' + reply[:200] + '"')

                # --- speak reply with Windows voices (offline) ---
                if self.cfg["speakReplies"] and reply:
                    self.on_status("speak")
                    try:
                        import pyttsx3
                        eng = pyttsx3.init()
                        eng.say(reply)
                        eng.runAndWait()
                        eng.stop()
                    except Exception as e:
                        self.log("Speech failed: " + str(e))

    def ask_hermes(self, text):
        import requests
        url = self.cfg["endpoint"].rstrip("/") + "/chat/completions"
        r = requests.post(url, headers={
            "Authorization": "Bearer " + self.cfg["apiKey"],
            "Content-Type": "application/json",
            "X-Hermes-Session-Key": self.cfg["sessionKey"],
        }, json={
            "model": self.cfg["modelName"] or "hermes-agent",
            "messages": [{"role": "user", "content": text}],
            "stream": False,
        }, timeout=120)
        if not r.ok:
            raise RuntimeError("HTTP %s - %s" % (r.status_code, r.text[:200]))
        data = r.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()

    def set_enabled(self, on):
        self.enabled.set() if on else self.enabled.clear()

    def stop(self):
        self.stopped.set()
        self.enabled.clear()

# ---------------- control window (visible indicator + off control) ----------------
LABELS = {
    "off":    ("MIC OFF", "#666666"),
    "wake":   ("LISTENING for wake phrase", "#b05cff"),
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

    worker = VoiceWorker(cfg, ui_status, ui_log)
    worker.start()

    btn = tk.Button(root, text="Start listening", font=("Consolas", 10),
                    bg="#9333ea", fg="white", relief="flat")
    def toggle():
        on = not worker.enabled.is_set()
        worker.set_enabled(on)
        btn.config(text="Stop" if on else "Start listening",
                   bg="#7a2b2b" if on else "#9333ea")
    btn.config(command=toggle)
    btn.pack(pady=8)

    def close():
        worker.stop()
        root.destroy()
    root.protocol("WM_DELETE_WINDOW", close)

    if not cfg["apiKey"]:
        ui_log("Add your Hermes API_SERVER_KEY to voice_config.json")
    root.mainloop()

if __name__ == "__main__":
    main()
