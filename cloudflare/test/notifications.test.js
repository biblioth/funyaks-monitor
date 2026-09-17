import test from "node:test";
import assert from "node:assert/strict";

import { configuredChannels, renderEvent } from "../src/notifications.js";

test("availability notification contains the direct booking link", () => {
  const rendered = renderEvent({
    type: "availability",
    payload: {
      targetDate: "2027-02-02",
      partySize: 1,
      sourceUrl: "https://example.com/search",
      bookable: [
        {
          time: "9:30 AM",
          availableSeats: 1,
          availabilityText: "1",
          bookingUrl: "https://example.com/book",
        },
      ],
    },
  });
  assert.match(rendered.message, /9:30 AM/);
  assert.match(rendered.message, /https:\/\/example\.com\/book/);
});

test("notification channels are independent and deduplicated", () => {
  assert.deepEqual(
    configuredChannels({
      FEISHU_WEBHOOK_URL: "https://example.com/feishu",
      PUSHPLUS_TOKEN: "token",
      PUSHPLUS_CHANNELS: "wechat,wechat,clawbot",
    }),
    ["feishu", "pushplus", "pushplus:clawbot"],
  );
});
