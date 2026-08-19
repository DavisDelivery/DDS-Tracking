// GET /api/review-followup-run?key=<dashboard key>[&send=1] — look at the follow-up job.
//
// WHY THIS EXISTS. Its scheduled twin cannot be reached by URL (Netlify 404s a direct hit
// on a scheduled function) and only runs on published production deploys. Without this,
// the only way to learn what the mailer does would be to let it mail real customers and
// read the log afterwards — which, in a change whose entire subject is a system asserting
// outcomes nobody verified, would be a poor joke.
//
// DEFAULTS TO A DRY RUN. It reports exactly who WOULD be mailed and sends nothing. Adding
// &send=1 performs the real run, under the same caps and the same claim-before-send rule as
// the schedule. Key-gated on DASHBOARD_KEY, the same secret review.js already requires for
// its GET and DELETE.
const { runFollowup } = require("./lib/followup-core");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "X-Robots-Tag": "noindex, nofollow" };
  const q = event.queryStringParameters || {};

  if (q.key !== (process.env.DASHBOARD_KEY || "davis2026")) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  // Opt IN to sending. A key holder who mistypes the query string gets a report, not a
  // batch of emails to customers.
  const dryRun = q.send !== "1";

  try {
    return { statusCode: 200, headers, body: JSON.stringify(await runFollowup({ dryRun })) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message) }) };
  }
};
