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
// Lazy, and global-first. Requiring node-fetch at module load makes this file unloadable
// anywhere the dependency is not installed — which is every test run, and the reason the
// send rules could not be exercised until now. Netlify's runtime has had a global fetch for
// years; node-fetch stays only as the fallback the rest of this repo still assumes.
function httpFetch(...args) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(...args);
  return require("node-fetch")(...args);
}
const {
  reviewsStore, clicksStore, withClicks, followupEligible, trackedGoogleUrl,
} = require("./reviews");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// NO DEFAULT SENDER, deliberately. review.js falls back to Resend's shared
// onboarding@resend.dev, which only ever delivers to the Resend account owner's address —
// fine for an alert TO Chad, catastrophic here, because this mails CUSTOMERS.
//
// With that fallback every send would be rejected, and the catch below deliberately keeps
// the claim, so each eligible customer would be marked permanently un-nudgeable and the
// entire backlog would be consumed one record per run with nothing but a console line to
// show for it. Refusing to run is the only safe behaviour when the sender is unset.
// REVIEW_FROM on this site is currently "Davis Delivery Alerts
// <alerts@warehouse.davisdelivery.com>" — a verified sender, so this job can genuinely send,
// which is the only thing that was actually blocking. But it is an INTERNAL-alerts identity:
// a customer who gets "Davis Delivery Alerts" from a warehouse.* subdomain asking them to
// post a review reads it as machinery, and mailbox providers score an alerts subdomain
// differently from the one that already talks to customers.
//
// So this job takes an override and falls back. Set REVIEW_FOLLOWUP_FROM to a customer-
// facing sender on the verified domain and nothing else changes; leave it unset and the job
// still works, just signed as the alert robot.
const MAIL_FROM = process.env.REVIEW_FOLLOWUP_FROM || process.env.REVIEW_FROM || "";
// Where an unsubscribe or a reply lands. A real human address, because the email invites a
// reply ("if you'd rather not, that's completely fine").
const REPLY_TO = (process.env.REVIEW_EMAIL || "chad@davisdelivery.com").trim().toLowerCase();
const SITE_ORIGIN = (process.env.REVIEW_SITE_ORIGIN || "https://tracking.davisdelivery.com").replace(/\/+$/, "");

// ON. Chad, after being shown the review-gating exposure below: "turn it on i'll take my
// chances." His call, made with the risk in front of him, so it is the default now — and
// REVIEW_FOLLOWUP_ENABLED=0 still switches it off from the Netlify UI without a deploy.
//
// THE RISK HE ACCEPTED, recorded here because whoever reads this next will not have been in
// the conversation: sending a "please post this on Google" nudge ONLY to 4-5 star raters is
// review gating. Google's policies prohibit soliciting reviews selectively from customers
// you already know are happy, and the penalty lands on the listing rather than on the code.
// The portal has done a soft version of this for as long as it routed 4-5 stars out and 1-3
// stars inward; a scheduled mailer that only ever writes to happy customers turns that from
// a momentary page behaviour into a documented, repeating pattern.
//
// If it ever needs undoing, the fix is not to delete this job — it is to offer the Google
// link to everyone and give unhappy customers a prominent "let us fix this first" path
// first. That removes the exposure, and since most raters are happy anyway it barely
// changes what actually gets posted.
const ENABLED = String(process.env.REVIEW_FOLLOWUP_ENABLED ?? "1") !== "0";

// Bounds, not targets. PER_RUN keeps one invocation inside its time limit; PER_DAY is the
// blast radius if the eligibility rules are ever loosened by someone in a hurry.
const PER_RUN = 10;
const PER_DAY = 60;

