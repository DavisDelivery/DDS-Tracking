const fetch = require("node-fetch");

// Resend's shared onboarding@resend.dev sender only delivers to the Resend
// account owner's address, and matches it case-sensitively — so normalize to
// lowercase (a capital-C "Chad@..." was being rejected with HTTP 403, which is
// why no alert emails were going out). To email recipients other than the
// owner, verify a domain at resend.com/domains and set REVIEW_FROM to an
// address on that domain.
const REVIEW_EMAIL = (process.env.REVIEW_EMAIL || "chad@davisdelivery.com").trim().toLowerCase();
const MAIL_FROM = process.env.REVIEW_FROM || "Davis Delivery Alerts <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// NuVizz credentials — same env vars track.js uses. Reviews carry only a PRO,
// so we resolve the delivering driver from NuVizz once (at submit time) and
// store it on the review. Every reader (admin dashboard, MarginIQ Reviews tab,
// Driver Scorecard Reviews tab) then gets per-driver attribution for free.
const DAVIS_USER = process.env.NUVIZZ_DAVIS_USER || "Chad";
const DAVIS_PASS = process.env.NUVIZZ_DAVIS_PASS;
const ULINE_USER = process.env.NUVIZZ_ULINE_USER || "Chad";
const ULINE_PASS = process.env.NUVIZZ_ULINE_PASS;
const NUVIZZ_BASE = "https://portal.nuvizz.com/deliverit/openapi/v7";

