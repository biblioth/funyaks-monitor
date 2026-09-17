#!/usr/bin/env python3
"""Deduplicate external Cloudflare health alerts in the GitHub watchdog."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from funyaks_monitor import load_dotenv, send_notifications


def load(path: Path) -> dict[str, object]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def update(status: str, state_file: Path) -> bool:
    previous = load(state_file)
    previous_status = previous.get("status")
    if status == previous_status:
        return False

    if status == "unhealthy":
        message = (
            "🚨 Funyaks Cloudflare 主监控异常\n"
            "GitHub 看门狗已启动手动自愈和独立官网兜底检查。\n"
            "请查看 GitHub Actions 的 Cloudflare watchdog and fallback。"
        )
    elif previous_status == "unhealthy":
        message = "✅ Funyaks Cloudflare 主监控已恢复\n每分钟官网检查已重新正常运行。"
    else:
        save(
            state_file,
            {"status": "healthy", "updated_at": datetime.now(timezone.utc).isoformat()},
        )
        return False

    delivered = send_notifications(
        message,
        title="🚨 Funyaks 主监控异常" if status == "unhealthy" else "✅ Funyaks 主监控已恢复",
    )
    if not delivered:
        return False
    save(
        state_file,
        {"status": status, "updated_at": datetime.now(timezone.utc).isoformat()},
    )
    return True


def main() -> int:
    load_dotenv(Path(".env"))
    parser = argparse.ArgumentParser()
    parser.add_argument("status", choices=("healthy", "unhealthy"))
    parser.add_argument("--state-file", default=".state/cloudflare-watchdog.json")
    args = parser.parse_args()
    try:
        sent = update(args.status, Path(args.state_file))
        print(json.dumps({"status": args.status, "notification_sent": sent}))
    except Exception as exc:
        # Availability fallback must still run even if a health notification
        # provider is temporarily broken.
        print(f"WARNING watchdog notification failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
