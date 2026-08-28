// Chad's own thank-you note, prepared in the five-star alert.
//
// Chad: "I now want to be able to click on this customers email and sent them directly an
// email thanking them and providing a link directly to my Google reviews", then, on the first
// build: "i want it to have a link straight to google they have already given a 5 star i don't
// want to link them back to my page. also want to apologize that their review didn't make it
// to google and if they would please click the link and leave it directly with google."
//
// The three that would cost something real if they broke: a mailto: addressed to a phone
// number (opens a compose window, looks like it worked, goes nowhere); a link pointing back at
// our own tracking host instead of Google, which is the thing he rejected; and an apology that
// ASSERTS the review never reached Google, which nobody knows at the moment this alert is
// sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { ownerThanksMailto, mailtoAttr, firstName, MAILTO_MAX } = require('../netlify/functions/lib/owner-thanks.js');
const { GOOGLE_REVIEW_URL } = require('../netlify/functions/lib/reviews.js');

// THE REAL LINK, not a stand-in. A fixture holding some other URL would let the tracked hop be
// reintroduced without a single test noticing — every "the link is in the body" assertion below
// would still pass against whatever it was handed.
const LINK = GOOGLE_REVIEW_URL;
const review = (over = {}) => ({ contact: 'w743mbr@gmail.com', name: 'TOB', driver: 'TREVARR HOWARD', ...over });

// ── The address ──────────────────────────────────────────────────────────────
test('a real email address gets a ready-to-send note', () => {
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK });
  assert.ok(t);
  assert.equal(t.to, 'w743mbr@gmail.com');
  assert.ok(t.href.startsWith('mailto:w743mbr%40gmail.com?subject='));
  assert.match(t.body, /Trevarr/);
  assert.ok(t.body.includes(LINK));
});

test('a PHONE NUMBER in the contact field gets no link at all', () => {
  // The review form asks for "email or phone" and people give both. mailto: does not check:
  // it opens a compose window addressed to 7702428585 that will never arrive.
  for (const contact of ['7702428585', '770-242-8585', '(770) 242-8585', 'call me', '']) {
    assert.equal(ownerThanksMailto({ review: review({ contact }), googleUrl: LINK }), null, `for ${contact}`);
  }
});

test('an absent, null or malformed review does not throw — it declines', () => {
  assert.equal(ownerThanksMailto(), null);
  assert.equal(ownerThanksMailto({}), null);
  assert.equal(ownerThanksMailto({ review: null, googleUrl: LINK }), null);
  assert.equal(ownerThanksMailto({ review: 'nope', googleUrl: LINK }), null);
  assert.equal(ownerThanksMailto({ review: review(), googleUrl: '' }), null);
  assert.equal(ownerThanksMailto({ review: review(), googleUrl: null }), null);
});

// ── The link ────────────────────────────────────────────────────────────────
test('the note links STRAIGHT to Google, never back through our own site', () => {
  // Chad: "i want it to have a link straight to google ... i don't want to link them back to
  // my page." In a plain-text note there is no anchor text, so the customer reads the URL
  // itself; a tracking.davisdelivery.com/g?rid=… line in a personal thank-you reads as being
  // handed back to the machine that already emailed them.
  const t = ownerThanksMailto({ review: review(), googleUrl: GOOGLE_REVIEW_URL });
  assert.ok(t.body.includes(GOOGLE_REVIEW_URL));
  assert.ok(!/\/g\?/.test(t.body), 'no tracked hop');
  assert.ok(!/davisdelivery\.com/.test(t.body), 'nothing pointing at our own site');
});

