import { parseChairmanAvailability } from "./chairman-parser.js";
import { configuredChannels } from "./notifications.js";
import { createEvent } from "./storage.js";

const DEFAULT_QUEUE_URL =
  "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys";
const DEFAULT_BOOKING_URL = "https://www.thechairmangroup.com/index.php?route=catering/booking";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ChairmanMonitor/1.0";

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  const values = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? [...new Set(values)] : fallback;
}

function responseLocation(response, currentUrl) {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
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

function mergeCookies(current, additions) {
  const values = new Map();
  for (const cookieHeader of [current, additions]) {
    for (const item of String(cookieHeader || "").split(";")) {
      const trimmed = item.trim();
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function isChairmanBookingUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "www.thechairmangroup.com" && url.searchParams.get("route") === "catering/booking";
  } catch {
    return false;
  }
}

function safeRedirectDescription(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}${url.searchParams.has("route") ? `?route=${url.searchParams.get("route")}` : ""}`;
  } catch {
    return "invalid redirect URL";
  }
}

function titleFromHtml(html) {
  return /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function isBrowserTabReloadPage(pageTitle, html) {
  return /^auto reload$/i.test(pageTitle || "") &&
    /params\.set\(\s*["']btabid["']/i.test(html || "");
}

function pageFingerprint(html) {
  let hash = 2166136261;
  for (let index = 0; index < html.length; index += 1) {
    hash ^= html.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fetchOptions(timeoutMs, extraHeaders = {}) {
  return {
    redirect: "manual",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
}

async function queuePass(queueUrl, fetcher, timeoutMs) {
  const first = await fetcher(queueUrl, fetchOptions(timeoutMs));
  const firstLocation = responseLocation(first, queueUrl);
  if (isChairmanBookingUrl(firstLocation)) return firstLocation;
  if (!firstLocation) {
    const body = await first.text();
    return {
      status: "busy",
      httpStatus: first.status,
      pageTitle: titleFromHtml(body),
      error: `Queue-it did not issue a redirect (HTTP ${first.status})`,
    };
  }

  const cookies = responseCookies(first);
  const second = await fetcher(
    firstLocation,
    fetchOptions(timeoutMs, cookies ? { cookie: cookies, referer: queueUrl } : { referer: queueUrl }),
  );
  const secondLocation = responseLocation(second, firstLocation);
  if (isChairmanBookingUrl(secondLocation)) return secondLocation;
  if (!secondLocation) {
    const body = await second.text();
    return {
      status: "busy",
      httpStatus: second.status,
      pageTitle: titleFromHtml(body),
      error: `Queue-it after-event page did not issue a booking redirect (HTTP ${second.status})`,
    };
  }
  return {
    status: "error",
    httpStatus: second.status,
    error: `Unexpected Queue-it redirect host: ${new URL(secondLocation).hostname}`,
  };
}

export async function fetchChairmanAvailability(env, fetcher = fetch) {
  const queueUrl = env.CHAIRMAN_QUEUE_URL || DEFAULT_QUEUE_URL;
  const bookingUrl = env.CHAIRMAN_BOOKING_URL || DEFAULT_BOOKING_URL;
  const timeoutMs = integer(env.CHAIRMAN_FETCH_TIMEOUT_MS, 45_000);
  const targetDates = list(env.CHAIRMAN_TARGET_DATES, ["2026-10-30", "2026-10-31", "2026-11-01"]);
  const mealWindows = list(env.CHAIRMAN_MEAL_WINDOWS, ["lunch", "dinner"]);
  const partySize = integer(env.CHAIRMAN_PARTY_SIZE, 2);

  let pass;
  try {
    pass = await queuePass(queueUrl, fetcher, timeoutMs);
  } catch (error) {
    return {
      status: "error",
      error: `Queue-it request failed: ${error instanceof Error ? error.message : String(error)}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  if (typeof pass !== "string") {
    return { ...pass, targetDates, mealWindows, partySize, sourceUrl: queueUrl };
  }

  let response;
  let currentUrl = pass;
  let originCookies = "";
  try {
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      response = await fetcher(
        currentUrl,
        fetchOptions(timeoutMs, {
          referer: redirectCount ? bookingUrl : queueUrl,
          ...(originCookies ? { cookie: originCookies } : {}),
        }),
      );
      originCookies = mergeCookies(originCookies, responseCookies(response));
      if (response.status < 300 || response.status >= 400) break;
      const location = responseLocation(response, currentUrl);
      if (!location) {
        return {
          status: "error",
          error: `Chairman booking page returned HTTP ${response.status} without Location`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      const hostname = new URL(location).hostname;
      if (hostname === "thechairmangroup.queue-it.net") {
        return {
          status: "busy",
          error: `Chairman sent the request back to Queue-it (${safeRedirectDescription(location)})`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      if (hostname !== "www.thechairmangroup.com") {
        return {
          status: "error",
          error: `Unexpected Chairman redirect: ${safeRedirectDescription(location)}`,
          httpStatus: response.status,
          targetDates,
          mealWindows,
          partySize,
          sourceUrl: queueUrl,
        };
      }
      currentUrl = location;
    }
  } catch (error) {
    return {
      status: "busy",
      error: `Chairman booking page timed out: ${error instanceof Error ? error.message : String(error)}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  if (!response) {
    return {
      status: "error",
      error: "Chairman booking request did not return a response",
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    };
  }
  let html = await response.text();
  let pageTitle = titleFromHtml(html);
  for (let reloadCount = 0; reloadCount < 2 && isBrowserTabReloadPage(pageTitle, html); reloadCount += 1) {
    const reloadUrl = new URL(currentUrl);
    reloadUrl.searchParams.set("btabid", String(Math.floor(Math.random() * 10_000)));
    let reloadCurrentUrl = reloadUrl.toString().replaceAll("%2F", "/");
    try {
      for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
        response = await fetcher(
          reloadCurrentUrl,
          fetchOptions(timeoutMs, {
            referer: currentUrl,
            ...(originCookies ? { cookie: originCookies } : {}),
          }),
        );
        originCookies = mergeCookies(originCookies, responseCookies(response));
        if (response.status < 300 || response.status >= 400) break;
        const location = responseLocation(response, reloadCurrentUrl);
        if (!location) {
          return {
            status: "error",
            error: `Chairman browser-tab reload returned HTTP ${response.status} without Location`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        const hostname = new URL(location).hostname;
        if (hostname === "thechairmangroup.queue-it.net") {
          return {
            status: "busy",
            error: `Chairman browser-tab reload returned to Queue-it (${safeRedirectDescription(location)})`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        if (hostname !== "www.thechairmangroup.com") {
          return {
            status: "error",
            error: `Unexpected Chairman browser-tab reload redirect: ${safeRedirectDescription(location)}`,
            httpStatus: response.status,
            targetDates,
            mealWindows,
            partySize,
            sourceUrl: queueUrl,
          };
        }
        reloadCurrentUrl = location;
      }
    } catch (error) {
      return {
        status: "busy",
        error: `Chairman browser-tab reload timed out: ${error instanceof Error ? error.message : String(error)}`,
        targetDates,
        mealWindows,
        partySize,
        sourceUrl: queueUrl,
      };
    }
    currentUrl = reloadCurrentUrl;
    html = await response.text();
    pageTitle = titleFromHtml(html);
  }
  const debug = {
    httpStatus: response.status,
    pageTitle,
    pageBytes: new TextEncoder().encode(html).length,
    pageFingerprint: pageFingerprint(html),
  };
  if (isBrowserTabReloadPage(pageTitle, html)) {
    return {
      status: "busy",
      error: "Chairman booking gate requested another browser-tab reload",
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }
  if (
    response.status === 429 ||
    /server\s*busy|currently\s*experiencing\s*high\s*traffic|系統非常繁忙|系统非常繁忙/i.test(html)
  ) {
    return {
      status: "busy",
      error: `Chairman booking server is busy (HTTP ${response.status})`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }
  if (!response.ok) {
    return {
      status: "error",
      error: `Chairman booking page returned HTTP ${response.status}`,
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
      ...debug,
    };
  }

  try {
    const parsed = parseChairmanAvailability(html, {
      targetDates,
      mealWindows,
      partySize,
      sourceUrl: queueUrl,
    });
    return {
      ...parsed,
      bookingPageUrl: bookingUrl,
      ...debug,
    };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
      targetDates,
      mealWindows,
      partySize,
      observations: [],
      available: [],
      unknown: [],
      sourceUrl: queueUrl,
      ...debug,
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

export async function getChairmanState(db) {
  return db.prepare("SELECT * FROM chairman_state WHERE id=1").first();
}

export function planChairmanTransition(previous, outcome, observedAt, failureThreshold = 3) {
  const prior = previous || {};
  const previousAvailable = new Set(parseJson(prior.available_keys_json, []));
  if (outcome.status === "busy") {
    return {
      state: {
        currentStatus: prior.current_status || "unknown",
        availableKeys: [...previousAvailable],
        observations: parseJson(prior.observations_json, []),
        bookingUrl: prior.booking_url || outcome.sourceUrl || DEFAULT_QUEUE_URL,
        lastSuccessAt: prior.last_success_at || null,
        lastCheckedAt: observedAt,
        consecutiveFailures: Number(prior.consecutive_failures || 0),
        failureStartedAt: prior.failure_started_at || null,
        lastError: outcome.error || null,
        sourceStatus: "busy",
      },
      events: [],
    };
  }

  if (outcome.status === "error" || outcome.status === "unknown") {
    const failures = Number(prior.consecutive_failures || 0) + 1;
    const failureStartedAt = prior.failure_started_at || observedAt;
    return {
      state: {
        currentStatus: prior.current_status || "unknown",
        availableKeys: [...previousAvailable],
        observations: outcome.observations || parseJson(prior.observations_json, []),
        bookingUrl: prior.booking_url || outcome.sourceUrl || DEFAULT_QUEUE_URL,
        lastSuccessAt: prior.last_success_at || null,
        lastCheckedAt: observedAt,
        consecutiveFailures: failures,
        failureStartedAt,
        lastError: outcome.error || "Chairman availability could not be determined",
        sourceStatus: outcome.status,
      },
      events: failures === Number(failureThreshold)
        ? [{
            type: "chairman_monitor_degraded",
            key: `chairman:degraded:${failureStartedAt}`,
            payload: {
              consecutiveFailures: failures,
              error: outcome.error,
              httpStatus: outcome.httpStatus || null,
              pageTitle: outcome.pageTitle || null,
              pageFingerprint: outcome.pageFingerprint || null,
            },
          }]
        : [],
    };
  }

  const availableKeys = new Set((outcome.available || []).map((item) => item.key));
  const newlyAvailable = (outcome.available || []).filter((item) => !previousAvailable.has(item.key));
  const events = [];
  if (newlyAvailable.length) {
    events.push({
      type: "chairman_availability",
      key: `chairman:availability:${newlyAvailable.map((item) => item.key).sort().join(",")}:${observedAt}`,
      payload: {
        partySize: outcome.partySize,
        available: newlyAvailable,
        sourceUrl: outcome.sourceUrl,
      },
    });
  }
  if (Number(prior.consecutive_failures || 0) >= Number(failureThreshold)) {
    events.push({
      type: "chairman_monitor_recovered",
      key: `chairman:recovered:${prior.failure_started_at || observedAt}`,
      payload: {
        previousFailures: Number(prior.consecutive_failures || 0),
        currentStatus: outcome.status,
      },
    });
  }
  return {
    state: {
      currentStatus: outcome.status,
      availableKeys: [...availableKeys],
      observations: outcome.observations || [],
      bookingUrl: outcome.sourceUrl || DEFAULT_QUEUE_URL,
      lastSuccessAt: observedAt,
      lastCheckedAt: observedAt,
      consecutiveFailures: 0,
      failureStartedAt: null,
      lastError: null,
      sourceStatus: "ok",
    },
    events,
  };
}

async function saveChairmanState(db, state, observedAt) {
  await db
    .prepare(
      `UPDATE chairman_state SET
         current_status=?, available_keys_json=?, observations_json=?, booking_url=?,
         last_success_at=?, last_checked_at=?, consecutive_failures=?, failure_started_at=?,
         last_error=?, source_status=?, updated_at=? WHERE id=1`,
    )
    .bind(
      state.currentStatus,
      JSON.stringify(state.availableKeys),
      JSON.stringify(state.observations),
      state.bookingUrl,
      state.lastSuccessAt,
      state.lastCheckedAt,
      state.consecutiveFailures,
      state.failureStartedAt,
      state.lastError,
      state.sourceStatus,
      observedAt,
    )
    .run();
}

async function startChairmanCheck(db, id, scheduledAt, startedAt, trigger) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO chairman_checks(id, scheduled_at, started_at, trigger, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(id, scheduledAt, startedAt, trigger)
    .run();
  return Boolean(result.meta?.changes);
}

export async function runChairmanCycle(
  env,
  { scheduledAt = new Date(), trigger = "scheduled", fetcher = fetch } = {},
) {
  if (String(env.CHAIRMAN_ENABLED || "true").toLowerCase() === "false") {
    return { status: "disabled" };
  }
  const startedClock = Date.now();
  const startedAt = new Date().toISOString();
  const checkId = trigger === "scheduled"
    ? `chairman:scheduled:${scheduledAt.getTime()}`
    : `chairman:manual:${crypto.randomUUID()}`;
  if (!await startChairmanCheck(env.DB, checkId, scheduledAt.toISOString(), startedAt, trigger)) {
    return { status: "duplicate", checkId };
  }

  let outcome;
  try {
    outcome = await fetchChairmanAvailability(env, fetcher);
  } catch (error) {
    outcome = {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      sourceUrl: env.CHAIRMAN_QUEUE_URL || DEFAULT_QUEUE_URL,
    };
  }
  const observedAt = new Date().toISOString();
  const previous = await getChairmanState(env.DB);
  const transition = planChairmanTransition(
    previous,
    outcome,
    observedAt,
    integer(env.CHAIRMAN_FAILURE_ALERT_THRESHOLD, 3),
  );
  await saveChairmanState(env.DB, transition.state, observedAt);
  await env.DB
    .prepare(
      `UPDATE chairman_checks SET finished_at=?, status=?, http_status=?, error=?,
       result_json=?, duration_ms=? WHERE id=?`,
    )
    .bind(
      observedAt,
      outcome.status,
      outcome.httpStatus || null,
      outcome.error || null,
      JSON.stringify({
        pageTitle: outcome.pageTitle || null,
        pageBytes: outcome.pageBytes || null,
        pageFingerprint: outcome.pageFingerprint || null,
        observations: outcome.observations || [],
      }),
      Date.now() - startedClock,
      checkId,
    )
    .run();

  const eventIds = [];
  for (const event of transition.events) {
    const eventId = await createEvent(
      env.DB,
      event,
      observedAt,
      configuredChannels(env),
    );
    if (eventId) eventIds.push(eventId);
  }
  return {
    checkId,
    status: outcome.status,
    httpStatus: outcome.httpStatus || null,
    error: outcome.error || null,
    pageTitle: outcome.pageTitle || null,
    pageBytes: outcome.pageBytes || null,
    pageFingerprint: outcome.pageFingerprint || null,
    observations: outcome.observations || [],
    available: outcome.available || [],
    eventIds,
  };
}

export async function chairmanHealthResponse(env) {
  const state = await getChairmanState(env.DB);
  const lastCheckedAgeMs = state?.last_checked_at
    ? Date.now() - new Date(state.last_checked_at).getTime()
    : null;
  const schedulerHealthy = Number.isFinite(lastCheckedAgeMs) && lastCheckedAgeMs < 180_000;
  return Response.json(
    {
      ok: schedulerHealthy,
      target: {
        dates: list(env.CHAIRMAN_TARGET_DATES, ["2026-10-30", "2026-10-31", "2026-11-01"]),
        partySize: integer(env.CHAIRMAN_PARTY_SIZE, 2),
        mealWindows: list(env.CHAIRMAN_MEAL_WINDOWS, ["lunch", "dinner"]),
      },
      state: state
        ? {
            status: state.current_status,
            sourceStatus: state.source_status,
            availableKeys: parseJson(state.available_keys_json, []),
            observations: parseJson(state.observations_json, []),
            bookingUrl: state.booking_url,
            lastSuccessAt: state.last_success_at,
            lastCheckedAt: state.last_checked_at,
            consecutiveFailures: state.consecutive_failures,
            lastError: state.last_error,
          }
        : null,
      scheduler: { ok: schedulerHealthy, ageMs: lastCheckedAgeMs },
    },
    { status: schedulerHealthy ? 200 : 503 },
  );
}
