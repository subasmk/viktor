"""Speaker factory for the VIKTOR voice watcher.
Returns a speak(text) callable backed by the persistent Chatterbox server when the
D-drive voice setup is complete (READY marker), else None so the watcher keeps pyttsx3.
Never raises on construction - voice upgrade must not break the watcher."""
import json, os, subprocess, sys, threading

VOICE_HOME = os.environ.get("VIKTOR_VOICE_HOME", r"D:\viktor-voice")
READY = os.path.join(VOICE_HOME, "READY")
VENV_PY = os.path.join(VOICE_HOME, "venv", "Scripts", "python.exe")
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "chatterbox_server.py")

class ChatterboxSpeaker:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()

    def _ensure(self):
        if self.proc is not None and self.proc.poll() is None:
            return True
        env = dict(os.environ, VIKTOR_VOICE_HOME=VOICE_HOME, HF_HOME=os.path.join(VOICE_HOME, "hf"))
        self.proc = subprocess.Popen(
            [VENV_PY, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, env=env)
        line = self.proc.stdout.readline()          # blocks until model loaded
        try:
            return json.loads(line).get("ready", False)
        except Exception:
            return False

    def __call__(self, text):
        with self.lock:
            if not self._ensure():
                raise RuntimeError("chatterbox server failed to start")
            self.proc.stdin.write(json.dumps({"text": text}) + "\n")
            self.proc.stdin.flush()
            resp = json.loads(self.proc.stdout.readline())
            if not resp.get("ok"):
                raise RuntimeError(resp.get("error", "speak failed"))
            self._play(resp["wav"])

    @staticmethod
    def _play(path):
        import winsound   # Windows stdlib; watcher is Windows-only
        winsound.PlaySound(path, winsound.SND_FILENAME)

def make_speaker(log=print):
    """Return Chatterbox-backed speak(text) if setup is complete, else None."""
    try:
        if os.path.isfile(READY) and os.path.isfile(VENV_PY):
            log("voice: Chatterbox voice detected, using selected voice")
            return ChatterboxSpeaker()
    except Exception as e:
        log(f"voice: Chatterbox unavailable ({e}); falling back")
    return None
