// The first tests this repo has ever had.
//
// They exist because of what went wrong: the portal told the owner "✅ The customer was also
// routed to leave this review on Google" on every 5-star submission, and that sentence was a
// hardcoded string in an email template. Nothing observed it, nothing could contradict it,
// and it was wrong for two weeks without anybody being able to tell. The rules below are the
// ones that, if they drift, put another confident sentence in front of him.
//
// Everything here is PURE — no Netlify Blobs, no network, no Resend, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GOOGLE_REVIEW_URL, GOOGLE_CLICK_PATH, trackedGoogleUrl,
  KNOWN_SOURCES, SOURCE_LABEL, normalizeSource,
  stampClick, clickedThrough, withClicks, cleanRef, validRef, isEmailAddress, followupEligible,
  FOLLOWUP_CLAIM_TTL_MS,
  FOLLOWUP_DELAY_MS, FOLLOWUP_MAX_AGE_MS,
} = require('../netlify/functions/lib/reviews.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T18:00:00.000Z');
const submitted = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── SOURCE ───────────────────────────────────────────────────────────────────

test('an untagged arrival is "direct", not blank', () => {
  // A blank source on the dashboard reads as a bug. "direct" is a real answer: somebody
  // reached the site without following one of our links.
  assert.equal(normalizeSource(''), 'direct');
  assert.equal(normalizeSource(null), 'direct');
  assert.equal(normalizeSource(undefined), 'direct');
  assert.equal(normalizeSource('   '), 'direct');
});

test('the two email buttons are distinguishable — the whole point of the field', () => {
  assert.equal(normalizeSource('review-email'), 'review-email');
  assert.equal(normalizeSource('track-email'), 'track-email');
  assert.notEqual(normalizeSource('review-email'), normalizeSource('track-email'));
});

test('src is allow-listed, because it arrives in a URL the customer can edit', () => {
  // This value is rendered on the admin dashboard and in an alert email. Storing it verbatim
  // would let anyone with the link decide what those say.
  assert.equal(normalizeSource('<img src=x onerror=alert(1)>'), 'other');
  assert.equal(normalizeSource('DROP TABLE reviews'), 'other');
  assert.equal(normalizeSource('a'.repeat(500)), 'other');
  assert.equal(normalizeSource({ toString: () => 'review-email' }), 'review-email');
});

test('case and whitespace do not create a second category for the same source', () => {
  assert.equal(normalizeSource(' Review-Email '), 'review-email');
  assert.equal(normalizeSource('TRACK-EMAIL'), 'track-email');
});

test('every allowed source has a human label — including the fallbacks', () => {
  // A source with no label would print as a raw slug in Chad's inbox.
  for (const s of KNOWN_SOURCES) {
    assert.ok(SOURCE_LABEL[s], `${s} has no label`);
  }
});

// ── THE TRACKED LINK ─────────────────────────────────────────────────────────

test('the customer-facing Google link goes through our hop, not straight to Google', () => {
  // If this ever reverts to the bare Google URL, click tracking goes silently to zero and
  // the dashboard starts under-reporting instead of over-reporting. Same class of lie.
  const url = trackedGoogleUrl('abc123');
  assert.ok(url.startsWith(GOOGLE_CLICK_PATH), 'must be the tracked path');
  assert.ok(url.includes('rid=abc123'));
  assert.ok(!url.includes('g.page'), 'must not bypass the hop');
});

test('the link is root-relative for the page and absolute for an inbox', () => {
  // A relative URL in an email has no page to be relative to and resolves to nothing.
  assert.equal(trackedGoogleUrl('x'), '/g?rid=x');
  assert.equal(
    trackedGoogleUrl('x', 'https://tracking.davisdelivery.com'),
    'https://tracking.davisdelivery.com/g?rid=x',
  );
  // A trailing slash on the origin must not produce a doubled one.
  assert.equal(
    trackedGoogleUrl('x', 'https://tracking.davisdelivery.com/'),
    'https://tracking.davisdelivery.com/g?rid=x',
  );
});

test('a missing id still yields a usable link rather than "/g?rid=undefined"', () => {
  assert.equal(trackedGoogleUrl(''), '/g');
  assert.equal(trackedGoogleUrl(null), '/g');
  assert.equal(trackedGoogleUrl(undefined), '/g');
});

test('review ids are escaped into the query string', () => {
  assert.ok(trackedGoogleUrl('a&b=c').includes('rid=a%26b%3Dc'));
});

test('the Google destination is one string, defined once', () => {
  assert.match(GOOGLE_REVIEW_URL, /^https:\/\/g\.page\/r\/[A-Za-z0-9]+\/review$/);
});

// ── THE CLICK ────────────────────────────────────────────────────────────────

