// test/stop-context.test.mjs — the customer and the delivery photos in the alert email.
//
// Chad, holding a 1-star alert that named a PRO, a driver, and "Name: Anonymous / Contact:
// Not provided": "these emails ... i want to start to include the customers information and
// the photos of the delivery."
//
// These pin the rules that, if they drift, put a confidently wrong alert in front of him —
// the wrong party's address, a photo count that is not the real count, or an alert that never
// arrives because a photo would not load.
//
// Everything here is PURE. No NuVizz, no Resend, no Netlify Blobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  esc, extractCustomer, formatAddress, extractPodDocs, isPhotoDoc,
  selectPhotos, fitWithinBudget, attachmentName,
  customerBlockHtml, photosBlockHtml, MAX_PHOTOS,
} = require('../netlify/functions/lib/stop-context.js');

// A delivery stop shaped the way /stop/info/{pro}/DAVIS actually returns one.
const DELIVERY = {
  stop: {
    stopType: 'DO',
    to: {
      address: { name: 'BUFORD TILE & STONE', addr1: '4150 Peachtree Industrial Blvd', addr2: 'Suite 200', city: 'Buford', state: 'GA', zip: '30518' },
      contact: { contactName: 'Receiving', phone: '770-555-0143', email: 'receiving@example.com' },
      documents: [{ documentGuid: 'cap-1', documentExtType: 'JPG', createdTime: '2026-08-24T13:02:00Z' }],
    },
    from: { address: { name: 'DAVIS TERMINAL', addr1: '1 Terminal Way', city: 'Duluth', state: 'GA', zip: '30096' } },
  },
  stopExecutionInfo: {
    to: { podDoc: [{ documentGuid: 'pod-1', extension: 'jpg', documentName: 'POD.jpg' }] },
  },
};

// ── WHOSE ADDRESS GOES IN THE EMAIL ──────────────────────────────────────────

test('A DELIVERY NAMES THE CUSTOMER, NOT THE DAVIS TERMINAL', () => {
  // The single most damaging way this can be wrong: a delivery reads .to, a pickup reads
  // .from, and getting it backwards puts our own dock in an email meant to identify the
  // customer somebody is about to phone about a bad delivery.
  const c = extractCustomer(DELIVERY);
  assert.equal(c.name, 'BUFORD TILE & STONE');
  assert.equal(c.city, 'Buford');
  assert.ok(!/TERMINAL/i.test(c.name), 'the origin terminal must never be the customer');
});

test('a PICKUP names the pickup side instead', () => {
  const pu = { stop: { ...DELIVERY.stop, stopType: 'PU' } };
  assert.equal(extractCustomer(pu).name, 'DAVIS TERMINAL');
});

test('the contact comes through as name, phone and email', () => {
  const c = extractCustomer(DELIVERY);
  assert.equal(c.contactName, 'Receiving');
  assert.equal(c.phone, '770-555-0143');
  assert.equal(c.email, 'receiving@example.com');
});

test('a stop with only some fields still yields a usable block', () => {
  // Half a customer is worth printing. Requiring the full set would blank the block on a
  // stop that has a name and an address but no contact — which is most of them.
  const partial = { stop: { stopType: 'DO', to: { address: { name: 'ACME', city: 'Atlanta', state: 'GA' } } } };
  const c = extractCustomer(partial);
  assert.equal(c.present, true);
  assert.equal(c.name, 'ACME');
  assert.equal(c.phone, null);
  assert.equal(formatAddress(c), 'Atlanta, GA');
});

test('an empty or missing stop is "not present", never a half-built fake', () => {
  assert.equal(extractCustomer(null).present, false);
  assert.equal(extractCustomer({}).present, false);
  assert.equal(extractCustomer({ stop: {} }).present, false);
});

test('custInfo.custName is the fallback when the address carries no name', () => {
  const s = { stop: { stopType: 'DO', to: { address: { addr1: '9 Dock Rd' } }, custInfo: { custName: 'FALLBACK CO' } } };
  assert.equal(extractCustomer(s).name, 'FALLBACK CO');
});

test('formatAddress skips what is absent instead of printing empty commas', () => {
  assert.equal(formatAddress({ addr1: '1 A St', city: 'Duluth', state: 'GA', zip: '30096' }), '1 A St, Duluth, GA, 30096');
  assert.equal(formatAddress({ addr1: '1 A St' }), '1 A St');
  assert.equal(formatAddress({}), '');
  assert.equal(formatAddress(null), '');
});

// ── THE PHOTOS ───────────────────────────────────────────────────────────────

test('BOTH PLACES NUVIZZ HIDES DOCUMENTS ARE READ, AND DEDUPED', () => {
  // podDoc is the signed bundle; to.documents is the driver's door photos. A stop with
  // capture photos and no signed POD showed an empty section when only podDoc was read —
  // and the door photo is the one that answers "did not bring to the right location".
  const docs = extractPodDocs(DELIVERY);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.documentGuid).sort(), ['cap-1', 'pod-1']);
});