test('the Google URL is the one constant, not a copy typed into the note', () => {
  // A second copy is a second thing to update the day the Google listing changes, and the one
  // that gets missed is always the one a customer sees.
  const t = ownerThanksMailto({ review: review(), googleUrl: GOOGLE_REVIEW_URL });
  assert.match(GOOGLE_REVIEW_URL, /^https:\/\/g\.page\//);
  assert.ok(t.href.includes(encodeURIComponent(GOOGLE_REVIEW_URL)));
});

test('the note apologises without claiming to know they did not post', () => {
  // Chad asked for the apology. But this alert is sent the moment the customer hits Send —
  // its own footer says nobody knows yet — so "your review did not reach Google" is a claim
  // about a stranger's behaviour we have not observed. Hedged, and the blame taken off them.
  const b = ownerThanksMailto({ review: review(), googleUrl: GOOGLE_REVIEW_URL }).body;
  assert.match(b, /I'm sorry/);
  assert.match(b, /looks like/, 'hedged, not asserted');
  assert.match(b, /not on you/, 'the blame does not land on the customer');
  assert.ok(!/you (didn't|did not|failed to) (post|leave)/i.test(b), 'never accuse them');
});

// ── The text ─────────────────────────────────────────────────────────────────
test('the driver is thanked by first name, not SHOUTED in full', () => {
  assert.equal(firstName('TREVARR HOWARD'), 'Trevarr');
  assert.equal(firstName('zach b'), 'zach');
  assert.equal(firstName('McKay Stevens'), 'McKay');   // already mixed case — left alone
  assert.equal(firstName(''), '');
  assert.equal(firstName(null), '');
});

test('an unattributed delivery still gets a note, just not one about a driver', () => {
  const t = ownerThanksMailto({ review: review({ driver: '' }), googleUrl: LINK });
  assert.ok(t);
  assert.ok(!/kind words about/.test(t.body));
  assert.ok(t.body.includes(LINK));
});

test('the note opens with a bare "Hi," and never tries to name them', () => {
  // Chad: "take out trying to name who just write hi." The name field is whatever the customer
  // typed and is often not a person — the review this was built from was signed "TOB", the
  // company's initials. "Hi TOB," in a note the owner signs himself reads as a misfired
  // mail-merge, which is the one thing this note must not be.
  for (const name of ['TOB', 'Rukhsana', '', 'receiving', 'x'.repeat(200)]) {
    const b = ownerThanksMailto({ review: review({ name }), googleUrl: LINK }).body;
    assert.match(b, /^Hi,\n/, `for ${JSON.stringify(name)}`);
    if (name) assert.ok(!b.includes(name), 'their name must not appear anywhere in the note');
  }
});

test('the note is signed Chad Davis', () => {
  const b = ownerThanksMailto({ review: review(), googleUrl: LINK }).body;
  assert.match(b, /Chad Davis/);
  assert.ok(!/Chad Blyth/.test(b));
});

// ── Encoding ─────────────────────────────────────────────────────────────────
test('the href survives an HTML attribute — the parameter separator is escaped', () => {
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK });
  const attr = mailtoAttr(t.href);
  assert.ok(!/&(?!amp;)/.test(attr), 'a raw & in an attribute is how ?subject=…&body=… loses its body');
  assert.ok(!attr.includes('"') && !attr.includes('<'), 'nothing that could break out of the attribute');
});

test('newlines reach the compose window as newlines', () => {
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK });
  assert.ok(t.href.includes('%0A'), 'a body without encoded newlines arrives as one run-on paragraph');
});

test('hostile text in the DRIVER field cannot inject markup or extra mailto parameters', () => {
  // Aimed at the driver, not the customer's name: the name no longer reaches the note at all,
  // so asserting against it would be a test that passes because there is nothing to attack.
  // The driver arrives from a vendor lookup and is the only free text left in the body.
  const t = ownerThanksMailto({ review: review({ driver: '"><b>x</b> &cc=someone@else.com' }), googleUrl: LINK });
  const attr = mailtoAttr(t.href);
  assert.ok(attr.includes(encodeURIComponent('<b>')) === false || !attr.includes('<b>'));
  assert.ok(!/<b>/.test(attr));
  assert.ok(!/&cc=/.test(attr), 'an unencoded & in the body would become a real mailto header');
});

