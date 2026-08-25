// Chad's own thank-you note, prepared in the five-star alert.
//
// Chad: "I now want to be able to click on this customers email and sent them directly an
// email thanking them and providing a link directly to my Google reviews to see if I can push
// them to give me a review."
//
// The two that would cost something real if they broke: a mailto: addressed to a phone number
// (opens a compose window, looks like it worked, goes nowhere), and a note carrying the raw
// g.page URL instead of the tracked hop (the automatic follow-up then writes to somebody Chad
// has already asked personally, telling them "this is the only time we'll ask").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { ownerThanksMailto, mailtoAttr, firstName, MAILTO_MAX } = require('../netlify/functions/lib/owner-thanks.js');
const { KNOWN_SOURCES, SOURCE_LABEL, normalizeSource, followupEligible, trackedGoogleUrl, GOOGLE_REVIEW_URL } = (() => {
  const r = require('../netlify/functions/lib/reviews.js');
  return { ...r, KNOWN_SOURCES: null };
})();

const LINK = 'https://tracking.davisdelivery.com/g?rid=abc123&src=owner-thanks';
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

// ── The link that keeps the robot quiet ──────────────────────────────────────
test('the note carries the TRACKED hop, so a click stands the follow-up mailer down', () => {
  // followupEligible refuses once googleClickAt is set. That stamp only happens if the
  // customer went through /g — which only happens if the link in Chad's note IS the /g link.
  const t = ownerThanksMailto({ review: review(), googleUrl: trackedGoogleUrl('abc123', 'https://tracking.davisdelivery.com', 'owner-thanks') });
  assert.match(t.body, /\/g\?rid=abc123/);
  assert.ok(!t.body.includes(GOOGLE_REVIEW_URL), 'must not paste the raw g.page URL past the tracker');

  const base = { rating: 5, clickRef: 'abc123', contact: 'w743mbr@gmail.com', submittedAt: new Date(Date.now() - 3 * 3600e3).toISOString() };
  assert.equal(followupEligible({ ...base }, Date.now()), true, 'control: it would have nudged');
  assert.equal(followupEligible({ ...base, googleClickAt: new Date().toISOString() }, Date.now()), false,
    'a recorded click is what makes the robot stand down');
});

test('the click source is a registered one, so the dashboard can name it', () => {
  // normalizeSource collapses anything unknown to "other" — Chad's personal asks would be
  // indistinguishable from stray traffic, which is the question this is meant to answer.
  assert.equal(normalizeSource('owner-thanks'), 'owner-thanks');
  assert.ok(SOURCE_LABEL['owner-thanks'], 'a source with no human label is a blank dashboard cell');
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
