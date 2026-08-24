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
  selectPhotos, trackingUrl, customerBlockHtml, photosBlockHtml,
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


// ── THE CAPS, AND SAYING SO ──────────────────────────────────────────────────





// ── WHAT THE EMAIL SAYS WHEN IT HAS NOTHING ──────────────────────────────────

test('a customer that could not be resolved SAYS SO — it does not render blank', () => {
  // A blank block reads as "this stop has no customer", which is never true. Naming the
  // miss is what tells somebody the lookup failed rather than the data being empty.
  const html = customerBlockHtml(null, { pro: '007165200' });
  assert.match(html, /Customer/);
  assert.match(html, /Couldn't be resolved/i);
  // And it points somewhere that can actually answer. admin.html renders the review record
  // only — no customer, no photos — so "look it up on the dashboard" was a dead end.
  assert.match(html, /tracking\.davisdelivery\.com\/\?pro=007165200/);
  assert.ok(!/dashboard/i.test(html), 'the admin dashboard has never shown a customer');
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



test('the customer block reuses the stop response resolveDriver ALREADY fetched', () => {
  // The whole call-cost argument rests on this. A second /stop/info call here would double
  // the NuVizz cost of every review submission for data we were already holding.
  assert.match(REVIEW, /const \{ driver, driverId, wrap \} = await resolveDriver\(proClean\)/);
  assert.match(REVIEW, /wrap \? extractCustomer\(wrap\) : null/);
  // Match an actual CALL, not the words. This assertion used to grep for the bare string
  // "/stop/info" and started failing the moment a comment mentioned it — a guard that reads
  // prose is a guard that will one day pass for the same reason.
  const proBlock = REVIEW.slice(REVIEW.indexOf('const { driver, driverId, wrap }'));
  assert.ok(!/fetch\(`?[^`)]*stop\/info/.test(proBlock), 'no second /stop/info call after the driver lookup');
  // Everything from the driver lookup up to (not including) the Resend send must be free of
  // network calls. That window is where the enrichment lives, and it is the window whose
  // latency the customer waits on before their rating is acknowledged.
  const beforeSend = proBlock.slice(0, proBlock.indexOf('const emailRes = await fetch('));
  assert.ok(beforeSend.length > 100, 'located the window between the lookup and the send');
  assert.ok(!/await\s+fetch\(/.test(beforeSend),
    'nothing between the driver lookup and the Resend send may touch the network');
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



// ── WHAT THE ADVERSARIAL REVIEW FOUND ────────────────────────────────────────
//
// Five independent lenses read the first version of this change. What they found killed its
// design, and each defect gets a test here so it cannot come back.

test('NO NETWORK CALL HAPPENS AT SUBMIT TIME — the photos are linked, not fetched', () => {
  // THE FINDING THAT KILLED THE FIRST DESIGN. It downloaded the photo bytes inside the rating
  // POST. Measured against a stubbed document server: six photos took 9-19 seconds, and the
  // DEGRADED path — a stop whose documents never resolve — was the SLOWEST at 24 sequential
  // round trips and ~19s, producing an email with no photos in it. Netlify kills a synchronous
  // function well before that, and public/review.html turns the 502 into "Something went wrong.
  // Please try again." for the angriest customer we have. It could also wedge the handler
  // before Resend was ever called, storing a 1-star that nobody is told about — and a platform
  // kill is not a throw, so the best-effort catch never ran and nothing logged it.
  const LIB = readFileSync(new URL('../netlify/functions/lib/stop-context.js', import.meta.url), 'utf8');
  for (const [name, src] of [['stop-context.js', LIB]]) {
    assert.ok(!/\bfetch\s*\(/.test(src), `${name} must perform no I/O at all`);
    assert.ok(!/require\(["']node-fetch/.test(src), `${name} must not even import a fetch`);
  }
  assert.ok(!/documentapi/.test(REVIEW), 'review.js no longer talks to the document API');
  assert.ok(!/attachments/.test(REVIEW), 'and no longer builds email attachments');
});

test('the public unauthenticated POST costs the SAME NuVizz calls it did before this change', () => {
  // The POST has no key, no rate limit and CORS "*". The first version turned each anonymous
  // request into up to ~40 metered document calls — an abuse amplifier against a vendor API
  // this repo's owner meters carefully, and one a customer retrying after a 502 paid twice.
  // The only NuVizz call in the handler is still resolveDriver's, exactly as before.
  const handler = REVIEW.slice(REVIEW.indexOf('exports.handler'));
  const calls = handler.match(/await fetch\(/g) || [];
  // resolveDriver is called (not inlined) — inside the handler the only fetches are the two
  // Resend sends, one per alert template.
  assert.equal(calls.length, 2, `expected only the two Resend sends in the handler, found ${calls.length}`);
  for (const m of handler.match(/await fetch\([^\n]*/g) || []) {
    assert.match(m, /api\.resend\.com/, `unexpected network call in the handler: ${m}`);
  }
});

test('A SIGNED POD IS NOT A DELIVERY PHOTO, and only documentType can tell them apart', () => {
  // Both are .jpg, so classifying by extension counted the signed POD as a photo Chad asked
  // to see. This repo's own live tracker has always keyed off documentType
  // (public/index.html: "03" is the POD, "02" are the photos) — the correct reference was
  // sitting in the same repository.
  assert.equal(isPhotoDoc({ documentType: '02', extension: 'jpg' }), true, '02 is a delivery photo');
  assert.equal(isPhotoDoc({ documentType: '03', extension: 'jpg' }), false, '03 is the signed POD, not a photo');
  // Extension is only the fallback for entries carrying no type at all.
  assert.equal(isPhotoDoc({ extension: 'jpg' }), true);
  assert.equal(isPhotoDoc({ extension: 'pdf' }), false);

  const mixed = [
    { documentGuid: 'a', documentType: '02', extension: 'jpg' },
    { documentGuid: 'b', documentType: '03', extension: 'jpg', documentName: 'POD.jpg' },
    { documentGuid: 'c', extension: 'pdf', documentName: 'BOL.pdf' },
  ];
  const sel = selectPhotos(mixed);
  assert.deepEqual(sel.photos.map((d) => d.documentGuid), ['a'], 'only the 02 is a photo');
  assert.deepEqual(sel.otherDocs.map((d) => d.documentGuid), ['b', 'c'], 'the POD and the BOL are on file, not photos');
});

test('extractPodDocs carries documentType through, or the classifier is blind', () => {
  const docs = extractPodDocs({ stop: { to: { documents: [{ documentGuid: 'x', documentType: '03', documentExtType: 'JPG' }] } } });
  assert.equal(docs[0].documentType, '03');
});

test('THE BLOCK NEVER SAYS "no photos" ABOUT A STOP THAT HAS THEM', () => {
  // The contradiction the completeness critic caught in the first version: with every fetch
  // failed it printed "No delivery photos were available for this PRO" AND "4 more photos
  // were not attached" in the same block. The first sentence was false, and it is the one a
  // reader believes — the same shape as the hardcoded "routed to Google" line this repo
  // shipped once and could not contradict for two weeks.
  //
  // There is no such state now: the count is read straight off the payload, so either the
  // stop has photos or it does not.
  const withPhotos = photosBlockHtml({ photos: [{ documentGuid: 'a' }, { documentGuid: 'b' }], pro: '007165200' });
  assert.match(withPhotos, /2 photos on this delivery/);
  assert.ok(!/no delivery photos/i.test(withPhotos), 'must not claim there are none');

  const none = photosBlockHtml({ photos: [], pro: '007165200' });
  assert.match(none, /captured no delivery photos/i);
  assert.ok(!/more photo/.test(none), 'no phantom overflow line');
  assert.ok(!/\d+ photos on this delivery/.test(none));
});

test('the email points at the surface that ACTUALLY holds the photos', () => {
  // The first version told Chad to "see the dashboard" — but public/admin.html renders the
  // review record only: rating, reviewer, comment, PRO, driver, source. No photos, no
  // customer. It sent him somewhere that could not answer the question.
  const html = photosBlockHtml({ photos: [{ documentGuid: 'a' }], pro: '007165200' });
  assert.match(html, /https:\/\/tracking\.davisdelivery\.com\/\?pro=007165200/);
  assert.ok(!/\/admin/.test(html), 'the admin dashboard shows no photos — do not send him there');
  assert.match(html, /View the photo/);
});

test('trackingUrl encodes the PRO and degrades to the bare origin', () => {
  assert.equal(trackingUrl('ESTES-0538243875'), 'https://tracking.davisdelivery.com/?pro=ESTES-0538243875');
  assert.equal(trackingUrl('a b&c'), 'https://tracking.davisdelivery.com/?pro=a%20b%26c');
  assert.equal(trackingUrl(''), 'https://tracking.davisdelivery.com/');
  assert.equal(trackingUrl(null), 'https://tracking.davisdelivery.com/');
});

test("THE REVIEWER'S OWN name AND contact ARE ESCAPED — they are typed by a stranger", () => {
  // These two fields come straight off a public rating form and were interpolated raw into
  // both alert emails. This change rewrote those exact lines (relabelling them), so leaving
  // them unescaped would have been a defect introduced by the very edit that touched them.
  assert.equal((REVIEW.match(/\$\{esc\(review\.name\)/g) || []).length, 2, 'escaped in both templates');
  assert.equal((REVIEW.match(/\$\{esc\(review\.contact\)/g) || []).length, 2, 'escaped in both templates');
});

test('BOTH alert templates still carry both blocks', () => {
  // The 1-star and 5-star templates are near-identical twins and have drifted before.
  assert.equal((REVIEW.match(/\$\{customerHtml\}/g) || []).length, 2, 'customer block in both');
  assert.equal((REVIEW.match(/\$\{photosHtml\}/g) || []).length, 2, 'photos block in both');
});

test('AN UNRESOLVED PRO SAYS SO — it never reports "the driver captured nothing"', () => {
  // Caught by rendering the redesign and reading it: when the lookup fails, wrap is null and
  // extractPodDocs returns [], which at this layer is indistinguishable from a stop the driver
  // genuinely photographed nothing on. The block printed "The driver captured no delivery
  // photos on this stop" — stating as fact something never observed, about a driver, on a
  // complaint email. Same defect as the empty-vs-missing branch, wearing different clothes.
  const unresolved = photosBlockHtml({ photos: [], pro: '007165200', resolved: false });
  assert.match(unresolved, /Couldn't be checked/i);
  assert.ok(!/captured no delivery photos/i.test(unresolved), 'must not blame the driver for a failed lookup');

  const looked = photosBlockHtml({ photos: [], pro: '007165200', resolved: true });
  assert.match(looked, /captured no delivery photos/i, 'having looked, "none" is a real answer');

  // And the handler must pass the distinction through rather than defaulting it away.
  assert.match(REVIEW, /resolved: !!wrap/, 'review.js tells the block whether the lookup worked');
});
