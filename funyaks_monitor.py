#!/usr/bin/env python3
"""Monitor Dart River Funyaks availability without browser automation."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_DATE = "2027-02-02"
DEFAULT_PARTY_SIZE = 1
DEFAULT_URL = (
    "https://book.dartriver.co.nz/activity/selection"
    "?filter=ProdGroup-DRAALL&workingDate=2027-02-02"
)
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36 FunyaksMonitor/1.0"
)


class MonitorError(RuntimeError):
    """A fetch or parse error that must not be mistaken for no availability."""


@dataclass(frozen=True)
class Departure:
    product: str
    date: str
    time: str
    availability_text: str | None
    available_seats: int | None
    booking_url: str | None
    message: str | None


@dataclass(frozen=True)
class CheckResult:
    status: str
    target_date: str
    party_size: int
    departures: list[Departure]

    @property
    def bookable(self) -> list[Departure]:
        return [
            item
            for item in self.departures
            if item.available_seats is not None
            and item.available_seats >= self.party_size
            and item.booking_url
        ]


def _classes(attrs: list[tuple[str, str | None]]) -> set[str]:
    raw = dict(attrs).get("class") or ""
    return set(raw.split())


def _clean(value: str) -> str:
    return " ".join(value.split())


class FunyaksTableParser(HTMLParser):
    """Extract only desktop Funyaks rows, avoiding duplicate mobile markup."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.rows: list[dict[str, Any]] = []
        self._row: dict[str, Any] | None = None
        self._cell_key: str | None = None
        self._cell_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = _classes(attrs)
        if tag == "tr":
            if "departure-body-desktop" in classes and "departure-item-funyaks" in classes:
                self._row = {"booking_url": None}
            return
        if self._row is None:
            return
        if tag == "td":
            class_to_key = {
                "departure-body-product": "product",
                "departure-body-date": "date",
                "departure-body-time": "time",
                "departure-body-available": "availability",
                "departure-body-book-now-message": "message",
            }
            self._cell_key = next((key for cls, key in class_to_key.items() if cls in classes), None)
            self._cell_text = []
        elif tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._row["booking_url"] = urljoin(self.base_url, href)

    def handle_data(self, data: str) -> None:
        if self._row is not None and self._cell_key:
            self._cell_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._row is None:
            return
        if tag == "td" and self._cell_key:
            self._row[self._cell_key] = _clean("".join(self._cell_text))
            self._cell_key = None
            self._cell_text = []
        elif tag == "tr":
            self.rows.append(self._row)
            self._row = None
            self._cell_key = None
            self._cell_text = []


def _display_date(target: date) -> str:
    months = (
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    )
    return f"{target.day:02d} {months[target.month - 1]} {target.year}"


def _seat_count(value: str | None) -> int | None:
    if not value:
        return None
    match = re.search(r"\d+", value)
    return int(match.group()) if match else None


def parse_availability(
    html: str,
    *,
    target_date: str = DEFAULT_DATE,
    party_size: int = DEFAULT_PARTY_SIZE,
    source_url: str = DEFAULT_URL,
) -> CheckResult:
    if party_size < 1:
        raise ValueError("party_size must be at least 1")
    try:
        target = date.fromisoformat(target_date)
    except ValueError as exc:
        raise ValueError(f"Invalid target date: {target_date}") from exc

    if "Funyaks" not in html or "Dart River" not in html:
        raise MonitorError("Booking page did not contain the expected Dart River/Funyaks markers")

    parser = FunyaksTableParser(source_url)
    parser.feed(html)
    expected = _display_date(target)
    matching_rows = [row for row in parser.rows if row.get("date") == expected]
    if not matching_rows:
        raise MonitorError(f"Could not find a Funyaks departure row for {expected}; page may have changed")

    departures: list[Departure] = []
    unknown_rows: list[dict[str, Any]] = []
    for row in matching_rows:
        available_seats = _seat_count(row.get("availability"))
        message = row.get("message") or None
        is_known_unavailable = bool(
            message and re.search(r"trip full|sold out|no availability|not available", message, re.I)
        )
        if available_seats is None and not is_known_unavailable:
            unknown_rows.append(row)
        departures.append(
            Departure(
                product=row.get("product") or "Funyaks",
                date=target_date,
                time=row.get("time") or "Unknown",
                availability_text=row.get("availability") or None,
                available_seats=available_seats,
                booking_url=row.get("booking_url"),
                message=message,
            )
        )

    if unknown_rows:
        raise MonitorError(f"Funyaks row had an unknown availability format: {unknown_rows!r}")

    status = "available" if any(
        item.available_seats is not None
        and item.available_seats >= party_size
        and item.booking_url
        for item in departures
    ) else "unavailable"
    return CheckResult(status, target_date, party_size, departures)


def fetch_page(url: str, *, attempts: int = 3, timeout: int = 30) -> str:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "en-NZ,en;q=0.9",
                },
            )
            with urlopen(request, timeout=timeout) as response:
                body = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                return body.decode(charset, errors="replace")
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise MonitorError(f"Could not fetch booking page after {attempts} attempts: {last_error}")


def _post_json(url: str, payload: dict[str, Any], timeout: int = 20) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", errors="replace")
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {"raw": raw}


def render_alert(result: CheckResult) -> str:
    lines = [
        f"🎉 Funyaks 有位置了（{result.party_size} 位）",
        f"日期：{result.target_date}",
    ]
    for departure in result.bookable:
        remaining = departure.availability_text or str(departure.available_seats)
        lines.append(f"时间：{departure.time}｜余位：{remaining}")
    link = result.bookable[0].booking_url if result.bookable else DEFAULT_URL
    lines.append(f"立即预订：{link}")
    return "\n".join(lines)


