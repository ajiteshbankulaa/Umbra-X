"""Hybrid retriever combining Okapi BM25 sparse matching with Qdrant neural embeddings (RRF)."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

from fastembed import TextEmbedding
from qdrant_client import QdrantClient

ROOT = Path(__file__).resolve().parents[2]
RAG_DIR = ROOT / "research" / "rag"
MANIFEST_PATH = RAG_DIR / "sources_manifest.json"
CHUNKS_PATH = RAG_DIR / "corpus_chunks.json"

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
    "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "what",
    "when", "where", "which", "who", "why", "with", "does", "do", "can",
}


def tokenize(text: str, drop_stopwords: bool = False) -> list[str]:
    terms = re.findall(r"[a-z0-9]+", text.lower())
    out = [t for t in terms if len(t) > 2]
    if drop_stopwords:
        out = [t for t in out if t not in STOPWORDS]
    return out


class SparseBM25Index:
    """In-memory Okapi BM25 over normalized corpus passages."""

    def __init__(self, documents: list[str], k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self.n_docs = len(documents)
        self.doc_tokens = [tokenize(d, drop_stopwords=True) for d in documents]
        self.doc_tfs = [Counter(t) for t in self.doc_tokens]
        self.doc_lens = [len(t) for t in self.doc_tokens]
        self.avg_len = sum(self.doc_lens) / max(1, self.n_docs)
        df: Counter[str] = Counter()
        for toks in self.doc_tokens:
            for term in set(toks):
                df[term] += 1
        self.idf = {
            term: math.log(1.0 + (self.n_docs - freq + 0.5) / (freq + 0.5))
            for term, freq in df.items()
        }

    def search(self, query: str, top_k: int = 10) -> list[tuple[int, float]]:
        q_terms = tokenize(query, drop_stopwords=True)
        scores: list[tuple[int, float]] = []
        for idx, tf in enumerate(self.doc_tfs):
            dl = self.doc_lens[idx]
            norm_len = self.k1 * (1.0 - self.b + self.b * dl / max(1e-9, self.avg_len))
            s = 0.0
            for term in q_terms:
                f = tf.get(term, 0)
                if f == 0:
                    continue
                s += self.idf.get(term, 0.0) * (f * (self.k1 + 1.0)) / (f + norm_len)
            if s > 0.0:
                scores.append((idx, s))
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_k]


class LegacyTfIdfIndex:
    """Exact mirror of web/src/planner/passageIndex.ts sparse TF-IDF baseline."""

    def __init__(self, documents: list[str]) -> None:
        toks = [tokenize(d, drop_stopwords=False) for d in documents]
        df: Counter[str] = Counter()
        for t in toks:
            for term in set(t):
                df[term] += 1
        n = len(documents)
        self.idf = {t: 1.0 + math.log((1.0 + n) / (1.0 + freq)) for t, freq in df.items()}
        self.vecs = [self._vec(t) for t in toks]

    def _vec(self, tokens: list[str]) -> dict[str, float]:
        w: dict[str, float] = {}
        for t in tokens:
            if t in self.idf:
                w[t] = w.get(t, 0.0) + self.idf[t]
        norm = math.hypot(*w.values())
        if norm > 0:
            for k in list(w.keys()):
                w[k] /= norm
        return w

    def search(self, query: str, top_k: int = 10) -> list[tuple[int, float]]:
        qv = self._vec(tokenize(query, drop_stopwords=False))
        scored: list[tuple[int, float]] = []
        for idx, dv in enumerate(self.vecs):
            sim = sum(wt * dv.get(term, 0.0) for term, wt in qv.items())
            if sim > 0.0:
                scored.append((idx, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]


class HybridResearchRetriever:
    """Thread/process-safe retriever wrapping Qdrant + FastEmbed + BM25 + legacy TF-IDF."""

    def __init__(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        chunk_bundle = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))
        self.collection = manifest["vectorStore"]["collection"]
        self.model_name = manifest["embedding"]["model"]
        self.chunks: list[dict[str, Any]] = chunk_bundle["chunks"]
        self.by_passage = {c["passageId"]: idx for idx, c in enumerate(self.chunks)}
        texts = [f"{c['title']} — {c['text']}" for c in self.chunks]
        self.bm25 = SparseBM25Index(texts)
        self.tfidf = LegacyTfIdfIndex(texts)

        qdrant_url = os.environ.get("UMBRA_QDRANT_URL")
        if qdrant_url:
            self.qdrant = QdrantClient(url=qdrant_url)
        else:
            self.qdrant = QdrantClient(path=str(ROOT / manifest["vectorStore"]["storagePath"]))
        self.embedder = TextEmbedding(model_name=self.model_name)

    def close(self) -> None:
        self.qdrant.close()

    def search(
        self,
        query: str,
        mode: str = "hybrid_rrf",
        top_k: int = 5,
        candidate_pool: int = 20,
        rrf_k: int = 60,
        doc_filter: str | None = None,
    ) -> dict[str, Any]:
        t0 = time.perf_counter()
        if mode == "tfidf_legacy":
            hits = self.tfidf.search(query, top_k=top_k * 2)
            results = [self._format_hit(idx, score, {"tfidf": score}) for idx, score in hits[:top_k]]
        elif mode == "bm25":
            hits = self.bm25.search(query, top_k=candidate_pool)
            results = [self._format_hit(idx, score, {"bm25": score}) for idx, score in hits[:top_k]]
        elif mode in {"dense_qdrant", "hybrid_rrf"}:
            q_vec = next(self.embedder.embed([query])).tolist()
            q_resp = self.qdrant.query_points(
                collection_name=self.collection,
                query=q_vec,
                limit=candidate_pool,
                with_payload=True,
            )
            dense_hits: list[tuple[int, float]] = []
            for pt in q_resp.points:
                pid = (pt.payload or {}).get("passageId")
                if pid in self.by_passage:
                    dense_hits.append((self.by_passage[pid], float(pt.score)))
            if mode == "dense_qdrant":
                results = [
                    self._format_hit(idx, score, {"dense": score})
                    for idx, score in dense_hits[:top_k]
                ]
            else:
                sparse_hits = self.bm25.search(query, top_k=candidate_pool)
                rrf_scores: dict[int, float] = {}
                components: dict[int, dict[str, float]] = {}
                for rank, (idx, sc) in enumerate(sparse_hits, start=1):
                    rrf_scores[idx] = rrf_scores.get(idx, 0.0) + 1.0 / (rrf_k + rank)
                    components.setdefault(idx, {})["bm25"] = round(sc, 4)
                    components[idx]["bm25Rank"] = rank
                for rank, (idx, sc) in enumerate(dense_hits, start=1):
                    rrf_scores[idx] = rrf_scores.get(idx, 0.0) + 1.0 / (rrf_k + rank)
                    components.setdefault(idx, {})["dense"] = round(sc, 4)
                    components[idx]["denseRank"] = rank
                ranked = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
                if doc_filter:
                    ranked = [(i, s) for i, s in ranked if self.chunks[i]["docId"] == doc_filter]
                results = [
                    self._format_hit(idx, score, components[idx])
                    for idx, score in ranked[:top_k]
                ]
        else:
            raise ValueError(f"Unsupported retrieval mode: {mode}")

        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "query": query,
            "mode": mode,
            "embeddingModel": self.model_name,
            "vectorStore": "qdrant",
            "latencyMs": round(elapsed_ms, 2),
            "results": results,
        }

    def _format_hit(self, idx: int, score: float, detail: dict[str, float]) -> dict[str, Any]:
        c = self.chunks[idx]
        return {
            "passageId": c["passageId"],
            "docId": c["docId"],
            "title": c["title"],
            "sectionTitle": c["sectionTitle"],
            "citation": c["citation"],
            "sourceUrl": c["sourceUrl"],
            "contentSha256": c["contentSha256"],
            "retrievedAt": c["retrievedAt"],
            "score": round(score, 6),
            "scoreDetail": detail,
            "text": c["text"],
        }


def serve_stdio() -> None:
    retriever = HybridResearchRetriever()
    sys.stdout.write(json.dumps({"ready": True, "chunks": len(retriever.chunks)}) + "\n")
    sys.stdout.flush()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = retriever.search(
                    query=str(req.get("query", "")),
                    mode=str(req.get("mode", "hybrid_rrf")),
                    top_k=int(req.get("topK", 5)),
                )
                sys.stdout.write(json.dumps({"id": req.get("id"), "ok": True, **resp}) + "\n")
            except Exception as exc:
                sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
            sys.stdout.flush()
    finally:
        retriever.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Query Umbra-X Qdrant hybrid RAG store.")
    parser.add_argument("--query", type=str, help="Single query string.")
    parser.add_argument("--mode", default="hybrid_rrf", choices=["tfidf_legacy", "bm25", "dense_qdrant", "hybrid_rrf"])
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--serve-stdio", action="store_true", help="Run persistent JSONL stdio server.")
    args = parser.parse_args()

    if args.serve_stdio:
        serve_stdio()
        return

    retriever = HybridResearchRetriever()
    try:
        out = retriever.search(args.query or "lunar south pole horizon extent", mode=args.mode, top_k=args.top_k)
        print(json.dumps(out, indent=2))
    finally:
        retriever.close()


if __name__ == "__main__":
    main()
