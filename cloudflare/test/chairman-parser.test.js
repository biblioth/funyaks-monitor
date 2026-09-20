import test from "node:test";
import assert from "node:assert/strict";

import { ChairmanParseError, parseChairmanAvailability } from "../src/chairman-parser.js";

const options = {
  targetDates: ["2026-10-30", "2026-10-31", "2026-11-01"],
  mealWindows: ["lunch", "dinner"],
  partySize: 2,
  sourceUrl: "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys",
};

test("finds explicit lunch availability and fails closed for unrelated dates", () => {
  const result = parseChairmanAvailability(`
    <html><head><title>The Chairman Reservation</title></head><body>
      <h1>The Chairman booking</h1>
      <table>
        <tr><td>2026-10-30</td><td><a href="/book?date=2026-10-30&time=12:30">Book 12:30</a></td><td><button disabled>18:30 Sold out</button></td></tr>
        <tr><td>2026-10-31</td><td><button disabled>12:00 Fully booked</button></td><td><button disabled>19:00 Fully booked</button></td></tr>
        <tr><td>2026-11-01</td><td>Reservations have not opened</td></tr>
      </table>
    </body></html>
  `, options);

  assert.equal(result.status, "available");
  assert.deepEqual(result.available.map((item) => item.key), ["2026-10-30:lunch"]);
  assert.match(result.available[0].bookingUrl, /date=2026-10-30/);
  assert.equal(result.observations.find((item) => item.key === "2026-10-30:dinner").status, "unavailable");
  assert.equal(result.observations.find((item) => item.key === "2026-11-01:lunch").status, "unknown");
});

test("an enabled date-level calendar control means at least one meal is available", () => {
  const result = parseChairmanAvailability(`
    <html><body><h1>大班樓網上訂座</h1>
      <button data-date="2026-10-30">30 October 2026 - Book</button>
      <button data-date="2026-10-31" disabled>31 October 2026 - Fully booked</button>
      <button data-date="2026-11-01" disabled>1 November 2026 - Fully booked</button>
    </body></html>
  `, options);
  const october30 = result.available.filter((item) => item.date === "2026-10-30");
  assert.equal(october30.length, 2);
  assert.ok(october30.every((item) => item.dateLevel));
});

test("a server busy page is never interpreted as sold out or available", () => {
  assert.throws(
    () => parseChairmanAvailability("<title>Server Busy</title>系統非常繁忙", options),
    ChairmanParseError,
  );
});

test("a generic reservation page without target dates fails closed", () => {
  const result = parseChairmanAvailability(
    "<html><title>The Chairman booking</title><a href='/booking'>Reserve now</a></html>",
    options,
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.unknown.length, 6);
});
