export function renderRaceMessage(event) {
  const message = event.payload?.message;
  if (typeof message !== "string" || !message.trim() || new TextEncoder().encode(message).length > 19000) {
    throw new Error("Invalid or oversized race message");
  }
  const title = { race_digest: "🏃 新的赛事与户外活动", race_wtm_asia: "🌏 WTM 新增亚洲站",
    race_source_degraded: "⚠️ 赛事监控覆盖异常", race_source_recovered: "✅ 赛事监控覆盖恢复" }[event.type];
  if (!title) throw new Error("Unsupported race event");
  return { title, message };
}