test('the same document surfacing under both keys is counted once', () => {
  const dup = {
    stop: { to: { documents: [{ documentGuid: 'same', documentExtType: 'JPG' }] } },
    stopExecutionInfo: { to: { podDoc: [{ documentGuid: 'same', extension: 'jpg' }] } },
  };
  assert.equal(extractPodDocs(dup).length, 1);
});

test('documentExtType and extension both normalise to a bare lowercase extension', () => {
  const docs = extractPodDocs(DELIVERY);
  for (const d of docs) assert.match(d.extension, /^jpg$/);
  const dotted = extractPodDocs({ stop: { to: { documents: [{ documentGuid: 'x', extension: '.PNG' }] } } });
  assert.equal(dotted[0].extension, 'png');
});

test('a document with no guid, path or name is dropped rather than fetched', () => {
  assert.deepEqual(extractPodDocs({ stop: { to: { documents: [{ createdTime: 'x' }, null] } } }), []);
});

test('a signed PDF is listed but is NOT a photo — it does not cost a fetch', () => {
  // "Photos of the delivery" is what was asked for. A BOL PDF is paperwork; naming it is
  // useful, spending a metered call and an attachment slot on it is not.
  assert.equal(isPhotoDoc({ extension: 'pdf' }), false);
  assert.equal(isPhotoDoc({ extension: 'jpg' }), true);
  assert.equal(isPhotoDoc({ extension: 'HEIC' }), true, 'iPhone captures are heic');
  assert.equal(isPhotoDoc({}), false);
  assert.equal(isPhotoDoc(null), false);

  const mixed = [{ extension: 'jpg', documentGuid: 'a' }, { extension: 'pdf', documentName: 'BOL.pdf' }];
  const sel = selectPhotos(mixed);
  assert.equal(sel.photos.length, 1);
  assert.equal(sel.otherDocs.length, 1);
});

// ── THE CAPS, AND SAYING SO ──────────────────────────────────────────────────

test('OVER THE CAP IS REPORTED, NEVER SILENTLY TRUNCATED', () => {
  // "3 photos" printed over a delivery that had eight is exactly the confident wrong
  // sentence this repo already shipped once, in the hardcoded "routed to Google" line.
  const many = Array.from({ length: MAX_PHOTOS + 3 }, (_, i) => ({ extension: 'jpg', documentGuid: `g${i}` }));
  const sel = selectPhotos(many);
  assert.equal(sel.photos.length, MAX_PHOTOS);
  assert.equal(sel.skippedPhotos.length, 3, 'the overflow is kept so the email can count it');

  const html = photosBlockHtml({ attached: [{ filename: 'a.jpg' }], missing: 3 });
  assert.match(html, /3 more photos/, 'the email states what it is not showing');
});

test('the byte ceiling drops photos rather than sending an email that bounces', () => {
  const huge = [
    { base64: 'x', bytes: 10 * 1024 * 1024, filename: 'a.jpg' },
    { base64: 'x', bytes: 10 * 1024 * 1024, filename: 'b.jpg' },
    { base64: 'x', bytes: 10 * 1024 * 1024, filename: 'c.jpg' },
  ];
  const { kept, dropped } = fitWithinBudget(huge);
  assert.equal(kept.length, 1, 'only what fits under 15MB travels');
  assert.equal(dropped.length, 2);
});

test('a photo whose bytes never arrived is dropped, not attached empty', () => {
  const { kept, dropped } = fitWithinBudget([{ base64: '', bytes: 0, filename: 'a.jpg' }, null]);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 2);
});

test('attachment names are safe filenames built from the PRO', () => {
  assert.equal(attachmentName('007165200', 0, { extension: 'jpg' }), '007165200-photo-1.jpg');
  assert.equal(attachmentName('ESTES-0538243875', 1, { extension: 'png' }), 'ESTES-0538243875-photo-2.png');
  // A PRO is customer-supplied text — it must never become a path.
  assert.equal(attachmentName('../../etc/passwd', 0, {}), 'etcpasswd-photo-1.jpg');
  assert.equal(attachmentName('', 0, {}), 'delivery-photo-1.jpg');
});

// ── WHAT THE EMAIL SAYS WHEN IT HAS NOTHING ──────────────────────────────────

