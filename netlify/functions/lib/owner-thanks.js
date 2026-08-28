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

/**
 * The note itself, as plain text. Plain because a mailto body cannot be anything else.
 *
 * ── THREE STATES, BECAUSE THE ANSWER DEPENDS ON WHERE YOU ARE STANDING ──────
 * `clicked` is what we know about the Google link at the moment the note is written:
 *
 *   null   the alert email. Nobody has clicked anything yet — the alert is sent the instant
 *          the customer hits Send, and its own footer says so. Hedged apology (see the
 *          header), because asserting a stranger's behaviour we have not observed is the
 *          exact defect this repo keeps being bitten by.
 *   false  the dashboard, on a row tagged "Link shown — not taken". Here it IS observed:
 *          g.js stamps googleClickAt only on a real click, and this row has none. The
 *          apology can be definite because the evidence exists.
 *   true   the dashboard, on a row tagged "Went to Google". They took the link. Apologising
 *          for a review that did not fail, and asking a second time for one they may have
 *          already left, is worse than sending nothing — so this variant carries NO apology,
 *          NO link and NO ask. Just the thank-you.
 *
 * ── AND THE READER MAY NOT BE THE REVIEWER ──────────────────────────────────
 * `recipient: 'account'` means the review was left anonymously and we are writing to the
 * address on the ORDER instead. "Thank you for your review" to someone who did not write one
 * is a mail-merge misfire, so that variant says what is actually true: somebody at their
 * company rated a delivery, and we do not know which of them it was.
 */
function thanksBody({ driver, googleUrl, clicked = null, recipient = 'reviewer' }) {
  // JUST "Hi". Chad: "take out trying to name who just write hi." The name field on the review
  // form is whatever the customer typed, and it is often not a person — the five-star review
  // this was built from was signed "TOB", the company's initials. "Hi TOB," in a note the
  // owner is about to sign himself reads like a mail-merge that misfired, which is the one
  // thing this note is supposed not to be. A bare "Hi," is right every single time.
  const hi = "Hi,";
  const toAccount = recipient === 'account';
  const about = toAccount
    ? (driver
      ? `Someone at your company took a minute to rate one of our deliveries five stars, and had kind words for ${driver} — I passed them straight on to him. They left it anonymously, so I'm writing to you.`
      : `Someone at your company took a minute to rate one of our deliveries five stars — it genuinely made someone's day here. They left it anonymously, so I'm writing to you.`)
    : (driver
      ? `Thank you for the kind words about ${driver} — I passed them straight on to him.`
      : `Thank you for taking the time to rate your delivery — it genuinely made someone's day here.`);

  // THEY TOOK THE LINK. Nothing to apologise for and nothing to ask for. A second ask here
  // lands on someone who has already done the thing, which is how goodwill gets spent.
  if (clicked === true) {
    return [hi, "", about, "", "That's all — no ask attached. Thank you.", "", "Chad Davis", "Davis Delivery Service"].join("\n");
  }

  const whose = toAccount ? "the review" : "your review";
  const apology = clicked === false
    ? `I'm sorry — ${whose} didn't make it through to Google. That's not on us or on ${toAccount ? "them" : "you"}: Google makes you sign in first, and it catches a lot of people out on a phone.`
    : `I'm sorry — it looks like ${whose} didn't make it through to Google. That's not on ${toAccount ? "them" : "you"}: Google makes you sign in first, and it catches a lot of people out on a phone.`;
  const ask = toAccount
    ? "If anyone there has a minute, this goes straight to the review box:"
    : "If you still have a minute, this goes straight there:";
  return [
    hi,
    "",
    about,
    "",
    apology,
    "",
    ask,
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
 * ownerThanksMailto({ review, googleUrl, fallbackTo, clicked })
 *   → { to, recipient, clicked, subject, body, href } | null
 *
 * null means there is nothing to offer — no address to write to, or no link to send them —
 * and the caller must then render the contact as plain text. Returning a half-built mailto
 * would put a dead link in the one email Chad actually acts on.
 *
 * ── fallbackTo: THE ADDRESS ON THE ORDER ────────────────────────────────────
 * Chad, on a five-star alert that carried no button: "Where is my button to generate my email
 * to customer saying their review didn't make it to Google". The reviewer had left the contact
 * field blank — "Review left by: Anonymous / Their contact: Not provided" — so there was no
 * address and no button, while MARYANN.MEDLIN@MFGINDUSTRIES.COM sat further down the same
 * email in the Customer block, linked as a bare mailto that opens an EMPTY compose window.
 *
 * So the reviewer's own address is still preferred and `fallbackTo` is only reached when there
 * isn't one. That order matters and is Chad's: "Think we should send to the ones who sent not
 * the one on the account." What changed is the case where nobody sent an address at all —
 * previously that meant no note, now it means a note to the account, clearly marked as such
 * (`recipient: 'account'`) so the caller can label the button and the copy does not thank a
 * person for a review they may not have written.
 *
 * Nothing here sends anything: it is a draft in Chad's own compose window, and he decides.
 */
function ownerThanksMailto({ review, googleUrl, fallbackTo, clicked = null } = {}) {
  const r = review && typeof review === "object" ? review : {};
  const own = String(r.contact == null ? "" : r.contact).trim();
  const alt = String(fallbackTo == null ? "" : fallbackTo).trim();
  // The reviewer first, ALWAYS. The order contact is a fallback, never a preference.
  const recipient = isEmailAddress(own) ? "reviewer" : "account";
  const to = recipient === "reviewer" ? own : alt;
  if (!isEmailAddress(to)) return null;
  const link = String(googleUrl == null ? "" : googleUrl).trim();
  // A thank-you with no link is not this feature — EXCEPT for the one variant that
  // deliberately carries no link, because they already took it.
  if (!link && clicked !== true) return null;

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
  const body = thanksBody({ driver, googleUrl: link, clicked, recipient });

  const href = `mailto:${encodeURIComponent(to)}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
  // Over the cap, drop the pleasantries rather than the link: a note that arrives without its
  // Google URL is the one outcome this whole thing exists to prevent.
  if (href.length > MAILTO_MAX) {
    // The stripped note keeps the LINK and drops the pleasantries — but it must still not
    // hand a second ask to someone who already took it, so that one variant stays linkless.
    const short = clicked === true
      ? ["Hi,", "", "Thank you for the review — it means a lot.", "", "Chad Davis", "Davis Delivery Service"].join("\n")
      : ["Hi,", "", "Thank you for the review — it means a lot.", "", "It looks like it didn't make it through to Google. If you still have a minute, this goes straight there:", "", link, "", "Chad Davis", "Davis Delivery Service"].join("\n");
    const shortHref = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
    return { to, recipient, clicked, subject, body: short, href: shortHref };
  }
  return { to, recipient, clicked, subject, body, href };
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
