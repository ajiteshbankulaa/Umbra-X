"""Repeatable research corpus ingestion, normalization, chunking, embedding, and Qdrant indexing."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import time
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import requests
from fastembed import TextEmbedding
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

ROOT = Path(__file__).resolve().parents[2]
RAG_DIR = ROOT / "research" / "rag"
CACHE_DIR = RAG_DIR / "raw_cache"
MANIFEST_PATH = RAG_DIR / "sources_manifest.json"
CHUNKS_PATH = RAG_DIR / "corpus_chunks.json"
INGEST_REPORT_PATH = ROOT / "research" / "benchmarks" / "corpus_ingest_report.json"


class _HTMLTextExtractor(HTMLParser):
    """Strip scripts, styles, and nav chrome while preserving section structure."""

    SKIP_TAGS = {"script", "style", "nav", "header", "footer", "noscript", "svg"}
    BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "li", "tr", "section", "article", "div", "dt", "dd"}

    def __init__(self) -> None:
        super().__init__()
        self.skip_depth = 0
        self.in_heading = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in self.SKIP_TAGS:
            self.skip_depth += 1
        elif self.skip_depth == 0:
            if t in {"h1", "h2", "h3", "h4"}:
                self.parts.append(f"\n\n## ")
                self.in_heading = True
            elif t in self.BLOCK_TAGS:
                self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in self.SKIP_TAGS and self.skip_depth > 0:
            self.skip_depth -= 1
        elif t in {"h1", "h2", "h3", "h4"}:
            self.in_heading = False
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth > 0:
            return
        text = re.sub(r"\s+", " ", html.unescape(data))
        if text.strip():
            self.parts.append(text)

    def get_text(self) -> str:
        raw = "".join(self.parts)
        raw = re.sub(r"[ \t]+\n", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_ntrs_text(payload: dict[str, Any]) -> tuple[str, str]:
    title = str(payload.get("title") or "Untitled NTRS Record").strip()
    authors = [
        a.get("meta", {}).get("author", {}).get("name")
        for a in payload.get("authorAffiliations", [])
        if a.get("meta", {}).get("author", {}).get("name")
    ]
    pub_info = payload.get("publications") or []
    pub_date = (
        pub_info[0].get("publicationDate")
        if pub_info and isinstance(pub_info[0], dict)
        else payload.get("distributionDate")
    ) or "unknown"
    pub_name = (
        pub_info[0].get("publicationName")
        if pub_info and isinstance(pub_info[0], dict)
        else ""
    )
    abstract = str(payload.get("abstract") or "").strip()
    keywords = ", ".join(str(k) for k in (payload.get("keywords") or [])[:16])
    subjects = ", ".join(str(s) for s in (payload.get("subjectCategories") or [])[:8])
    sti_id = str(payload.get("id") or "")
    sections = [
        f"# {title}",
        f"NTRS ID: {sti_id} | Publication Date: {pub_date}" + (f" | Venue: {pub_name}" if pub_name else ""),
        f"Authors: {', '.join(authors)}" if authors else "",
        f"## Abstract\n{abstract}" if abstract else "",
        f"## Keywords & Subject Categories\nKeywords: {keywords}\nSubjects: {subjects}".strip()
        if (keywords or subjects)
        else "",
    ]
    normalized = "\n\n".join(s for s in sections if s)
    return normalized, str(pub_date)


def extract_html_text(raw_html: str) -> str:
    parser = _HTMLTextExtractor()
    parser.feed(raw_html)
    parser.close()
    text = parser.get_text()
    if len(text) > 18000:
        text = text[:18000] + "\n\n[Truncated long reference manual beyond initial 18,000 characters.]"
    return text


def chunk_markdown(text: str, doc_id: str, max_chars: int, overlap_chars: int) -> list[dict[str, str]]:
    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_title = "Overview"
    buf: list[str] = []
    for line in lines:
        m = re.match(r"^#{1,4}\s+(.+)$", line.strip())
        if m:
            body = "\n".join(buf).strip()
            if body:
                sections.append((current_title, [body]))
            current_title = m.group(1).strip()
            buf = []
        else:
            buf.append(line)
    tail = "\n".join(buf).strip()
    if tail:
        sections.append((current_title, [tail]))

    chunks: list[dict[str, str]] = []
    idx = 0
    for sec_title, blocks in sections:
        sec_text = re.sub(r"\n{3,}", "\n\n", "\n".join(blocks)).strip()
        if not sec_text:
            continue
        start = 0
        while start < len(sec_text):
            end = min(len(sec_text), start + max_chars)
            if end < len(sec_text):
                split = sec_text.rfind("\n", start + max_chars // 2, end)
                if split == -1:
                    split = sec_text.rfind(". ", start + max_chars // 2, end)
                if split > start + 100:
                    end = split + 1
            piece = sec_text[start:end].strip()
            if piece:
                idx += 1
                chunks.append(
                    {
                        "passageId": f"{doc_id}#p{idx:03d}",
                        "sectionTitle": sec_title,
                        "text": f"[{sec_title}] {piece}" if sec_title != "Overview" else piece,
                    }
                )
            if end >= len(sec_text):
                break
            start = max(start + 1, end - overlap_chars)
    return chunks


def fetch_or_load_source(src: dict[str, Any], refresh: bool) -> dict[str, Any]:
    doc_id = src["docId"]
    kind = src["kind"]
    if kind == "local_markdown":
        file_path = ROOT / src["path"]
        raw_bytes = file_path.read_bytes()
        norm_text = raw_bytes.decode("utf-8").strip()
        return {
            "rawBytes": raw_bytes,
            "normalizedText": norm_text,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "httpStatus": None,
            "publicationVersion": "repo-phase3-verified",
            "fromCache": False,
        }

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ext = "json" if kind == "ntrs_json" else "html"
    cache_raw = CACHE_DIR / f"{doc_id}.{ext}"
    cache_meta = CACHE_DIR / f"{doc_id}.meta.json"
    if not refresh and cache_raw.exists() and cache_meta.exists():
        meta = json.loads(cache_meta.read_text(encoding="utf-8"))
        raw_bytes = cache_raw.read_bytes()
    else:
        resp = requests.get(
            src["url"],
            timeout=20,
            headers={"User-Agent": "UmbraX-Phase4-ResearchCorpus/1.0"},
        )
        resp.raise_for_status()
        raw_bytes = resp.content
        meta = {
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "httpStatus": resp.status_code,
            "contentType": resp.headers.get("Content-Type", ""),
            "etag": resp.headers.get("ETag"),
            "lastModified": resp.headers.get("Last-Modified"),
        }
        cache_raw.write_bytes(raw_bytes)
        cache_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    if kind == "ntrs_json":
        payload = json.loads(raw_bytes.decode("utf-8"))
        norm_text, pub_ver = extract_ntrs_text(payload)
    else:
        norm_text = extract_html_text(raw_bytes.decode("utf-8", errors="replace"))
        pub_ver = meta.get("lastModified") or meta.get("etag") or meta["retrievedAt"][:10]

    return {
        "rawBytes": raw_bytes,
        "normalizedText": norm_text,
        "retrievedAt": meta["retrievedAt"],
        "httpStatus": meta["httpStatus"],
        "publicationVersion": str(pub_ver),
        "fromCache": not refresh and cache_raw.exists(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest Umbra-X scientific research corpus into Qdrant.")
    parser.add_argument("--refresh", action="store_true", help="Re-fetch external NASA/JPL URLs instead of cache.")
    args = parser.parse_args()

    t0 = time.perf_counter()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    max_chars = int(manifest["chunking"]["maxChars"])
    overlap_chars = int(manifest["chunking"]["overlapChars"])
    model_name = manifest["embedding"]["model"]
    collection_name = manifest["vectorStore"]["collection"]
    qdrant_path = ROOT / manifest["vectorStore"]["storagePath"]

    documents_report: list[dict[str, Any]] = []
    all_chunks: list[dict[str, Any]] = []

    for src in manifest["sources"]:
        loaded = fetch_or_load_source(src, refresh=args.refresh)
        raw_hash = sha256_bytes(loaded["rawBytes"])
        norm_bytes = loaded["normalizedText"].encode("utf-8")
        norm_hash = sha256_bytes(norm_bytes)
        doc_chunks = chunk_markdown(loaded["normalizedText"], src["docId"], max_chars, overlap_chars)
        for ch in doc_chunks:
            all_chunks.append(
                {
                    "passageId": ch["passageId"],
                    "docId": src["docId"],
                    "title": src["title"],
                    "citation": src["citation"],
                    "sourceUrl": src["url"],
                    "usagePermission": src["usagePermission"],
                    "publicationVersion": loaded["publicationVersion"],
                    "retrievedAt": loaded["retrievedAt"],
                    "contentSha256": raw_hash,
                    "normalizedSha256": norm_hash,
                    "sectionTitle": ch["sectionTitle"],
                    "text": ch["text"],
                }
            )
        documents_report.append(
            {
                "docId": src["docId"],
                "title": src["title"],
                "url": src["url"],
                "httpStatus": loaded["httpStatus"],
                "retrievedAt": loaded["retrievedAt"],
                "publicationVersion": loaded["publicationVersion"],
                "contentSha256": raw_hash,
                "normalizedSha256": norm_hash,
                "normalizedChars": len(loaded["normalizedText"]),
                "chunks": len(doc_chunks),
            }
        )

    embed_t0 = time.perf_counter()
    embedder = TextEmbedding(model_name=model_name)
    texts = [f"{c['title']} — {c['text']}" for c in all_chunks]
    vectors = [vec.tolist() for vec in embedder.embed(texts, batch_size=32)]
    embed_ms = (time.perf_counter() - embed_t0) * 1000.0
    dim = len(vectors[0])

    qdrant_path.mkdir(parents=True, exist_ok=True)
    client = QdrantClient(path=str(qdrant_path))
    if client.collection_exists(collection_name):
        client.delete_collection(collection_name)
    client.create_collection(
        collection_name=collection_name,
        vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
    )

    points = []
    for chunk, vec in zip(all_chunks, vectors, strict=True):
        pid_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"umbra-x:{chunk['passageId']}"))
        points.append(PointStruct(id=pid_uuid, vector=vec, payload=chunk))

    client.upsert(collection_name=collection_name, points=points, wait=True)
    client.close()

    CHUNKS_PATH.write_text(
        json.dumps(
            {
                "manifestVersion": manifest["manifestVersion"],
                "embeddingModel": model_name,
                "embeddingDimension": dim,
                "collection": collection_name,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "chunkCount": len(all_chunks),
                "chunks": all_chunks,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    total_ms = (time.perf_counter() - t0) * 1000.0
    report = {
        "manifestVersion": manifest["manifestVersion"],
        "embeddingModel": model_name,
        "embeddingDimension": dim,
        "vectorStore": "qdrant_local_disk",
        "collection": collection_name,
        "documentCount": len(documents_report),
        "chunkCount": len(all_chunks),
        "embedMs": round(embed_ms, 2),
        "totalIngestMs": round(total_ms, 2),
        "documents": documents_report,
    }
    INGEST_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    INGEST_REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Ingested {len(documents_report)} documents -> {len(all_chunks)} chunks "
        f"(dim={dim}, embed={embed_ms:.1f} ms, total={total_ms:.1f} ms) into {qdrant_path}"
    )


if __name__ == "__main__":
    main()
