import { configuredChannels } from "./notifications.js";
import { createEvent } from "./storage.js";

const DEFAULT_PRODUCT_URL =
  "https://oceanextreme.rezdy.com/294317/whale-watching-on-vessel-extreme-circular-quay-departure";
const DEFAULT_UPDATE_URL = "https://oceanextreme.rezdy.com/updateTotalprice";
const DEFAULT_TARGET_DATE = "2026-10-07";
const DEFAULT_TARGET_TIME = "11:00";
const DEFAULT_STOP_AT = "2026-10-07T13:00:00Z"; // 2026-10-08 00:00 Australia/Sydney (AEDT)
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OceanExtremeMonitor/1.0";

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function enabled(env) {
  return String(env.OCEAN_ENABLED ?? "true").toLowerCase() !== "false";
}

export function oceanExpired(env, at = new Date()) {
  const stopAt = new Date(env.OCEAN_STOP_AT_UTC || DEFAULT_STOP_AT).getTime();
  return Number.isFinite(stopAt) && at.getTime() >= stopAt;
}

export function oceanCheckDue(env, at) {
  const intervalMinutes = Math.max(1, integer(env.OCEAN_INTERVAL_MINUTES, 5));
  return at.getUTCMinutes() % intervalMinutes === 0;
}

function responseCookies(response) {
  const headers = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return headers
    .flatMap((value) => String(value).split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

function htmlTitle(html) {
  return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function pageFingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function csrfToken(html) {
  const patterns = [
    /settings\.data\[['"]YII_CSRF_TOKEN['"]\]\s*=\s*['"]([^'"]+)['"]/i,
    /name=['"]YII_CSRF_TOKEN['"][^>]*value=['"]([^'"]+)['"]/i,
    /value=['"]([^'"]+)['"][^>]*name=['"]YII_CSRF_TOKEN['"]/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return null;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizedTime(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ");
  const match = /(?:上午|下午)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = match[3] || (text.includes("下午") ? "pm" : text.includes("上午") ? "am" : null);
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseOceanSessions(data, targetTime = DEFAULT_TARGET_TIME) {
  if (!data || !Array.isArray(data.sessions) || !data.sessionTimeLabel || !data.activeSession) {
    throw new Error("Rezdy session response did not contain the expected fields");
  }
  const sessions = data.sessions.map((id) => ({
    id: String(id),
    label: String(data.sessionTimeLabel[id] ?? data.sessionTimeLabel[String(id)] ?? ""),
    available: truthy(data.activeSession[id] ?? data.activeSession[String(id)]),
  }));
  const target = sessions.find((session) => normalizedTime(session.label) === targetTime);
  if (!target) {
    throw new Error(`Rezdy response did not include the ${targetTime} session`);
  }
  return { sessions, target };
}

export async function fetchOceanAvailability(env, fetcher = fetch) {
  const sourceUrl = env.OCEAN_PRODUCT_URL || DEFAULT_PRODUCT_URL;
  const updateUrl = env.OCEAN_UPDATE_URL || DEFAULT_UPDATE_URL;
  const targetDate = env.OCEAN_TARGET_DATE || DEFAULT_TARGET_DATE;
  const targetTime = env.OCEAN_TARGET_TIME || DEFAULT_TARGET_TIME;
  const partySize = integer(env.OCEAN_PARTY_SIZE, 1);
  const timeoutMs = integer(env.OCEAN_FETCH_TIMEOUT_MS, 30_000);
  const commonHeaders = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-AU,en;q=0.9",
    "cache-control": "no-cache",
  };

  let bootstrap;
  try {
    bootstrap = await fetcher(sourceUrl, {
      headers: commonHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: "error",
      error: `Rezdy product page request failed: ${error instanceof Error ? error.message : String(error)}`,
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
    };
  }
  const html = await bootstrap.text();
  const debug = {
    httpStatus: bootstrap.status,
    pageTitle: htmlTitle(html),
    pageBytes: new TextEncoder().encode(html).length,
    pageFingerprint: pageFingerprint(html),
  };
  if (!bootstrap.ok) {
    const blocked = bootstrap.status === 403 || /attention required|sorry, you have been blocked/i.test(html);
    return {
      status: "error",
      error: blocked
        ? `Rezdy blocked the monitor request (HTTP ${bootstrap.status})`
        : `Rezdy product page returned HTTP ${bootstrap.status}`,
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      ...debug,
    };
  }
  const csrf = csrfToken(html);
  if (!csrf) {
    return {
      status: "unknown",
      error: "Rezdy product page did not expose a CSRF token",
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      ...debug,
    };
  }

  const body = new URLSearchParams();
  body.set("YII_CSRF_TOKEN", csrf);
  body.set("OrderItem[preferredDate]", targetDate);
  body.set("OrderItem[minDate]", "");
  body.set("OrderItem[product][id]", String(env.OCEAN_PRODUCT_ID || "294317"));
  body.set("ItemQuantity[294317][0][priceOption][id]", String(env.OCEAN_PRICE_OPTION_ID || "66782022"));
  body.set("ItemQuantity[294317][0][quantity]", String(partySize));
  body.set("OrderItem[selectedSessionId]", "");

  let response;
  try {
    response = await fetcher(updateUrl, {
      method: "POST",
      headers: {
        ...commonHeaders,
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: new URL(sourceUrl).origin,
        referer: sourceUrl,
        "x-requested-with": "XMLHttpRequest",
        ...(responseCookies(bootstrap) ? { cookie: responseCookies(bootstrap) } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: "error",
      error: `Rezdy session request failed: ${error instanceof Error ? error.message : String(error)}`,
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      ...debug,
    };
  }
  const responseText = await response.text();
  if (!response.ok) {
    return {
      status: "error",
      error: `Rezdy session request returned HTTP ${response.status}`,
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      ...debug,
      sessionHttpStatus: response.status,
    };
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    return {
      status: "unknown",
      error: "Rezdy session response was not JSON",
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      ...debug,
      sessionHttpStatus: response.status,
    };
  }
  try {
    const parsed = parseOceanSessions(data, targetTime);
    return {
      status: parsed.target.available ? "available" : "unavailable",
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      sessions: parsed.sessions,
      targetSession: parsed.target,
      ...debug,
      sessionHttpStatus: response.status,
    };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
      targetDate,
      targetTime,
      partySize,
      sourceUrl,
      sessions: [],
      ...debug,
      sessionHttpStatus: response.status,
    };
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export async function getOceanState(db) {
  return db.prepare("SELECT * FROM ocean_state WHERE id=1").first();
}

export function planOceanTransition(previous, outcome, observedAt, failureThreshold = 3) {
  const prior = previous || {};
  if (outcome.status === "error" || outcome.status === "unknown") {
    const failures = Number(prior.consecutive_failures || 0) + 1;
    const failureStartedAt = prior.failure_started_at || observedAt;
    return {
      state: {
        currentStatus: prior.current_status || "unknown",
        targetSession: parseJson(prior.target_session_json, null),
        sessions: parseJson(prior.sessions_json, []),
        bookingUrl: prior.booking_url || outcome.sourceUrl || DEFAULT_PRODUCT_URL,
        lastSuccessAt: prior.last_success_at || null,
        lastCheckedAt: observedAt,
        lastUnavailableAt: prior.last_unavailable_at || null,
        consecutiveFailures: failures,
        failureStartedAt,
        lastError: outcome.error || "Ocean Extreme availability could not be determined",
      },
      events: failures === Number(failureThreshold)
        ? [{
            type: "ocean_monitor_degraded",
            key: `ocean:degraded:${failureStartedAt}`,
            payload: {
              consecutiveFailures: failures,
              error: outcome.error,
              httpStatus: outcome.httpStatus || outcome.sessionHttpStatus || null,
              pageTitle: outcome.pageTitle || null,
            },
          }]
        : [],
    };
  }

  const events = [];
  if (outcome.status === "available" && prior.current_status !== "available") {
    events.push({
      type: "ocean_availability",
      key: `ocean:availability:${prior.last_unavailable_at || "initial"}`,
      payload: {
        targetDate: outcome.targetDate,
        targetTime: outcome.targetTime,
        partySize: outcome.partySize,
        session: outcome.targetSession,
        sourceUrl: outcome.sourceUrl,
      },
    });
  }
  if (Number(prior.consecutive_failures || 0) >= Number(failureThreshold)) {
    events.push({
      type: "ocean_monitor_recovered",
      key: `ocean:recovered:${prior.failure_started_at || observedAt}`,
      payload: {
        previousFailures: Number(prior.consecutive_failures || 0),
        currentStatus: outcome.status,
      },
    });
  }
  return {
    state: {
      currentStatus: outcome.status,
      targetSession: outcome.targetSession || null,
      sessions: outcome.sessions || [],
      bookingUrl: outcome.sourceUrl || DEFAULT_PRODUCT_URL,
      lastSuccessAt: observedAt,
      lastCheckedAt: observedAt,
      lastUnavailableAt:
        outcome.status === "unavailable" && prior.current_status !== "unavailable"
          ? observedAt
          : prior.last_unavailable_at || null,
      consecutiveFailures: 0,
      failureStartedAt: null,
      lastError: null,
    },
    events,
  };
}

async function saveOceanState(db, state, observedAt) {
  await db
    .prepare(
      `UPDATE ocean_state SET current_status=?, target_session_json=?, sessions_json=?,
       booking_url=?, last_success_at=?, last_checked_at=?, last_unavailable_at=?,
       consecutive_failures=?, failure_started_at=?, last_error=?, updated_at=? WHERE id=1`,
    )
    .bind(
      state.currentStatus,
      JSON.stringify(state.targetSession),
      JSON.stringify(state.sessions),
      state.bookingUrl,
      state.lastSuccessAt,
      state.lastCheckedAt,
      state.lastUnavailableAt,
      state.consecutiveFailures,
      state.failureStartedAt,
      state.lastError,
      observedAt,
    )
    .run();
}

async function startOceanCheck(db, id, scheduledAt, startedAt, trigger) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ocean_checks(id, scheduled_at, started_at, trigger, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(id, scheduledAt, startedAt, trigger)
    .run();
  return Boolean(result.meta?.changes);
}

export async function runOceanCycle(
  env,
  { scheduledAt = new Date(), trigger = "scheduled", fetcher = fetch } = {},
) {
  if (!enabled(env)) return { status: "disabled" };
  if (oceanExpired(env, scheduledAt)) return { status: "expired" };

  const startedClock = Date.now();
  const startedAt = new Date().toISOString();
  const checkId = trigger === "scheduled"
    ? `ocean:scheduled:${scheduledAt.getTime()}`
    : `ocean:manual:${crypto.randomUUID()}`;
  if (!await startOceanCheck(env.DB, checkId, scheduledAt.toISOString(), startedAt, trigger)) {
    return { status: "duplicate", checkId };
  }

  let outcome;
  try {
    outcome = await fetchOceanAvailability(env, fetcher);
  } catch (error) {
    outcome = {
      status: "error",
      error: `Ocean Extreme check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      targetDate: env.OCEAN_TARGET_DATE || DEFAULT_TARGET_DATE,
      targetTime: env.OCEAN_TARGET_TIME || DEFAULT_TARGET_TIME,
      partySize: integer(env.OCEAN_PARTY_SIZE, 1),
      sourceUrl: env.OCEAN_PRODUCT_URL || DEFAULT_PRODUCT_URL,
    };
  }
  const observedAt = new Date().toISOString();
  const previous = await getOceanState(env.DB);
  const transition = planOceanTransition(
    previous,
    outcome,
    observedAt,
    integer(env.OCEAN_FAILURE_ALERT_THRESHOLD, 3),
  );
  await saveOceanState(env.DB, transition.state, observedAt);
  await env.DB
    .prepare(
      `UPDATE ocean_checks SET finished_at=?, status=?, http_status=?, error=?,
       result_json=?, duration_ms=? WHERE id=?`,
    )
    .bind(
      observedAt,
      outcome.status,
      outcome.sessionHttpStatus || outcome.httpStatus || null,
      outcome.error || null,
      JSON.stringify({
        targetSession: outcome.targetSession || null,
        sessions: outcome.sessions || [],
        pageTitle: outcome.pageTitle || null,
        pageFingerprint: outcome.pageFingerprint || null,
      }),
      Date.now() - startedClock,
      checkId,
    )
    .run();

  const eventIds = [];
  for (const event of transition.events) {
    const eventId = await createEvent(env.DB, event, observedAt, configuredChannels(env));
    if (eventId) eventIds.push(eventId);
  }
  return {
    checkId,
    status: outcome.status,
    targetDate: outcome.targetDate,
    targetTime: outcome.targetTime,
    targetSession: outcome.targetSession || null,
    sessions: outcome.sessions || [],
    httpStatus: outcome.sessionHttpStatus || outcome.httpStatus || null,
    error: outcome.error || null,
    eventIds,
  };
}

export async function oceanHealthResponse(env) {
  const expired = oceanExpired(env);
  if (!enabled(env) || expired) {
    return Response.json({
      ok: true,
      paused: !enabled(env),
      expired,
      stopAt: env.OCEAN_STOP_AT_UTC || DEFAULT_STOP_AT,
      message: expired ? "Ocean Extreme monitoring window has ended" : "Ocean Extreme monitoring is paused",
    });
  }
  const state = await getOceanState(env.DB);
  const lastCheckedAgeMs = state?.last_checked_at
    ? Date.now() - new Date(state.last_checked_at).getTime()
    : null;
  const intervalMinutes = Math.max(1, integer(env.OCEAN_INTERVAL_MINUTES, 5));
  const staleMs = integer(env.OCEAN_HEALTH_STALE_SECONDS, intervalMinutes * 60 + 120) * 1000;
  const healthy = Number.isFinite(lastCheckedAgeMs) && lastCheckedAgeMs >= 0 && lastCheckedAgeMs < staleMs;
  return Response.json(
    {
      ok: healthy,
      target: {
        product: "Whale Watching on vessel EXTREME - Circular Quay Departure",
        date: env.OCEAN_TARGET_DATE || DEFAULT_TARGET_DATE,
        time: env.OCEAN_TARGET_TIME || DEFAULT_TARGET_TIME,
        partySize: integer(env.OCEAN_PARTY_SIZE, 1),
        stopAt: env.OCEAN_STOP_AT_UTC || DEFAULT_STOP_AT,
      },
      state: state
        ? {
            status: state.current_status,
            targetSession: parseJson(state.target_session_json, null),
            sessions: parseJson(state.sessions_json, []),
            bookingUrl: state.booking_url,
            lastSuccessAt: state.last_success_at,
            lastCheckedAt: state.last_checked_at,
            consecutiveFailures: state.consecutive_failures,
            lastError: state.last_error,
          }
        : null,
      scheduler: { ok: healthy, ageMs: lastCheckedAgeMs, staleAfterMs: staleMs },
    },
    { status: healthy ? 200 : 503 },
  );
}
