export class ChairmanParseError extends Error {}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateVariants(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new ChairmanParseError(`Invalid Chairman target date: ${isoDate}`);
  const [, year, monthText, dayText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ChairmanParseError(`Invalid Chairman target date: ${isoDate}`);
  }
  const monthName = MONTH_NAMES[month - 1];
  const shortMonth = monthName.slice(0, 3);
  return [
    `${year}-${monthText}-${dayText}`,
    `${year}/${monthText}/${dayText}`,
    `${dayText}/${monthText}/${year}`,
    `${monthText}/${dayText}/${year}`,
    `${day} ${monthName} ${year}`,
    `${day} ${shortMonth} ${year}`,
    `${monthName} ${day}, ${year}`,
    `${shortMonth} ${day}, ${year}`,
    `${year}年${month}月${day}日`,
    `${month}月${day}日`,
  ];
}

function containsDate(value, isoDate) {
  return dateVariants(isoDate).some((variant) => new RegExp(escapeRegExp(variant), "i").test(value));
}

function targetContexts(html, isoDate, allTargetDates) {
  const decoded = decodeEntities(html);
  const candidates = [];
  const blockPatterns = [
    /<tr\b[^>]*>[\s\S]*?<\/tr>/gi,
    /<li\b[^>]*>[\s\S]*?<\/li>/gi,
    /<section\b[^>]*>[\s\S]*?<\/section>/gi,
    /<article\b[^>]*>[\s\S]*?<\/article>/gi,
    /<div\b[^>]*>[\s\S]*?<\/div>/gi,
    /<(?:a|button)\b[^>]*>[\s\S]*?<\/(?:a|button)>/gi,
    /<input\b[^>]*>/gi,
  ];
  for (const pattern of blockPatterns) {
    for (const match of decoded.matchAll(pattern)) {
      if (match[0].length <= 6000 && containsDate(match[0], isoDate)) candidates.push(match[0]);
    }
  }
  if (!candidates.length) {
    for (const variant of dateVariants(isoDate)) {
      const expression = new RegExp(escapeRegExp(variant), "gi");
      for (const match of decoded.matchAll(expression)) {
        candidates.push(decoded.slice(Math.max(0, match.index - 900), match.index + variant.length + 900));
      }
    }
  }
  return [...new Set(candidates)]
    .sort((left, right) => left.length - right.length)
    .map((context) => ({
      html: context,
      ambiguous: allTargetDates.filter((date) => containsDate(context, date)).length > 1,
    }));
}

