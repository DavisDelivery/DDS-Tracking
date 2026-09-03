// The public review feed is the only endpoint on this site meant to be open to
// the internet, and the store behind it is full of things that must never
// leave: email addresses, phone numbers, surnames, driver names, PRO numbers.
//
// These tests exist because two of those nearly did. The store's own ids are
// shaped `restored-20260617-007130000` for backfilled records, and the trailing
// segment is the PRO number — publishing the raw id would have published the
// PRO. And a customer who types their own phone number into the comment box
// hands it to the homepage unless something takes it out.
//
// FIXTURES ARE FABRICATED ON PURPOSE. Every shape below is one that occurs in
// the real store, but no real customer's name, number or words are committed to
// this repository — that would be the leak these tests exist to prevent.
// Verification against live data happens with curl after deploy, not here.
//
// Everything here is PURE — no Netlify Blobs, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildFeed, containsPro, displayName, opaqueId,
  proVariants, scrubComment, tidyCompany, toPublic,
} = require('../netlify/functions/lib/public-reviews.js');

const PRO = '007169763';

// Shapes drawn from the real store; values invented.
const FIXTURES = [
  { id: 'mtaaaaaaaaaa1', rating: 5, comment: 'Driver was courteous and put the pallet in the garage.',
    name: 'Marguerite Ashdown', contact: '5555550101', customerEmail: 'm.ashdown@example.com',
    proNumber: '007111111', driver: 'MARCUS CRUMPTON', customerName: '', submittedAt: '2026-08-30T14:02:00Z' },
  { id: 'mtaaaaaaaaaa2', rating: 5, comment: 'Fast and professional.',
    name: 'Sean', proNumber: '007111112', driver: 'TREY WALTON', customerName: '', submittedAt: '2026-08-29T09:00:00Z' },
  { id: 'mtaaaaaaaaaa3', rating: 5, comment: 'showed up on time, no fuss',
    name: 'delia okonkwo', proNumber: '007111113', driver: 'NANA OSEI', customerName: '', submittedAt: '2026-08-28T09:00:00Z' },
  { id: 'mtaaaaaaaaaa4', rating: 5, comment: 'Great service, thank you.',
    name: '', proNumber: '007111114', driver: 'NANA OSEI', customerName: 'WESCO DISTRIBUTION', submittedAt: '2026-08-27T09:00:00Z' },
  { id: 'mtaaaaaaaaaa5', rating: 5, comment: 'Everything arrived intact.',
    name: '', proNumber: '007111115', driver: '', customerName: '', submittedAt: '2026-08-26T09:00:00Z' },
  { id: 'mtaaaaaaaaaa6', rating: 5, comment: '', // a bare star, no words
    name: 'Pat Vance', proNumber: '007111116', driver: '', customerName: '', submittedAt: '2026-08-25T09:00:00Z' },
  { id: 'mtaaaaaaaaaa7', rating: 2, comment: 'Late by two days and nobody called.',
    name: 'Otto Brand', proNumber: '007111117', driver: 'MARCUS CRUMPTON', customerName: '', submittedAt: '2026-08-24T09:00:00Z' },
  { id: 'mtaaaaaaaaaa8', rating: 1, comment: 'Wrong address entirely.',
    name: 'Ines Farrow', proNumber: '007111118', driver: 'TREY WALTON', customerName: '', submittedAt: '2026-08-23T09:00:00Z' },
  { id: 'mtaaaaaaaaaa9', rating: 5, comment: 'Call me on 555-555-0142 or nadia@example.com about PRO 007111119, otherwise great.',
    name: 'Nadia Whitlock', proNumber: '007111119', driver: '', customerName: '', submittedAt: '2026-08-22T09:00:00Z' },
  // The backfilled shape: the id itself carries the PRO.
  { id: 'restored-20260617-007130000', rating: 5, comment: 'Good delivery, on schedule.',
    name: 'Hal Brenner', proNumber: '007130000', driver: '', customerName: '', submittedAt: '2026-06-17T09:00:00Z' },
];

