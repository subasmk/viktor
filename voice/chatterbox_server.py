"""VIKTOR Chatterbox speaker server - persistent, matches the audition engine exactly.
Protocol: one JSON line in ({"text": "..."}), one JSON line out ({"ok":true,"wav":path} or {"ok":false,"error":...}).
Run with the D:\\viktor-voice venv python. Voice home: VIKTOR_VOICE_HOME env (default D:\\viktor-voice)."""
import json, os, sys, time
import numpy as np
import soundfile as sf
import onnxruntime
from transformers import AutoTokenizer
from huggingface_hub import hf_hub_download

MODEL_ID = "ResembleAI/chatterbox-turbo-ONNX"
SR = 24000
START_SPEECH_TOKEN, STOP_SPEECH_TOKEN, SILENCE_TOKEN = 6561, 6562, 4299
NUM_KV_HEADS, HEAD_DIM = 16, 64
DTYPE = "quantized"          # exact audition config
TEMP, TOP_P, REP_PEN, MAX_TOKENS = 0.8, 0.95, 1.2, 400

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_HOME = os.environ.get("VIKTOR_VOICE_HOME", r"D:\viktor-voice")
OUT_DIR = os.path.join(VOICE_HOME, "say")
os.makedirs(OUT_DIR, exist_ok=True)

sel = json.load(open(os.path.join(HERE, "selected-voice.json")))
REF = os.path.normpath(os.path.join(HERE, sel["reference"].split("/", 1)[1]))

class RepPen:
    def __init__(self, p): self.p = p
    def __call__(self, ids, scores):
        s = np.take_along_axis(scores, ids, axis=1)
        s = np.where(s < 0, s * self.p, s / self.p)
        out = scores.copy(); np.put_along_axis(out, ids, s, axis=1)
        return out

def dl(name):
    fn = f"{name}_{DTYPE}.onnx"
    g = hf_hub_download(MODEL_ID, subfolder="onnx", filename=fn)
    hf_hub_download(MODEL_ID, subfolder="onnx", filename=f"{fn}_data")
    return g

so = onnxruntime.SessionOptions(); so.intra_op_num_threads = 4
sess = {}
for n in ["conditional_decoder", "speech_encoder", "embed_tokens"]:
    sess[n] = onnxruntime.InferenceSession(dl(n), so)
sess["language_model"] = onnxruntime.InferenceSession(dl("language_model"), so)
tok = AutoTokenizer.from_pretrained(MODEL_ID)
audio, fsr = sf.read(REF)
assert fsr == SR, f"reference must be {SR} Hz, got {fsr}"
REF_AUDIO = audio[np.newaxis, :].astype(np.float32)

def speak(text, out_path):
    ids = tok(text, return_tensors="np")["input_ids"].astype(np.int64)
    rp = RepPen(REP_PEN)
    gen = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)
    for i in range(MAX_TOKENS):
        emb = sess["embed_tokens"].run(None, {"input_ids": ids})[0]
        if i == 0:
            cond_emb, prompt_token, spk_emb, spk_feat = sess["speech_encoder"].run(None, {"audio_values": REF_AUDIO})
            emb = np.concatenate((cond_emb, emb), axis=1)
            b, L, _ = emb.shape
            pkv = {i2.name: np.zeros([b, NUM_KV_HEADS, 0, HEAD_DIM], dtype=np.float16 if i2.type == "tensor(float16)" else np.float32)
                   for i2 in sess["language_model"].get_inputs() if "past_key_values" in i2.name}
            am = np.ones((b, L), dtype=np.int64)
            pos = np.arange(L, dtype=np.int64).reshape(1, -1).repeat(b, axis=0)
        logits, *present = sess["language_model"].run(None, dict(inputs_embeds=emb, attention_mask=am, position_ids=pos, **pkv))
        nxt = rp(gen, logits[:, -1, :]).astype(np.float64) / TEMP
        nxt -= nxt.max(axis=-1, keepdims=True)
        p = np.exp(nxt); p /= p.sum(axis=-1, keepdims=True)
        srt = np.sort(p, axis=-1)[..., ::-1]
        cum = np.cumsum(srt, axis=-1)
        cut = np.searchsorted(cum[..., 0], TOP_P) + 1
        thresh = srt[..., min(cut - 1, srt.shape[-1] - 1)]
        p = np.where(p >= thresh[..., None], p, 0.0)
        p /= p.sum(axis=-1, keepdims=True)
        ids = np.array([[np.random.choice(p.shape[-1], p=p[0])]], dtype=np.int64)
        gen = np.concatenate((gen, ids), axis=-1)
        if (ids.flatten() == STOP_SPEECH_TOKEN).all(): break
        am = np.concatenate([am, np.ones((b, 1), dtype=np.int64)], axis=1)
        pos = pos[:, -1:] + 1
        for j, k in enumerate(pkv): pkv[k] = present[j]
    speech = gen[:, 1:-1]
    sil = np.full((speech.shape[0], 3), SILENCE_TOKEN, dtype=np.int64)
    speech = np.concatenate([prompt_token, speech, sil], axis=1)
    wav = sess["conditional_decoder"].run(None, dict(speech_tokens=speech, speaker_embeddings=spk_emb, speaker_features=spk_feat))[0].squeeze(axis=0)
    sf.write(out_path, wav, SR)

print(json.dumps({"ready": True, "engine": "chatterbox-turbo-onnx", "dtype": DTYPE, "ref": os.path.basename(REF)}), flush=True)
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    n += 1
    try:
        text = json.loads(line)["text"]
        out = os.path.join(OUT_DIR, f"say-{int(time.time())}-{n}.wav")
        speak(text, out)
        print(json.dumps({"ok": True, "wav": out}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
