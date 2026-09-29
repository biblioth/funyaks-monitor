import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchOceanAvailability,
  oceanCheckDue,
  oceanExpired,
  parseOceanSessions,
  planOceanTransition,
} from "../src/ocean.js";

const productUrl =
  "https://oceanextreme.rezdy.com/294317/whale-watching-on-vessel-extreme-circular-quay-departure";
const env = {
  OCEAN_PRODUCT_URL: productUrl,
  OCEAN_UPDATE_URL: "https://oceanextreme.rezdy.com/updateTotalprice",
  OCEAN_TARGET_DATE: "2026-10-07",
  OCEAN_TARGET_TIME: "11:00",
  OCEAN_PARTY_SIZE: "1",
};

const responsePayload = (available) => ({
  sessions: [439431590, 439431574, 439431573],
  sessionTimeLabel: {
    439431590: "8:00 AM - Sold out",
    439431574: available ? "11:00 AM" : "11:00 AM - Sold out",
    439431573: "2:00 PM - Sold out",
  },
  activeSession: {
    439431590: false,
    439431574: available,
    439431573: false,
  },
});

test("parses the exact 11:00 session without confusing other departures", () => {
  const parsed = parseOceanSessions(responsePayload(true));
  assert.equal(parsed.target.id, "439431574");
  assert.equal(parsed.target.available, true);
});

test("bootstraps Rezdy CSRF and cookie before checking the target session", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(
        `<title>Ocean Extreme Reservations</title><script>settings.data['YII_CSRF_TOKEN'] = 'csrf-1';</script>`,
        { status: 200, headers: { "set-cookie": "session=abc; path=/; secure" } },
      );
    }
    assert.equal(url, env.OCEAN_UPDATE_URL);
    assert.match(options.headers.cookie, /session=abc/);
    assert.match(options.body, /OrderItem%5BpreferredDate%5D=2026-10-07/);
    assert.match(options.body, /YII_CSRF_TOKEN=csrf-1/);
    return Response.json(responsePayload(false));
  };
  const result = await fetchOceanAvailability(env, fetcher);
  assert.equal(requests.length, 2);
  assert.equal(result.status, "unavailable");
  assert.equal(result.targetSession.id, "439431574");
});

test("reports Cloudflare bot blocking as an error, never as no availability", async () => {
  const result = await fetchOceanAvailability(env, async () => new Response(
    "<title>Attention Required!</title>Sorry, you have been blocked",
    { status: 403 },
  ));
  assert.equal(result.status, "error");
  assert.match(result.error, /blocked/);
});

test("availability alerts once and rearms after sold out", () => {
  const available = {
    status: "available",
    targetDate: "2026-10-07",
    targetTime: "11:00",
    partySize: 1,
    targetSession: { id: "439431574", label: "11:00 AM", available: true },
    sessions: [],
    sourceUrl: productUrl,
  };
  assert.equal(planOceanTransition(null, available, "2026-09-28T00:00:00Z").events[0].type, "ocean_availability");
  assert.equal(
    planOceanTransition({ current_status: "available" }, available, "2026-09-28T00:01:00Z").events.length,
    0,
  );
  const unavailable = planOceanTransition(
    { current_status: "available" },
    { ...available, status: "unavailable", targetSession: { ...available.targetSession, available: false } },
    "2026-09-28T00:02:00Z",
  );
  const returned = planOceanTransition(
    { current_status: "unavailable", last_unavailable_at: unavailable.state.lastUnavailableAt },
    available,
    "2026-09-28T00:03:00Z",
  );
  assert.equal(returned.events[0].type, "ocean_availability");
});

test("monitor expires exactly at Sydney midnight after 7 October", () => {
  const stopEnv = { OCEAN_STOP_AT_UTC: "2026-10-07T13:00:00Z" };
  assert.equal(oceanExpired(stopEnv, new Date("2026-10-07T12:59:59Z")), false);
  assert.equal(oceanExpired(stopEnv, new Date("2026-10-07T13:00:00Z")), true);
});

test("scheduled checks are spread to a five-minute cadence", () => {
  assert.equal(oceanCheckDue({}, new Date("2026-09-29T11:20:44Z")), true);
  assert.equal(oceanCheckDue({}, new Date("2026-09-29T11:21:44Z")), false);
});