test('displayName never publishes a surname in full', () => {
  assert.equal(displayName('Marguerite Ashdown', null), 'Marguerite A.');
  assert.equal(displayName('delia okonkwo', null), 'delia O.');
  assert.equal(displayName('Sean', null), 'Sean');
  assert.ok(!displayName('Marguerite Ashdown', null).toLowerCase().includes('ashdown'));
});

test('displayName falls back to the receiving company, then to a generic label', () => {
  assert.equal(displayName('', 'WESCO DISTRIBUTION'), 'Wesco Distribution');
  assert.equal(displayName('', ''), 'Verified customer');
  assert.equal(displayName(null, null), 'Verified customer');
});

test('tidyCompany calms a shouty name without mangling a deliberate one', () => {
  assert.equal(tidyCompany('E2 OPTICS'), 'E2 Optics');
  assert.equal(tidyCompany('BOEHRINGER INGELHEIM ANIMAL'), 'Boehringer Ingelheim Animal');
  assert.ok(tidyCompany('ACME HAULING LLC').endsWith('LLC'));
  assert.equal(tidyCompany('iRobot Corp'), 'iRobot Corp');
});

test('scrubComment removes contact details typed into the comment box', () => {
  assert.ok(!scrubComment('mail me at bob@example.com thanks').includes('bob@example.com'));
  assert.ok(!scrubComment('call 678-926-3939 please').includes('678-926-3939'));
  assert.ok(!scrubComment('call (678) 555-1212').includes('555-1212'));
  assert.equal(scrubComment('Driver was great, very professional.'), 'Driver was great, very professional.');
  assert.equal(scrubComment(''), null);
  assert.equal(scrubComment('   '), null);
});

// "Don't publish the pro numbers at all." Every form a person actually writes.
for (const [label, text] of [
  ['bare',                    `shipment ${PRO} arrived fine`],
  ['leading zeros dropped',   'shipment 7169763 arrived fine'],
  ['spaced',                  'shipment 007 169 763 arrived fine'],
  ['hyphenated',              'shipment 007-169-763 arrived fine'],
  ['dotted',                  'shipment 007.169.763 arrived fine'],
  ['slashed',                 'shipment 007/169/763 arrived fine'],
  ['labelled PRO#',           `PRO# ${PRO} was on time`],
  ['labelled pro no.',        'pro no. 007 169 763 was on time'],
  ['labelled p.r.o.',         `p.r.o. ${PRO} was on time`],
  ['labelled BOL',            `BOL ${PRO} was on time`],
  ['labelled tracking',       `tracking number ${PRO} was on time`],
  ['mid-sentence',            `great job on ${PRO}, thanks`],
  ['spaced digit by digit',   'ref 0 0 7 1 6 9 7 6 3 ok'],
]) {
  test(`scrubComment removes a PRO written ${label}`, () => {
    const digits = (scrubComment(text, PRO) || '').replace(/\D/g, '');
    assert.ok(!digits.includes('7169763'), `survived: ${scrubComment(text, PRO)}`);
  });
}

test('innocent numbers survive the scrub', () => {
  assert.ok(scrubComment('Serving since 1985, great crew.', PRO).includes('1985'));
  assert.ok(scrubComment('Lifted all 3500 pounds no problem.', PRO).includes('3500'));
  assert.ok(scrubComment('A 5 star delivery.', PRO).includes('5 star'));
  assert.ok(scrubComment('2 guys unloaded it fast.', PRO).includes('2 guys'));
});

test('opaqueId keeps the backfilled id shape from carrying its PRO out', () => {
  assert.ok(!opaqueId('restored-20260617-007130000').includes('007130000'));
  assert.equal(opaqueId('abc'), opaqueId('abc'));
  assert.notEqual(opaqueId('abc'), opaqueId('abd'));
  assert.match(opaqueId('anything'), /^[0-9a-f]{12}$/);
});

