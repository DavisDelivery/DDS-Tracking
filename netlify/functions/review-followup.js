// Scheduled: one polite nudge to a 4-5 star customer who never reached Google.
//
// WHY IT EXISTS. Google's review page sends a signed-out visitor to accounts.google.com
// rather than to a review box. A good share of customers meet that wall on a phone, in an
// email client's in-app browser where they are not signed in, and quietly give up. They
// meant to leave the review. Nothing about the delivery went wrong. The only thing missing
// is a second chance at a moment when they are not standing next to a truck.
//
// THIS MAILS REAL CUSTOMERS, so every rule below is a reason NOT to send, and the send is
// claimed before it is attempted:
//
//   • rating >= 4 only — a nudge to post publicly is the worst thing to send someone who
//     just told us we did badly
//   • only if they typed an actual email address (the field also collects phone numbers)
//   • only if the click hop never saw them (see lib/reviews followupEligible)
//   • only if the record carries a clickRef, i.e. was written after click tracking existed
//     — otherwise "you haven't posted yet" goes to people who already did
//   • at least 2 hours old, at most 7 days old
//   • once, ever, per review
//   • capped per run and per day
//
// CLAIM BEFORE SEND, deliberately. The claim is written first, so a send that throws
// half-way keeps its claim and is never retried. One customer missing a nudge is a
// non-event; one customer getting the same nudge on every scheduled run is the kind of
// thing that ends with an unsubscribe complaint.
//
// NOT REACHABLE OVER HTTP. Netlify scheduled functions refuse direct invocation, which is
// deliberate — there is no URL anyone can hit to blast the backlog.
const fetch = require("node-fetch");
const {
  reviewsStore, clicksStore, withClicks, followupEligible, trackedGoogleUrl,
} = require("./lib/reviews");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.REVIEW_FROM || "Davis Delivery <onboarding@resend.dev>";
const SITE_ORIGIN = (process.env.REVIEW_SITE_ORIGIN || "https://tracking.davisdelivery.com").replace(/\/+$/, "");

// The kill switch. Set REVIEW_FOLLOWUP_ENABLED=0 on the Netlify site to stop every send
// without a deploy.
const ENABLED = String(process.env.REVIEW_FOLLOWUP_ENABLED ?? "1") !== "0";

// Bounds, not targets. PER_RUN keeps one invocation inside its time limit; PER_DAY is the
// blast radius if the eligibility rules are ever loosened by someone in a hurry.
const PER_RUN = 15;
const PER_DAY = 60;

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function body(review, googleUrl) {
  const name = String(review.name || "").trim();
  const hi = name ? `Hi ${name.replace(/</g, "&lt;")},` : "Hi there,";
  const stars = "★".repeat(Number(review.rating) || 5);
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1f2937">
      <div style="background:linear-gradient(135deg,#0a2744,#1e5b92);color:#fff;padding:22px;border-radius:8px;margin-bottom:18px">
        <div style="font-size:19px;font-weight:700">Thank you for the ${stars}</div>
        <div style="font-size:13px;opacity:.8;margin-top:4px">Davis Delivery Service</div>
      </div>
      <p style="margin:0 0 12px">${hi}</p>
      <p style="margin:0 0 12px">You rated your recent delivery${review.proNumber ? ` (PRO# ${String(review.proNumber).replace(/</g, "&lt;")})` : ""} and we wanted to say thank you — it genuinely made someone's day here.</p>
      <p style="margin:0 0 18px">If you have half a minute, would you say it on Google too? We're family-owned, and reviews are how new customers find us. Google will ask you to sign in first, which is the bit that trips most people up on a phone.</p>
      <p style="margin:0 0 18px;text-align:center">
        <a href="${googleUrl}" style="display:inline-block;background:#1e5b92;color:#fff;padding:14px 30px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px">Post it on Google</a>
      </p>
      <p style="margin:0 0 6px;color:#5a6779;font-size:13px">Takes about 30 seconds. If you'd rather not, that's completely fine — you won't hear from us about this again.</p>
      <p style="margin:18px 0 0;color:#97a3b3;font-size:12px">Davis Delivery Service Inc. — Buford, Georgia · (678) 926-3939</p>
    </div>
  `;
}

exports.handler = async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!ENABLED) return { statusCode: 200, body: JSON.stringify({ skipped: "disabled" }) };
  if (!RESEND_API_KEY) return { statusCode: 200, body: JSON.stringify({ skipped: "no RESEND_API_KEY" }) };

  const store = reviewsStore();
  const clicks = clicksStore();

  // Read the reviews, then join the clicks on. NOTE: this goes straight to the blob store
  // and NOT through review.js's GET — that handler runs a lazy NuVizz driver backfill, and
  // an hourly cron quietly calling a vendor API is exactly the kind of cost nobody notices
  // until the bill.
  const list = await store.list();
  const raw = [];
  for (const blob of list.blobs) {
    try {
      const data = await store.get(blob.key, { type: "json" });
      if (data) raw.push(data);
    } catch { /* one unreadable record must not stop the run */ }
  }

  const clicksByRef = {};
  for (const ref of [...new Set(raw.map((r) => r && r.clickRef).filter(Boolean))]) {
    try {
      const hit = await clicks.get(ref, { type: "json" });
      if (hit) clicksByRef[ref] = hit;
    } catch { /* treat an unreadable click as absent */ }
  }

  const joined = withClicks(raw, clicksByRef);
  const sentToday = joined.filter((r) => r.followupSentAt && r.followupSentAt.slice(0, 10) === dayKey(nowMs)).length;
  const budget = Math.max(0, Math.min(PER_RUN, PER_DAY - sentToday));

  const due = joined
    .filter((r) => followupEligible(r, nowMs))
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))
    .slice(0, budget);

  const results = { considered: joined.length, eligible: due.length, sent: 0, failed: 0, sentToday, budget };

  for (const review of due) {
    // Re-read immediately before claiming. list() is a snapshot, and a concurrent run (or a
    // retry of this one) may already have claimed this record.
    let fresh;
    try { fresh = await store.get(review.id, { type: "json" }); } catch { continue; }
    if (!fresh || fresh.followupClaimedAt || fresh.followupSentAt) continue;

    try {
      await store.setJSON(review.id, { ...fresh, followupClaimedAt: nowIso });
    } catch {
      continue; // could not claim it — leave it for the next run rather than risk a double
    }

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: String(fresh.contact).trim(),
          subject: "Thanks again — would you share that on Google?",
          html: body(fresh, trackedGoogleUrl(fresh.clickRef, SITE_ORIGIN) + "&src=review-followup"),
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}`);
      await store.setJSON(review.id, { ...fresh, followupClaimedAt: nowIso, followupSentAt: nowIso });
      results.sent++;
    } catch (err) {
      // The claim STAYS. See the header: a nudge missed is nothing; a nudge repeated is a
      // complaint. The claim is the record that we already tried.
      results.failed++;
      console.error("followup send failed for", review.id, err && err.message);
    }
  }

  console.log("review-followup:", JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
};
