// Creates a Stripe Checkout Session (Apple Pay / Google Pay / card / Link).
// Dependency-free: talks to the Stripe REST API with fetch, so it deploys
// without any npm install. Set STRIPE_SECRET_KEY in Netlify env vars.

const PRICES = { luggage: 5, bike: 5, pram: 5, surf: 5, other: 5 }; // £ per item, per day
const LABELS = {
  luggage: "Luggage / suitcase",
  bike: "Pedal bike",
  pram: "Pram / buggy",
  surf: "Surfboard",
  other: "Other item",
};

// Turn "4:30 pm", "4:30pm" or "16:30" into minutes-since-midnight (or null).
function toMinutes(t) {
  t = (t || "").trim().toLowerCase();
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/); // 12-hour with am/pm
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === "pm") h += 12;
    return h * 60 + parseInt(m[2], 10);
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/); // 24-hour
  if (m) {
    const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    if (h <= 23 && mi <= 59) return h * 60 + mi;
  }
  return null;
}
// minutes-since-midnight -> "HH:MM"
function hhmm(mins) {
  const h = Math.floor(mins / 60), mi = mins % 60;
  return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "Payment not configured yet." }) };
  }

  let data;
  try { data = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Bad request" }) }; }

  const cart = Array.isArray(data.cart) ? data.cart : [];
  if (!cart.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "Your booking is empty." }) };
  }

  const origin =
    event.headers.origin ||
    (event.headers.host ? "https://" + event.headers.host : "https://bagsawaynewquay.com");

  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", origin + "/thanks.html?session_id={CHECKOUT_SESSION_ID}");
  params.append("cancel_url", origin + "/book.html");
  params.append("billing_address_collection", "auto");
  params.append("phone_number_collection[enabled]", "true");

  let i = 0;
  const summary = [];
  for (const line of cart) {
    const price = PRICES[line.key];
    if (!price) continue; // ignore anything unexpected
    const qty = Math.max(1, Math.min(100, parseInt(line.qty) || 1));
    const days = Math.max(1, Math.min(60, parseInt(line.days) || 1));
    params.append(`line_items[${i}][price_data][currency]`, "gbp");
    params.append(`line_items[${i}][price_data][unit_amount]`, String(price * days * 100));
    params.append(
      `line_items[${i}][price_data][product_data][name]`,
      `${LABELS[line.key]} — ${days} day${days > 1 ? "s" : ""} @ £${price}/day`
    );
    params.append(`line_items[${i}][quantity]`, String(qty));
    summary.push(`${qty}x ${LABELS[line.key]} (${days}d)`);
    i++;
  }
  if (i === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No valid items in booking." }) };
  }

  // attach booking details so they appear on the payment in your Stripe dashboard
  params.append("metadata[customer_name]", (data.name || "").slice(0, 200));
  params.append("metadata[phone]", (data.phone || "").slice(0, 60));
  params.append("metadata[dropoff_date]", (data.dropoff || "").slice(0, 40));
  params.append("metadata[dropoff_time]", (data.dropTime || "").slice(0, 20));
  params.append("metadata[collection_time]", (data.collectTime || "").slice(0, 20));
  params.append("metadata[items]", summary.join("; ").slice(0, 480));
  params.append("metadata[source]", "bags_away_website"); // marker so the webhook ignores other gym payments

  // Build clean ISO 8601 start/end so the calendar shows a TIMED block, not all-day.
  // Normalised here on the server, so it works no matter what format the dropdown sends.
  const isoDate = (data.dropoff || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const startMin = toMinutes(data.dropTime);
    let endMin = toMinutes(data.collectTime);
    if (startMin != null) {
      // ensure end is after start; if missing or not later, default to start + 2h (capped at 23:59)
      if (endMin == null || endMin <= startMin) endMin = Math.min(startMin + 120, 23 * 60 + 59);
      params.append("metadata[start_iso]", isoDate + "T" + hhmm(startMin) + ":00");
      params.append("metadata[end_iso]", isoDate + "T" + hhmm(endMin) + ":00");
    }
  }
  params.append("metadata[email]", (data.email || "").slice(0, 200));
  if (data.email && /.+@.+\..+/.test(data.email)) {
    params.append("customer_email", data.email.slice(0, 200)); // prefills Stripe + sends receipt here
  }
  params.append("payment_intent_data[description]", "Bags Away booking: " + summary.join("; ").slice(0, 200));

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const session = await res.json();
    if (session.error) {
      return { statusCode: 400, body: JSON.stringify({ error: session.error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Could not reach payment provider." }) };
  }
}
