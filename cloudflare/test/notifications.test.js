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

test("Chairman notification contains target date, meal and official queue link", () => {
  const rendered = renderEvent({
    type: "chairman_availability",
    payload: {
      partySize: 2,
      sourceUrl: "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys",
      available: [{
        date: "2026-10-30",
        mealWindow: "lunch",
        times: ["12:30"],
        dateLevel: false,
      }],
    },
  });
  assert.match(rendered.title, /大班楼/);
  assert.match(rendered.message, /2026-10-30/);
  assert.match(rendered.message, /午餐/);
  assert.match(rendered.message, /12:30/);
  assert.match(rendered.message, /queue-it\.net/);
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

test("weekly summary renders reliability and availability metrics", () => {
  const rendered = renderEvent({
    type: "weekly_summary",
    payload: {
      periodStart: "2026-09-13T02:00:00.000Z",
      periodEnd: "2026-09-20T02:00:00.000Z",
      targetDate: "2027-02-02",
      partySize: 1,
      currentStatus: "unavailable",
      totalChecks: 10080,
      successfulChecks: 10079,
      failedChecks: 1,
      successRate: "99.99",
      availableChecks: 0,
      unavailableChecks: 10079,
      averageDurationMs: 820,
      maxDurationMs: 4800,
      availabilityEvents: 0,
      degradedEvents: 1,
      recoveredEvents: 1,
      lastCheckedAt: "2026-09-20T01:59:00.000Z",
    },
  });
  assert.match(rendered.message, /本周检查：10080 次/);
  assert.match(rendered.message, /成功率 99\.99%/);
  assert.match(rendered.message, /当前房态：无位/);
});