// ── Length ───────────────────────────────────────────────────────────────────
test('an absurd DRIVER name cannot push the Google link out of the note', () => {
  // Aimed at the driver: the customer's name is gone from the body, so a long one proves
  // nothing. What holds HERE is the over-cap fallback, not the clamp — verified by deleting
  // the clamp and re-running, which still passes this.
  const t = ownerThanksMailto({ review: review({ driver: 'x'.repeat(4000) }), googleUrl: LINK });
  assert.ok(t.href.length <= MAILTO_MAX, `href was ${t.href.length}`);
  assert.ok(t.body.includes(LINK), 'a truncated note that loses the link defeats the whole feature');
});

test('an absurd driver name still yields the REAL note, not the stripped fallback', () => {
  // This is the clamp's actual job, and without this test nothing in the suite held it: the
  // length test above passes either way because the fallback catches the overflow. Without the
  // clamp every such delivery is silently demoted to the short note — link intact, but the
  // thank-you and the apology gone.
  const t = ownerThanksMailto({ review: review({ driver: 'x'.repeat(4000) }), googleUrl: LINK });
  assert.match(t.body, /kind words about/, 'the real note, not the fallback');
  assert.match(t.body, /I'm sorry/, 'the apology survives too');
  const shown = (t.body.match(/kind words about (x+)/) || [])[1] || '';
  assert.ok(shown.length <= 40, `driver ran to ${shown.length} chars in the note`);
});

// ── THE ANONYMOUS FIVE-STAR, AND THE BUTTON THAT WASN'T THERE ────────────────
//
// Chad, holding a five-star alert with no button on it: "Where is my button to generate my
// email to customer saying their review didn't make it to Google". PRO 007168192,
// MANUFACTURING INDUSTRIES — "Review left by: Anonymous / Their contact: Not provided", with
// MARYANN.MEDLIN@MFGINDUSTRIES.COM sitting 200px further down the same email in the Customer
// block, linked as a bare mailto that opens an EMPTY compose window.
const ANON = { contact: '', name: '', driver: 'OYIEKE NELSON', proNumber: '007168192' };
const ORDER_EMAIL = 'MARYANN.MEDLIN@MFGINDUSTRIES.COM';

test('THE BUG: an anonymous review with no contact had nothing to offer', () => {
  // Unchanged when there is genuinely no address anywhere — this is what Chad hit.
  assert.equal(ownerThanksMailto({ review: ANON, googleUrl: LINK }), null);
});

test('THE FIX: with an address on the order, the note goes there', () => {
  const t = ownerThanksMailto({ review: ANON, googleUrl: LINK, fallbackTo: ORDER_EMAIL });
  assert.ok(t);
  assert.equal(t.to, ORDER_EMAIL);
  assert.equal(t.recipient, 'account');
  assert.ok(t.body.includes(LINK));
});

test('the REVIEWER always wins — the order contact is a fallback, never a preference', () => {
  // Chad: "Think we should send to the ones who sent not the one on the account." That order
  // is load-bearing and this is the test that holds it.
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK, fallbackTo: ORDER_EMAIL });
  assert.equal(t.to, 'w743mbr@gmail.com');
  assert.equal(t.recipient, 'reviewer');
});

test('a phone number in the contact field still falls through to the order address', () => {
  const t = ownerThanksMailto({ review: review({ contact: '7702428585' }), googleUrl: LINK, fallbackTo: ORDER_EMAIL });
  assert.equal(t.to, ORDER_EMAIL);
  assert.equal(t.recipient, 'account');
});

test('a phone number on the order is refused too — it is not an address', () => {
  assert.equal(ownerThanksMailto({ review: ANON, googleUrl: LINK, fallbackTo: '7066465000' }), null);
});

test('the note to an ACCOUNT contact never thanks them for a review they may not have written', () => {
  const t = ownerThanksMailto({ review: ANON, googleUrl: LINK, fallbackTo: ORDER_EMAIL });
  // "Thank you for the kind words" to a person who did not write them is a mail-merge misfire.
  assert.doesNotMatch(t.body, /Thank you for the kind words/);
  assert.doesNotMatch(t.body, /your review/);
  assert.match(t.body, /Someone at your company/);
  assert.match(t.body, /anonymously/);
  assert.match(t.body, /Oyieke/);              // the driver is still named and still cased
});

