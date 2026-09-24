import test from "node:test";
import assert from "node:assert/strict";

import { funyaksEnabled, healthResponse, weeklySummaryDue } from "../src/index.js";

test("weekly report window is Sunday 10:00 Beijing time", () => {
  assert.equal(weeklySummaryDue(new Date("2026-09-20T02:00:00.000Z")), true);
  assert.equal(weeklySummaryDue(new Date("2026-09-20T02:59:00.000Z")), true);
  assert.equal(weeklySummaryDue(new Date("2026-09-20T01:59:00.000Z")), false);
  assert.equal(weeklySummaryDue(new Date("2026-09-21T02:00:00.000Z")), false);
});

test("paused Funyaks health is explicit and does not touch D1", async () => {
  assert.equal(funyaksEnabled({ FUNYAKS_ENABLED: "false" }), false);
  assert.equal(funyaksEnabled({}), true);
  const response = await healthResponse({
    FUNYAKS_ENABLED: "false",
    TARGET_DATE: "2027-02-02",
    PARTY_SIZE: "1",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    paused: true,
    target: { date: "2027-02-02", partySize: 1 },
    message: "Funyaks monitoring is paused",
  });
});
