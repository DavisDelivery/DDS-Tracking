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

test('the reviewer is greeted with what they actually typed', () => {
  // "TOB" is how they signed it. Title-casing it to "Tob" invents a person who is not there.
  assert.match(ownerThanksMailto({ review: review({ name: 'TOB' }), googleUrl: LINK }).body, /^Hi TOB,/);
  assert.match(ownerThanksMailto({ review: review({ name: '' }), googleUrl: LINK }).body, /^Hi there,/);
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

test('a hostile name cannot inject markup or extra mailto parameters', () => {
  const t = ownerThanksMailto({ review: review({ name: '"><b>x</b> &cc=someone@else.com' }), googleUrl: LINK });
  const attr = mailtoAttr(t.href);
  assert.ok(!attr.includes('<b>'));
  assert.ok(!/&cc=/.test(attr), 'an unencoded & in the body would become a real mailto header');
});

// ── Length ───────────────────────────────────────────────────────────────────
test('a very long name drops the pleasantries but never the Google link', () => {
  const t = ownerThanksMailto({ review: review({ name: 'x'.repeat(4000) }), googleUrl: LINK });
  assert.ok(t.href.length <= MAILTO_MAX, `href was ${t.href.length}`);
  assert.ok(t.body.includes(LINK), 'a truncated note that loses the link defeats the whole feature');
});
