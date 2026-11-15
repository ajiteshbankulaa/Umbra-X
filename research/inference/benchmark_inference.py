import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "research" / "rag"))
sys.path.insert(0, str(ROOT / "research" / "ml"))

from retriever import HybridResearchRetriever, CHUNKS_PATH  # noqa: E402
from train_and_eval import ResidualSurrogateMLP, STATIC_COLS, load_csv  # noqa: E402

DATA_PATH = ROOT / "research" / "ml" / "surrogate_dataset.csv"
OUT_PATH = ROOT / "research" / "benchmarks" / "inference_python.json"


def pctl(arr, p):
    s = sorted(arr)
    idx = min(len(s) - 1, max(0, int(np.ceil((p / 100.0) * len(s))) - 1))
    return round(float(s[idx]), 3)


def bench_embeddings(chunks_text):
    t_load0 = time.perf_counter()
    embedder = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    cold_load_ms = (time.perf_counter() - t_load0) * 1000.0

    # Cold single query
    t_cold0 = time.perf_counter()
    list(embedder.query_embed(["How does 96 km far-field terrain affect Shackleton Ridge Earth visibility?"]))
    cold_query_ms = (time.perf_counter() - t_cold0) * 1000.0

    # Warm single query x 30
    warm_q_times = []
    queries = [
        "What is the LOLA 20 m elevation error model?",
        "Compare Shackleton Ridge Pad 481 48h launch delay.",
        "How does mast height affect lunar south pole darkness?",
    ]
    for i in range(30):
        t0 = time.perf_counter()
        list(embedder.query_embed([queries[i % len(queries)]]))
        warm_q_times.append((time.perf_counter() - t0) * 1000.0)

    # Batch passage embedding throughput
    batch_benchmarks = {}
    sample_texts = chunks_text[:128]
    for bs in [1, 8, 32, 64]:
        subset = sample_texts[:bs] if bs <= 32 else sample_texts[:64]
        repeats = 5 if bs <= 8 else 3
        times = []
        for _ in range(repeats):
            t0 = time.perf_counter()
            list(embedder.embed(subset, batch_size=bs))
            times.append(time.perf_counter() - t0)
        mean_s = float(np.mean(times))
        batch_benchmarks[f"batch_{bs}"] = {
            "itemsPerRun": len(subset),
            "meanSec": round(mean_s, 4),
            "throughputChunksPerSec": round(len(subset) / mean_s, 2),
            "msPerChunk": round((mean_s * 1000.0) / len(subset), 3),
        }

    return {
        "model": "BAAI/bge-small-en-v1.5",
        "runtime": "fastembed-onnxruntime-cpu",
        "coldModelLoadMs": round(cold_load_ms, 2),
        "coldQueryEmbedMs": round(cold_query_ms, 2),
        "warmQueryEmbedMs": {"p50": pctl(warm_q_times, 50), "p95": pctl(warm_q_times, 95), "mean": round(float(np.mean(warm_q_times)), 3)},
        "batchThroughput": batch_benchmarks,
    }


def bench_retrieval():
    t0 = time.perf_counter()
    ret = HybridResearchRetriever()
    cold_init_ms = (time.perf_counter() - t0) * 1000.0
    sample_queries = [
        "Does 96 km terrain change Earth blackout vs 48 km?",
        "JPL DE440 MOON_ME reference frame ephemeris",
        "Barker Mazarico 2020 LOLA elevation error illumination",
        "NASA DSN Goldstone DSS-14 10 deg elevation mask",
        "Permanently shadowed region PSR vs ice deposits",
    ]
    modes = {}
    try:
        for mode in ["bm25", "dense_qdrant", "hybrid_rrf"]:
            # warmup
            ret.search(sample_queries[0], mode=mode, top_k=5)
            lat = []
            for i in range(25):
                q = sample_queries[i % len(sample_queries)]
                ts = time.perf_counter()
                ret.search(q, mode=mode, top_k=5)
                lat.append((time.perf_counter() - ts) * 1000.0)
            modes[mode] = {
                "p50Ms": pctl(lat, 50),
                "p95Ms": pctl(lat, 95),
                "meanMs": round(float(np.mean(lat)), 3),
                "qpsMean": round(1000.0 / float(np.mean(lat)), 2),
            }
    finally:
        ret.close()
    return {"coldInitMs": round(cold_init_ms, 2), "modes": modes}


