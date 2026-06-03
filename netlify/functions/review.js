const fetch = require("node-fetch");

const REVIEW_EMAIL = process.env.REVIEW_EMAIL || "Chad@davisdelivery.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

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

  // GET = fetch reviews from the dashboard
  if (event.httpMethod === "GET") {
    const pwd = (event.queryStringParameters || {}).key;
    if (pwd !== (process.env.DASHBOARD_KEY || "davis2026")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    try {
      const { getStore } = require("@netlify/blobs");
      const store = getStore("reviews");
      const list = await store.list();
      const reviews = [];
      for (const blob of list.blobs) {
        const data = await store.get(blob.key, { type: "json" });
        if (data) reviews.push(data);
      }
      reviews.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return { statusCode: 200, headers, body: JSON.stringify({ reviews }) };
    } catch (err) {
      console.error("Fetch reviews error:", err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Fetch failed" }) };
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

  const review = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    rating: Number(rating),
    comment: (comment || "").trim().slice(0, 2000),
    name: (name || "").trim().slice(0, 100),
    contact: (contact || "").trim().slice(0, 200),
    proNumber: (proNumber || "").trim().slice(0, 50),
    submittedAt: new Date().toISOString(),
    routedTo: rating >= 4 ? "google" : "internal",
  };

  // Store in Netlify Blobs
  try {
    const { getStore } = require("@netlify/blobs");
    const store = getStore("reviews");
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
          from: "Davis Delivery Alerts <onboarding@resend.dev>",
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
