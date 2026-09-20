import { configuredChannels } from "./notifications.js";

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export async function getState(db) {
  return db.prepare("SELECT * FROM monitor_state WHERE id=1").first();
}

export async function startCheck(db, id, scheduledAt, startedAt, trigger) {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO monitor_checks(id, scheduled_at, started_at, trigger, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(id, scheduledAt, startedAt, trigger)
    .run();
  return Boolean(result.meta?.changes);
}

export function planTransition(previous, outcome, observedAt, failureThreshold = 3) {
  const prior = previous || {};
  if (outcome.status === "error") {
    const failures = Number(prior.consecutive_failures || 0) + 1;
    const failureStartedAt = prior.failure_started_at || observedAt;
    return {
      state: {
        currentStatus: prior.current_status || null,
        availableSeats: prior.available_seats ?? null,
        availabilityText: prior.availability_text || null,
        bookingUrl: prior.booking_url || null,
        lastSuccessAt: prior.last_success_at || null,
        lastCheckedAt: observedAt,
        lastUnavailableAt: prior.last_unavailable_at || null,
        consecutiveFailures: failures,
        failureStartedAt,
        lastError: outcome.error,
      },
      events: failures === Number(failureThreshold)
        ? [{
            type: "monitor_degraded",
            key: `degraded:${failureStartedAt}`,
            payload: { consecutiveFailures: failures, error: outcome.error },
          }]
        : [],
    };
  }

  const wasDegraded = Number(prior.consecutive_failures || 0) >= Number(failureThreshold);
  const events = [];
  if (outcome.status === "available" && prior.current_status !== "available") {
    events.push({
      type: "availability",
      key: `availability:${prior.last_unavailable_at || "initial"}`,
      payload: {
        targetDate: outcome.targetDate,
        partySize: outcome.partySize,
        bookable: outcome.bookable,
        sourceUrl: outcome.sourceUrl,
      },
    });
  }
  if (wasDegraded) {
    events.push({
      type: "monitor_recovered",
      key: `recovered:${prior.failure_started_at || observedAt}`,
      payload: {
        previousFailures: Number(prior.consecutive_failures || 0),
        currentStatus: outcome.status,
      },
    });
  }
  const first = outcome.departures?.[0] || {};
  return {
    state: {
      currentStatus: outcome.status,
      availableSeats: first.availableSeats ?? null,
      availabilityText: first.availabilityText || null,
      bookingUrl: first.bookingUrl || null,
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

async function saveState(db, state) {
  await db
    .prepare(
      `UPDATE monitor_state SET
         current_status=?, available_seats=?, availability_text=?, booking_url=?,
         last_success_at=?, last_checked_at=?, last_unavailable_at=?,
         consecutive_failures=?, failure_started_at=?, last_error=?, updated_at=?
       WHERE id=1`,
    )
    .bind(
      state.currentStatus,
      state.availableSeats,
      state.availabilityText,
      state.bookingUrl,
      state.lastSuccessAt,
      state.lastCheckedAt,
      state.lastUnavailableAt,
      state.consecutiveFailures,
      state.failureStartedAt,
      state.lastError,
      state.lastCheckedAt,
    )
    .run();
}

export async function createEvent(db, event, createdAt, channels) {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO monitor_events(idempotency_key, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(event.key, event.type, JSON.stringify(event.payload), createdAt)
    .run();
  const row = await db
    .prepare("SELECT id FROM monitor_events WHERE idempotency_key=?")
    .bind(event.key)
    .first();
  if (!row) return null;
  for (const channel of channels) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO monitor_deliveries(
           event_id, channel, status, created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?)`,
      )
      .bind(row.id, channel, createdAt, createdAt)
      .run();
  }
  return inserted.meta?.changes ? row.id : null;
}

export async function recordOutcome(
  env,
  { checkId, outcome, observedAt, durationMs, failureThreshold = 3 },
) {
  const previous = await getState(env.DB);
  const transition = planTransition(previous, outcome, observedAt, failureThreshold);
  await saveState(env.DB, transition.state);
  await env.DB
    .prepare(
      `UPDATE monitor_checks SET finished_at=?, status=?, available_seats=?,
       error=?, duration_ms=? WHERE id=?`,
    )
    .bind(
      observedAt,
      outcome.status,
      outcome.departures?.[0]?.availableSeats ?? null,
      outcome.error || null,
      durationMs,
      checkId,
    )
    .run();

  const channels = configuredChannels(env);
  const eventIds = [];
  for (const event of transition.events) {
    const eventId = await createEvent(env.DB, event, observedAt, channels);
    if (eventId) eventIds.push(eventId);
  }
  return { previous, state: transition.state, eventIds };
}

export async function pendingDeliveries(db, staleBefore, limit = 20) {
  const result = await db
    .prepare(
      `SELECT d.id FROM monitor_deliveries d
       WHERE d.status != 'delivered'
         AND (d.queued_at IS NULL OR d.queued_at < ?)
       ORDER BY d.id LIMIT ?`,
    )
    .bind(staleBefore, limit)
    .all();
  return result.results || [];
}

export async function markQueued(db, deliveryId, queuedAt) {
  await db
    .prepare(
      `UPDATE monitor_deliveries SET status='queued', queued_at=?, updated_at=? WHERE id=?`,
    )
    .bind(queuedAt, queuedAt, deliveryId)
    .run();
}

export async function getDelivery(db, deliveryId) {
  const row = await db
    .prepare(
      `SELECT d.*, e.event_type, e.payload_json
       FROM monitor_deliveries d
       JOIN monitor_events e ON e.id=d.event_id
       WHERE d.id=?`,
    )
    .bind(deliveryId)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    attempts: Number(row.attempts || 0),
    event: { type: row.event_type, payload: parseJson(row.payload_json) },
  };
}

export async function markDelivered(db, deliveryId, deliveredAt) {
  await db
    .prepare(
      `UPDATE monitor_deliveries SET status='delivered', attempts=attempts+1,
       delivered_at=?, last_error=NULL, updated_at=? WHERE id=?`,
    )
    .bind(deliveredAt, deliveredAt, deliveryId)
    .run();
}

export async function markDeliveryFailed(db, deliveryId, error, failedAt) {
  await db
    .prepare(
      `UPDATE monitor_deliveries SET status='pending', attempts=attempts+1,
       last_error=?, updated_at=? WHERE id=?`,
    )
    .bind(String(error).slice(0, 1000), failedAt, deliveryId)
    .run();
}

export async function cleanup(db, cutoff) {
  await db.prepare("DELETE FROM monitor_checks WHERE scheduled_at < ?").bind(cutoff).run();
  await db.prepare("DELETE FROM chairman_checks WHERE scheduled_at < ?").bind(cutoff).run();
  await db
    .prepare(
      `DELETE FROM monitor_deliveries
       WHERE status='delivered' AND delivered_at < ?`,
    )
    .bind(cutoff)
    .run();
  await db
    .prepare(
      `DELETE FROM monitor_events
       WHERE created_at < ? AND id NOT IN (SELECT event_id FROM monitor_deliveries)`,
    )
    .bind(cutoff)
    .run();
}
