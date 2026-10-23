import copy
import json
import unittest
import requests
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import patch

from race_monitor.core import CST, digest_events, merge_discoveries, member_events, eligible, display_time, in_scope
from race_monitor import sources as source_module
from race_monitor.catalog import cached_directory, certification, validate_snapshot, SNAPSHOT
from race_monitor.service import execute, plan
from race_monitor.sources import Client, utmb_index, utmb_event, next_data, wtm_members, directory_rows, match_directory, arcteryx_records, zui_cards, SourceError

NOW = datetime(2026, 10, 22, 9, tzinfo=CST)


def item(**kwargs):
    return dict({"id": "utmb:one:2027", "series_id": "utmb:one", "edition": "2027", "name": "2027 Example by UTMB", "category": "utmb",
                 "date": "2027-03-01", "status": "open", "verified": True, "official": "https://one.utmb.world/", "location": "Japan", "continent": "Asia"}, **kwargs)


def result(items=None, sources=None, members=None):
    return {"items": items if items is not None else [item()], "sources": sources or {"official": {"ok": True}}, "members": members or [], "gaps": []}


class DiscoveryTests(unittest.TestCase):
    def test_utmb_requires_official_asian_continent(self):
        for continent in ["Asia", " asia "]:
            self.assertTrue(eligible(item(continent=continent), NOW))
        for continent in ["Europe", "Oceania", "North America", "", None]:
            self.assertFalse(eligible(item(continent=continent, location="Japan"), NOW))

    def test_a_class_requires_jiangsu_zhejiang_or_shanghai_directory_province(self):
        for province in ["江苏", "浙江省", "上海市"]:
            self.assertTrue(eligible(item(category="caa", province=province), NOW))
        for province in ["安徽", "北京", "江西", "", None]:
            self.assertFalse(eligible(item(category="caa", province=province, location="上海赞助商"), NOW))
        self.assertTrue(in_scope(item(category="brand", location="安徽黄山", in_region=True)))
        self.assertTrue(in_scope(item(category="wtm", continent=None)))

    def test_same_edition_changes_and_added_groups_never_notify_again(self):
        state = {}
        self.assertEqual(len(merge_discoveries(state, [item()], NOW)), 1)
        changed = item(name="2027 New official name", date="2027-05-02", groups="20K/100K", status="preview")
        self.assertEqual(merge_discoveries(state, [changed], NOW + timedelta(days=1)), [])
        self.assertEqual(len(state["known"]), 1)

    def test_next_edition_is_a_new_opportunity(self):
        state = {}
        merge_discoveries(state, [item()], NOW)
        self.assertEqual(len(merge_discoveries(state, [item(id="utmb:one:2028", edition="2028", date="2028-03-01")], NOW)), 1)

    def test_cross_platform_repost_uses_same_identity(self):
        state = {}
        merge_discoveries(state, [item(category="brand", id="official:1", series_id=None, name="2027凯乐石莫干山跑山赛", in_region=True, location="浙江")], NOW)
        self.assertEqual(merge_discoveries(state, [item(category="brand", id="zui:123", series_id=None, name="2027 KAILAS 莫干山跑山赛", in_region=True)], NOW), [])

    def test_closed_past_unverified_or_outside_region_never_notify(self):
        for candidate in [item(status="closed"), item(date="2025-01-01"), item(verified=False), item(category="brand", in_region=False), item(closes="2026-10-21T09:00:00+08:00")]:
            self.assertFalse(eligible(candidate, NOW))

    def test_different_brand_sessions_stay_separate(self):
        state = {}
        first = item(category="brand", id="brand:1", series_id=None, in_region=True, name="2027始祖鸟攀岩训练", date="2027-03-01")
        second = dict(first, id="brand:2", date="2027-03-08")
        self.assertEqual(len(merge_discoveries(state, [first, second], NOW)), 2)

    def test_wtm_only_new_asian_members_get_separate_messages(self):
        state = {}
        members = [{"id": "vietnam-mountain-marathon", "name": "VMM", "asia": True, "verified": True},
                   {"id": "new-europe", "name": "Europe", "asia": False, "verified": True},
                   {"id": "new-asia", "name": "New Asia", "asia": True, "verified": True}]
        messages = member_events(state, members, NOW)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["type"], "race_wtm_asia")
        self.assertEqual(member_events(state, members, NOW), [])

    def test_digest_uses_categories_and_stays_below_feishu_size(self):
        events = digest_events([item(id=f"race:{n}", groups="长距离" * 200) for n in range(30)], NOW, "5/5")
        self.assertGreater(len(events), 1)
        for event in events:
            text = event["payload"]["message"]
            self.assertLess(len(text.encode()), 19000)
            self.assertIn("分类：越野跑UTMB", text)
            self.assertNotIn("报名变化", text)
            self.assertNotIn("即将截止", text)

    def test_timezones_and_date_only_evidence(self):
        self.assertEqual(display_time("2026-11-02T12:00:00+09:00"), "2026-11-02 11:00")
        self.assertEqual(display_time("2026-11-02"), "2026-11-02")
        self.assertEqual(display_time(None), "待公布")

    def test_different_group_windows_do_not_hide_a_still_open_short_race(self):
        candidate = item(category="wtm", closes="2026-10-01", registration_windows=[
            {"label": "100mi", "closes": "2026-10-01"}, {"label": "短距离", "closes": "2026-12-01"}])
        self.assertTrue(eligible(candidate, NOW))
        message = digest_events([candidate], NOW, "1/1")[0]["payload"]["message"]
        self.assertIn("短距离：待公布 ～ 2026-12-01", message)


