export class ParseError extends Error {}

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

function textContent(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function attributeValue(attributes, name) {
  const expression = new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  return expression.exec(attributes || "")?.[2] || null;
}

function hasClass(attributes, className) {
  return new Set((attributeValue(attributes, "class") || "").split(/\s+/)).has(className);
}

function displayDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new ParseError(`Invalid target date: ${isoDate}`);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new ParseError(`Invalid target date: ${isoDate}`);
  return `${match[3]} ${months[month - 1]} ${match[1]}`;
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(decodeEntities(href), baseUrl).toString();
  } catch {
    return null;
  }
}

function parseSeatCount(value) {
  const match = /\d+/.exec(value || "");
  return match ? Number(match[0]) : null;
}

function cellsFromRow(rowHtml) {
  const cells = {};
  const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  for (const match of rowHtml.matchAll(cellPattern)) {
    const attributes = match[1];
    const body = match[2];
    if (hasClass(attributes, "departure-body-product")) cells.product = textContent(body);
    if (hasClass(attributes, "departure-body-date")) cells.date = textContent(body);
    if (hasClass(attributes, "departure-body-time")) cells.time = textContent(body);
    if (hasClass(attributes, "departure-body-available")) cells.availability = textContent(body);
    if (hasClass(attributes, "departure-body-book-now-message")) cells.message = textContent(body);
  }
  const hrefMatch = /<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1/i.exec(rowHtml);
  cells.href = hrefMatch?.[2] || null;
  return cells;
}

export function parseFunyaksAvailability(
  html,
  { targetDate = "2027-02-02", partySize = 1, sourceUrl } = {},
) {
  if (!Number.isInteger(Number(partySize)) || Number(partySize) < 1) {
    throw new ParseError("partySize must be a positive integer");
  }
  if (!sourceUrl) throw new ParseError("sourceUrl is required");
  if (!/Dart River/i.test(html) || !/Funyaks/i.test(html)) {
    throw new ParseError("Booking page is missing the expected Dart River/Funyaks markers");
  }

  const expectedDate = displayDate(targetDate);
  const departures = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const rowHtml = match[1];
    const cells = cellsFromRow(rowHtml);
    if (cells.product?.trim().toLowerCase() !== "funyaks" || cells.date !== expectedDate) continue;

    const availableSeats = parseSeatCount(cells.availability);
    const bookingUrl = cells.href ? absoluteUrl(sourceUrl, cells.href) : null;
    const knownUnavailable = /trip full|sold out|no availability|not available/i.test(cells.message || "");
    if (availableSeats === null && !knownUnavailable) {
      throw new ParseError(`Unknown Funyaks availability format: ${JSON.stringify(cells)}`);
    }
    if (availableSeats !== null && availableSeats >= Number(partySize) && !bookingUrl) {
      throw new ParseError("Funyaks shows enough seats but no booking link was found");
    }
    departures.push({
      product: "Funyaks",
      date: targetDate,
      time: cells.time || "Unknown",
      availabilityText: cells.availability || null,
      availableSeats,
      bookingUrl,
      message: cells.message || null,
    });
  }

  if (!departures.length) {
    throw new ParseError(`No Funyaks row found for ${expectedDate}; the booking page may have changed`);
  }

  const bookable = departures.filter(
    (departure) =>
      departure.availableSeats !== null &&
      departure.availableSeats >= Number(partySize) &&
      departure.bookingUrl,
  );
  return {
    status: bookable.length ? "available" : "unavailable",
    targetDate,
    partySize: Number(partySize),
    departures,
    bookable,
  };
}
