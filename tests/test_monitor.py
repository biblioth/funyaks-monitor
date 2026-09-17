from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import funyaks_monitor as monitor


FIXTURES = Path(__file__).parent / "fixtures"


class ParserTests(unittest.TestCase):
    def test_sold_out_is_unavailable(self):
        html = (FIXTURES / "sold_out.html").read_text(encoding="utf-8")
        result = monitor.parse_availability(html)
        self.assertEqual(result.status, "unavailable")
        self.assertEqual(result.departures[0].time, "9:30 AM")
        self.assertIn("Trip full", result.departures[0].message or "")

    def test_one_seat_is_bookable_for_one_person(self):
        html = (FIXTURES / "available.html").read_text(encoding="utf-8")
        result = monitor.parse_availability(html, party_size=1)
        self.assertEqual(result.status, "available")
        self.assertEqual(result.bookable[0].available_seats, 1)
        self.assertEqual(
            result.bookable[0].booking_url,
            "https://book.dartriver.co.nz/activity/add?DepartureCode=departure.20270202T0930.DRFUNYAK..&transport=-1",
        )

    def test_one_seat_is_not_enough_for_two_people(self):
        html = (FIXTURES / "available.html").read_text(encoding="utf-8")
        result = monitor.parse_availability(html, party_size=2)
        self.assertEqual(result.status, "unavailable")

    def test_missing_target_row_is_an_error(self):
        html = (FIXTURES / "sold_out.html").read_text(encoding="utf-8")
        with self.assertRaises(monitor.MonitorError):
            monitor.parse_availability(html, target_date="2027-02-03")


class StateTests(unittest.TestCase):
    def test_alerts_once_per_available_episode(self):
        html = (FIXTURES / "available.html").read_text(encoding="utf-8")
        result = monitor.parse_availability(html)
        self.assertTrue(monitor.should_alert({}, result))
        self.assertFalse(monitor.should_alert({"last_alert_status": "available"}, result))

    def test_cli_fixture_writes_state_without_notification(self):
        with TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            args = SimpleNamespace(
                state_file=str(state_file),
                html_file=str(FIXTURES / "sold_out.html"),
                url=monitor.DEFAULT_URL,
                date=monitor.DEFAULT_DATE,
                party_size=1,
                no_notify=True,
            )
            self.assertEqual(monitor.run(args), 0)
            self.assertEqual(monitor.load_state(state_file)["last_status"], "unavailable")

    def test_dry_run_does_not_suppress_later_real_alert(self):
        with TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            args = SimpleNamespace(
                state_file=str(state_file),
                html_file=str(FIXTURES / "available.html"),
                url=monitor.DEFAULT_URL,
                date=monitor.DEFAULT_DATE,
                party_size=1,
                no_notify=True,
            )
            self.assertEqual(monitor.run(args), 0)
            state = monitor.load_state(state_file)
            self.assertEqual(state["last_status"], "available")
            self.assertIsNone(state["last_alert_status"])
            self.assertTrue(monitor.should_alert(state, monitor.parse_availability(
                (FIXTURES / "available.html").read_text(encoding="utf-8")
            )))


class NotificationTests(unittest.TestCase):
    @patch("funyaks_monitor._post_json", return_value={"code": 200})
    @patch.dict(
        "os.environ",
        {"PUSHPLUS_TOKEN": "token", "PUSHPLUS_CHANNELS": "wechat,wechat,clawbot"},
        clear=True,
    )
    def test_pushplus_sends_wechat_and_clawbot_once_each(self, post_json):
        delivered = monitor.send_notifications("test", title="Funyaks")
        self.assertEqual(delivered, ["pushplus", "pushplus:clawbot"])
        self.assertEqual(
            [call.args[1]["channel"] for call in post_json.call_args_list],
            ["wechat", "clawbot"],
        )


if __name__ == "__main__":
    unittest.main()
