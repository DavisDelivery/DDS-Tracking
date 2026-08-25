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
// ── WHY THE LINK GOES STRAIGHT TO GOOGLE ────────────────────────────────────
// The first build routed this through our own /g hop so the click would be recorded. Chad, on
// reading it: "i want it to have a link straight to google they have already given a 5 star i
// don't want to link them back to my page." He is right about the thing that matters here. In
// a PLAIN-TEXT note there is no anchor text to hide a URL behind — the customer reads the URL
// itself, and a tracking.davisdelivery.com/g?rid=… line in a personal thank-you looks like
// being handed back to the machine that already emailed them once. The whole point of this
// note is that it is not that.
//
// THE COST, AND IT IS REAL, so it is written down rather than discovered later: lib/followup-
// core stands its automatic nudge down only when googleClickAt is stamped, and only the /g hop
// stamps it. A customer who takes THIS link stays invisible to that job, so they can still get
// the robot's nudge (2h-7d, REVIEW_FOLLOWUP_ENABLED defaults on) after Chad has already
// written to them personally — and both messages now say the same thing, because this note
// carries the same apology. The lever for that is REVIEW_FOLLOWUP_ENABLED=0, which is Chad's
// call, not a code change.
//
// ── THE APOLOGY SAYS "LOOKS LIKE", NOT "DID NOT" ────────────────────────────
// Chad: "also want to apologize that their review didn't make it to google". The reason it
// keeps happening is real and is documented in this repo — Google sends a signed-out visitor
// to accounts.google.com instead of a review box, and in an email client's in-app browser that
// is most of them. But this alert is sent the moment the customer hits Send, before anybody
// has clicked anything: the alert's own footer says so. So at the instant this note is
// written, whether the review reached Google is UNKNOWN, and asserting it did not is a claim
// about a stranger's behaviour we have not observed. It is hedged for that reason, and it also
// takes the blame off them, which is the version that gets a second attempt rather than a
// shrug. Chad can delete the sentence in two taps on the days the dashboard already shows the
// click.
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
function thanksBody({ driver, googleUrl }) {
  // JUST "Hi". Chad: "take out trying to name who just write hi." The name field on the review
  // form is whatever the customer typed, and it is often not a person — the five-star review
  // this was built from was signed "TOB", the company's initials. "Hi TOB," in a note the
  // owner is about to sign himself reads like a mail-merge that misfired, which is the one
  // thing this note is supposed not to be. A bare "Hi," is right every single time.
  const hi = "Hi,";
  const about = driver
    ? `Thank you for the kind words about ${driver} — I passed them straight on to him.`
    : `Thank you for taking the time to rate your delivery — it genuinely made someone's day here.`;
  return [
    hi,
    "",
    about,
    "",
    "I'm sorry — it looks like your review didn't make it through to Google. That's not on you: Google makes you sign in first, and it catches a lot of people out on a phone.",
    "",
    "If you still have a minute, this goes straight there:",
    "",
    googleUrl,
    "",
    "We're family-owned, and reviews are how new customers find us. Thank you either way.",
    "",
    "Chad Davis",
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

  // CLAMPED. The driver name is now the ONLY free text that reaches the note — the customer's
  // own name no longer appears anywhere in it — and it still arrives from a vendor lookup
  // rather than from us.
  //
  // WHAT THIS CLAMP ACTUALLY DOES, measured rather than assumed: it keeps the NORMAL note
  // readable. It is NOT what stops an absurd value producing an unopenable href — the over-cap
  // fallback below does that, and it does it whether or not this line exists. That was checked
  // by deleting the clamp and running it: the note falls back and the link survives. The
  // difference the clamp makes is that a 4,000-character driver name still yields the real
  // note instead of silently demoting every such delivery to the stripped one.
  const driver = firstName(r.driver).slice(0, 40);
  const subject = "Thank you from Davis Delivery";
  const body = thanksBody({ driver, googleUrl: link });

  const href = `mailto:${encodeURIComponent(to)}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
  // Over the cap, drop the pleasantries rather than the link: a note that arrives without its
  // Google URL is the one outcome this whole thing exists to prevent.
  if (href.length > MAILTO_MAX) {
    const short = ["Hi,", "", "Thank you for the review — it means a lot.", "", "It looks like it didn't make it through to Google. If you still have a minute, this goes straight there:", "", link, "", "Chad Davis", "Davis Delivery Service"].join("\n");
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
