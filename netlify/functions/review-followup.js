// The scheduled entry point. Cadence lives in netlify.toml; every rule about who gets
// mailed lives in lib/followup-core.js and lib/reviews.js.
//
// THE GUARD BELOW IS NOT PARANOIA. An earlier draft of this file carried a comment saying
// "NOT REACHABLE OVER HTTP — Netlify scheduled functions refuse direct invocation, so there
// is no URL anyone can hit to blast the backlog", and then did no checking at all. That is
// the precise shape of the bug this whole change exists to fix: a confident sentence with
// no observation behind it, guarding something that matters. It is worse here, because the
// file is a top-level function and netlify.toml maps /api/* onto /.netlify/functions/:splat,
// so `/api/review-followup` is a URL that names it. If the platform assumption is ever
// wrong — or if the schedule silently unregisters because the table name in netlify.toml
// stops matching this filename — that URL mails real customers to anyone who finds it.
//
// So it fails CLOSED, and it says why. The refusal logs the header names it actually saw,
// because the point of the exercise is that nobody here has observed what a real scheduled
// invocation looks like: one glance at the function log after the first firing settles it
// permanently, instead of another sentence asserting it.
const { runFollowup } = require("./lib/followup-core");

// Any of these is good enough evidence that the scheduler called us. Several rather than
// one, because which signal Netlify sends is exactly the thing not verified.
function looksScheduled(event) {
  if (!event || typeof event !== "object") return true;   // invoked with no HTTP context
  const h = event.headers || {};
  const hv = (k) => String(h[k] || h[k.toLowerCase()] || "");
  if (hv("x-nf-event") === "schedule") return true;
  if (hv("user-agent").toLowerCase().includes("netlify")) return true;
  try {
    if (event.body && JSON.parse(event.body) && JSON.parse(event.body).next_run) return true;
  } catch { /* not the scheduler's payload */ }
  return false;
}

exports.handler = async (event) => {
  if (!looksScheduled(event)) {
    console.error(
      "review-followup: refused a non-scheduled invocation. Headers seen:",
      JSON.stringify(Object.keys((event && event.headers) || {})),
      "method:", event && event.httpMethod,
    );
    return {
      statusCode: 403,
      body: JSON.stringify({
        error: "This job runs on a schedule. Use /api/review-followup-run?key=… to inspect it.",
      }),
    };
  }
  const results = await runFollowup();
  return { statusCode: 200, body: JSON.stringify(results) };
};