test('a customer that could not be resolved SAYS SO — it does not render blank', () => {
  // A blank block reads as "this stop has no customer", which is never true. Naming the
  // miss is what tells somebody the lookup failed rather than the data being empty.
  const html = customerBlockHtml(null);
  assert.match(html, /Customer/);
  assert.match(html, /Couldn't be resolved/i);
});

test('no photos says no photos, plainly', () => {
  const html = photosBlockHtml({ attached: [], missing: 0 });
  assert.match(html, /No delivery photos were available/i);
  assert.ok(!/more photo/.test(html), 'no phantom overflow line when there is no overflow');
});

test('photosBlockHtml survives being handed nothing at all', () => {
  assert.match(photosBlockHtml(), /Delivery photos/);
  assert.match(photosBlockHtml({}), /No delivery photos/i);
});

// ── ESCAPING ─────────────────────────────────────────────────────────────────

test('CUSTOMER TEXT FROM NUVIZZ IS ESCAPED BEFORE IT REACHES THE EMAIL', () => {
  // These strings are typed by people outside Davis and land in an HTML body. The existing
  // templates escaped only "<" on the review comment, which leaves quotes and ampersands.
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('Tile & Stone'), 'Tile &amp; Stone');
  assert.equal(esc('a"b\'c'), 'a&quot;b&#39;c');
  assert.equal(esc(null), '');

  const html = customerBlockHtml(extractCustomer({
    stop: { stopType: 'DO', to: { address: { name: '<img src=x onerror=alert(1)>' } } },
  }));
  assert.ok(!/<img/.test(html), 'no raw tag survives into the email');
  assert.match(html, /&lt;img/);
});

test('the ampersand is escaped FIRST, or every other escape gets double-encoded', () => {
  // esc('<') → '&lt;'. If & were escaped last, that becomes '&amp;lt;' and the email shows
  // the literal text "&lt;". Ordering is the whole correctness of this function.
  assert.equal(esc('<'), '&lt;');
  assert.ok(!/&amp;lt;/.test(esc('<')));
});

test('a phone number is a tel: link with the punctuation stripped from the href', () => {
  // On a phone this is one tap at the moment it matters. The visible text keeps its dashes.
  const html = customerBlockHtml(extractCustomer(DELIVERY));
  assert.match(html, /href="tel:7705550143"/);
  assert.match(html, /770-555-0143/);
});

// ── THE WIRING, PINNED AT THE SOURCE ─────────────────────────────────────────

const REVIEW = readFileSync(new URL('../netlify/functions/review.js', import.meta.url), 'utf8');

test('BOTH alert templates carry the customer and the photos', () => {
  // The 1-star and 5-star templates are near-identical twins and have drifted before.
  // Adding a block to one and not the other is the shape of bug that ships unnoticed.
  assert.equal((REVIEW.match(/\$\{customerHtml\}/g) || []).length, 2, 'customer block in both templates');
  assert.equal((REVIEW.match(/\$\{photosHtml\}/g) || []).length, 2, 'photos block in both templates');
  assert.equal((REVIEW.match(/attachments: photos\.attachments/g) || []).length, 2, 'attachments on both sends');
});

test('the photos are only fetched when an alert is actually going out', () => {
  // A 4-star routes to Google and sends no email. Fetching photos for it would be a metered
  // NuVizz call per photo, per review, for something nobody ever looks at.
  assert.match(REVIEW, /const willAlert = !!RESEND_API_KEY && \(rating <= 3 \|\| rating === 5\)/);
  assert.match(REVIEW, /willAlert \? await collectDeliveryPhotos/);
});

test('the customer block reuses the stop response resolveDriver ALREADY fetched', () => {
  // The whole call-cost argument rests on this. A second /stop/info call here would double
  // the NuVizz cost of every review submission for data we were already holding.
  assert.match(REVIEW, /const \{ driver, driverId, wrap \} = await resolveDriver\(proClean\)/);
  assert.match(REVIEW, /wrap \? extractCustomer\(wrap\) : null/);
  const proBlock = REVIEW.slice(REVIEW.indexOf('const { driver, driverId, wrap }'));
  assert.ok(!/stop\/info/.test(proBlock), 'no second /stop/info call after the driver lookup');
});

test('A PHOTO THAT WILL NOT LOAD NEVER COSTS THE ALERT', () => {
  // The review itself and the alert email matter more than the pictures. Every fetch path
  // must swallow its own failure — a NuVizz document outage must not silence a 1-star.
  const fn = REVIEW.slice(REVIEW.indexOf('async function collectDeliveryPhotos'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /catch \(err\)/, 'the collector cannot throw');
  assert.match(body, /return empty/, 'and it degrades to no photos');
  const fetcher = REVIEW.slice(REVIEW.indexOf('async function fetchDocBase64'));
  assert.match(fetcher.slice(0, fetcher.indexOf('\n}\n')), /catch/, 'each document fetch cannot throw');
});

test('THE REVIEWER AND THE CUSTOMER ARE LABELLED APART', () => {
  // Adding the customer block put two name/contact pairs in one email: what the REVIEWER
  // typed into the rating form (usually nothing — "Anonymous / Not provided") sitting
  // directly above the customer of record and their real phone number. Left as bare
  // "Name:" and "Contact:", somebody reading fast rings the wrong one, or reads
  // "Not provided" and concludes there is no number when there is.
  assert.equal((REVIEW.match(/<strong>Review left by:<\/strong>/g) || []).length, 2);
  assert.equal((REVIEW.match(/<strong>Their contact:<\/strong>/g) || []).length, 2);
  assert.ok(!/<strong>Name:<\/strong>/.test(REVIEW), 'the ambiguous "Name:" label is gone');
  assert.ok(!/<strong>Contact:<\/strong>/.test(REVIEW), 'the ambiguous "Contact:" label is gone');
});