// ── WHAT WE KNOW ABOUT GOOGLE, AND WHERE WE KNOW IT ──────────────────────────
test('in the ALERT (clicked unknown) the apology stays hedged', () => {
  // The alert is sent the instant the customer hits Send; its own footer says nobody knows yet.
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK });
  assert.equal(t.clicked, null);
  assert.match(t.body, /it looks like your review didn't make it through to Google/);
});

test('on the DASHBOARD, a link shown and not taken gets the DEFINITE apology', () => {
  // Here it is observed: g.js stamps googleClickAt on a real click and on nothing else.
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK, clicked: false });
  assert.match(t.body, /I'm sorry — your review didn't make it through to Google/);
  assert.doesNotMatch(t.body, /looks like/);
  assert.ok(t.body.includes(LINK));
});

test('a review that DID reach Google gets no apology, no link and no second ask', () => {
  // Apologising for a review that did not fail, and asking again for one they may already have
  // left, is worse than sending nothing at all.
  const t = ownerThanksMailto({ review: review(), googleUrl: LINK, clicked: true });
  assert.ok(t);
  assert.equal(t.clicked, true);
  assert.doesNotMatch(t.body, /sorry/i);
  assert.doesNotMatch(t.body, /didn't make it/);
  assert.ok(!t.body.includes(LINK), 'the note must not carry the review link');
  assert.doesNotMatch(t.body, /minute/);       // no "if you still have a minute"
  assert.match(t.body, /Trevarr/);             // it is still a thank-you
});

// REACHING THE OVER-CAP BRANCH AT ALL takes a long ADDRESS, not a long driver name — the
// 40-char clamp means no driver can push the note over. The two length tests above therefore
// never enter the fallback; they pass on the normal note. This one does enter it, proved by
// the assertion that the body IS the stripped text.
const LONG_TO = `${'a'.repeat(1900)}@mfgindustries.com`;

test('the over-cap fallback is genuinely reached by a long address', () => {
  const t = ownerThanksMailto({ review: review({ contact: LONG_TO }), googleUrl: LINK });
  assert.equal(t.to, LONG_TO);
  assert.match(t.body, /Thank you for the review — it means a lot\./, 'this is the stripped note');
  assert.ok(t.body.includes(LINK), 'and the link is what the stripping protects');
});

test('the no-ask note survives the over-cap fallback WITHOUT gaining a link', () => {
  // The stripped note exists to protect the link. For this one variant that would be the bug:
  // the cap must not smuggle a second ask into a note that deliberately has none, because the
  // recipient has already been to Google.
  const t = ownerThanksMailto({ review: review({ contact: LONG_TO }), googleUrl: LINK, clicked: true });
  assert.match(t.body, /Thank you for the review — it means a lot\./, 'the stripped note, so the branch ran');
  assert.ok(!t.body.includes(LINK), 'no link may be smuggled back in');
  assert.doesNotMatch(t.body, /didn't make it/);
  assert.doesNotMatch(t.body, /minute/);
});

test('a thank-you with no link is still refused for every variant that asks', () => {
  assert.equal(ownerThanksMailto({ review: review(), googleUrl: '' }), null);
  assert.equal(ownerThanksMailto({ review: review(), googleUrl: '', clicked: false }), null);
  // ...except the one that was never going to carry a link.
  assert.ok(ownerThanksMailto({ review: review(), googleUrl: '', clicked: true }));
});

test('empty, absent and malformed still produce nothing rather than a half-built mailto', () => {
  assert.equal(ownerThanksMailto(), null);
  assert.equal(ownerThanksMailto({}), null);
  assert.equal(ownerThanksMailto({ review: null, googleUrl: LINK }), null);
  assert.equal(ownerThanksMailto({ review: ANON, googleUrl: LINK, fallbackTo: null }), null);
  assert.equal(ownerThanksMailto({ review: ANON, googleUrl: LINK, fallbackTo: '   ' }), null);
});
