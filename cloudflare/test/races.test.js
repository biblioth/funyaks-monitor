import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { raceState, commitRaceState, raceHealthResponse, raceSourceResponse } from "../src/races.js";
import { renderEvent, sendEvent } from "../src/notifications.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      const make = (args = []) => ({
        bind(...next) { return make(next); },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
      });
      return make();
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  };
}

const event = { key: "races:digest:sample", type: "race_digest", payload: { message: "🏃 新增活动\n分类：越野跑UTMB\n官方原文：https://utmb.world/" } };
function env() { return { DB: database(), FEISHU_WEBHOOK_URL: "https://example.com/bot", PUSHPLUS_TOKEN: "unused", ADMIN_TOKEN: "test", NOTIFICATION_QUEUE: { async send() {} } }; }

test("race state and Feishu outbox are committed atomically; retry cannot duplicate delivery", async () => {
  const e = env();
  assert.deepEqual(await raceState(e.DB), { version: 0, state: {} });
  assert.equal((await commitRaceState(e, { version: 0, state: { known: { one: {} } }, events: [event] })).version, 1);
  assert.deepEqual(await commitRaceState(e, { version: 0, state: {}, events: [{ ...event, key: "races:digest:losing-writer" }] }), { conflict: true });
  assert.equal(Object.keys((await raceState(e.DB)).state.known).length, 1);
  await commitRaceState(e, { version: 1, state: { known: { one: {} } }, events: [event] });
  assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM monitor_events").first()).n, 1);
  const deliveries = await e.DB.prepare("SELECT channel FROM monitor_deliveries").all();
  assert.deepEqual(deliveries.results.map(x => x.channel), ["feishu"]);
});

test("missing Feishu configuration must not consume a discovery", async () => {
  const e = env();
  delete e.FEISHU_WEBHOOK_URL;
  await assert.rejects(commitRaceState(e, { version: 0, state: {}, events: [event] }), /Feishu/);
  assert.equal((await raceState(e.DB)).version, 0);
});

test("race endpoints require the existing admin credential", async () => {
  for (const path of ["/races/state", "/races/commit", "/races/source"]) {
    const r = await worker.fetch(new Request("https://worker.test" + path, { method: path.endsWith("commit") ? "POST" : "GET" }), env());
    assert.equal(r.status, 401);
  }
});

test("public-source fallback only fetches fixed URLs and never forwards admin credentials", async () => {
  let options;
  const response = await raceSourceResponse(new Request("https://worker.test/races/source?name=hk_home", { headers: { authorization: "Bearer private", cookie: "private" } }), async (url, opts) => {
    assert.equal(url, "https://hk100ultra.com/"); options = opts; return new Response("<html>race</html>");
  });
  assert.equal(response.status, 200);
  assert.equal(options.headers.authorization, undefined);
  assert.equal(options.headers.cookie, undefined);
  assert.equal((await raceSourceResponse(new Request("https://worker.test/races/source?name=http://127.0.0.1"))).status, 400);
});

test("a malformed race payload cannot create an event or mutate D1", async () => {
  const e = env();
  const request = new Request("https://worker.test/races/commit", { method: "POST", headers: { authorization: "Bearer test" }, body: JSON.stringify({ version: 0, state: {}, events: [{ ...event, type: "availability" }] }) });
  assert.equal((await worker.fetch(request, e)).status, 400);
  assert.equal((await raceState(e.DB)).version, 0);
});

test("daily health does not inherit the old three-minute freshness threshold", async () => {
  const e = env();
  const state = { last_completed_at: new Date(Date.now() - 23 * 3600000).toISOString(), sources: { official: { ok: true } }, known: {} };
  await commitRaceState(e, { version: 0, state, events: [] });
  assert.equal((await raceHealthResponse(e)).status, 200);
  await commitRaceState(e, { version: 1, state: { ...state, last_completed_at: new Date(Date.now() - 27 * 3600000).toISOString() }, events: [] });
  assert.equal((await raceHealthResponse(e)).status, 503);
});

test("Feishu keeps the exact Chinese category and does not add old reminder sections", async () => {
  const message = renderEvent(event).message;
  assert.match(message, /分类：越野跑UTMB/);
  assert.doesNotMatch(message, /报名变化|即将截止/);
  let posted;
  await sendEvent(env(), event, "feishu", async (url, options) => { posted = { url, payload: JSON.parse(options.body) }; return Response.json({ code: 0 }); });
  assert.equal(posted.url, "https://example.com/bot");
  assert.equal(posted.payload.content.text, message);
});

test("HTTP and Feishu business failures remain retryable", async () => {
  await assert.rejects(sendEvent(env(), event, "feishu", async () => Response.json({ code: 19024 })), /rejected/);
  await assert.rejects(sendEvent(env(), event, "feishu", async () => new Response("", { status: 503 })), /503/);
});
