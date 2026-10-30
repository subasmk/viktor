"""Speaker factory for the VIKTOR voice watcher.
Returns a speak(text) callable backed by the persistent Chatterbox server when the
D-drive voice setup is complete (READY marker), else None so the watcher keeps pyttsx3.
Never raises on construction - voice upgrade must not break the watcher.
cancel() interrupts an in-flight render/playback without waiting for it."""
import json, os, subprocess, threading

VOICE_HOME = os.environ.get("VIKTOR_VOICE_HOME", r"D:\viktor-voice")
READY = os.path.join(VOICE_HOME, "READY")
VENV_PY = os.path.join(VOICE_HOME, "venv", "Scripts", "python.exe")
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "chatterbox_server.py")

class ChatterboxSpeaker:
    def __init__(self):
        self.proc = None
        self.render_lock = threading.Lock()  # serializes renders
        self.proc_lock = threading.Lock()    # guards the proc pointer (cancel/shutdown never wait on a render)

    def _ensure(self):
        with self.proc_lock:
            if self.proc is not None and self.proc.poll() is None:
                return True
            env = dict(os.environ, VIKTOR_VOICE_HOME=VOICE_HOME,
                       HF_HOME=os.path.join(VOICE_HOME, "hf"))
            self.proc = subprocess.Popen(
                [VENV_PY, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, env=env)
            line = self.proc.stdout.readline()          # blocks until model loaded
            try:
                ok = json.loads(line).get("ready", False)
            except Exception:
                ok = False
            if not ok:
                self._kill_locked()
            return ok

    def _kill_locked(self):
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=10)   # reap - no zombie/orphan
            except Exception:
                pass
            self.proc = None

    def __call__(self, text):
        with self.render_lock:
            if not self._ensure():
                raise RuntimeError("chatterbox server failed to start")
            try:
                self.proc.stdin.write(json.dumps({"text": text}) + "\n")
                self.proc.stdin.flush()
            except Exception:
                with self.proc_lock: self._kill_locked()
                raise RuntimeError("chatterbox server pipe broken")
            line = self.proc.stdout.readline()
            if not line:
                with self.proc_lock: self._kill_locked()
                raise RuntimeError("chatterbox server stopped mid-render")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise RuntimeError(resp.get("error", "speak failed"))
            self._play(resp["wav"])

    @staticmethod
    def _play(path):
        import winsound   # Windows stdlib; watcher is Windows-only
        winsound.PlaySound(path, winsound.SND_FILENAME)

    def cancel(self):
        """Abort in-flight render/playback without waiting for the render lock."""
        try:
            import winsound
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:
            pass
        self._kill()

    def _kill(self):
        with self.proc_lock:
            self._kill_locked()

    def shutdown(self):
        """Release the persistent server so no orphan outlives the watcher."""
        self._kill()

def make_speaker(log=print):
    """Return Chatterbox-backed speak(text) if setup is complete, else None."""
    try:
        if os.path.isfile(READY) and os.path.isfile(VENV_PY):
            log("voice: Chatterbox voice detected, using selected voice")
            return ChatterboxSpeaker()
    except Exception as e:
        log(f"voice: Chatterbox unavailable ({e}); falling back")
    return None
