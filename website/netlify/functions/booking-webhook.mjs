// Stripe webhook → emails a full booking summary to luggage@bagsawaynewquay.com
// when a payment completes. Dependency-free: verifies the signature with
// node:crypto and sends mail via the Resend REST API with fetch.
//
// Env vars needed in Netlify:
//   STRIPE_WEBHOOK_SECRET  (whsec_…  from the Stripe webhook you create)
//   RESEND_API_KEY         (re_…     from resend.com)

import crypto from "node:crypto";

const FROM = "Bags Away <luggage@bagsawaynewquay.com>"; // domain must be verified in Resend
const TO = "luggage@bagsawaynewquay.com";               // where the business alert goes

function esc(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Get a Google API access token from a service account (dependency-free JWT flow)
async function googleToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY || "";
  if (!email || !key) return null;
  key = key.replace(/\\n/g, "\n"); // env vars often store newlines escaped
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + claim);
  const sig = b64url(signer.sign(key));
  const jwt = header + "." + claim + "." + sig;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt,
  });
  const j = await res.json();
  return j.access_token || null;
}

// Create an all-day event on the booking's drop-off date in the shared calendar
async function addToCalendar({ name, items, phone, email, total, ref, dropoff, dropTime, collectTime }) {
  const calId = process.env.GOOGLE_CALENDAR_ID;
  const token = await googleToken();
  if (!calId || !token) return;
  let start = (dropoff && /^\d{4}-\d{2}-\d{2}$/.test(dropoff)) ? dropoff : new Date().toISOString().slice(0, 10);
  const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  const end = d.toISOString().slice(0, 10);
  const body = {
    summary: "Bags Away: " + (name || "Booking") + " — " + items + (dropTime ? " (drop " + dropTime + ")" : ""),
    description: "Items: " + items + "\nName: " + (name || "") + "\nPhone: " + (phone || "") +
      "\nEmail: " + (email || "") + "\nDrop-off time: " + (dropTime || "—") +
      "\nCollection time: " + (collectTime || "—") + "\nPaid: " + total + "\nRef: " + ref + "\nSource: website",
    start: { date: start },
    end: { date: end },
  };
  await fetch("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Drop-off</td><td>' + esc(m.dropoff_date) + ' · ' + esc(m.dropoff_time) + '</td></tr>' +
    '<tr><td style="color:#777;padding:3px 12px 3px 0">Collection</td><td>' + esc(m.collection_time) + '</td></tr>' +
    '</table></div></div>';

  // add the paid booking to the shared Google Calendar (non-blocking)
  try {
    await addToCalendar({
      name: m.customer_name, items: m.items || "", phone: m.phone,
      email, total, ref, dropoff: m.dropoff_date,
      dropTime: m.dropoff_time, collectTime: m.collection_time,
    });
  } catch (e) { /* don't block emails if calendar fails */ }

  // bespoke confirmation for the CUSTOMER
  const firstName = (m.customer_name || "there").split(" ")[0];
  const custHtml =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;color:#16223f">' +
    '<div style="background:#21395E;color:#fff;padding:26px 24px;border-radius:12px 12px 0 0">' +
    '<div style="font-size:24px;font-weight:bold;letter-spacing:-.5px">Bags Away</div>' +
    '<div style="opacity:.85;font-size:14px;margin-top:2px">Luggage storage · K2 Gym, Newquay</div></div>' +
    '<div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">' +
    '<h1 style="font-size:22px;margin:0 0 6px;color:#21395E">You\'re booked in, ' + esc(firstName) + '! 🎉</h1>' +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 18px">Thanks for booking with Bags Away — your payment is confirmed. Here are your details:</p>' +
    '<div style="background:#F3EAD2;border-radius:12px;padding:16px 18px">' +
    '<div style="font-size:13px;color:#5d6b82;margin-bottom:8px">Booking ref <b style="color:#21395E;font-family:monospace">' + esc(ref) + '</b></div>' +
    '<ul style="font-size:15px;margin:0 0 10px;padding-left:18px">' + itemsHtml + '</ul>' +
    '<div style="font-size:15px"><b>Drop-off:</b> ' + esc(m.dropoff_date) + (m.dropoff_time ? ' at ' + esc(m.dropoff_time) : '') + '</div>' +
    '<div style="font-size:15px"><b>Collection time:</b> ' + esc(m.collection_time || "—") + '</div>' +
    '<div style="font-size:18px;font-weight:bold;color:#21395E;margin-top:8px">Total paid: ' + total + '</div></div>' +
    '<h3 style="font-size:16px;color:#21395E;margin:22px 0 6px">When you arrive</h3>' +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 16px">Bring your items to <b>K2 Gym, 27–29 Cliff Road, Newquay, TR7 2NE</b>. Reception will tag everything and hand you a matching tag — keep it for collection. Just show this email or your tag.</p>' +
    '<table style="font-size:14px;color:#3b4a63"><tr><td style="padding:2px 14px 2px 0;color:#777">Open</td><td>Mon–Fri 6am–9pm · Sat 6am–6pm · Sun 8am–4pm</td></tr>' +
    '<tr><td style="padding:2px 14px 2px 0;color:#777">Questions</td><td>Call or WhatsApp 07971 812567</td></tr></table>' +
    '<p style="font-size:14px;color:#5d6b82;margin-top:22px">Enjoy Newquay — hands free. 🏄<br>The Bags Away team</p>' +
    '</div></div>';

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { statusCode: 200, body: "Email not configured" };

  async function send(to, subject, body, replyTo) {
    return fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: replyTo || undefined, subject, html: body }),
    });
  }

  try {
    // 1. business alert to luggage@
    await send(TO, "New booking — " + (m.customer_name || "customer") + " (" + total + ")", html, email);
    // 2. bespoke confirmation to the customer
    if (email) await send(email, "Your Bags Away booking is confirmed ✓", custHtml, TO);
  } catch (e) {
    return { statusCode: 200, body: "Email send failed" };
  }
  return { statusCode: 200, body: "ok" };
}
