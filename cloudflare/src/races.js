import { renderRaceMessage } from "./race-messages.js";

const TYPES = new Set(["race_digest", "race_wtm_asia", "race_source_degraded", "race_source_recovered"]);
const PUBLIC_SOURCES = {
  hk_home: "https://hk100ultra.com/",
  hk_entry: "https://hk100ultra.com/entry/",
  wtm_members: "https://hk100ultra.com/world-trail-majors/",
  kailas_news: "https://www.kailas.com.cn/Home/Article/BrandNews/type/1.html",
};

export async function raceSourceResponse(request, fetcher = fetch) {
  const name = new URL(request.url).searchParams.get("name");
  const url = PUBLIC_SOURCES[name];
  if (!url) return new Response("Unknown public source", { status: 400 });
  // No caller-supplied URL, cookies or credentials are ever forwarded upstream.
  try {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; RaceRegistrationMonitor/1.0)", accept: "text/html" } });
    if (!response.ok) return Response.json({ upstreamStatus: response.status }, { status: 502 });
    const html = await response.text();
    if (html.length > 2_000_000) return new Response("Source too large", { status: 502 });
    return Response.json({ html });
  } catch {
    return Response.json({ error: "Public source fetch failed" }, { status: 502 });
  }
}

export async function raceState(db) {
  const row = await db.prepare("SELECT version, state_json FROM race_monitor_state WHERE id=1").first();
  return { version: Number(row?.version || 0), state: row ? JSON.parse(row.state_json) : {} };
}

export function validateRaceCommit(body) {
  if (!Number.isSafeInteger(body?.version) || body.version < 0 || !body.state || Array.isArray(body.state) || typeof body.state !== "object") {
    throw new Error("Invalid state/version");
  }
  if (!Array.isArray(body.events) || body.events.length > 300) throw new Error("Invalid events");
  for (const event of body.events) {
    if (!TYPES.has(event.type) || !/^races:[a-zA-Z0-9:_-]{1,200}$/.test(event.key || "")) throw new Error("Invalid race event");
    renderRaceMessage(event);
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > 4_000_000) throw new Error("Race state too large");
}

export async function commitRaceState(env, body) {
  validateRaceCommit(body);
  if (!env.FEISHU_WEBHOOK_URL) throw new Error("Feishu is not configured");
  const at = new Date().toISOString();
  const commit = crypto.randomUUID();
  const next = body.version + 1;
  // batch is one D1 transaction. Every outbox insert is guarded by the CAS
  // commit ID, so a losing writer cannot create notifications or overwrite state.
  const statements = [env.DB.prepare("INSERT OR IGNORE INTO race_monitor_state(id, version, state_json, updated_at) VALUES (1, 0, '{}', ?)").bind(at),
    env.DB.prepare("UPDATE race_monitor_state SET version=?, state_json=?, commit_id=?, updated_at=? WHERE id=1 AND version=?")
      .bind(next, JSON.stringify(body.state), commit, at, body.version)];
  for (const event of body.events) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO monitor_events(idempotency_key, event_type, payload_json, created_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM race_monitor_state WHERE id=1 AND commit_id=?)`)
      .bind(event.key, event.type, JSON.stringify(event.payload), at, commit));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO monitor_deliveries(event_id, channel, status, created_at, updated_at)
      SELECT id, 'feishu', 'pending', ?, ? FROM monitor_events WHERE idempotency_key=?
      AND EXISTS (SELECT 1 FROM race_monitor_state WHERE id=1 AND commit_id=?)`).bind(at, at, event.key, commit));
  }
  const results = await env.DB.batch(statements);
  if (!results[1]?.meta?.changes) return { conflict: true };
  return { version: next, eventCount: body.events.length };
}

export async function raceHealthResponse(env) {
  const { state } = await raceState(env.DB);
  const now = Date.now();
  const completedAt = state.last_completed_at || null;
  const age = completedAt ? now - Date.parse(completedAt) : null;
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS count, MIN(d.created_at) AS oldest
    FROM monitor_deliveries d JOIN monitor_events e ON e.id=d.event_id
    WHERE e.event_type LIKE 'race_%' AND d.status!='delivered'`).first();
  const failed = Object.entries(state.sources || {}).filter(([, x]) => !x.ok).map(([name, x]) => ({ name, error: x.error }));
  const scheduleOk = age !== null && age >= 0 && age < 26 * 3600_000;
  const deliveryOk = !pending?.oldest || now - Date.parse(pending.oldest) < 30 * 60_000;
  const ok = scheduleOk && deliveryOk && failed.length === 0 && Boolean(env.FEISHU_WEBHOOK_URL);
  return Response.json({ ok, scheduleOk, deliveryOk, lastCompletedAt: completedAt, runDate: state.last_run_date || null,
    knownEvents: Object.keys(state.known || {}).length, sources: { total: Object.keys(state.sources || {}).length, failed },
    gaps: state.gaps || [], pendingNotifications: Number(pending?.count || 0) }, { status: ok ? 200 : 503 });
}
