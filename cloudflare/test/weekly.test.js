import test from "node:test";
import assert from "node:assert/strict";

import { weeklySummaryDue } from "../src/index.js";

test("weekly report window is Sunday 10:00 Beijing time", () => {
  assert.equal(weeklySummaryDue(new Date("2026-09-20T02:00:00.000Z")), true);
  assert.equal(weeklySummaryDue(new Date("2026-09-20T02:59:00.000Z")), true);
  assert.equal(weeklySummaryDue(new Date("2026-09-20T01:59:00.000Z")), false);
  assert.equal(weeklySummaryDue(new Date("2026-09-21T02:00:00.000Z")), false);
});
