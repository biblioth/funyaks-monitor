import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { checkWithRetries } from "../src/index.js";

const sourceUrl =
  "https://book.dartriver.co.nz/activity/selection?filter=ProdGroup-DRAALL&workingDate=2027-02-02";

test("booking check retries transient fetch failures", async () => {
  const html = await readFile(
    fileURLToPath(new URL("../../tests/fixtures/sold_out.html", import.meta.url)),
    "utf8",
  );
  let attempts = 0;
  const fetcher = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("temporary network failure");
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  const result = await checkWithRetries(
    {
      BOOKING_URL: sourceUrl,
      TARGET_DATE: "2027-02-02",
      PARTY_SIZE: "1",
      FETCH_ATTEMPTS: "3",
    },
    fetcher,
    async () => {},
  );
  assert.equal(attempts, 3);
  assert.equal(result.status, "unavailable");
});

test("booking check retries a malformed page instead of treating it as sold out", async () => {
  const html = await readFile(
    fileURLToPath(new URL("../../tests/fixtures/sold_out.html", import.meta.url)),
    "utf8",
  );
  let attempts = 0;
  const fetcher = async () => {
    attempts += 1;
    return new Response(attempts === 1 ? "maintenance" : html, { status: 200 });
  };
  const result = await checkWithRetries(
    {
      BOOKING_URL: sourceUrl,
      TARGET_DATE: "2027-02-02",
      PARTY_SIZE: "1",
      FETCH_ATTEMPTS: "2",
    },
    fetcher,
    async () => {},
  );
  assert.equal(attempts, 2);
  assert.equal(result.status, "unavailable");
});
