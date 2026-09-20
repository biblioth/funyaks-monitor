import { parseFunyaksAvailability } from "./parser.js";
import { configuredChannels, sendEvent } from "./notifications.js";
import {
  chairmanHealthResponse,
  getChairmanState,
  runChairmanCycle,
} from "./chairman.js";
import {
  cleanup,
  createEvent,
  getDelivery,
  getState,
  markDelivered,
  markDeliveryFailed,
  markQueued,
  pendingDeliveries,
  recordOutcome,
  startCheck,
} from "./storage.js";

const DEFAULT_URL =
  "https://book.dartriver.co.nz/activity/selection?filter=ProdGroup-DRAALL&workingDate=2027-02-02";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FunyaksMonitor/2.0";

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function oneCheck(env, fetcher) {
  const sourceUrl = env.BOOKING_URL || DEFAULT_URL;
  const response = await fetcher(sourceUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-NZ,en;q=0.9",
      "cache-control": "no-cache",
    },
    signal: AbortSignal.timeout(integer(env.FETCH_TIMEOUT_MS, 15_000)),
  });
  if (!response.ok) throw new Error(`Booking page returned HTTP ${response.status}`);
  const html = await response.text();
  const result = parseFunyaksAvailability(html, {
    targetDate: env.TARGET_DATE || "2027-02-02",
    partySize: integer(env.PARTY_SIZE, 1),
    sourceUrl,
  });
  return { ...result, sourceUrl };
}

export async function checkWithRetries(env, fetcher = fetch, sleeper = sleep) {
  const attempts = Math.max(1, integer(env.FETCH_ATTEMPTS, 3));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await oneCheck(env, fetcher);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleeper(400 * 2 ** attempt);
    }
  }
  throw new Error(
    `Booking check failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function enqueuePending(env) {
  const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  let count = 0;
  for (const row of await pendingDeliveries(env.DB, staleBefore)) {
    await env.NOTIFICATION_QUEUE.send({ deliveryId: row.id });
    await markQueued(env.DB, row.id, new Date().toISOString());
    count += 1;
  }
  return count;
}

export function weeklySummaryDue(date, utcHour = 2) {
  return date.getUTCDay() === 0 && date.getUTCHours() === Number(utcHour);
}

export async function recordWeeklySummary(env, periodEnd = new Date()) {
  const periodEndIso = periodEnd.toISOString();
  const periodStartIso = new Date(periodEnd.getTime() - 7 * 86_400_000).toISOString();
  const key = `weekly_summary:${periodEndIso.slice(0, 10)}`;
  const existing = await env.DB
    .prepare("SELECT id FROM monitor_events WHERE idempotency_key=?")
    .bind(key)
    .first();
  if (existing) return { eventId: null, duplicate: true, key };

  const [checks, events, state] = await Promise.all([
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS total_checks,
           SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS successful_checks,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed_checks,
           SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_checks,
           SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_checks,
           ROUND(AVG(duration_ms)) AS average_duration_ms,
           MAX(duration_ms) AS max_duration_ms
         FROM monitor_checks
         WHERE trigger = 'scheduled' AND scheduled_at >= ? AND scheduled_at < ?`,
      )
      .bind(periodStartIso, periodEndIso)
      .first(),
    env.DB
      .prepare(
        `SELECT
           SUM(CASE WHEN event_type = 'availability' THEN 1 ELSE 0 END) AS availability_events,
           SUM(CASE WHEN event_type = 'monitor_degraded' THEN 1 ELSE 0 END) AS degraded_events,
           SUM(CASE WHEN event_type = 'monitor_recovered' THEN 1 ELSE 0 END) AS recovered_events
         FROM monitor_events WHERE created_at >= ? AND created_at < ?`,
      )
      .bind(periodStartIso, periodEndIso)
      .first(),
    getState(env.DB),
  ]);
  const totalChecks = Number(checks?.total_checks || 0);
  const successfulChecks = Number(checks?.successful_checks || 0);
  const payload = {
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
    targetDate: env.TARGET_DATE || "2027-02-02",
    partySize: integer(env.PARTY_SIZE, 1),
    totalChecks,
    successfulChecks,
    failedChecks: Number(checks?.failed_checks || 0),
    successRate: totalChecks ? ((successfulChecks / totalChecks) * 100).toFixed(2) : "0.00",
    availableChecks: Number(checks?.available_checks || 0),
    unavailableChecks: Number(checks?.unavailable_checks || 0),
    averageDurationMs: Number(checks?.average_duration_ms || 0),
    maxDurationMs: Number(checks?.max_duration_ms || 0),
    availabilityEvents: Number(events?.availability_events || 0),
    degradedEvents: Number(events?.degraded_events || 0),
    recoveredEvents: Number(events?.recovered_events || 0),
    currentStatus: state?.current_status || "unknown",
    lastCheckedAt: state?.last_checked_at || null,
  };
  const eventId = await createEvent(
    env.DB,
    { key, type: "weekly_summary", payload },
    periodEndIso,
    configuredChannels(env),
  );
  return { eventId, duplicate: !eventId, key, payload };
}

