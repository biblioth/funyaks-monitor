import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ParseError, parseFunyaksAvailability } from "../src/parser.js";

const fixture = (name) =>
  readFile(fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url)), "utf8");
const sourceUrl =
  "https://book.dartriver.co.nz/activity/selection?filter=ProdGroup-DRAALL&workingDate=2027-02-02";

test("ignores Wilderness Jet availability and reports sold-out Funyaks", async () => {
  const result = parseFunyaksAvailability(await fixture("sold_out.html"), {
    targetDate: "2027-02-02",
    partySize: 1,
    sourceUrl,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.departures.length, 1);
  assert.match(result.departures[0].message, /Trip full/);
});

test("one Funyaks seat is available for one person", async () => {
  const result = parseFunyaksAvailability(await fixture("available.html"), {
    targetDate: "2027-02-02",
    partySize: 1,
    sourceUrl,
  });
  assert.equal(result.status, "available");
  assert.equal(result.bookable[0].availableSeats, 1);
  assert.match(result.bookable[0].bookingUrl, /DRFUNYAK/);
});

test("one seat is unavailable for a party of two", async () => {
  const result = parseFunyaksAvailability(await fixture("available.html"), {
    targetDate: "2027-02-02",
    partySize: 2,
    sourceUrl,
  });
  assert.equal(result.status, "unavailable");
});

test("a missing target date fails closed", async () => {
  const html = await fixture("sold_out.html");
  assert.throws(
    () =>
      parseFunyaksAvailability(html, {
        targetDate: "2027-02-03",
        partySize: 1,
        sourceUrl,
      }),
    ParseError,
  );
});
