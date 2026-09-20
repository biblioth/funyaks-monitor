function configuredPushPlusChannels(env) {
  if (!env.PUSHPLUS_TOKEN) return [];
  return [...new Set(
    String(env.PUSHPLUS_CHANNELS || "wechat")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ["wechat", "clawbot"].includes(value)),
  )].map((value) => (value === "wechat" ? "pushplus" : `pushplus:${value}`));
}

export function configuredChannels(env) {
  return [env.FEISHU_WEBHOOK_URL ? "feishu" : null, ...configuredPushPlusChannels(env)].filter(Boolean);
}

function pushPlusApiChannel(channel) {
  if (channel === "pushplus") return "wechat";
  if (channel.startsWith("pushplus:")) return channel.slice("pushplus:".length);
  return null;
}

function truncate(value, length = 700) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function renderEvent(event) {
  const payload = event.payload || {};
  if (event.type === "availability") {
    const lines = [
      `🎉 Funyaks 有位置了（${payload.partySize || 1} 位）`,
      `日期：${payload.targetDate}`,
    ];
    for (const departure of payload.bookable || []) {
      lines.push(`时间：${departure.time}｜余位：${departure.availabilityText || departure.availableSeats}`);
    }
    const link = payload.bookable?.[0]?.bookingUrl || payload.sourceUrl;
    if (link) lines.push(`立即预订：${link}`);
    return { title: "🎉 Funyaks 有位置了", message: lines.join("\n") };
  }
  if (event.type === "monitor_degraded") {
    return {
      title: "🚨 Funyaks 监控异常",
      message: [
        "🚨 Funyaks 监控连续失败",
        `连续失败：${payload.consecutiveFailures || "多"} 次`,
        `最后错误：${truncate(payload.error)}`,
        "GitHub 看门狗将继续尝试自愈和兜底检查。",
      ].join("\n"),
    };
  }
  if (event.type === "monitor_recovered") {
    return {
      title: "✅ Funyaks 监控已恢复",
      message: [
        "✅ Funyaks 监控已恢复",
        `此前连续失败：${payload.previousFailures || 0} 次`,
        `当前房态：${payload.currentStatus === "available" ? "有位" : "无位"}`,
      ].join("\n"),
    };
  }
  if (event.type === "weekly_summary") {
    const currentStatus = {
      available: "有位",
      unavailable: "无位",
      error: "检查异常",
    }[payload.currentStatus] || "未知";
    return {
      title: "📊 Funyaks 监控周报",
      message: [
        "📊 Funyaks 监控周报",
        `周期：${payload.periodStart?.slice(0, 10)} ～ ${payload.periodEnd?.slice(0, 10)}（北京时间）`,
        `目标：${payload.targetDate} Funyaks，${payload.partySize || 1} 位`,
        `当前房态：${currentStatus}`,
        `本周检查：${payload.totalChecks || 0} 次｜成功 ${payload.successfulChecks || 0}｜异常 ${payload.failedChecks || 0}｜成功率 ${payload.successRate || "0.00"}%`,
        `检测结果：有位 ${payload.availableChecks || 0} 次｜无位 ${payload.unavailableChecks || 0} 次`,
        `响应耗时：平均 ${payload.averageDurationMs || 0} ms｜最大 ${payload.maxDurationMs || 0} ms`,
        `事件：放位提醒 ${payload.availabilityEvents || 0}｜监控异常 ${payload.degradedEvents || 0}｜恢复 ${payload.recoveredEvents || 0}`,
        `最后检查：${payload.lastCheckedAt || "暂无"}`,
      ].join("\n"),
    };
  }
  throw new Error(`Unsupported event type: ${event.type}`);
}

async function feishuSignature(secret, timestamp) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function sendFeishu(env, message, fetcher) {
  const payload = { msg_type: "text", content: { text: message } };
  if (env.FEISHU_WEBHOOK_SECRET) {
    payload.timestamp = String(Math.floor(Date.now() / 1000));
    payload.sign = await feishuSignature(env.FEISHU_WEBHOOK_SECRET, payload.timestamp);
  }
  const response = await fetcher(env.FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Feishu returned HTTP ${response.status}`);
  const result = await response.json();
  const code = result.code ?? result.StatusCode ?? 0;
  if (![0, "0", null].includes(code)) throw new Error(`Feishu rejected the message: ${code}`);
}

async function sendPushPlus(env, title, message, channel, fetcher) {
  const payload = {
    token: env.PUSHPLUS_TOKEN,
    title: title.slice(0, 80),
    content: message,
    template: "txt",
    channel,
  };
  if (env.PUSHPLUS_TOPIC) payload.topic = env.PUSHPLUS_TOPIC;
  const response = await fetcher("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`PushPlus returned HTTP ${response.status}`);
  const result = await response.json();
  if (![200, "200"].includes(result.code)) {
    throw new Error(`PushPlus rejected the message: ${result.code}`);
  }
}

export async function sendEvent(env, event, channel, fetcher = fetch) {
  const rendered = renderEvent(event);
  if (channel === "feishu") {
    if (!env.FEISHU_WEBHOOK_URL) throw new Error("Feishu is not configured");
    return sendFeishu(env, rendered.message, fetcher);
  }
  const apiChannel = pushPlusApiChannel(channel);
  if (apiChannel) {
    if (!env.PUSHPLUS_TOKEN) throw new Error("PushPlus is not configured");
    return sendPushPlus(env, rendered.title, rendered.message, apiChannel, fetcher);
  }
  throw new Error(`Unsupported notification channel: ${channel}`);
}