test('a fresh record has NOT clicked through — silence is not success', () => {
  // The bug in one line: the old system treated "rating >= 4" as "reached Google".
  assert.equal(clickedThrough({ rating: 5, routedTo: 'google', clickRef: 'r1' }, {}), false);
  assert.equal(clickedThrough({ rating: 5, routedTo: 'google' }, {}), false);
  assert.equal(clickedThrough({}, {}), false);
  assert.equal(clickedThrough(null, {}), false);
});

test('a click is recorded against the ref, not the review — so it survives arriving first', () => {
  // The whole reason the click store is separate. The anchor tap and the review POST leave
  // the browser in the same instant and the POST is the slower one (it waits on NuVizz), so
  // a design that needed the review to exist first would drop exactly the clicks that count.
  const c = stampClick(null, '2026-08-19T18:00:00.000Z', { source: 'review-email' });
  assert.equal(c.firstAt, '2026-08-19T18:00:00.000Z');
  assert.equal(c.count, 1);
  assert.equal(c.source, 'review-email');
});

test('the first click stamps the time; later clicks do not rewrite it', () => {
  const first = stampClick(null, '2026-08-19T18:00:00.000Z');
  const second = stampClick(first, '2026-08-19T19:30:00.000Z');
  assert.equal(second.firstAt, '2026-08-19T18:00:00.000Z', 'first click is the one that counts');
  assert.equal(second.lastAt, '2026-08-19T19:30:00.000Z');
  assert.equal(second.count, 2, 'a double-fire stays visible rather than hidden');
});

test('a corrupt click count does not produce NaN', () => {
  assert.equal(stampClick({ count: 'lots' }, 'now').count, 1);
  assert.equal(stampClick({ count: null }, 'now').count, 1);
  assert.equal(stampClick(undefined, 'now').count, 1);
});

test('the join is what answers "did this one reach Google"', () => {
  const clicks = { abc12345: stampClick(null, '2026-08-19T18:00:00.000Z') };
  const review = { id: 'r1', rating: 5, clickRef: 'abc12345', driver: 'RICHARD MAWUENYEGA' };
  assert.equal(clickedThrough(review, clicks), true);
  // A review pointing at a ref nobody clicked is still honestly unclicked.
  assert.equal(clickedThrough({ ...review, clickRef: 'zzz99999' }, clicks), false);
});

test('withClicks folds the click on without losing any review field', () => {
  // The dashboard reads these rows. Dropping a field here would erase the driver
  // attribution the scorecards depend on.
  const before = { id: 'r1', rating: 5, driver: 'RICHARD MAWUENYEGA', comment: 'great', source: 'review-email', clickRef: 'abc12345' };
  const clicks = { abc12345: { firstAt: 'T1', lastAt: 'T2', count: 2 } };
  const [after] = withClicks([before], clicks);
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `${k} was lost`);
  assert.equal(after.googleClickAt, 'T1');
  assert.equal(after.googleClickCount, 2);
});

test('withClicks reports zero rather than undefined when nothing was observed', () => {
  // undefined renders as "undefined" in a template string. Zero is a number Chad can read.
  const [a] = withClicks([{ id: 'r1', clickRef: 'abc12345' }], {});
  assert.equal(a.googleClickAt, null);
  assert.equal(a.googleClickCount, 0);
  const [b] = withClicks([{ id: 'r2' }], {});
  assert.equal(b.googleClickAt, null);
  assert.equal(b.googleClickCount, 0);
  assert.deepEqual(withClicks(null, null), []);
});

// ── THE REF ──────────────────────────────────────────────────────────────────

test('a client-supplied ref can never be adopted as a record key', () => {
  // This endpoint is public and unauthenticated. If the browser chose the primary key,
  // anyone could overwrite an existing review by guessing its id. The ref only ever names a
  // click record, which is worthless to forge.
  assert.equal(cleanRef('abc12345'), 'abc12345');
  assert.equal(cleanRef('ABC12345'), 'abc12345', 'case-folded so one ref is one row');
  assert.equal(cleanRef('  abc12345  '), 'abc12345');
});

test('a malformed ref is refused rather than sanitised into something that works', () => {
  for (const bad of ['', '   ', 'short', 'has-a-dash', 'has space', '../../etc/passwd', 'a'.repeat(200), null, undefined, {}]) {
    assert.equal(cleanRef(bad), null, JSON.stringify(bad));
    assert.equal(validRef(bad), false, JSON.stringify(bad));
  }
});

// ── FOLLOW-UP ────────────────────────────────────────────────────────────────

const CHASEABLE = {
  id: 'r1', rating: 5, contact: 'someone@example.com', submittedAt: submitted(4 * HOUR),
  clickRef: 'abc12345',
};

