"""Speak one line with the selected VIKTOR voice. Runs inside the D:\\viktor-voice venv.
Usage: python voice/say.py "text to speak" [output.wav]
Loads the model per call (fine for auditioning; a persistent server comes after hardware verification)."""
import json, os, sys
import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

HERE = os.path.dirname(os.path.abspath(__file__))
sel = json.load(open(os.path.join(HERE, "selected-voice.json")))
ref = os.path.join(HERE, "..", sel["reference"].split("/", 1)[1])
text = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.environ.get("TEMP", "."), "viktor-say.wav")
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"device={device}")
if device == "cuda":
    torch.cuda.reset_peak_memory_stats()
model = ChatterboxTurboTTS.from_pretrained(device=device)
wav = model.generate(text, audio_prompt_path=ref)
ta.save(out, wav, model.sr)
print("wrote", out)
if device == "cuda":
    print(f"peak_gpu_memory={torch.cuda.max_memory_allocated()/1e9:.2f} GB")
