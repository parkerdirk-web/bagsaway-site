// Stripe webhook → emails a full booking summary to luggage@bagsawaynewquay.com
// when a payment completes. Dependency-free: verifies the signature with
// node:crypto and sends mail via the Resend REST API with fetch.
//
// Env vars needed in Netlify:
//   STRIPE_WEBHOOK_SECRET  (whsec_…  from the Stripe webhook you create)
//   RESEND_API_KEY         (re_…     from resend.com)

import crypto from "node:crypto";

const FROM = "Bags Away <bookings@bagsawaynewquay.com>"; // must be a Resend-verified domain
const TO = "luggage@bagsawaynewquay.com";

function esc(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export async function handler(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");

  // 1. verify the request really came from Stripe
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = event.headers["stripe-signature"];
  if (secret && sig) {
    try {
      const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
      const expected = crypto
        .createHmac("sha256", secret)
        .update(parts.t + "." + raw)
        .digest("hex");
      if (!parts.v1 || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
        return { statusCode: 400, body: "Invalid signature" };
      }
    } catch (e) {
      return { statusCode: 400, body: "Signature check failed" };
    }
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return { statusCode: 400, body: "Bad JSON" }; }
  if (evt.type !== "checkout.session.completed") return { statusCode: 200, body: "Ignored" };

  const s = evt.data.object || {};
  const m = s.metadata || {};
  const total = "£" + ((s.amount_total || 0) / 100).toFixed(2);
  const email = (s.customer_details && s.customer_details.email) || m.email || "";
  const ref = (s.id || "").slice(-8).toUpperCase();
  const itemsHtml = (m.items || "")
    .split("; ").filter(Boolean)
    .map((x) => "<li>" + esc(x) + "</li>").join("");

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">' +
    '<h2 style="background:#22386B;color:#fff;padding:16px;border-radius:10px 10px 0 0;margin:0">New booking · Bags Away</h2>' +
    '<div style="border:1px solid #eee;border-top:none;padding:18px;border-radius:0 0 10px 10px">' +
    '<p style="font-size:18px;margin:0 0 12px"><b>' + total + '</b> paid &nbsp;·&nbsp; Ref <b>' + esc(ref) + '</b></p>' +
    '<ul style="font-size:15px;padding-left:18px">' + itemsHtml + '</ul>' +
    '<table style="font-size:15px;border-collapse:collapse;margin-top:10px">' +
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Name</td><td>' + esc(m.customer_name) + '</td></tr>' +
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Phone</td><td>' + esc(m.phone) + '</td></tr>' +
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Email</td><td>' + esc(email) + '</td></tr>' +
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Drop-off</td><td>' + esc(m.dropoff_date) + '</td></tr>' +
    '</table></div></div>';

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { statusCode: 200, body: "Email not configured" };
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email || undefined,
        subject: "New booking — " + (m.customer_name || "customer") + " (" + total + ")",
        html: html,
      }),
    });
  } catch (e) {
    return { statusCode: 200, body: "Email send failed" };
  }
  return { statusCode: 200, body: "ok" };
}