test('a 4-5 star with an email who never clicked through is chaseable', () => {
  assert.equal(followupEligible(CHASEABLE, NOW), true);
  assert.equal(followupEligible({ ...CHASEABLE, rating: 4 }, NOW), true);
});

test('a review from before click tracking is NEVER chased', () => {
  // The whole bug, run backwards. Every record the old code wrote reports googleClickAt:
  // null — not because nobody went to Google, but because nothing was watching. Chasing
  // those would put "you haven't posted yet" in the inbox of someone who already had.
  const legacy = { ...CHASEABLE };
  delete legacy.clickRef;
  assert.equal(followupEligible(legacy, NOW), false);
  assert.equal(followupEligible({ ...CHASEABLE, clickRef: '' }, NOW), false);
  assert.equal(followupEligible({ ...CHASEABLE, clickRef: null }, NOW), false);
});

test('a complaint is NEVER chased', () => {
  // Mailing "please post this on Google" to someone who gave us two stars is the single
  // worst thing this job could do.
  for (const rating of [1, 2, 3]) {
    assert.equal(followupEligible({ ...CHASEABLE, rating }, NOW), false, `rating ${rating}`);
  }
});

test('someone who already went to Google is not chased', () => {
  assert.equal(
    followupEligible({ ...CHASEABLE, googleClickAt: '2026-08-19T15:00:00.000Z' }, NOW),
    false,
  );
});

test('a follow-up sends once, ever — and a claim blocks a concurrent second send', () => {
  assert.equal(followupEligible({ ...CHASEABLE, followupSentAt: 'whenever' }, NOW), false);
  // The claim is written BEFORE the send. Two overlapping runs must not both mail.
  assert.equal(followupEligible({ ...CHASEABLE, followupClaimedAt: 'whenever' }, NOW), false);
});

test('a phone number in the contact box is not an address to mail', () => {
  for (const contact of ['678-926-3939', '', '   ', 'no thanks', 'a@b']) {
    assert.equal(followupEligible({ ...CHASEABLE, contact }, NOW), false, JSON.stringify(contact));
  }
  assert.equal(isEmailAddress('someone@example.com'), true);
  assert.equal(isEmailAddress('678-926-3939'), false);
});

test('they get a couple of hours to do it themselves first', () => {
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(0) }, NOW), false);
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(FOLLOWUP_DELAY_MS - 1000) }, NOW), false);
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(FOLLOWUP_DELAY_MS + 1000) }, NOW), true);
});

test('an old review is left alone rather than dug up', () => {
  // A "how was your delivery?" nudge about something three weeks gone reads as spam.
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(FOLLOWUP_MAX_AGE_MS - HOUR) }, NOW), true);
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(FOLLOWUP_MAX_AGE_MS + HOUR) }, NOW), false);
});

test('an undatable or malformed record is skipped, not guessed at', () => {
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: 'not a date' }, NOW), false);
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: undefined }, NOW), false);
  assert.equal(followupEligible(null, NOW), false);
  assert.equal(followupEligible('nonsense', NOW), false);
});

test('a review submitted in the future is not chased', () => {
  // Clock skew between the submit host and the cron host would otherwise make age negative,
  // which is < FOLLOWUP_DELAY_MS and correctly refuses.
  assert.equal(followupEligible({ ...CHASEABLE, submittedAt: submitted(-HOUR) }, NOW), false);
});

// ── BOUNDED READS ────────────────────────────────────────────────────────────
//
// A scheduled function gets THIRTY SECONDS. The follow-up job reads one blob per review,
// so the read loop is the part that will quietly start timing out as the store grows —
// long after anyone is watching it.

const { mapLimit, READ_CONCURRENCY } = require('../netlify/functions/lib/followup-core.js');

test('mapLimit keeps results in input order despite running out of order', () => {
  // Results are indexed into the output array, not pushed. Pushing would interleave them
  // and silently pair each review with somebody else's click record.
  const items = [50, 5, 30, 1, 20];
  return mapLimit(items, 2, (n) => new Promise((r) => setTimeout(() => r(n), n)))
    .then((out) => assert.deepEqual(out, items));
});

test('mapLimit never runs more than `limit` at once', async () => {
  let live = 0, peak = 0;
  await mapLimit([...Array(40).keys()], 4, async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  assert.ok(peak > 1, 'it should actually be concurrent, not accidentally serial');
});

test('mapLimit handles an empty list without hanging', async () => {
  assert.deepEqual(await mapLimit([], READ_CONCURRENCY, async () => 'x'), []);
});

test('mapLimit does not spawn more workers than there are items', async () => {
  let peak = 0, live = 0;
  await mapLimit([1, 2], 12, async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
  });
  assert.ok(peak <= 2, `peak was ${peak}`);
});

