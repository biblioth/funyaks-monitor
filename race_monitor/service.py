"""Daily collector backed by the existing Cloudflare D1 + Feishu outbox."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timedelta

import requests

from .core import CST, digest_events, member_events, merge_discoveries, stamp
from .sources import collect


class Store:
    def __init__(self, base, token):
        if not base.startswith("https://") or not token:
            raise RuntimeError("缺少 RACE_MONITOR_URL 或 CLOUDFLARE_ADMIN_TOKEN")
        self.base, self.headers = base.rstrip("/"), {"Authorization": f"Bearer {token}"}

    def load(self):
        r = requests.get(self.base + "/races/state", headers=self.headers, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"读取持久化状态失败 HTTP {r.status_code}")
        return r.json()

    def commit(self, version, state, events):
        # Never blindly retry a POST: an ambiguous response must reload state.
        r = requests.post(self.base + "/races/commit", headers=self.headers,
                          json={"version": version, "state": state, "events": events}, timeout=45)
        if r.status_code != 200:
            raise RuntimeError(f"保存状态／通知事件失败 HTTP {r.status_code}；请重载状态后续跑")
        return r.json()["version"]


def plan(state, result, now):
    state = copy.deepcopy(state)
    previous_sources = state.get("sources", {})
    current = result["sources"]
    # Keep the last successful time across failures, instead of pretending the
    # current failed request was a successful freshness check.
    for name, value in current.items():
        value["last_success_at"] = now.isoformat() if value["ok"] else previous_sources.get(name, {}).get("last_success_at")
    fresh = merge_discoveries(state, result["items"], now)
    good = sum(bool(s["ok"]) for s in current.values())
    events = digest_events(fresh, now, f"{good}/{len(current)}")
    events += member_events(state, result["members"], now)
    failed = {k: v for k, v in current.items() if not v["ok"]}
    # A removed/paused source is a coverage gap, never a successful recovery.
    old_failed = {k for k, v in previous_sources.items() if not v["ok"] and k in current}
    signature = hashlib.sha256(json.dumps(sorted(failed)).encode()).hexdigest()[:16]
    if failed and set(failed) != old_failed:
        lines = [f"⚠️ 赛事监控部分来源无法读取｜{now:%Y-%m-%d}", f"成功 {good}/{len(current)} 个来源；受影响信息未能核实。"]
        for name, value in sorted(failed.items()):
            lines.extend([f"\n影响来源：{name}", f"原因：{value.get('error', '读取失败')}",
                          f"最后成功读取：{value.get('last_success_at') or '尚无成功记录'}"])
            if value.get("fallback", {}).get("kind") == "verified_snapshot":
                fallback = value["fallback"]
                lines.append(f"备用处理：使用{fallback['verified_at']}核验的{fallback['edition']}年目录快照继续核对A类；目录在线更新尚未核实，报名信息仍实时读取。")
        # Bound diagnostics; full source status remains in D1 and the run artifact.
        message = "\n".join(lines)[:4200] + "\n\n其余来源的已确认新增照常推送；未接入的小程序另列为覆盖缺口。"
        events.append({"key": f"races:degraded:{now:%Y%m%d}:{signature}", "type": "race_source_degraded", "payload": {"message": message}})
    elif not failed and old_failed:
        events.append({"key": f"races:recovered:{now:%Y%m%d}", "type": "race_source_recovered",
                       "payload": {"message": f"✅ 赛事监控已启用来源恢复正常\n核验时间：{now:%Y-%m-%d %H:%M}（北京时间）\n本轮 {good}/{len(current)} 个已启用来源读取成功；暂停来源及未接入渠道的覆盖缺口仍保留。"}})
    state.update(sources=current, last_completed_at=now.isoformat(), last_run_date=now.date().isoformat(), run=None,
                 directory_cache=result.get("directory_cache", state.get("directory_cache", {})),
                 paused_sources=result.get("paused_sources", {}),
                 marathon_coverage=result.get("marathon_coverage", {}),
                 gaps=result.get("gaps", []), registry_count=result.get("registry_count", 0), a_class_count=result.get("a_class_count", 0), review_leads=result.get("review_leads", []))
    return state, events


def execute(store, now, collector=collect):
    snapshot = store.load()
    state = snapshot["state"]
    if state.get("last_run_date") == now.date().isoformat():
        return {"status": "already_completed", "date": state["last_run_date"]}
    started = stamp((state.get("run") or {}).get("started_at"))
    if started and now - started < timedelta(minutes=25):
        return {"status": "running", "started_at": started.isoformat()}
    state["run"] = {"date": now.date().isoformat(), "started_at": now.isoformat()}
    version = store.commit(snapshot["version"], state, [])
    result = collector(now, directory_cache=state.get("directory_cache", {}))
    if not any(v["ok"] for v in result["sources"].values()):
        raise RuntimeError("全部来源读取失败；未更新活动基线")
    state, events = plan(state, result, now)
    store.commit(version, state, events)
    return {"status": "completed", "date": state["last_run_date"], "known": len(state.get("known", {})), "messages": len(events),
            "marathon_coverage": result.get("marathon_coverage", {}),
            "sources": result["sources"], "registry_count": result.get("registry_count"), "a_class_count": result.get("a_class_count"), "gaps": result.get("gaps", []), "review_leads": result.get("review_leads", [])}


def notify_failure():
    """Independent GitHub fallback, using only the existing Feishu secrets."""
    import base64
    import hmac
    import time
    url = os.environ.get("FEISHU_WEBHOOK_URL")
    if not url:
        raise RuntimeError("原飞书机器人 Secret 未配置")
    payload = {"msg_type": "text", "content": {"text": "⚠️ 赛事监控任务未正常完成\n每日采集或状态保存失败，部分新增可能延迟发现。\n请查看 GitHub Actions：" + os.environ.get("GITHUB_RUN_URL", "https://github.com/biblioth/funyaks-monitor/actions")}}
    secret = os.environ.get("FEISHU_WEBHOOK_SECRET")
    if secret:
        t = str(int(time.time()))
        payload.update(timestamp=t, sign=base64.b64encode(hmac.new(f"{t}\n{secret}".encode(), digestmod=hashlib.sha256).digest()).decode())
    for attempt in range(3):
        try:
            r = requests.post(url, json=payload, timeout=20)
            r.raise_for_status()
            value = r.json()
            if value.get("code", value.get("StatusCode", -1)) not in (0, "0"):
                raise RuntimeError("飞书机器人拒绝故障通知")
            return
        except (requests.RequestException, ValueError, RuntimeError):
            if attempt == 2:
                raise RuntimeError("飞书故障通知投递失败（未输出凭据）") from None
            time.sleep(2 ** attempt)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true", help="真实采集但不读写远端状态、不发送消息")
    parser.add_argument("--failure-notify", action="store_true")
    parser.add_argument("--output", default=".state/race-report.json")
    args = parser.parse_args(argv)
    now = datetime.now(CST)
    if args.failure_notify:
        notify_failure()
        return 0
    if args.preview:
        result = collect(now)
        state, events = plan({}, result, now)
        report = {"preview": True, "result": result, "messages": events, "known": len(state.get("known", {}))}
    else:
        store = Store(os.environ.get("RACE_MONITOR_URL", ""), os.environ.get("CLOUDFLARE_ADMIN_TOKEN", ""))
        report = execute(store, now)
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in {"result", "messages", "sources", "review_leads"}}, ensure_ascii=False))
    if "sources" in report:
        print(f"来源：成功 {sum(x['ok'] for x in report['sources'].values())}/{len(report['sources'])}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # Requests exception strings can contain the webhook URL. Never print them.
        print(f"赛事监控失败：{type(e).__name__}；请检查运行报告和已配置来源。", file=sys.stderr)
        sys.exit(1)
