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
const { GOOGLE_REVIEW_URL, clicksStore, cleanRef, normalizeSource, stampClick, clientKind, CLIENT_MAX } = require("./lib/reviews");

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

  // IS THIS A PERSON, OR A MAIL SCANNER?
  //
  // This URL goes in a follow-up email, and corporate mail filters and link-preview bots
  // fetch every link they see. Counting those as clicks would inflate the exact number this
  // whole change exists to make honest — the dashboard would say "Went to Google" about
  // someone who never opened the message.
  //
  // Fetch metadata is the cheap signal: a real top-level navigation from a tap sends
  // Sec-Fetch-Mode: navigate and Sec-Fetch-Dest: document. Scanners generally send neither.
  // It is a heuristic, not proof, so nothing is DISCARDED — a probe is recorded as a probe
  // and kept out of the headline number, which is the honest way to hold a guess.
  const h = event.headers || {};
  const hv = (k) => String(h[k] || h[k.toLowerCase()] || "").toLowerCase();
  const navigational = hv("sec-fetch-mode") === "navigate" || hv("sec-fetch-dest") === "document";

  // WHAT THEY TAPPED IT IN, because "why did only half of them post" cannot be answered
  // without it. See clientKind in lib/reviews for the three competing explanations and why
  // only one of them predicts a pattern here. The raw string is kept beside the verdict so
  // the bucket can be checked against the original rather than believed.
  //
  // Deliberately NOT hashed or anonymised further: it is a browser string, it is already
  // sent to every site the customer visits, and a truncated one that cannot be re-read is a
  // measurement nobody can audit. Capped so a pathological UA cannot bloat the record.
  const rawUA = String(h["user-agent"] || h["User-Agent"] || "");
  const ua = rawUA.slice(0, CLIENT_MAX);

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
        client: clientKind(ua),
        ua: ua,
      }, navigational));
    } catch (err) {
      // Logged, never surfaced. The customer is mid-hand-off.
      console.error("google click stamp failed (non-fatal):", err && err.message);
    }
  }

  return { statusCode: 302, headers, body: "" };
};
