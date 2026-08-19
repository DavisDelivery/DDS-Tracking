// GET /g?rid=<clickRef> — send the customer to Google, and write down that they went.
//
// WHY. Until now the system said "✅ The customer was also routed to leave this review on
// Google" in an alert email and tagged the record routedTo:"google" — both of which fired
// on rating>=4 unconditionally, before the customer had done anything at all. They recorded
// an INTENT and were read as an OUTCOME. Chad, looking at a 5-star alert carrying that line
// next to a Google page whose newest review was two weeks old, asked the obvious question.
//
// This is the smallest honest fix: put one hop we control between the button and Google, so
// "they took the link" becomes a thing we OBSERVED rather than a thing we asserted.
//
// WHAT IT STILL CANNOT KNOW, and nothing downstream may pretend otherwise: whether a review
// was actually POSTED. That happens on google.com, signed in as the customer, and Google
// tells us nothing. The ceiling of this endpoint is "clicked through", and the dashboard
// and the emails are worded to stop exactly there.
//
// WHY A REF AND NOT THE REVIEW ID. The Google button is a plain anchor the customer taps,
// and the review POST rides alongside it fire-and-forget — so this request and the review
// often arrive in the same instant with no ordering between them, and the review is the
// slower of the two because it waits on NuVizz. Looking the review up here would therefore
// miss roughly the clicks that matter most. The ref is minted in the browser before either
// request leaves, the click is recorded against it unconditionally, and the two are joined
// when something reads them.
//
// THE REDIRECT IS UNCONDITIONAL. A customer who is trying to leave us five stars must never
// be blocked by our own bookkeeping, so every failure path below still ends in the 302: an
// unknown id, an unreachable blob store, a malformed record, a write that throws. The
// bookkeeping is best-effort; the hand-off is not.
const { GOOGLE_REVIEW_URL, clicksStore, cleanRef, normalizeSource, stampClick } = require("./lib/reviews");

exports.handler = async (event) => {
  const headers = {
    Location: GOOGLE_REVIEW_URL,
    // A tracking hop must not be cached, or the second click from the same device never
    // reaches us and the count silently under-reports.
    "Cache-Control": "no-store, no-cache, must-revalidate",
    // This URL goes in emails and gets crawled by link scanners; keep it out of indexes.
    "X-Robots-Tag": "noindex, nofollow",
  };

  const q = event.queryStringParameters || {};
  const ref = cleanRef(q.rid);

  // No ref, or a malformed one, is a legitimate call rather than an error — a bare /g means
  // "just take me to Google", which is what a page falls back to if it ever loses its ref.
  if (ref) {
    try {
      const store = clicksStore();
      const prev = await store.get(ref, { type: "json" });
      await store.setJSON(ref, stampClick(prev, new Date().toISOString(), {
        // Carried through so the dashboard can say which button produced a click even when
        // the review row is slow to land, or never lands at all.
        source: normalizeSource(q.src),
      }));
    } catch (err) {
      // Logged, never surfaced. The customer is mid-hand-off.
      console.error("google click stamp failed (non-fatal):", err && err.message);
    }
  }

  return { statusCode: 302, headers, body: "" };
};
