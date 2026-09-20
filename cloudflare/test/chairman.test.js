import test from "node:test";
import assert from "node:assert/strict";

import { fetchChairmanAvailability, planChairmanTransition } from "../src/chairman.js";

const queueUrl = "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";
const env = {
  CHAIRMAN_QUEUE_URL: queueUrl,
  CHAIRMAN_TARGET_DATES: "2026-10-30,2026-10-31,2026-11-01",
  CHAIRMAN_MEAL_WINDOWS: "lunch,dinner",
  CHAIRMAN_PARTY_SIZE: "2",
  CHAIRMAN_FETCH_TIMEOUT_MS: "45000",
};

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

test("follows Queue-it redirects with its visitor cookie and treats HTTP 429 as busy", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return redirect("/afterevent.aspx?c=thechairmangroup&e=chairman260806", {
        "set-cookie": "Queue-it-visitorsession=visitor-1; path=/; secure; httponly",
      });
    }
    if (requests.length === 2) {
      assert.match(options.headers.cookie, /Queue-it-visitorsession=visitor-1/);
      return redirect(
        "https://www.thechairmangroup.com/index.php?route=catering/booking&queueittoken=test",
      );
    }
    return new Response("<title>Server Busy</title>現在系統非常繁忙", { status: 429 });
  };

  const result = await fetchChairmanAvailability(env, fetcher);
  assert.equal(requests.length, 3);
  assert.equal(result.status, "busy");
  assert.equal(result.httpStatus, 429);
});

test("keeps the Queue-it acceptance cookie across the Chairman token-cleanup redirect", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return redirect("/afterevent.aspx?c=thechairmangroup&e=chairman260806", {
        "set-cookie": "Queue-it-visitorsession=visitor-1; path=/; secure; httponly",
      });
    }
    if (requests.length === 2) {
      return redirect(
        "https://www.thechairmangroup.com/index.php?route=catering/booking&queueittoken=test",
      );
    }
    if (requests.length === 3) {
      return redirect("https://www.thechairmangroup.com/index.php?route=catering/booking", {
        "set-cookie": "QueueITAccepted-SDFrts345E-V3_chairman260806=accepted; path=/; secure; httponly",
      });
    }
    assert.match(options.headers.cookie, /QueueITAccepted-SDFrts345E-V3_chairman260806=accepted/);
    return new Response(`
      <html><body><h1>The Chairman Reservation</h1>
        <table>
          <tr><td>2026-10-30</td><td><a href="/book?date=2026-10-30&time=12:30">Book 12:30</a></td></tr>
          <tr><td>2026-10-31</td><td><button disabled>12:00 Fully booked</button><button disabled>19:00 Fully booked</button></td></tr>
          <tr><td>2026-11-01</td><td><button disabled>12:00 Fully booked</button><button disabled>19:00 Fully booked</button></td></tr>
        </table>
      </body></html>
    `, { status: 200 });
  };

  const result = await fetchChairmanAvailability(env, fetcher);
  assert.equal(requests.length, 4);
  assert.equal(result.status, "available");
  assert.deepEqual(result.available.map((item) => item.key), ["2026-10-30:lunch"]);
});

test("newly available Chairman slots alert once and rearm after unavailability", () => {
  const available = {
    status: "available",
    partySize: 2,
    sourceUrl: queueUrl,
    observations: [],
    available: [{ key: "2026-10-30:lunch", date: "2026-10-30", mealWindow: "lunch", times: ["12:30"] }],
  };
  const first = planChairmanTransition(null, available, "2026-09-20T00:00:00Z", 3);
  assert.equal(first.events[0].type, "chairman_availability");

  const continued = planChairmanTransition(
    { available_keys_json: JSON.stringify(["2026-10-30:lunch"]), consecutive_failures: 0 },
    available,
    "2026-09-20T00:01:00Z",
    3,
  );
  assert.equal(continued.events.length, 0);

  const unavailable = planChairmanTransition(
    { available_keys_json: JSON.stringify(["2026-10-30:lunch"]), consecutive_failures: 0 },
    { ...available, status: "unavailable", available: [] },
    "2026-09-20T00:02:00Z",
    3,
  );
  const returned = planChairmanTransition(
    { available_keys_json: JSON.stringify(unavailable.state.availableKeys), consecutive_failures: 0 },
    available,
    "2026-09-20T00:03:00Z",
    3,
  );
  assert.equal(returned.events[0].type, "chairman_availability");
});

test("expected server busy state does not increment failures or send alerts", () => {
  const result = planChairmanTransition(
    {
      current_status: "unavailable",
      available_keys_json: "[]",
      observations_json: "[]",
      consecutive_failures: 2,
    },
    { status: "busy", error: "HTTP 429", sourceUrl: queueUrl },
    "2026-09-20T00:03:00Z",
    3,
  );
  assert.equal(result.state.consecutiveFailures, 2);
  assert.equal(result.events.length, 0);
});
