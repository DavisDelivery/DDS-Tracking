// The owner's own thank-you, prepared as a ready-to-send email. PURE: builds a string and
// sends nothing.
//
// Chad, holding a five-star alert on his phone: "I now want to be able to click on this
// customers email and sent them directly an email thanking them and providing a link
// directly to my Google reviews to see if I can push them to give me a review."
//
// ── WHY A mailto: AND NOT A SEND BUTTON ─────────────────────────────────────
// The obvious build is a button that posts to a function and sends through Resend. It is the
// wrong one. A customer who has just written "Trey was awesome!!!" by name gets, in reply,
// another template from a robot — which is exactly the thing they were being warm about not
// getting. A mailto opens Chad's own compose window with the note already written: it leaves
// from HIS mailbox, their reply comes back to HIM, and he can change a line before it goes,
// which matters because a gushing review and a bare five stars do not deserve the same note.
// It also keeps this entirely outside the sending domain, the daily cap and the suppression
// list, because a one-to-one message a person types and sends is not a mailing.
//
// ── WHY THE TRACKED LINK AND NOT g.page DIRECTLY ────────────────────────────
// This repo already mails a 4-5★ customer a nudge when the click hop never saw them
// (lib/followup-core), and REVIEW_FOLLOWUP_ENABLED defaults to ON. Put the raw g.page URL in
// Chad's note and a customer who takes it is still invisible to that job — so the robot
// writes to somebody Chad has already asked personally, saying "this is the only time we'll
// ask", which by then is false. Routing his ask through the same /g hop means a click stamps
// the record, followupEligible sees googleClickAt and stands down, and the two never
// collide. It also answers a question nobody can answer today: do Chad's personal notes
// actually produce reviews? They carry their own source, so the dashboard can say.
//
// ── WHY IT REFUSES A PHONE NUMBER ───────────────────────────────────────────
// The contact field on the review form collects "email or phone" and people use both — the
// alert in Chad's hand had a gmail address, but 7702428585 is just as likely. mailto: does
// not care: it will happily open a compose window addressed to a phone number, which looks
// like it worked and goes nowhere. So the link only appears when there is a real address to
// write to, and the same isEmailAddress the follow-up job gates on decides that, rather than
// a second opinion written here that could drift from it.

const { isEmailAddress } = require("./reviews");

// Clients truncate long mailto hrefs, and a truncated one loses the END of the body — which
// is where the Google link sits. Kept well under the ~2000 chars where the shortest clients
// start cutting; the note is deliberately short anyway, because a long one does not get read.
const MAILTO_MAX = 1800;

/**
 * firstName("TREVARR HOWARD") → "Trevarr".
 *
 * Driver names arrive SHOUTING from the dispatch system, and "thank you for the kind words
 * about TREVARR" reads like a summons. Only the first token is used: the customer met one
 * person for four minutes and knows him by his first name.
 */
function firstName(full) {
  const first = String(full == null ? "" : full).trim().split(/\s+/)[0] || "";
  if (!first) return "";
  // Leave names that are already mixed-case alone — "McKay" must not become "Mckay".
  if (/[a-z]/.test(first)) return first;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** The note itself, as plain text. Plain because a mailto body cannot be anything else. */
function thanksBody({ name, driver, googleUrl }) {
  // Their name is used EXACTLY as they typed it, not re-cased — same as the follow-up mailer
  // does. Someone who signs "TOB" gets "Hi TOB"; title-casing it to "Tob" invents a person.
  const hi = name ? `Hi ${name},` : "Hi there,";
  const about = driver
    ? `Thank you for the kind words about ${driver} — I passed them straight on to him.`
    : `Thank you for taking the time to rate your delivery — it genuinely made someone's day here.`;
  return [
    hi,
    "",
    about,
    "",
    "If you have thirty seconds, would you mind saying the same on Google? We're family-owned, and reviews are how new customers find us:",
    "",
    googleUrl,
    "",
    "Thanks again,",
    "Chad Blyth",
    "Davis Delivery Service",
  ].join("\n");
}

/**
 * ownerThanksMailto({ review, googleUrl }) → { to, subject, body, href } | null
 *
 * null means there is nothing to offer — no address to write to, or no link to send them —
 * and the caller must then render the contact as plain text. Returning a half-built mailto
 * would put a dead link in the one email Chad actually acts on.
 */
function ownerThanksMailto({ review, googleUrl } = {}) {
  const r = review && typeof review === "object" ? review : {};
  const to = String(r.contact == null ? "" : r.contact).trim();
  if (!isEmailAddress(to)) return null;
  const link = String(googleUrl == null ? "" : googleUrl).trim();
  if (!link) return null;                       // a thank-you with no link is not this feature

  // CLAMPED, because these are free-text fields a stranger filled in. The first build let
  // them through at full length and relied on the over-cap fallback below to save it — but
  // that fallback greets them by name too, so a 4,000-character "name" blew straight through
  // both and produced an href no mail client would open. Caught by the length test, which is
  // the only reason this comment is here rather than a bug in Chad's inbox. Sixty characters
  // is longer than any real name and shorter than anything that could crowd out the link.
  const name = String(r.name == null ? "" : r.name).trim().slice(0, 60);
  const driver = firstName(r.driver).slice(0, 40);
  const subject = "Thank you from Davis Delivery";
  const body = thanksBody({ name, driver, googleUrl: link });

  const href = `mailto:${encodeURIComponent(to)}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
  // Over the cap, drop the pleasantries rather than the link: a note that arrives without its
  // Google URL is the one outcome this whole thing exists to prevent.
  if (href.length > MAILTO_MAX) {
    const short = [name ? `Hi ${name},` : "Hi there,", "", "Thank you for the review — it means a lot.", "", link, "", "Chad Blyth", "Davis Delivery Service"].join("\n");
    const shortHref = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
    return { to, subject, body: short, href: shortHref };
  }
  return { to, subject, body, href };
}

/**
 * The href as it goes into an HTML attribute. encodeURIComponent never emits < > or ", so the
 * only character needing HTML treatment is the & separating the mailto's own parameters —
 * and a raw & in an attribute is what turns ?subject=…&body=… into a mailto with no body in
 * the stricter clients.
 */
function mailtoAttr(href) {
  return String(href == null ? "" : href).replace(/&/g, "&amp;");
}

module.exports = { ownerThanksMailto, mailtoAttr, firstName, thanksBody, MAILTO_MAX };
