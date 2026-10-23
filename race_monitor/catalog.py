"""Validated annual catalog fallback; never a substitute for live signup data."""
import hashlib
import json
from pathlib import Path


SNAPSHOT = Path(__file__).with_name("data") / "caa-2026.json"


def rows_digest(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_snapshot(value, url):
    try:
        rows = value["rows"]
        if value["source"] != url or value["rows_sha256"] != rows_digest(rows):
            return None
        if len(rows) != value["row_count"] or len(rows) < 20 or len({r["id"] for r in rows}) != len(rows):
            return None
        if any(r["edition"] != value["edition"] or r["evidence"] != url for r in rows):
            return None
        return dict(value, rows=[dict(r, snapshot_at=value["verified_at"]) for r in rows])
    except (ValueError, KeyError, TypeError):
        return None


def cached_directory(url, saved=None, path=SNAPSHOT):
    """Prefer the latest D1 success, then the bundled verified seed."""
    if saved:
        verified = validate_snapshot(saved, url)
        if verified:
            return verified
    try:
        return validate_snapshot(json.loads(path.read_text(encoding="utf-8")), url)
    except (OSError, ValueError):
        return None


def directory_snapshot(url, data, rows, now):
    return {"source": url, "edition": rows[0]["edition"], "verified_at": now.isoformat(),
            "pdf_sha256": hashlib.sha256(data).hexdigest(), "row_count": len(rows), "rows_sha256": rows_digest(rows), "rows": rows}


def certification(row):
    result = f"{row['edition']}田协目录A类（第{row['page']}页；计划类别）"
    if row.get("snapshot_at"):
        result += f"；使用{row['snapshot_at']}核验的目录快照，在线更新本轮未核实"
    return result