def send_notifications(message: str, title: str | None = None) -> list[str]:
    delivered: list[str] = []
    errors: list[str] = []

    feishu_url = os.getenv("FEISHU_WEBHOOK_URL", "").strip()
    if feishu_url:
        payload: dict[str, Any] = {"msg_type": "text", "content": {"text": message}}
        secret = os.getenv("FEISHU_WEBHOOK_SECRET", "").strip()
        if secret:
            timestamp = str(int(time.time()))
            string_to_sign = f"{timestamp}\n{secret}"
            digest = hmac.new(string_to_sign.encode(), digestmod=hashlib.sha256).digest()
            payload.update(timestamp=timestamp, sign=base64.b64encode(digest).decode())
        try:
            response = _post_json(feishu_url, payload)
            code = response.get("code", response.get("StatusCode", 0))
            if code not in (0, "0", None):
                raise MonitorError(f"Feishu rejected notification: {response}")
            delivered.append("feishu")
        except Exception as exc:  # Continue so another configured channel can still succeed.
            errors.append(f"feishu: {exc}")

    pushplus_token = os.getenv("PUSHPLUS_TOKEN", "").strip()
    if pushplus_token:
        payload = {
            "token": pushplus_token,
            "title": (title or next((line.strip() for line in message.splitlines() if line.strip()), "Funyaks"))[:80],
            "content": message,
            "template": "txt",
            "channel": os.getenv("PUSHPLUS_CHANNEL", "wechat").strip() or "wechat",
        }
        topic = os.getenv("PUSHPLUS_TOPIC", "").strip()
        if topic:
            payload["topic"] = topic
        try:
            response = _post_json("https://www.pushplus.plus/send", payload)
            if response.get("code") not in (200, "200"):
                raise MonitorError(f"PushPlus rejected notification: {response}")
            delivered.append("pushplus")
        except Exception as exc:
            errors.append(f"pushplus: {exc}")

    if errors and not delivered:
        raise MonitorError("All configured notification channels failed: " + "; ".join(errors))
    for error in errors:
        print(f"WARNING notification channel failed: {error}", file=sys.stderr)
    if not feishu_url and not pushplus_token:
        print("WARNING no notification channel configured; alert printed only", file=sys.stderr)
        print(message)
    return delivered


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"").strip("'")
        if key:
            os.environ.setdefault(key, value)


def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        raise MonitorError(f"Could not read state file {path}: {exc}") from exc


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def should_alert(previous: dict[str, Any], result: CheckResult) -> bool:
    return result.status == "available" and previous.get("last_alert_status") != "available"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(args: argparse.Namespace) -> int:
    state_path = Path(args.state_file)
    previous = load_state(state_path)
    checked_at = _now()
    try:
        html = Path(args.html_file).read_text(encoding="utf-8") if args.html_file else fetch_page(args.url)
        result = parse_availability(
            html,
            target_date=args.date,
            party_size=args.party_size,
            source_url=args.url,
        )
    except Exception as exc:
        state = {
            **previous,
            "version": 1,
            "target_date": args.date,
            "party_size": args.party_size,
            "last_checked_at": checked_at,
            "last_error": str(exc),
            "consecutive_errors": int(previous.get("consecutive_errors", 0)) + 1,
        }
        save_state(state_path, state)
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1

    alert = should_alert(previous, result)
    delivered: list[str] = []
    if alert and not args.no_notify:
        try:
            delivered = send_notifications(render_alert(result), title="🎉 Funyaks 有位置了")
        except Exception as exc:
            state = {
                **previous,
                "version": 1,
                "target_date": args.date,
                "party_size": args.party_size,
                "last_status": result.status,
                "last_checked_at": checked_at,
                "last_error": str(exc),
                "consecutive_errors": int(previous.get("consecutive_errors", 0)) + 1,
                "departures": [asdict(item) for item in result.departures],
            }
            save_state(state_path, state)
            print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
            return 1

    changed = previous.get("last_status") != result.status
    if result.status == "unavailable":
        last_alert_status = None
    elif previous.get("last_alert_status") == "available" or delivered:
        last_alert_status = "available"
    else:
        # A dry run or a run without a configured channel must not suppress the
        # first real notification after the user finishes configuring secrets.
        last_alert_status = None

    state = {
        "version": 1,
        "target_date": args.date,
        "party_size": args.party_size,
        "last_status": result.status,
        "last_alert_status": last_alert_status,
        "last_checked_at": checked_at,
        "last_change_at": checked_at if changed else previous.get("last_change_at", checked_at),
        "last_error": None,
        "consecutive_errors": 0,
        "departures": [asdict(item) for item in result.departures],
    }
    save_state(state_path, state)
    output = {
        "status": result.status,
        "target_date": result.target_date,
        "party_size": result.party_size,
        "alert_sent": bool(delivered),
        "notification_channels": delivered,
        "departures": [asdict(item) for item in result.departures],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Monitor Dart River Funyaks availability")
    parser.add_argument("--date", default=os.getenv("TARGET_DATE", DEFAULT_DATE))
    parser.add_argument("--party-size", type=int, default=int(os.getenv("PARTY_SIZE", DEFAULT_PARTY_SIZE)))
    parser.add_argument("--url", default=os.getenv("BOOKING_URL", DEFAULT_URL))
    parser.add_argument("--state-file", default=os.getenv("STATE_FILE", ".state/funyaks.json"))
    parser.add_argument("--html-file", help="Read a saved HTML page instead of making a network request")
    parser.add_argument("--no-notify", action="store_true", help="Check and update state without sending alerts")
    return parser


def main() -> int:
    load_dotenv(Path(".env"))
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