test('containsPro is the final gate, and does not fire on clean records', () => {
  const clean = { comment: 'Great driver.', author: 'Bob', id: 'aaaaaaaaaaaa', date: '2026-08-01' };
  assert.ok(containsPro({ ...clean, comment: 'ref 007169763' }, PRO));
  assert.ok(containsPro({ ...clean, comment: 'ref 007-169-763' }, PRO));
  assert.ok(!containsPro(clean, PRO));
  assert.equal(proVariants('123').length, 0);
  assert.equal(proVariants(null).length, 0);
});

test('a PRO obfuscated past the scrub drops the whole review', () => {
  // Layer 2 handles the normal case and the review still publishes.
  const scrubbed = toPublic({ id: 'x1', rating: 5, comment: `ref ${PRO} thanks`,
    proNumber: PRO, name: 'Bob Smith', submittedAt: '2026-08-01T00:00:00Z' });
  assert.ok(scrubbed);
  assert.ok(!scrubbed.comment.replace(/\D/g, '').includes('7169763'));

  // Letters between the digits defeat the spacing-tolerant regex. The
  // digits-only gate still catches it, and drops rather than patches.
  assert.equal(toPublic({ id: 'x2', rating: 5, comment: 'ref 0a0b7c1d6e9f7g6h3 thanks',
    proNumber: PRO, name: 'Bob Smith', submittedAt: '2026-08-01T00:00:00Z' }), null);
});

test('the published object carries exactly the allow-listed keys', () => {
  const allowed = ['author', 'comment', 'date', 'id', 'rating'].join(',');
  for (const r of FIXTURES) {
    const pub = toPublic(r);
    if (!pub) continue;
    assert.equal(Object.keys(pub).sort().join(','), allowed);
  }
});

test('nothing from the source record leaks into the feed', () => {
  const feed = buildFeed(FIXTURES);
  const blob = JSON.stringify(feed).toLowerCase();

  const forbidden = [
    ...FIXTURES.map((r) => r.customerEmail),
    ...FIXTURES.map((r) => r.contact),
    ...FIXTURES.map((r) => r.proNumber),
    ...FIXTURES.map((r) => r.driver),
    ...FIXTURES.map((r) => (r.name || '').trim().split(/\s+/).slice(1).join(' ')),
  ].filter((v) => v && String(v).length > 2);

  for (const v of forbidden) {
    assert.ok(!blob.includes(String(v).toLowerCase()), `leaked: ${v}`);
  }

  // Belt and braces: no PRO survives even a digits-only reading of the feed.
  const digits = JSON.stringify(feed).replace(/\D/g, '');
  for (const r of FIXTURES) {
    const d = String(r.proNumber || '').replace(/\D/g, '');
    if (d.length < 6) continue;
    assert.ok(!digits.includes(d), `PRO ${d} survived as digits`);
  }
});

test('buildFeed publishes only 4-star-and-up reviews that have words in them', () => {
  const feed = buildFeed(FIXTURES);
  assert.ok(feed.reviews.every((r) => r.rating >= 4));
  assert.ok(feed.reviews.every((r) => r.comment));
  assert.ok(feed.reviews.every((r) => r.author));
  // The 1- and 2-star reviews and the wordless 5-star are all absent.
  assert.equal(feed.publishedCount, FIXTURES.length - 3);
  assert.equal(feed.reviews.length, feed.publishedCount);
});

test('buildFeed sorts newest first and honours the cap', () => {
  const feed = buildFeed(FIXTURES, { max: 3 });
  assert.equal(feed.reviews.length, 3);
  const dates = feed.reviews.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('the average describes the published set, not the store', () => {
  const feed = buildFeed(FIXTURES);
  // The 1- and 2-star reviews must not drag it down: they were never published.
  assert.equal(feed.publishedAverage, 5);
  assert.equal(feed.minRating, 4);
  assert.equal(buildFeed([]).publishedAverage, null);
  assert.equal(buildFeed([]).publishedCount, 0);
});

test('a malformed record is skipped, not published half-built', () => {
  assert.equal(toPublic({ id: 'z', rating: 'not a number', comment: 'hi' }), null);
  const feed = buildFeed([{ id: 'z', rating: null, comment: 'hi' }, ...FIXTURES]);
  assert.ok(feed.reviews.every((r) => Number.isFinite(r.rating)));
});