export async function runCycle(
  env,
  { scheduledAt = new Date(), trigger = "scheduled", fetcher = fetch, sleeper = sleep } = {},
) {
  const startedClock = Date.now();
  const startedAt = new Date().toISOString();
  const checkId =
    trigger === "scheduled"
      ? `scheduled:${scheduledAt.getTime()}`
      : `manual:${crypto.randomUUID()}`;
  const inserted = await startCheck(
    env.DB,
    checkId,
    scheduledAt.toISOString(),
    startedAt,
    trigger,
  );
  if (!inserted) return { status: "duplicate", checkId };

  let outcome;
  try {
    outcome = await checkWithRetries(env, fetcher, sleeper);
  } catch (error) {
    outcome = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      targetDate: env.TARGET_DATE || "2027-02-02",
      partySize: integer(env.PARTY_SIZE, 1),
      departures: [],
      bookable: [],
      sourceUrl: env.BOOKING_URL || DEFAULT_URL,
    };
  }

  const observedAt = new Date().toISOString();
  const recorded = await recordOutcome(env, {
    checkId,
    outcome,
    observedAt,
    durationMs: Date.now() - startedClock,
    failureThreshold: integer(env.FAILURE_ALERT_THRESHOLD, 2),
  });
  let weekly = null;
  if (trigger === "scheduled" && weeklySummaryDue(
    scheduledAt,
    integer(env.WEEKLY_REPORT_UTC_HOUR, 2),
  )) {
    weekly = await recordWeeklySummary(env, scheduledAt);
  }
  const queued = await enqueuePending(env);

  const retentionDays = Math.max(1, integer(env.RETENTION_DAYS, 14));
  if (scheduledAt.getUTCHours() === 0 && scheduledAt.getUTCMinutes() === 0) {
    await cleanup(env.DB, new Date(Date.now() - retentionDays * 86_400_000).toISOString());
  }
  return {
    checkId,
    status: outcome.status,
    targetDate: outcome.targetDate,
    partySize: outcome.partySize,
    departures: outcome.departures,
    error: outcome.error || null,
    eventIds: recorded.eventIds,
    weekly,
    queued,
  };
}