// ── SCANNER PROBES vs PEOPLE ─────────────────────────────────────────────────
//
// /g goes in an email, and corporate mail filters fetch every link they see. Counting those
// as clicks would inflate the one number this whole change exists to make honest.

test('a mail scanner fetch does not count as having gone to Google', () => {
  const probe = stampClick(null, 'T1', {}, false);
  assert.equal(probe.firstAt, undefined, 'a probe must never set firstAt');
  assert.equal(probe.probeCount, 1);
  assert.equal(clickedThrough({ clickRef: 'r' }, { r: probe }), false);
});

test('a real navigation after a probe still registers the customer', () => {
  const probe = stampClick(null, 'T1', {}, false);
  const human = stampClick(probe, 'T2', {}, true);
  assert.equal(human.firstAt, 'T2', 'the human sets firstAt, not the earlier bot');
  assert.equal(human.probeCount, 1, 'the probe is remembered, not erased');
  assert.equal(clickedThrough({ clickRef: 'r' }, { r: human }), true);
});

test('a probe after a real click never rewrites the moment they went', () => {
  const human = stampClick(null, 'T1', {}, true);
  const later = stampClick(human, 'T9', {}, false);
  assert.equal(later.firstAt, 'T1');
  assert.equal(later.probeCount, 1);
});

test('withClicks surfaces probes so a quiet rate can be told from a busy one', () => {
  const [row] = withClicks([{ id: 'r1', clickRef: 'abc12345' }], {
    abc12345: { count: 3, probeCount: 2, lastAt: 'T3', source: 'review-followup' },
  });
  assert.equal(row.googleClickAt, null, 'no firstAt means nobody actually went');
  assert.equal(row.googleClickProbes, 2);
  assert.equal(row.googleClickSource, 'review-followup', 'the click knows which link produced it');
});

// ── THE CLAIM EXPIRES; THE SEND DOES NOT ─────────────────────────────────────
//
// The claim is written before the send so a crash cannot mail twice. A PERMANENT claim
// turns any partial run -- a timeout, an unset sender, one Resend outage -- into a batch of
// customers marked un-nudgeable forever, with nothing to show for it.

test('a fresh claim blocks a second send', () => {
  const claimed = { ...CHASEABLE, followupClaimedAt: new Date(NOW - 60 * 1000).toISOString() };
  assert.equal(followupEligible(claimed, NOW), false);
});

test('a stale claim with no send becomes eligible again', () => {
  const stale = { ...CHASEABLE, followupClaimedAt: new Date(NOW - FOLLOWUP_CLAIM_TTL_MS - 1000).toISOString() };
  assert.equal(followupEligible(stale, NOW), true);
});

test('a stale claim that DID send stays blocked forever', () => {
  // followupSentAt is checked first and has no expiry. This is the line between "we tried"
  // and "they got one".
  const sent = {
    ...CHASEABLE,
    followupClaimedAt: new Date(NOW - FOLLOWUP_CLAIM_TTL_MS - 1000).toISOString(),
    followupSentAt: new Date(NOW - FOLLOWUP_CLAIM_TTL_MS - 1000).toISOString(),
  };
  assert.equal(followupEligible(sent, NOW), false);
});

test('an unparseable claim is left alone rather than retried', () => {
  assert.equal(followupEligible({ ...CHASEABLE, followupClaimedAt: 'sometime' }, NOW), false);
});

// ── THE FOLLOW-UP LINK ───────────────────────────────────────────────────────

test('src is a parameter, so the link cannot lose its question mark', () => {
  // It used to be concatenated at the call site: trackedGoogleUrl(ref, origin) + "&src=...".
  // With no ref that function emits no query string at all, so the concat produced
  // ".../g&src=review-followup" -- no "?", matching no rule in netlify.toml, i.e. a 404 in
  // a real customer's inbox. It was unreachable only because of a guard three files away.
  const u = trackedGoogleUrl('', 'https://tracking.davisdelivery.com', 'review-followup');
  assert.ok(u.includes('?'), `no query string: ${u}`);
  assert.ok(!u.includes('/g&'), `malformed: ${u}`);
  assert.equal(u, 'https://tracking.davisdelivery.com/g?src=review-followup');
});

test('a follow-up link is absolute — a relative one has no page to resolve against', () => {
  const u = trackedGoogleUrl('abc12345', 'https://tracking.davisdelivery.com', 'review-followup');
  assert.ok(u.startsWith('https://'), u);
  assert.equal(new URL(u).searchParams.get('rid'), 'abc12345');
  assert.equal(new URL(u).searchParams.get('src'), 'review-followup');
});
