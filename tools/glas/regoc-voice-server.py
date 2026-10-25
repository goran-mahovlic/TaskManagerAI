#!/usr/bin/env python3
"""RegocMobile VoiceService — lokalni TTS (hrvatski) + STT (faster-whisper).
Endpointi:
  GET  /health            -> {ok, tts_backend, voice, stt_model}
  POST /tts   JSON {text, speed?}  -> audio/ogg (Opus) hrvatski govor
  POST /stt   raw audio bytes (Content-Type audio/*) -> {text, language, seconds}
Model se učita JEDNOM pri startu (STT brz). Bind 127.0.0.1 (nije izložen). Radi offline nakon što su modeli lokalni.
Env: REGOC_VOICE_PORT(8899), WHISPER_MODEL(small), PIPER_VOICE(put do .onnx), ESPEAK_VOICE(hr),
     STT_LANG(hr; "auto" = prepoznaj jezik), TM_GLAS_MODEL (mapa glasova), TM_GLAS_FFMPEG.

Paketna kopija (TaskManagerAI, TASK-5795): isti ugovor kao servis na node-A, uz macOS —
Python iz venva (sys.executable, ne `python3` iz PATH-a launchd-a), ffmpeg i iz Homebrewa,
naglasni leksikon uključen zadano (hr_accent.py i lexicon_hr.json su u istoj mapi), `/stt?lang=en`.
Pokreće ga usluga `voice` (templates/servis/usluge.json) kroz scripts/s-okolinom.sh.
"""
import os, sys, json, shutil, subprocess, tempfile, threading, time, glob, shlex
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("REGOC_VOICE_PORT", "8899"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
ESPEAK_VOICE = os.environ.get("ESPEAK_VOICE", "hr")
PIPER_VOICE = os.environ.get("PIPER_VOICE", "")
PY = sys.executable or "python3"
# launchd ne nasljeđuje PATH ljuske — ffmpeg iz Homebrewa (/opt/homebrew/bin) se traži izričito.
FFMPEG = os.environ.get("TM_GLAS_FFMPEG") or shutil.which("ffmpeg") or next(
    (p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.exists(p)), "ffmpeg")
GLASOVI_DIR = os.path.dirname(os.path.expanduser(os.environ.get("TM_GLAS_MODEL", "~/.local/share/piper-voices/hr_regoc.onnx")))
# Piper prozodija — "radijski voditelj" stil (brže, glatko, manje zastajkivanja).
# length_scale<1 = brže; sentence_silence nisko = manje pauza; noise_w niže = ujednačeniji ritam (manje zastajkivanja).
PIPER_TUNE = {
    "length_scale":     os.environ.get("PIPER_LENGTH_SCALE", "0.80"),   # brže
    "noise_scale":      os.environ.get("PIPER_NOISE_SCALE", "0.40"),    # čisto, bez čujnog šuma
    "noise_w_scale":    os.environ.get("PIPER_NOISE_W", "0.30"),        # opcija B: max tečno (min. zastajkivanja); odabir vlasnika
    "sentence_silence": os.environ.get("PIPER_SENTENCE_SILENCE", "0.08"),
}
# ffmpeg audio post-filter (uklanja rezidualni hiss/rumble). Prazno = bez filtra.
PIPER_AF = os.environ.get("PIPER_AF", "highpass=f=60,afftdn=nr=12:nf=-30,dynaudnorm")
# auto-detekcija piper glasa ako nije zadan — PREDNOST hrvatskom (hr_*), pa hr_regoc, pa ostalo.
# glob nije sortiran (proizvoljan poredak na FS-u) → deterministički biramo hrvatski glas kao default.
if not PIPER_VOICE:
    cands = [c for c in glob.glob(os.path.join(GLASOVI_DIR, "*.onnx")) + glob.glob("/opt/piper/voices/*.onnx") if os.path.exists(c + ".json")]
    def _voice_rank(p):
        b = os.path.basename(p).lower()
        return (0 if b.startswith("hr_regoc") else 1 if b.startswith("hr") else 2, b)
    cands.sort(key=_voice_rank)
    if cands: PIPER_VOICE = cands[0]
# Piper se zove preko `<venv python> -m piper` (radi neovisno o PATH-u systemd/launchd usluge)
HAVE_PIPER = bool(PIPER_VOICE) and (subprocess.run([PY,"-c","import piper"],capture_output=True).returncode == 0)
TTS_BACKEND = "piper" if HAVE_PIPER else "espeak-ng"

# HR_ACCENT=1 -> hrvatski naglasni leksikon preko Piper Python API (patch_piper_voice presreće phonemize).
# Paket: zadano ON (isti recept kao naredba `glas`); HR_ACCENT=0 vraća CLI put. Model se NE dira, samo fonemizacija.
HR_ACCENT = os.environ.get("HR_ACCENT", "1") == "1"
_PIPER = None            # PiperVoice objekt sa zakrpom (None = CLI put)
_piper_lock = threading.Lock()
if HR_ACCENT and TTS_BACKEND == "piper":
    try:
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from piper import PiperVoice
        from piper.config import SynthesisConfig
        import hr_accent
        _lex = os.environ.get("HR_ACCENT_LEXICON", os.path.join(os.path.dirname(os.path.abspath(__file__)), "lexicon_hr.json"))
        _n = hr_accent.load_lexicon(_lex)
        _PIPER = PiperVoice.load(PIPER_VOICE)
        hr_accent.patch_piper_voice(_PIPER)
        print(f"[voice] HR_ACCENT ON — naglasni leksikon aktivan ({_n} oblika)", flush=True)
    except Exception as e:
        print(f"[voice] HR_ACCENT init FAIL: {e} — fallback na CLI put", flush=True)
        _PIPER = None

# OFFLINE učitavanje modela: bez ovoga faster_whisper pokušava HF Hub i VISI kad je internet OFF (blokiran WAN).
# Model je već u lokalnom cacheu; za prvo (online) skidanje pokreni s HF_HUB_OFFLINE=0.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
print(f"[voice] TTS={TTS_BACKEND} voice={PIPER_VOICE or ESPEAK_VOICE} | učitavam STT {WHISPER_MODEL} (offline)...", flush=True)
from faster_whisper import WhisperModel
_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
_stt_lock = threading.Lock()
print(f"[voice] STT spreman. Sluša 127.0.0.1:{PORT}", flush=True)

# Odabir glasa po zahtjevu (TaskManagerAI TASK-5294): /tts {"voice": "<ime>"} — ime je osnovno ime
# piper modela bez .onnx iz istih mapa kao auto-detekcija; putanje i nepoznata imena se odbijaju.
VOICE_DIRS = [GLASOVI_DIR, "/opt/piper/voices"]
def available_voices():
    out = {}
    for d in VOICE_DIRS:
        for c in sorted(glob.glob(os.path.join(d, "*.onnx"))):
            if os.path.exists(c + ".json"): out.setdefault(os.path.basename(c)[:-5], c)
    return out
def voice_path(name):
    name = str(name or "").strip()
    if not name: return None
    if not all(ch.isalnum() or ch in "._-" for ch in name) or name.startswith("."):
        raise ValueError(f"nepoznat glas: {name}")
    v = available_voices()
    if name not in v: raise ValueError(f"nepoznat glas: {name} (dostupno: {', '.join(v) or 'nijedan'})")
    return v[name]

def synth_ogg(text, speed=145, tune=None, voice=None):
    wav = tempfile.mktemp(suffix=".wav"); ogg = tempfile.mktemp(suffix=".ogg")
    t = dict(PIPER_TUNE);
    if tune: t.update({k: str(v) for k, v in tune.items() if k in PIPER_TUNE})
    try:
        model = voice or PIPER_VOICE
        if TTS_BACKEND == "piper" and _PIPER is not None and model == PIPER_VOICE:
            # Python API put: naglasni leksikon aktivan (patch_piper_voice). Ista prozodija (SynthesisConfig).
            import wave as _wave
            sc = SynthesisConfig(length_scale=float(t['length_scale']), noise_scale=float(t['noise_scale']), noise_w_scale=float(t['noise_w_scale']))
            with _piper_lock, _wave.open(wav, "wb") as wf:
                _PIPER.synthesize_wav(text, wf, syn_config=sc)
        elif TTS_BACKEND == "piper":
            flags = (f"--length-scale {shlex.quote(t['length_scale'])} --noise-scale {shlex.quote(t['noise_scale'])} "
                     f"--noise-w-scale {shlex.quote(t['noise_w_scale'])} --sentence-silence {shlex.quote(t['sentence_silence'])}")
            subprocess.run(["bash","-c",f"printf '%s' {shlex.quote(text)} | {shlex.quote(PY)} -m piper --model {shlex.quote(model)} {flags} --output_file {shlex.quote(wav)}"], check=True, capture_output=True)
        else:
            subprocess.run(["espeak-ng","-v",ESPEAK_VOICE,"-s",str(speed),"-w",wav,text], check=True, capture_output=True)
        cmd = [FFMPEG,"-y","-i",wav]
        if TTS_BACKEND == "piper" and PIPER_AF.strip():
            cmd += ["-af", PIPER_AF]
        cmd += ["-c:a","libopus","-b:a","48k","-ar","48000",ogg]
        subprocess.run(cmd, check=True, capture_output=True)
        return open(ogg,"rb").read()
    finally:
        for f in (wav,ogg):
            try: os.unlink(f)
            except OSError: pass

def stt_jezik(trazeno=None):
    """Jezik za whisper: ?lang= iz zahtjeva, inače STT_LANG (zadano hr); "auto" = prepoznaj."""
    j = (trazeno or os.environ.get("STT_LANG", "hr")).strip().lower()
    if j in ("", "auto"): return None
    if not j.isalpha() or len(j) > 3: raise ValueError(f"nepoznat jezik: {j}")
    return j

def transcribe(data, ctype, jezik="hr"):
    ext = ".ogg" if "ogg" in ctype else (".mp3" if "mpeg" in ctype else (".wav" if "wav" in ctype else ".bin"))
    p = tempfile.mktemp(suffix=ext); open(p,"wb").write(data)
    try:
        with _stt_lock:
            segs, info = _model.transcribe(p, language=jezik, beam_size=5)
            txt = "".join(s.text for s in segs).strip()
        return {"text": txt, "language": info.language, "language_probability": round(info.language_probability,3), "seconds": round(info.duration,2)}
    finally:
        try: os.unlink(p)
        except OSError: pass

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, (bytes, bytearray)) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "tts_backend": TTS_BACKEND, "voice": PIPER_VOICE or ESPEAK_VOICE, "stt_model": WHISPER_MODEL, "hr_accent": _PIPER is not None, "voices": sorted(available_voices())})
        else: self._send(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); data = self.rfile.read(n)
        put = urlparse(self.path)
        try:
            if put.path == "/tts":
                body = json.loads(data or b"{}"); text = (body.get("text") or "").strip()
                if not text: return self._send(400, {"error": "text obavezan"})
                try: vp = voice_path(body.get("voice")) if TTS_BACKEND == "piper" else None
                except ValueError as e: return self._send(400, {"error": str(e)})
                self._send(200, synth_ogg(text, int(body.get("speed", 145)), body.get("tune"), vp), "audio/ogg")
            elif put.path == "/stt":
                if not data: return self._send(400, {"error": "prazan audio"})
                try: jezik = stt_jezik((parse_qs(put.query).get("lang") or [None])[0])
                except ValueError as e: return self._send(400, {"error": str(e)})
                self._send(200, transcribe(data, self.headers.get("Content-Type", ""), jezik))
            else: self._send(404, {"error": "not found"})
        except Exception as e:
            self._send(500, {"error": str(e)})

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