function timeParts(value) {
  const text = value || "";
  const withPeriod = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  const twentyFourHour = /\b(\d{1,2}):(\d{2})\b/i.exec(text);
  const match = withPeriod || twentyFourHour;
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const period = withPeriod?.[3]?.toLowerCase();
  if (period === "pm" && hour < 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function mealWindowForTime(time) {
  if (!time) return null;
  if (time.hour >= 11 && time.hour < 16) return "lunch";
  if (time.hour >= 17 && time.hour <= 23) return "dinner";
  return null;
}

function hasUnavailableMarker(value) {
  return /(?:\bdisabled\b|aria-disabled\s*=\s*["']?true|fully\s*booked|sold\s*out|no\s*availability|not\s*available|unavailable|booking\s*closed|\bclosed\b|滿座|已滿|無位|没位|不可預訂|不可预订|已經客滿|已经客满)/i.test(value || "");
}

function hasAvailableMarker(value) {
  return /(?:\bbook(?:ing)?\b|book\s*now|\breserve\b|\bavailable\b|\bselect\b|預訂|预订|訂座|订座|有位|可預訂|可预订)/i.test(value || "");
}

function absoluteUrl(baseUrl, value) {
  if (!value) return null;
  try {
    return new URL(decodeEntities(value), baseUrl).toString();
  } catch {
    return null;
  }
}

function candidateControls(context, sourceUrl, isoDate, allowContextTime) {
  const controls = [];
  const pattern = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>|<input\b([^>]*)>/gi;
  for (const match of context.matchAll(pattern)) {
    const tag = match[1]?.toLowerCase() || "input";
    const attributes = match[1] ? match[2] || "" : match[4] || "";
    const body = match[1] ? match[3] || "" : "";
    const text = stripTags(`${attributes} ${body}`);
    const time = timeParts(text);
    const mealWindow = mealWindowForTime(time);
    const raw = `${tag} ${attributes} ${body}`;
    const mentionsDate = containsDate(raw, isoDate);
    if ((!mealWindow || !allowContextTime) && !mentionsDate) continue;
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2] || null;
    const disabled = hasUnavailableMarker(raw);
    const interactive = tag === "a" ? Boolean(href) : !disabled;
    const explicitlyAvailable = hasAvailableMarker(raw);
    controls.push({
      mealWindow: mealWindow || "any",
      time: time?.label || null,
      available: !disabled && interactive && (explicitlyAvailable || tag === "a" || tag === "button"),
      bookingUrl: absoluteUrl(sourceUrl, href),
      evidence: text.slice(0, 240),
    });
  }
  return controls;
}

function contextMealMarker(context, mealWindow) {
  const text = stripTags(context);
  const marker = mealWindow === "lunch" ? /\b(?:lunch|noon)\b|午餐|午市/i : /\b(?:dinner|evening)\b|晚餐|晚市/i;
  return marker.test(text);
}

export function parseChairmanAvailability(
  html,
  {
    targetDates = ["2026-10-30", "2026-10-31", "2026-11-01"],
    mealWindows = ["lunch", "dinner"],
    partySize = 2,
    sourceUrl = "https://thechairmangroup.queue-it.net/?c=thechairmangroup&e=chairmanwaitingrmsys",
  } = {},
) {
  if (!Number.isInteger(Number(partySize)) || Number(partySize) < 1) {
    throw new ChairmanParseError("partySize must be a positive integer");
  }
  if (!Array.isArray(targetDates) || !targetDates.length) {
    throw new ChairmanParseError("At least one Chairman target date is required");
  }
  const normalizedWindows = [...new Set(mealWindows.map((value) => String(value).toLowerCase()))];
  if (normalizedWindows.some((value) => !["lunch", "dinner"].includes(value))) {
    throw new ChairmanParseError("mealWindows may only contain lunch and dinner");
  }
  if (/server\s*busy|currently\s*experiencing\s*high\s*traffic|系統非常繁忙|系统非常繁忙/i.test(html)) {
    throw new ChairmanParseError("The Chairman booking server is busy");
  }
  if (!/chairman|大班樓|大班楼/i.test(html) || !/book|reserv|訂座|订座|預訂|预订/i.test(html)) {
    throw new ChairmanParseError("Page is missing expected Chairman booking markers");
  }

  const observations = [];
  for (const date of targetDates) {
    const contexts = targetContexts(html, date, targetDates);
    const controls = contexts.flatMap((context) =>
      candidateControls(context.html, sourceUrl, date, !context.ambiguous));
    const dateLevelControls = controls.filter((control) => control.mealWindow === "any");
    for (const mealWindow of normalizedWindows) {
      const matchingControls = controls.filter(
        (control) => control.mealWindow === mealWindow || control.mealWindow === "any",
      );
      const availableControls = matchingControls.filter((control) => control.available);
      let status = "unknown";
      let evidence = "Target date was not present in the booking response";
      if (contexts.length) {
        if (availableControls.length) {
          status = "available";
          evidence = availableControls.map((control) => control.evidence).join(" | ").slice(0, 700);
        } else if (matchingControls.length) {
          status = "unavailable";
          evidence = matchingControls.map((control) => control.evidence).join(" | ").slice(0, 700);
        } else {
          const mealContexts = contexts.filter(
            (context) => !context.ambiguous && contextMealMarker(context.html, mealWindow),
          );
          const unavailableContext = mealContexts.find((context) => hasUnavailableMarker(context.html));
          if (unavailableContext) {
            status = "unavailable";
            evidence = stripTags(unavailableContext.html).slice(0, 700);
          } else {
            evidence = "Date found, but no explicit bookable or unavailable meal control was found";
          }
        }
      }
      observations.push({
        key: `${date}:${mealWindow}`,
        date,
        mealWindow,
        status,
        times: availableControls.map((control) => control.time).filter(Boolean),
        dateLevel: availableControls.some((control) => dateLevelControls.includes(control)),
        bookingUrl: availableControls.find((control) => control.bookingUrl)?.bookingUrl || sourceUrl,
        evidence,
      });
    }
  }

  const available = observations.filter((observation) => observation.status === "available");
  const unavailable = observations.filter((observation) => observation.status === "unavailable");
  const unknown = observations.filter((observation) => observation.status === "unknown");
  const status = available.length
    ? "available"
    : unknown.length
      ? "unknown"
      : unavailable.length === observations.length
        ? "unavailable"
        : "unknown";
  return {
    status,
    partySize: Number(partySize),
    targetDates,
    mealWindows: normalizedWindows,
    observations,
    available,
    unknown,
    sourceUrl,
  };
}
