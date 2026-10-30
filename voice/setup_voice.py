"""VIKTOR voice setup core - cross-platform Python, every write lands under the voice home.
The ps1 wrapper only finds a Python 3.10-3.12 and calls this. Testable with --dry-run.
Steps: disk check -> venv -> deps (pip cache in voice home) -> model files (HF_HOME in voice home)
-> render 3 audition samples with chatterbox_server.py -> write READY marker."""
import argparse, json, os, pathlib, shutil, subprocess, sys, time

DEPS = ["onnxruntime", "transformers", "soundfile", "numpy", "huggingface_hub"]
MODEL_ID = "ResembleAI/chatterbox-turbo-ONNX"
MODEL_PATTERNS = ["onnx/*_quantized.onnx*", "tokenizer.json", "config.json"]
SAMPLES = ["Yo, I'm up! What are we doing today?",
           "Right then! I'm up. What chaos are we causing today?",
           "Ha! Okay, that actually worked. What's next?"]
MIN_FREE_GB = 3  # quantized set ~1.2 GB + deps ~0.5 GB + samples; margin included

def voice_home():
    return pathlib.Path(os.environ.get("VIKTOR_VOICE_HOME", r"D:\viktor-voice"))

def free_gb(path):
    usage = shutil.disk_usage(pathlib.Path(path).anchor or "/")
    return usage.free / 1e9

def plan(home):
    return {
        "home": str(home),
        "venv": str(home / "venv"),
        "hf_home": str(home / "hf"),
        "pip_cache": str(home / "pip-cache"),
        "samples": str(home / "samples"),
        "ready": str(home / "READY"),
        "deps": DEPS, "model": MODEL_ID, "patterns": MODEL_PATTERNS,
    }

def venv_python(home):
    win = home / "venv" / "Scripts" / "python.exe"
    return str(win if os.name == "nt" else home / "venv" / "bin" / "python")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    home = voice_home()
    p = plan(home)
    print("VIKTOR voice setup plan:"); print(json.dumps(p, indent=2))
    if a.dry_run:
        print("dry-run: no changes"); return 0
    if free_gb(home.anchor or "/") < MIN_FREE_GB:
        print(f"STOP: need {MIN_FREE_GB}+ GB free on {home.anchor}, have {free_gb(home.anchor or '/'):.1f}"); return 1
    home.mkdir(parents=True, exist_ok=True)
    subprocess.check_call([sys.executable, "-m", "venv", p["venv"]])
    env = dict(os.environ, HF_HOME=p["hf_home"], PIP_CACHE_DIR=p["pip_cache"],
               VIKTOR_VOICE_HOME=str(home))
    py = venv_python(home)
    subprocess.check_call([py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], env=env)
    subprocess.check_call([py, "-m", "pip", "install", "--quiet"] + DEPS, env=env)
    print("deps installed (cache under voice home)")
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL_ID, allow_patterns=MODEL_PATTERNS)
    print("model files present (under voice home)")
    t0 = time.time()
    srv = subprocess.Popen([py, str(pathlib.Path(__file__).parent / "chatterbox_server.py")],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    print("server:", srv.stdout.readline().strip())
    os.makedirs(p["samples"], exist_ok=True)
    for s in SAMPLES:
        srv.stdin.write(json.dumps({"text": s}) + "\n"); srv.stdin.flush()
        r = json.loads(srv.stdout.readline())
        if not r.get("ok"): print("STOP: sample render failed:", r); srv.kill(); return 1
        shutil.move(r["wav"], os.path.join(p["samples"], os.path.basename(r["wav"])))
        print("sample:", r["wav"], f"({time.time()-t0:.0f}s)")
    srv.kill()
    pathlib.Path(p["ready"]).write_text(json.dumps({"engine": "chatterbox-turbo-onnx", "dtype": "quantized",
                                                    "setup_seconds": round(time.time()-t0, 1)}))
    # Lock the watcher to the selected voice: failure = visible error, never silent robotic fallback.
    # User can later edit voice/voice_config.json ("voiceEngine": "auto") to allow the basic fallback.
    vcfg = pathlib.Path(__file__).parent / "voice_config.json"
    existing = {}
    if vcfg.exists():
        try: existing = json.loads(vcfg.read_text(encoding="utf-8"))
        except Exception: existing = {}
    existing["voiceEngine"] = "chatterbox"
    vcfg.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    print("READY marker written + voiceEngine=chatterbox locked in voice_config.json.")
    print("VIKTOR will now speak with the selected voice.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
