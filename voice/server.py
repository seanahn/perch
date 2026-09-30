#!/usr/bin/env python3
"""Perch voice: a speech-to-text server that talks JSON lines over stdin and stdout.

Perch starts one of these when dictation is first used and keeps it alive while it is in use, so the model is loaded
once. Audio arrives as 16-bit mono PCM, base64 encoded; nothing is written to disk and nothing leaves the machine.

Requests, one JSON object per line:
  {"id": 1, "op": "transcribe", "pcm": "<base64>", "sample_rate": 16000, "language": "en" | null, "prompt": "..."}
  {"id": 2, "op": "ping"}
  {"op": "quit"}
Replies carry the same id: {"id": 1, "ok": true, "text": "...", "language": "en", "seconds": 3.2, "took_ms": 210}
The first line written is {"ready": true, "device": "cuda" | "cpu", "model": "...", "load_ms": ...}, or {"ready": false, "error": "..."};
"model" is the one loaded, which for --model auto depends on the device.
"""
import argparse
import base64
import json
import os
import sys
import time


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def preload_cuda_libraries():
    """NVIDIA's pip wheels put their libraries inside site-packages, where the dynamic loader does not look.
    Loading them by path first lets CTranslate2 find them, without needing LD_LIBRARY_PATH set by whoever starts us."""
    import ctypes
    import glob
    import site
    loaded = []
    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    for root in roots:
        for pattern in ("nvidia/cublas/lib/libcublasLt.so.*", "nvidia/cublas/lib/libcublas.so.*", "nvidia/cudnn/lib/libcudnn*.so.*"):
            for path in sorted(glob.glob(os.path.join(root, pattern))):
                try:
                    ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                    loaded.append(os.path.basename(path))
                except OSError:
                    pass
    return loaded


GPU_MODEL, CPU_MODEL = "large-v3-turbo", "small"   # what --model auto means on each device
MAX_CPU_THREADS = 16                                # measured: past this the encoder gains nothing


def cpu_threads():
    """The cores this process may use, honouring an affinity mask and a cgroup quota (a container's CPU limit).
    CTranslate2 would otherwise use 4, whatever the machine has."""
    n = os.cpu_count() or 1
    try:
        n = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        pass
    try:
        with open("/sys/fs/cgroup/cpu.max") as f:
            quota, period = f.read().split()[:2]
        if quota != "max":
            n = min(n, max(1, int(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, min(MAX_CPU_THREADS, n))


def load(model_name, device, models_dir):
    from faster_whisper import WhisperModel
    attempts = []
    if device in ("auto", "cuda"):
        attempts += [("cuda", "float16"), ("cuda", "int8_float16")]
    if device in ("auto", "cpu"):
        attempts += [("cpu", "int8")]
    last = None
    for dev, compute in attempts:
        name = model_name if model_name != "auto" else (GPU_MODEL if dev == "cuda" else CPU_MODEL)
        try:
            model = WhisperModel(name, device=dev, compute_type=compute, download_root=models_dir, cpu_threads=cpu_threads() if dev == "cpu" else 0)
            # a GPU that loads the model can still fail on first use (a missing library); find out now, not mid-dictation
            import numpy as np
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1, vad_filter=False)[0])
            return model, dev, compute, name
        except Exception as exc:  # noqa: BLE001 - any failure here means "try the next way"
            last = exc
    raise RuntimeError(str(last) if last else "no device to run on")


def transcribe(model, req, device):
    import numpy as np
    pcm = base64.b64decode(req.get("pcm") or "")
    rate = int(req.get("sample_rate") or 16000)
    audio = np.frombuffer(pcm[: len(pcm) - (len(pcm) % 2)], dtype="<i2").astype(np.float32) / 32768.0
    seconds = len(audio) / float(rate) if rate else 0.0
    if rate != 16000 and len(audio):
        # the recorder asks for 16 kHz; this covers a device that could not provide it
        n = int(round(len(audio) * 16000.0 / rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    if len(audio) < 1600:  # under a tenth of a second: nothing was said
        return {"text": "", "language": req.get("language") or "", "seconds": round(seconds, 2)}
    segments, info = model.transcribe(
        audio,
        language=req.get("language") or None,
        initial_prompt=req.get("prompt") or None,
        beam_size=5 if device == "cuda" else 1,   # a beam search is cheap on a GPU; on a CPU it is most of the wait
        vad_filter=True,                       # drop silence, so a pause is not transcribed as words
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,      # dictations are independent of each other
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "seconds": round(seconds, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="auto", help="a faster-whisper model name, or auto: %s on a GPU, %s on a CPU" % (GPU_MODEL, CPU_MODEL))
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--download-only", action="store_true", help="fetch the model, report, and exit")
    args = ap.parse_args()
    os.makedirs(args.models_dir, exist_ok=True)

    t0 = time.time()
    try:
        libs = preload_cuda_libraries() if args.device != "cpu" else []
        model, device, compute, name = load(args.model, args.device, args.models_dir)
    except Exception as exc:  # noqa: BLE001
        say({"ready": False, "error": str(exc)})
        return 1
    say({"ready": True, "device": device, "compute": compute, "model": name, "threads": cpu_threads() if device == "cpu" else 0, "load_ms": int((time.time() - t0) * 1000), "cuda_libraries": len(libs)})
    if args.download_only:
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            say({"ok": False, "error": "not JSON"})
            continue
        op, rid = req.get("op"), req.get("id")
        if op == "quit":
            break
        if op == "ping":
            say({"id": rid, "ok": True})
            continue
        if op != "transcribe":
            say({"id": rid, "ok": False, "error": "unknown op"})
            continue
        t1 = time.time()
        try:
            out = transcribe(model, req, device)
            out.update({"id": rid, "ok": True, "took_ms": int((time.time() - t1) * 1000)})
            say(out)
        except Exception as exc:  # noqa: BLE001
            say({"id": rid, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
