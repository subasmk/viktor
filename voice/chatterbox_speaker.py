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
    def __init__(self, log=None):
        self.proc = None
        self.render_lock = threading.Lock()  # serializes renders
        self.proc_lock = threading.Lock()    # guards the proc pointer (cancel/shutdown never wait on a render)
        self.log = log or (lambda m: None)

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

    def _render(self, text):
        """Render text to a wav path via the persistent server. Serialized by render_lock."""
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
            return resp["wav"]

    def __call__(self, text):
        self._play(self._render(text))

    def speak_chunks(self, chunks):
        """Render sentence chunks and play each as soon as it is ready: chunk n+1 renders
        while chunk n plays, so first audio lands after one chunk's render instead of the
        whole reply's. Same server, same voice config - no engine change. Raises like __call__."""
        chunks = [c for c in chunks if c and c.strip()]
        if not chunks:
            return
        if len(chunks) == 1:
            self(chunks[0])
            return
        import time
        t0 = time.time()
        self.log(f"voice: chunked speak - {len(chunks)} chunks")
        upcoming = {}

        def pre(i):
            try:
                rt = time.time()
                upcoming[i] = self._render(chunks[i])
                self.log(f"voice: chunk {i + 1}/{len(chunks)} rendered in {time.time() - rt:.1f}s")
            except Exception as e:
                upcoming[i] = e

        t = threading.Thread(target=pre, args=(0,), daemon=True)
        t.start()
        for i in range(len(chunks)):
            t.join()
            r = upcoming.pop(i)
            if isinstance(r, Exception):
                raise r
            if i == 0:
                self.log(f"voice: first audio after {time.time() - t0:.1f}s")
            if i + 1 < len(chunks):
                t = threading.Thread(target=pre, args=(i + 1,), daemon=True)
                t.start()
            self._play(r)

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
            return ChatterboxSpeaker(log)
    except Exception as e:
        log(f"voice: Chatterbox unavailable ({e}); falling back")
    return None