def bench_ml_surrogates():
    if not DATA_PATH.exists():
        return {"error": "surrogate_dataset.csv missing"}
    data = load_csv(DATA_PATH)
    X = np.stack([data[c] for c in STATIC_COLS], axis=1).astype(np.float32)
    yc = data["viable96Sig2"].astype(int)
    yr = data["sig2_96DarkH"].astype(np.float32)

    # Fit representative trained instances on first 12k rows for authentic inference latency
    n_fit = min(12000, len(X) - 1000)
    hgb_c = HistGradientBoostingClassifier(max_iter=180, max_depth=6, random_state=42).fit(X[:n_fit], yc[:n_fit])
    hgb_r = HistGradientBoostingRegressor(max_iter=180, max_depth=6, random_state=42).fit(X[:n_fit], yr[:n_fit])

    torch.set_num_threads(min(4, os.cpu_count() or 1))
    mlp = ResidualSurrogateMLP(X.shape[1], hidden=96, dropout=0.15)
    mlp.eval()

    results = {}
    for bs in [1, 100, 961]:
        Xb = X[-bs:]
        Xt = torch.from_numpy(Xb)

        # warmup
        _ = hgb_c.predict_proba(Xb)
        _ = hgb_r.predict(Xb)
        with torch.no_grad():
            _ = mlp(Xt)

        t_hgb = []
        for _ in range(40 if bs < 961 else 25):
            t0 = time.perf_counter()
            _ = hgb_c.predict_proba(Xb)
            _ = hgb_r.predict(Xb)
            t_hgb.append((time.perf_counter() - t0) * 1000.0)

        t_mlp = []
        with torch.no_grad():
            for _ in range(60 if bs < 961 else 30):
                t0 = time.perf_counter()
                _ = mlp(Xt)
                t_mlp.append((time.perf_counter() - t0) * 1000.0)

        t_mc = []
        mlp.train()
        with torch.no_grad():
            for _ in range(20):
                t0 = time.perf_counter()
                for _k in range(16):
                    _ = mlp(Xt)
                t_mc.append((time.perf_counter() - t0) * 1000.0)
        mlp.eval()

        results[f"batch_{bs}"] = {
            "histGbdtPair": {
                "p50Ms": pctl(t_hgb, 50),
                "p95Ms": pctl(t_hgb, 95),
                "throughputSamplesPerSec": round(bs * 1000.0 / float(np.median(t_hgb)), 1),
            },
            "pytorchResMlpSinglePass": {
                "p50Ms": pctl(t_mlp, 50),
                "p95Ms": pctl(t_mlp, 95),
                "throughputSamplesPerSec": round(bs * 1000.0 / float(np.median(t_mlp)), 1),
            },
            "pytorchResMlpMc16": {
                "p50Ms": pctl(t_mc, 50),
                "p95Ms": pctl(t_mc, 95),
                "throughputSamplesPerSec": round(bs * 1000.0 / float(np.median(t_mc)), 1),
            },
        }
    return {"cpuThreads": torch.get_num_threads(), "batches": results}


def main():
    chunks = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))["chunks"]
    texts = [c["text"] for c in chunks]
    report = {
        "benchmarkVersion": "phase4-python-inference-v1",
        "hardware": {
            "deviceExecuted": "cpu",
            "cpuCount": os.cpu_count(),
            "torchVersion": torch.__version__,
            "cudaAvailableInVenv": bool(torch.cuda.is_available()),
        },
        "embedding": bench_embeddings(texts),
        "retrieval": bench_retrieval(),
        "surrogates": bench_ml_surrogates(),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
