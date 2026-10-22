"""Identity, eligibility and Feishu rendering; no network or credentials here."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from urllib.parse import urlsplit, urlunsplit

CST = timezone(timedelta(hours=8))
CATEGORIES = {"utmb": "越野跑UTMB", "wtm": "越野跑WTM", "caa": "马拉松A类赛事", "brand": "品牌活动"}
WTM_ASIA_BASELINE = {"hong-kong-100", "mt-fuji-100", "vietnam-mountain-marathon"}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_url(value):
    """Only preserve public HTTP links, never script or data URLs."""
    try:
        p = urlsplit(str(value or ""))
        if p.scheme not in {"https", "http"} or not p.hostname or p.username or p.password:
            return ""
        return urlunsplit((p.scheme, p.netloc, p.path, p.query, ""))
    except ValueError:
        return ""


def normalized_name(value):
    value = clean(value).lower()
    value = re.sub(r"20\d{2}|凯乐石|kailas|fuga|始祖鸟|arc.?teryx|暨第[一二三四五六七八九十\d]+届", "", value)
    return re.sub(r"[^\w\u4e00-\u9fff]", "", value)


def stamp(value):
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d.replace(tzinfo=CST) if d.tzinfo is None else d.astimezone(CST)
    except (ValueError, TypeError):
        return None


def display_time(value):
    if not value:
        return "待公布"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value)):
        return str(value)  # Date-only evidence must remain date-only.
    d = stamp(value)
    return d.strftime("%Y-%m-%d %H:%M") if d else clean(value)


def eligible(item, now):
    if item.get("category") not in CATEGORIES or not item.get("verified"):
        return False
    if item.get("category") == "brand" and not item.get("in_region"):
        return False
    if item.get("status") in {"closed", "sold_out", "cancelled", "past", "unknown"}:
        return False
    windows = item.get("registration_windows", [])
    end = max((stamp(w.get("closes")) for w in windows if stamp(w.get("closes"))), default=None) if windows else stamp(item.get("closes"))
    if end and end < now:
        return False
    race = str(item.get("date_end") or item.get("date") or "")[:10]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", race) and race < now.date().isoformat():
        return False
    return bool(item.get("id") and item.get("edition") and item.get("name"))


def find_identity(item, known):
    if item["id"] in known:
        return item["id"]
    # Official IDs handle renamed/rescheduled editions. Cross-platform aliases
    # require the same edition; two different sessions on different dates stay separate.
    name = normalized_name(item["name"])
    for key, old in known.items():
        if old.get("edition") != item.get("edition") or old.get("category") != item.get("category"):
            continue
        if item.get("series_id") and old.get("series_id") == item["series_id"]:
            return key
        a, b = safe_url(item.get("official")), safe_url(old.get("official"))
        same_page = a and a == b and urlsplit(a).path not in {"", "/"}
        same_date = item.get("date") and item.get("date") == old.get("date")
        other = normalized_name(old.get("name"))
        if (same_page or same_date) and len(name) >= 5 and SequenceMatcher(None, name, other).ratio() >= .92:
            return key
    return item["id"]


def merge_discoveries(state, items, now):
    """Only first discovery may notify; changes to known items never do."""
    known = state.setdefault("known", {})
    fresh = []
    for item in sorted(items, key=lambda v: v.get("priority", 10)):
        key = find_identity(item, known)
        old = known.get(key)
        item = dict(item, id=key, first_seen=(old or {}).get("first_seen", now.isoformat()), last_seen=now.isoformat())
        if old is None and eligible(item, now):
            fresh.append(item)
        if old is None or item.get("priority", 10) <= old.get("priority", 10):
            known[key] = item
        else:
            known[key]["last_seen"] = now.isoformat()
    return fresh


def item_text(item):
    labels = {"open": "报名中", "preview": "报名预告", "announced": "报名公告已发布（当前状态请查看原文）", "ballot": "抽签登记", "charity": "慈善名额入口（实际余位未核实）"}
    lines = [f"🆕 {clean(item['name'])}", f"分类：{CATEGORIES[item['category']]}",
             f"地点：{clean(item.get('location')) or '待公布'}｜活动日期：{display_time(item.get('date'))}",
             f"项目／组别：{clean(item.get('groups')) or '待公布'}",
             f"报名状态：{labels.get(item.get('status'), '待公布')}",
             "报名时间：按组别列示（时刻为北京时间；仅日期另注明原时区）" if item.get("registration_windows") else f"报名时间：{display_time(item.get('opens'))} ～ {display_time(item.get('closes'))}（北京时间）",
             f"报名方式：{clean(item.get('method')) or '待公布'}｜费用：{clean(item.get('fee')) or '待公布'}",
             f"资格要求：{clean(item.get('qualification')) or '请查看官方规程'}"]
    for window in item.get("registration_windows", []):
        lines.append(f"{clean(window['label'])}：{display_time(window.get('opens'))} ～ {display_time(window.get('closes'))}")
    for key, label in [("brand", "品牌关系"), ("certification", "A类依据")]:
        if item.get(key):
            lines.append(f"{label}：{clean(item[key])}")
    lines.extend([f"报名入口：{safe_url(item.get('registration')) or clean(item.get('entry_path')) or '待公布，请查看官方原文'}",
                  f"官方原文：{safe_url(item.get('official')) or safe_url(item.get('source'))}"])
    if item.get("evidence") and item["evidence"] != item.get("official"):
        lines.append(f"核验依据：{safe_url(item['evidence'])}")
    return "\n".join(lines)


def digest_events(items, now, coverage, max_bytes=15000):
    """Split on whole entries, comfortably below the text webhook byte limit."""
    blocks, chunks = [], []
    rank = {"utmb": 0, "wtm": 1, "caa": 2, "brand": 3}
    for item in sorted(items, key=lambda x: (rank[x["category"]], "上海" not in (x.get("location") or ""), x.get("date") or "", x["id"])):
        block = item_text(item)
        if blocks and len(("\n\n".join(blocks + [block])).encode()) > max_bytes - 1500:
            chunks.append(blocks)
            blocks = []
        blocks.append(block)
    if blocks:
        chunks.append(blocks)
    events = []
    for index, blocks in enumerate(chunks, 1):
        header = f"🏃 发现新的赛事与户外活动｜{now:%Y-%m-%d}\n本次新增 {len(items)} 项（{index}/{len(chunks)}）"
        text = header + "\n\n" + "\n\n".join(blocks) + f"\n\n核验时间：{now:%Y-%m-%d %H:%M}（北京时间）\n来源覆盖：{coverage}"
        fingerprint = hashlib.sha256(text.encode()).hexdigest()[:24]
        events.append({"key": f"races:digest:{fingerprint}", "type": "race_digest", "payload": {"message": text}})
    return events


def member_events(state, members, now):
    known = state.setdefault("wtm_members", sorted(WTM_ASIA_BASELINE))
    events = []
    for member in members:
        if member["id"] in known or not member.get("asia") or not member.get("verified"):
            continue
        known.append(member["id"])
        text = (f"🌏 World Trail Majors 新增亚洲站\n\n赛事：{member['name']}\n"
                f"地点：{member.get('location') or '亚洲（具体地点待公布）'}\n"
                f"官方确认：成员赛事官方页面已列入 WTM 名单\n加入公告日期：{member.get('announced') or '未公布'}\n比赛及报名信息：请查看赛事官网\n"
                f"官方依据：{safe_url(member.get('evidence'))}\n赛事官网：{safe_url(member.get('url')) or '待公布'}\n\n"
                f"当前WTM报名监控仍为环富士山、港百。\n核验时间：{now:%Y-%m-%d %H:%M}（北京时间）")
        events.append({"key": f"races:wtm-asia:{member['id']}", "type": "race_wtm_asia", "payload": {"message": text}})
    return events