export async function healthResponse(env) {
  const state = await getState(env.DB);
  const now = Date.now();
  const staleMs = integer(env.HEALTH_STALE_SECONDS, 180) * 1000;
  const threshold = integer(env.FAILURE_ALERT_THRESHOLD, 2);
  const lastSuccessAgeMs = state?.last_success_at
    ? now - new Date(state.last_success_at).getTime()
    : null;
  const lastCheckedAgeMs = state?.last_checked_at
    ? now - new Date(state.last_checked_at).getTime()
    : null;
  const pending = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM monitor_deliveries WHERE status != 'delivered'`,
    )
    .first();
  const oldestDeliveryAgeMs = pending?.oldest ? now - new Date(pending.oldest).getTime() : 0;
  const channels = configuredChannels(env);
  const checksHealthy =
    Number.isFinite(lastCheckedAgeMs) && lastCheckedAgeMs >= 0 && lastCheckedAgeMs < staleMs;
  const sourceHealthy =
    Number.isFinite(lastSuccessAgeMs) &&
    lastSuccessAgeMs >= 0 &&
    lastSuccessAgeMs < staleMs &&
    Number(state?.consecutive_failures || 0) < threshold;
  const notificationsHealthy = channels.length > 0 && oldestDeliveryAgeMs < 15 * 60_000;
  const healthy = checksHealthy && sourceHealthy && notificationsHealthy;
  return Response.json(
    {
      ok: healthy,
      target: { date: env.TARGET_DATE || "2027-02-02", partySize: integer(env.PARTY_SIZE, 1) },
      state: state
        ? {
            status: state.current_status,
            availableSeats: state.available_seats,
            availabilityText: state.availability_text,
            bookingUrl: state.booking_url,
            lastSuccessAt: state.last_success_at,
            lastCheckedAt: state.last_checked_at,
            consecutiveFailures: state.consecutive_failures,
            lastError: state.last_error,
          }
        : null,
      components: {
        scheduler: { ok: checksHealthy, ageMs: lastCheckedAgeMs, staleAfterMs: staleMs },
        bookingSource: { ok: sourceHealthy, ageMs: lastSuccessAgeMs },
        notifications: {
          ok: notificationsHealthy,
          configuredChannels: channels,
          pending: Number(pending?.count || 0),
          oldestPendingAgeMs: oldestDeliveryAgeMs,
        },
      },
    },
    { status: healthy ? 200 : 503 },
  );
}

function authorized(request, env) {
  return Boolean(env.ADMIN_TOKEN) && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

async function processQueue(batch, env) {
  for (const message of batch.messages) {
    const deliveryId = Number(message.body?.deliveryId);
    try {
      const delivery = await getDelivery(env.DB, deliveryId);
      if (!delivery || delivery.status === "delivered") {
        message.ack();
        continue;
      }
      await sendEvent(env, delivery.event, delivery.channel);
      await markDelivered(env.DB, delivery.id, new Date().toISOString());
      message.ack();
    } catch (error) {
      const failedAt = new Date().toISOString();
      await markDeliveryFailed(
        env.DB,
        deliveryId,
        error instanceof Error ? error.message : String(error),
        failedAt,
      );
      const delivery = await getDelivery(env.DB, deliveryId);
      const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(delivery?.attempts || 0, 7));
      message.retry({ delaySeconds });
    }
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime);
    ctx.waitUntil((async () => {
      await Promise.allSettled([
        runCycle(env, { scheduledAt }),
        runChairmanCycle(env, { scheduledAt }),
      ]);
      await enqueuePending(env);
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return healthResponse(env);
    if (request.method === "GET" && url.pathname === "/chairman/health") {
      return chairmanHealthResponse(env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "Funyaks and The Chairman availability monitor",
        monitors: {
          funyaks: {
            targetDate: env.TARGET_DATE || "2027-02-02",
            partySize: integer(env.PARTY_SIZE, 1),
            health: "/health",
          },
          chairman: {
            targetDates: String(env.CHAIRMAN_TARGET_DATES || "2026-10-30,2026-10-31,2026-11-01").split(","),
            partySize: integer(env.CHAIRMAN_PARTY_SIZE, 2),
            mealWindows: String(env.CHAIRMAN_MEAL_WINDOWS || "lunch,dinner").split(","),
            health: "/chairman/health",
          },
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/check") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      return Response.json(await runCycle(env, { trigger: "manual" }));
    }
    if (request.method === "POST" && url.pathname === "/chairman/check") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const result = await runChairmanCycle(env, { trigger: "manual" });
      const queued = await enqueuePending(env);
      return Response.json({ ...result, queued });
    }
    if (request.method === "POST" && url.pathname === "/weekly-report") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      const report = await recordWeeklySummary(env, new Date());
      const queued = await enqueuePending(env);
      return Response.json({ ...report, queued });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
      return Response.json({
        funyaks: await getState(env.DB),
        chairman: await getChairmanState(env.DB),
        channels: configuredChannels(env),
      });
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env) {
    await processQueue(batch, env);
  },
};