// Pull the first present value across a set of candidate key paths. NuVizz
// surfaces the driver under different keys depending on load vs stop payload,
// so we probe several rather than hard-coding one that may be absent.
function firstVal(obj, paths) {
  if (!obj) return "";
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Resolve { driver, driverId } for a PRO via NuVizz. Best-effort: returns empty
// strings (never throws) so a NuVizz hiccup never blocks a review submission.
async function resolveDriver(rawPro) {
  const trimmed = (rawPro || "").trim().toUpperCase();
  if (!trimmed || !DAVIS_PASS) return { driver: "", driverId: "" };

  let candidates;
  if (/^\d+$/.test(trimmed)) {
    const padded = trimmed.padStart(9, "0");
    candidates = padded === trimmed ? [trimmed] : [padded, trimmed];
  } else if (/^[A-Z0-9]+$/.test(trimmed)) {
    candidates = [trimmed];
  } else {
    return { driver: "", driverId: "" };
  }

  const davisAuth = "Basic " + Buffer.from(`${DAVIS_USER}:${DAVIS_PASS}`).toString("base64");

  try {
    let stopData = null;
    let load = null;
    for (const cand of candidates) {
      const r = await fetch(`${NUVIZZ_BASE}/stop/info/${cand}/DAVIS`, {
        headers: { Authorization: davisAuth },
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.Stop && j.Stop.stop) {
          stopData = j.Stop;
          load = j.Stop.load || null;
          break;
        }
      }
    }
    if (!stopData) return { driver: "", driverId: "" };

    // Try the stop-level execution info first.
    const exe = stopData.stopExecutionInfo || {};
    let driver = firstVal(exe, ["driverName", "driver.driverName", "driver.name", "assignedDriver"]);
    let driverId = firstVal(exe, ["driverId", "driver.driverId", "driver.id"]);

    // Fall back to the load — the assigned driver lives on the route header.
    if ((!driver || !driverId) && load && load.loadNbr) {
      const r = await fetch(`${NUVIZZ_BASE}/load/info/${load.loadNbr}/DAVIS`, {
        headers: { Authorization: davisAuth },
      });
      if (r.ok) {
        const ld = await r.json();
        const L = (ld && ld.Load) || {};
        const lexe = L.loadExecutionInfo || {};
        driver = driver || firstVal(L, ["driverName", "driver.driverName", "driver.name"]) ||
          firstVal(lexe, ["driverName", "driver.driverName", "driver.name", "assignedDriver"]);
        driverId = driverId || firstVal(L, ["driverId", "driver.driverId", "driver.id"]) ||
          firstVal(lexe, ["driverId", "driver.driverId", "driver.id"]);
      }
    }
    return { driver: driver || "", driverId: driverId || "" };
  } catch (err) {
    console.log("resolveDriver error (non-fatal):", err.message);
    return { driver: "", driverId: "" };
  }
}

function reviewsStore() {
  const { getStore } = require("@netlify/blobs");
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: "reviews", siteID, token, consistency: "strong" });
  }
  return getStore({ name: "reviews", consistency: "strong" });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // GET = fetch reviews for the dashboards
  if (event.httpMethod === "GET") {
    const pwd = (event.queryStringParameters || {}).key;
    if (pwd !== (process.env.DASHBOARD_KEY || "davis2026")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    try {
      const store = reviewsStore();
      const list = await store.list();
      const reviews = [];
      for (const blob of list.blobs) {
        const data = await store.get(blob.key, { type: "json" });
        if (data) reviews.push(data);
      }

      // Lazy backfill: attribute any review that predates driver capture (or
      // whose earlier lookup failed). Bounded per request so a big backlog
      // can't time the function out — the rest fill in on subsequent loads.
      const backfillCap = 8;
      let backfilled = 0;
      for (const rv of reviews) {
        if (backfilled >= backfillCap) break;
        if (rv.driverResolved) continue;
        if (!rv.proNumber) { rv.driver = rv.driver || ""; rv.driverResolved = true; continue; }
        const { driver, driverId } = await resolveDriver(rv.proNumber);
        rv.driver = driver;
        rv.driverId = driverId;
        rv.driverResolved = true;
        try { await store.setJSON(rv.id, rv); } catch (e) { /* non-fatal */ }
        backfilled++;
      }

      reviews.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return { statusCode: 200, headers, body: JSON.stringify({ reviews, backfilled }) };
    } catch (err) {
      console.error("Fetch reviews error:", err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Fetch failed", detail: err.message }) };
    }
  }

  // POST = submit a review
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { rating, comment, name, contact, proNumber } = payload;

  if (!rating || rating < 1 || rating > 5) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid rating" }) };
  }

  const proClean = (proNumber || "").trim().slice(0, 50);

  // Resolve the delivering driver up front so every reader is attributed.
  const { driver, driverId } = await resolveDriver(proClean);

  const review = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    rating: Number(rating),
    comment: (comment || "").trim().slice(0, 2000),
    name: (name || "").trim().slice(0, 100),
    contact: (contact || "").trim().slice(0, 200),
    proNumber: proClean,
    driver: driver || "",
    driverId: driverId || "",
    driverResolved: true,
    submittedAt: new Date().toISOString(),
    routedTo: rating >= 4 ? "google" : "internal",
  };

  // Store in Netlify Blobs
  try {
    const store = reviewsStore();
    await store.setJSON(review.id, review);
  } catch (err) {
    console.error("Blob storage error:", err);
  }

  // Email if rating is 3 or below
  if (rating <= 3 && RESEND_API_KEY) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: REVIEW_EMAIL,
          reply_to: REVIEW_EMAIL,
          subject: `⚠️ ${rating}-Star Review — PRO# ${review.proNumber || "Unknown"}`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <div style="background:linear-gradient(135deg,#0a2744,#1e5b92);color:#fff;padding:20px;border-radius:8px;margin-bottom:16px">
                <h1 style="margin:0;font-size:20px">⚠️ Low Rating Alert</h1>
                <div style="font-size:13px;opacity:.8;margin-top:4px">Davis Delivery Tracking Portal</div>
              </div>
              <div style="background:#fff;padding:20px;border:1px solid #dde2e8;border-radius:8px">
                <div style="font-size:28px;color:#e8a838;letter-spacing:3px;margin-bottom:12px">${"★".repeat(rating)}<span style="color:#dde2e8">${"★".repeat(5 - rating)}</span></div>
                <p style="margin:6px 0"><strong>PRO #:</strong> ${review.proNumber || "Not provided"}</p>
                <p style="margin:6px 0"><strong>Driver:</strong> ${review.driver || "Unattributed"}</p>
                <p style="margin:6px 0"><strong>Name:</strong> ${review.name || "Anonymous"}</p>
                <p style="margin:6px 0"><strong>Contact:</strong> ${review.contact || "Not provided"}</p>
                ${review.comment ? `<div style="background:#fef5f5;padding:16px;border-left:4px solid #d63b3b;margin:16px 0;border-radius:4px"><strong>What they said:</strong><br>${review.comment.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>` : ''}
                <p style="color:#666;font-size:12px;margin-top:16px;padding-top:16px;border-top:1px solid #f0f2f5">Submitted ${new Date(review.submittedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} EST</p>
                <p style="color:#666;font-size:12px;margin:4px 0">🔒 This review was captured internally and was NOT sent to Google.</p>
                <p style="color:#666;font-size:12px;margin:4px 0">📊 <a href="https://davisdeliverytracking.netlify.app/admin" style="color:#1e5b92">View full dashboard</a></p>
              </div>
            </div>
          `,
        }),
      });
      const emailResult = await emailRes.json();
      if (!emailRes.ok) {
        console.error("Resend API error:", emailResult);
      }
    } catch (err) {
      console.error("Email send error:", err);
    }
  }

  const googleReviewUrl = "https://g.page/r/CcBkxtEUiFOGEAE/review";

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      routedTo: review.routedTo,
      googleUrl: rating >= 4 ? googleReviewUrl : null,
    }),
  };
};
