import test from "node:test";
import assert from "node:assert/strict";

import { planTransition } from "../src/storage.js";

const unavailable = {
  status: "unavailable",
  targetDate: "2027-02-02",
  partySize: 1,
  departures: [{ availableSeats: null, availabilityText: null, bookingUrl: null }],
  bookable: [],
  sourceUrl: "https://example.com",
};
const available = {
  ...unavailable,
  status: "available",
  departures: [{ availableSeats: 1, availabilityText: "1", bookingUrl: "https://example.com/book" }],
  bookable: [{ availableSeats: 1, availabilityText: "1", bookingUrl: "https://example.com/book" }],
};

test("first available observation alerts immediately", () => {
  const result = planTransition(null, available, "2026-09-16T00:00:00Z", 3);
  assert.equal(result.events[0].type, "availability");
});

test("continued availability does not alert twice", () => {
  const previous = { current_status: "available", consecutive_failures: 0 };
  const result = planTransition(previous, available, "2026-09-16T00:01:00Z", 3);
  assert.equal(result.events.length, 0);
});

test("an unavailable episode rearms the next availability alert", () => {
  const soldOut = planTransition(
    { current_status: "available", consecutive_failures: 0 },
    unavailable,
    "2026-09-16T00:01:00Z",
    3,
  );
  const returned = planTransition(
    {
      current_status: soldOut.state.currentStatus,
      consecutive_failures: 0,
      last_unavailable_at: soldOut.state.lastUnavailableAt,
    },
    available,
    "2026-09-16T00:02:00Z",
    3,
  );
  assert.equal(returned.events[0].type, "availability");
  assert.match(returned.events[0].key, /2026-09-16T00:01:00Z/);
});

test("third consecutive failure emits one degraded event", () => {
  const previous = {
    current_status: "unavailable",
    consecutive_failures: 2,
    failure_started_at: "2026-09-16T00:00:00Z",
  };
  const result = planTransition(
    previous,
    { status: "error", error: "timeout" },
    "2026-09-16T00:02:00Z",
    3,
  );
  assert.equal(result.events[0].type, "monitor_degraded");
});

test("successful check after degradation emits recovery", () => {
  const previous = {
    current_status: "unavailable",
    consecutive_failures: 4,
    failure_started_at: "2026-09-16T00:00:00Z",
  };
  const result = planTransition(previous, unavailable, "2026-09-16T00:05:00Z", 3);
  assert.equal(result.events[0].type, "monitor_recovered");
  assert.equal(result.state.consecutiveFailures, 0);
});
