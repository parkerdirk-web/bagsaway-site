// Reads back a completed Checkout Session so the confirmation page can show
// the booking details as a receipt. Dependency-free (fetch to Stripe API).

export async function handler(event) {
  const key = process.env.STRIPE_SECRET_KEY;
  const id = (event.queryStringParameters || {}).session_id;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: "Not configured" }) };
  if (!id) return { statusCode: 400, body: JSON.stringify({ error: "Missing session" }) };

  try {
    const res = await fetch(
      "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id) + "?expand[]=line_items",
      { headers: { Authorization: "Bearer " + key } }
    );
    const s = await res.json();
    if (s.error) return { statusCode: 400, body: JSON.stringify({ error: s.error.message }) };

    const items = ((s.line_items && s.line_items.data) || []).map((li) => ({
      name: li.description || "Item",
      qty: li.quantity,
      amount: li.amount_total,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        paid: s.payment_status === "paid",
        total: s.amount_total,
        currency: (s.currency || "gbp").toUpperCase(),
        email: (s.customer_details && s.customer_details.email) || "",
        name: (s.metadata && s.metadata.customer_name) || "",
        dropoff: (s.metadata && s.metadata.dropoff_date) || "",
        reference: (s.id || "").slice(-8).toUpperCase(),
        items: items,
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Lookup failed" }) };
  }
}