class SourceTests(unittest.TestCase):
    def test_blocked_hk100_can_recover_through_official_isolated_browser(self):
        class Blocked:
            def get(self, url):
                raise source_module.SourceError("HTTP 403")
        home = '<h2>2027 Events</h2><p>21 January 2027</p><a href="https://raceresults.com.hk/event/476">Register</a>'
        entry = '<h2>HONG KONG 100 ENTRY PROCEDURES</h2><h3>Charity Places</h3>'
        with patch.object(source_module, "hk_browser_pages", return_value=[home, entry]):
            value = source_module.hk_items(Blocked())[0]
        self.assertEqual(value["edition"], "2027")
        self.assertEqual(value["verification_method"], "official_browser")
        self.assertEqual(value["status"], "announced")
        self.assertEqual(value["registration"], "https://raceresults.com.hk/event/476")
        with patch.object(source_module, "hk_browser_pages", return_value=['<title>Just a moment</title>', entry]):
            with self.assertRaises(source_module.SourceError):
                source_module.hk_items(Blocked())

    def test_verified_catalog_snapshot_is_exact_and_cannot_certify_another_edition(self):
        cached = cached_directory(source_module.DIRECTORY_URL)
        self.assertEqual(len(cached["rows"]), 489)
        row = next(r for r in cached["rows"] if r["category"] == "A" and r["province"] == "上海")
        self.assertIn("在线更新本轮未核实", certification(row))
        self.assertIsNone(match_directory(row["name"], "2027", cached["rows"]))
        self.assertIsNone(cached_directory("https://example.com/new-2027-catalog.pdf"))
        corrupted = json.loads(SNAPSHOT.read_text())
        corrupted["rows"][0]["category"] = "B"
        self.assertIsNone(validate_snapshot(corrupted, source_module.DIRECTORY_URL))

    def test_catalog_timeout_keeps_marathon_discovery_and_reports_degraded_coverage(self):
        class Client:
            def get(self, url, binary=False):
                if binary:
                    raise source_module.SourceError("catalog connection timed out")
                return "unused fixture"
        with ExitStack() as stack:
            for name in ["utmb_index", "inview_events", "zui_cards", "member_catalog", "fuji_items", "hk_items", "arc_items", "brand_article_items"]:
                stack.enter_context(patch.object(source_module, name, return_value=[]))
            collected = source_module.collect(NOW, Client())
        self.assertEqual(collected["registry_count"], 489)
        directory = next(v for k, v in collected["sources"].items() if k.startswith("caa:directory:"))
        self.assertFalse(directory["ok"])
        self.assertEqual(directory["fallback"]["kind"], "verified_snapshot")
        self.assertNotIn("brand:kailas", collected["sources"])
        self.assertIn("brand:kailas", collected["paused_sources"])
        _, events = plan({}, collected, NOW)
        self.assertIn("报名信息仍实时读取", events[0]["payload"]["message"])

    def test_collector_skips_out_of_scope_detail_pages_on_both_marathon_channels(self):
        events = [dict(tenant=t, title=t, dateBegin="2027-03-01", continent=c, url=f"https://{t}.utmb.world")
                  for t, c in [("asian", "Asia"), ("montblanc", "Europe"), ("unknown", None)]]
        rows = [dict(id=f"caa:{i}", name=f"2027{name}马拉松", edition="2027", category="A", province=p)
                for i, (name, p) in enumerate([("上海", "上海"), ("杭州", "浙江"), ("南京", "江苏"), ("合肥", "安徽"), ("北京", "北京")])]
        domestic = [dict(id=r["id"], name=r["name"], year="2027", raceMoment="2027-03-01", registration={"opensAt": "2026-11-01"}) for r in rows]
        cards = [dict(name=r["name"], date="2027-03-01", url=f"https://reg.zuicool.com/{i}", text=r["province"]) for i, r in enumerate(rows)]
        class Client:
            def get(self, *args, **kwargs):
                return b"unused fixture" if kwargs.get("binary") else "unused fixture"
        with patch.object(source_module, "utmb_index", return_value=events), \
             patch.object(source_module, "inview_events", return_value=domestic), \
             patch.object(source_module, "directory_rows", return_value=rows), \
             patch.object(source_module, "zui_cards", return_value=cards), \
             patch.object(source_module, "utmb_event", return_value=[]) as utmb, \
             patch.object(source_module, "caa_item", return_value=[]) as caa, \
             patch.object(source_module, "zui_detail", return_value=[]) as zui, \
             patch.object(source_module, "member_catalog", return_value=[]), \
             patch.object(source_module, "fuji_items", return_value=[]), \
             patch.object(source_module, "hk_items", return_value=[]), \
             patch.object(source_module, "arc_items", return_value=[]), \
             patch.object(source_module, "brand_article_items", return_value=[]):
            source_module.collect(NOW, Client())
        self.assertEqual([c.args[1]["tenant"] for c in utmb.call_args_list], ["asian"])
        self.assertEqual({c.args[2]["province"] for c in caa.call_args_list}, {"上海", "江苏", "浙江"})
        self.assertEqual({c.args[2]["province"] for c in zui.call_args_list}, {"上海", "江苏", "浙江"})

    def test_public_wordpress_api_can_recover_a_blocked_official_page(self):
        blocked = requests.Response()
        blocked.status_code = 403
        api = requests.Response()
        api.status_code = 200
        html = "<h3>Hong Kong 100</h3>" * 20
        api._content = json.dumps({"content": {"rendered": html}}).encode()
        with patch("race_monitor.sources.public_url"), patch("race_monitor.sources.requests.get", side_effect=[blocked, api]) as get:
            self.assertEqual(Client().get("https://hk100ultra.com/"), html)
            self.assertIn("/wp-json/wp/v2/pages/2", get.call_args_list[1].args[0])
            self.assertNotIn("Authorization", get.call_args_list[1].kwargs.get("headers", {}))

    def test_utmb_reads_complete_embedded_catalog_not_visible_first_page(self):
        events = [{"tenant": n, "dateBegin": "2027-01-01", "url": f"https://{n}.utmb.world", "title": n} for n in ["first", "second", "third"]]
        html = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps({"props": {"pageProps": {"eventsTopBar": events, "slices": [{"data": {"races": [{"name": "visible first page only"}]}}]}}}) + '</script>'
        self.assertEqual(len(utmb_index(html)), 3)
        with self.assertRaises(SourceError):
            next_data("<html>Checking your browser…</html>")

    def test_directory_category_must_be_exact_for_this_year(self):
        rows = [{"name": "2027某地半程马拉松", "edition": "2027", "category": "B"}]
        self.assertEqual(match_directory("2027某地半程马拉松", "2027", rows)["category"], "B")
        self.assertIsNone(match_directory("2027某地马拉松", "2027", rows))
        self.assertIsNone(match_directory("2026某地半程马拉松", "2026", rows))

    def test_directory_rejects_challenge_page_disguised_as_success(self):
        with self.assertRaises(SourceError):
            directory_rows(b"<html>challenge</html>", "https://example.com/list.pdf")

    def test_arcteryx_data_is_parsed_without_executing_javascript(self):
        code = 'ignore();var a=[{P63187_campaigndetail:{id:123,title:"上海攀岩",describe:"a } brace !0",hiddenTitle:!0,eventlocation:"上海"}}];'
        record = arcteryx_records(code)[0]
        self.assertEqual(record["id"], 123)
        self.assertTrue(record["hiddenTitle"])
        self.assertIn("!0", record["describe"])
        with self.assertRaises(SourceError):
            arcteryx_records('P63187_campaigndetail:{id:run_untrusted_code()}')

    def test_zui_empty_or_login_page_is_not_successful_no_news(self):
        with self.assertRaises(SourceError):
            zui_cards("<html>请登录</html>")

    def test_utmb_registration_slug_and_sold_out_groups_are_not_lost(self):
        data = {"props": {"pageProps": {"event": {"name": "Example", "begin": "2027-03-01"},
                "pageHeader": {"link": {"label": "Register Now", "slug": "https://in.register-utmb.world/example"}},
                "simpleMenu": {"slug": "https://in.register-utmb.world/another-event"},
                "slices": [{"data": {"races": [{"id": 1, "name": "100K", "raceStatus": {"status": "registration_open"}},
                                               {"id": 2, "name": "50K", "raceStatus": {"status": "registration_sold_out"}}]}}]}}}
        class Client:
            def get(self, url):
                return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(data) + '</script>'
        value = utmb_event(Client(), {"url": "https://example.utmb.world", "tenant": "example", "dateBegin": "2027-03-01", "title": "Example"})[0]
        self.assertEqual(value["registration"], "https://in.register-utmb.world/example")
        self.assertIn("50K（已满）", value["groups"])
        self.assertEqual(value["status"], "open")

    def test_official_members_card_can_identify_a_new_asian_race(self):
        html = ''.join(f'<section><h3>{name}</h3><p>{country}</p><a href="https://worldtrailmajors.com/activities/{n}">Details</a></section>'
                       for n, name, country in [(1, "Hong Kong 100", "China"), (2, "New Asia Trail", "Nepal"), (3, "New Europe Trail", "Italy")])
        values = {x["name"]: x for x in wtm_members(html)}
        self.assertTrue(values["New Asia Trail"]["asia"])
        self.assertFalse(values["New Europe Trail"]["asia"])


