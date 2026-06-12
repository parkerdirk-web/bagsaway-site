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
  params.append("success_url", origin + "/thanks.html");
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
  params.append("metadata[items]", summary.join("; ").slice(0, 480));
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