// Reading the store is the part that can blow the 30s budget, not the sending. Bounded
// rather than unbounded Promise.all so a big store cannot open hundreds of sockets at once.
const SCAN_CAP = 400;
const READ_CONCURRENCY = 12;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// Eastern, not UTC. Slicing an ISO string rolls the day over at 8pm local, so a busy
// evening could send PER_DAY twice inside one day as Chad counts days. Everything else
// customer-facing in this codebase is already America/New_York.
function dayKey(nowMs) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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
      <p style="margin:0 0 6px;color:#5a6779;font-size:13px">Takes about 30 seconds. If you'd rather not, that's completely fine — this is the only time we'll ask.</p>
      <p style="margin:18px 0 0;color:#97a3b3;font-size:12px">Davis Delivery Service Inc. — Buford, Georgia · (678) 926-3939</p>
    </div>
  `;
}

// dryRun lists exactly who WOULD be mailed and sends nothing. It exists because a
// scheduled function cannot be invoked by URL (Netlify returns 404), so without it the only
// way to find out what this job does is to let it mail real customers and read the log
// afterwards. Given that the whole point of this change is to stop asserting things nobody
// checked, shipping an unverifiable mailer would have been a poor joke.
async function runFollowup({ dryRun = false } = {}) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!ENABLED && !dryRun) return { skipped: "disabled" };
  if (!RESEND_API_KEY && !dryRun) return { skipped: "no RESEND_API_KEY" };
  // See MAIL_FROM. A run without a verified sender does not fail loudly — it burns the
  // backlog quietly — so it must not start.
  if (!MAIL_FROM && !dryRun) return { skipped: "REVIEW_FROM is not set (refusing to claim records that could not be mailed)" };

  const store = reviewsStore();
  const clicks = clicksStore();

  // Read the reviews, then join the clicks on. NOTE: this goes straight to the blob store
  // and NOT through review.js's GET — that handler runs a lazy NuVizz driver backfill, and
  // an hourly cron quietly calling a vendor API is exactly the kind of cost nobody notices
  // until the bill.
  const list = await store.list();
  // Newest first, then capped. A scheduled function gets THIRTY SECONDS, and this loop is
  // one blob read per record — sequential reads over a store that only ever grows is a job
  // that works fine for a year and then starts timing out silently. Nothing older than
  // FOLLOWUP_MAX_AGE_MS can be eligible anyway, so reading the whole history buys nothing.
  const keys = list.blobs.map((b) => b.key).sort().reverse().slice(0, SCAN_CAP);
  const raw = (await mapLimit(keys, READ_CONCURRENCY, async (key) => {
    try { return await store.get(key, { type: "json" }); } catch { return null; }
  })).filter(Boolean);

  const refs = [...new Set(raw.map((r) => r && r.clickRef).filter(Boolean))];
  const clicksByRef = {};
  for (const [ref, hit] of await mapLimit(refs, READ_CONCURRENCY, async (ref) => {
    try { return [ref, await clicks.get(ref, { type: "json" })]; } catch { return [ref, null]; }
  })) {
    if (hit) clicksByRef[ref] = hit;
  }

  const joined = withClicks(raw, clicksByRef);
  const sentToday = joined.filter((r) => r.followupSentAt && r.followupSentAt.slice(0, 10) === dayKey(nowMs)).length;
  const budget = Math.max(0, Math.min(PER_RUN, PER_DAY - sentToday));

  // ONE PER PERSON, not one per review. followupEligible keys on the review id, so a
  // customer with three deliveries in a week who rates all three and clicks none would get
  // three separate "would you share that on Google?" emails — while the body promises "you
  // won't hear from us about this again". True per review, false per person, and the person
  // is the one reading it.
  //
  // Anyone already mailed at this address, EVER, is out; so is a second review from the
  // same address inside one run. Oldest first, so the person hears about the delivery they
  // are least likely to still remember rather than the one they just rated.
  const mailedAddresses = new Set(
    joined.filter((r) => r.followupSentAt && r.contact)
      .map((r) => String(r.contact).trim().toLowerCase()),
  );

  const due = [];
  const claimedThisRun = new Set();
  for (const r of joined
    .filter((x) => followupEligible(x, nowMs))
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) {
    const addr = String(r.contact).trim().toLowerCase();
    if (mailedAddresses.has(addr) || claimedThisRun.has(addr)) continue;
    claimedThisRun.add(addr);
    due.push(r);
    if (due.length >= budget) break;
  }

  const results = {
    considered: joined.length, eligible: due.length, sent: 0, failed: 0, sentToday, budget,
    enabled: ENABLED, resendConfigured: !!RESEND_API_KEY, dryRun,
    scanned: keys.length, scanCapped: list.blobs.length > SCAN_CAP,
  };

  if (dryRun) {
    // Enough to judge the rule, and no more: no comment text, and the address is masked.
    results.wouldSend = due.map((r) => ({
      id: r.id, rating: r.rating, pro: r.proNumber || null, submittedAt: r.submittedAt,
      source: r.source || null,
      contact: String(r.contact || "").replace(/^(.).*(@.*)$/, "$1***$2"),
    }));
    return results;
  }

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
      const res = await httpFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: String(fresh.contact).trim(),
          // An unsolicited "would you post a review?" is promotional in shape whatever its
          // intent, and a promotional mail with no unsubscribe affordance is what mailbox
          // providers score as spam. mailto: rather than a URL because this repo has no
          // preference centre to point at, and inventing a dead link would be worse.
          headers: {
            "List-Unsubscribe": `<mailto:${REPLY_TO}?subject=unsubscribe>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          reply_to: REPLY_TO,
          subject: "Thanks again — would you share that on Google?",
          html: body(fresh, trackedGoogleUrl(fresh.clickRef, SITE_ORIGIN, "review-followup")),
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
  return results;
}

module.exports = { runFollowup, mapLimit, PER_RUN, PER_DAY, SCAN_CAP, READ_CONCURRENCY };
