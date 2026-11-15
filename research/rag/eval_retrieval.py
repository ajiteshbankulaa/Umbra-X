"""Evaluate retrieval quality & latency across legacy TF-IDF, BM25, Dense Qdrant, and Hybrid RRF."""

from __future__ import annotations

import json
import math
import statistics
from pathlib import Path
from typing import Any

from retriever import HybridResearchRetriever

ROOT = Path(__file__).resolve().parents[2]
BENCH_PATH = ROOT / "research" / "rag" / "benchmark_queries.json"
OUT_PATH = ROOT / "research" / "benchmarks" / "retrieval_eval.json"

MODES = ["tfidf_legacy", "bm25", "dense_qdrant", "hybrid_rrf"]


def dcg_at_k(relevances: list[int], k: int) -> float:
    return sum((rel / math.log2(i + 2)) for i, rel in enumerate(relevances[:k]) if rel > 0)


def ndcg_at_k(retrieved_docs: list[str], expected_docs: set[str], k: int) -> float:
    seen: set[str] = set()
    rels = []
    for d in retrieved_docs[:k]:
        if d in expected_docs and d not in seen:
            rels.append(1)
            seen.add(d)
        else:
            rels.append(0)
    ideal = [1] * min(len(expected_docs), k)
    idcg = dcg_at_k(ideal, k)
    return (dcg_at_k(rels, k) / idcg) if idcg > 0 else 0.0


def evaluate_mode(retriever: HybridResearchRetriever, queries: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    # One warmup query so lazy initialization doesn't distort per-query latency distribution
    retriever.search(queries[0]["query"], mode=mode, top_k=5)

    r1_list, r3_list, r5_list, mrr5_list, ndcg5_list, latencies = [], [], [], [], [], []
    failures: list[dict[str, Any]] = []

    for q in queries:
        expected = set(q["expectedDocIds"])
        resp = retriever.search(q["query"], mode=mode, top_k=5)
        latencies.append(resp["latencyMs"])
        top_docs = [r["docId"] for r in resp["results"]]
        r1 = 1.0 if (top_docs[:1] and top_docs[0] in expected) else 0.0
        r3 = 1.0 if any(d in expected for d in top_docs[:3]) else 0.0
        r5 = 1.0 if any(d in expected for d in top_docs[:5]) else 0.0
        mrr = 0.0
        for rank, d in enumerate(top_docs[:5], start=1):
            if d in expected:
                mrr = 1.0 / rank
                break
        ndcg = ndcg_at_k(top_docs, expected, 5)
        r1_list.append(r1)
        r3_list.append(r3)
        r5_list.append(r5)
        mrr5_list.append(mrr)
        ndcg5_list.append(ndcg)
        if r1 == 0.0:
            failures.append(
                {
                    "id": q["id"],
                    "category": q["category"],
                    "query": q["query"],
                    "expectedDocIds": q["expectedDocIds"],
                    "top3DocIds": top_docs[:3],
                    "r5Hit": bool(r5),
                }
            )

    sorted_lat = sorted(latencies)
    p50 = statistics.median(sorted_lat)
    p95 = sorted_lat[min(len(sorted_lat) - 1, int(math.ceil(0.95 * len(sorted_lat))) - 1)]
    return {
        "mode": mode,
        "queryCount": len(queries),
        "recallAt1": round(sum(r1_list) / len(queries), 4),
        "recallAt3": round(sum(r3_list) / len(queries), 4),
        "recallAt5": round(sum(r5_list) / len(queries), 4),
        "mrrAt5": round(sum(mrr5_list) / len(queries), 4),
        "ndcgAt5": round(sum(ndcg5_list) / len(queries), 4),
        "latencyMs": {
            "p50": round(p50, 2),
            "p95": round(p95, 2),
            "mean": round(sum(latencies) / len(latencies), 2),
        },
        "r1MissesCount": len(failures),
        "r1Misses": failures,
    }


def main() -> None:
    bench = json.loads(BENCH_PATH.read_text(encoding="utf-8"))
    queries = bench["queries"]
    retriever = HybridResearchRetriever()
    try:
        summaries = [evaluate_mode(retriever, queries, m) for m in MODES]
    finally:
        retriever.close()

    report = {
        "benchmarkVersion": bench["benchmarkVersion"],
        "embeddingModel": retriever.model_name,
        "vectorStore": "qdrant",
        "chunkCount": len(retriever.chunks),
        "queryCount": len(queries),
        "results": summaries,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    for s in summaries:
        print(
            f"{s['mode']:14s} | R@1={s['recallAt1']:.3f} R@3={s['recallAt3']:.3f} "
            f"R@5={s['recallAt5']:.3f} MRR@5={s['mrrAt5']:.3f} nDCG@5={s['ndcgAt5']:.3f} "
            f"| p50={s['latencyMs']['p50']:.2f}ms p95={s['latencyMs']['p95']:.2f}ms"
        )


if __name__ == "__main__":
    main()