class StoreTests(unittest.TestCase):
    class MemoryStore:
        def __init__(self):
            self.value = {"version": 0, "state": {}}
            self.events = []
        def load(self):
            return copy.deepcopy(self.value)
        def commit(self, version, state, events):
            if version != self.value["version"]:
                raise RuntimeError("CAS conflict")
            self.value = {"version": version + 1, "state": copy.deepcopy(state)}
            self.events.extend(copy.deepcopy(events))
            return version + 1

    def test_latest_successful_directory_is_persisted_and_preferred_next_day(self):
        saved = json.loads(SNAPSHOT.read_text())
        saved["verified_at"] = NOW.isoformat()
        store = self.MemoryStore()
        first = dict(result(), directory_cache={saved["source"]: saved})
        execute(store, NOW, collector=lambda now, **kwargs: first)
        def next_day(now, directory_cache):
            cached = cached_directory(saved["source"], directory_cache[saved["source"]])
            self.assertEqual(cached["verified_at"], NOW.isoformat())
            return result(items=[])
        execute(store, NOW + timedelta(days=1), collector=next_day)
        self.assertEqual(store.value["state"]["directory_cache"][saved["source"]], saved)

    def test_watchdog_does_not_scan_twice_after_completed_daily_batch(self):
        store = self.MemoryStore()
        execute(store, NOW, collector=lambda now, **kwargs: result())
        response = execute(store, NOW + timedelta(minutes=30), collector=lambda now, **kwargs: self.fail("should not collect"))
        self.assertEqual(response["status"], "already_completed")
        self.assertEqual(len(store.events), 1)

    def test_crashed_batch_can_resume_after_lease_and_still_alert_once(self):
        store = self.MemoryStore()
        with self.assertRaises(RuntimeError):
            execute(store, NOW, collector=lambda now, **kwargs: (_ for _ in ()).throw(RuntimeError("source crash")))
        self.assertEqual(execute(store, NOW + timedelta(minutes=10))["status"], "running")
        execute(store, NOW + timedelta(minutes=30), collector=lambda now, **kwargs: result())
        self.assertEqual(len(store.events), 1)

    def test_state_and_new_notifications_are_not_lost_when_commit_fails(self):
        store = self.MemoryStore()
        actual = store.commit
        def fail_final(version, state, events):
            if events:
                raise RuntimeError("network failure")
            return actual(version, state, events)
        with patch.object(store, "commit", side_effect=fail_final):
            with self.assertRaises(RuntimeError):
                execute(store, NOW, collector=lambda now, **kwargs: result())
        execute(store, NOW + timedelta(minutes=30), collector=lambda now, **kwargs: result())
        self.assertEqual(len(store.events), 1)

    def test_partial_failure_does_not_wipe_known_data_or_repeat_error_daily(self):
        initial, events = plan({}, result(), NOW)
        bad = result(items=[], sources={"official": {"ok": False, "error": "HTTP 403"}})
        state, alerts = plan(initial, bad, NOW + timedelta(days=1))
        self.assertIn("utmb:one:2027", state["known"])
        self.assertEqual(alerts[0]["type"], "race_source_degraded")
        state, alerts = plan(state, copy.deepcopy(bad), NOW + timedelta(days=2))
        self.assertEqual(alerts, [])
        state, alerts = plan(state, result(items=[]), NOW + timedelta(days=3))
        self.assertEqual(alerts[0]["type"], "race_source_recovered")

    def test_pausing_a_blocked_source_is_not_reported_as_a_recovery(self):
        state = {"sources": {"brand:kailas": {"ok": False}}}
        collected = dict(result(items=[]), paused_sources={"brand:kailas": {"reason": "user chose partner sources"}})
        state, alerts = plan(state, collected, NOW)
        self.assertEqual(alerts, [])
        self.assertIn("brand:kailas", state["paused_sources"])


if __name__ == "__main__":
    unittest.main()
