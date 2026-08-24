// stop-context.js — who the delivery was for, and what the driver photographed.
//
// Chad, holding a 1-star alert: "These emails that are being sent i want to start to include
// the customers information and the photos of the delivery."
//
// WHAT THE ALERT USED TO SAY, in full: a PRO number, a driver name, and "Name: Anonymous /
// Contact: Not provided". Those last two are what the REVIEWER typed into the rating form —
// almost always nothing, because the form does not require them. So the alert named the
// customer of record nowhere at all.
//
// THE OPERATIONAL COST OF THAT. A 1-star lands at 9am. To act on it the owner has to open the
// dashboard, look the PRO up, find the business, find the phone number, then go somewhere else
// again for the delivery photos. That is four steps between "something went wrong" and "I can
// phone them", and the window in which a bad delivery can still be saved is measured in hours.
// One of these reviews said, in full, "Did not bring to the right location and did not try" —
// a claim the driver's own delivery photo answers in about two seconds, if anyone can see it.
//
// THE CALL BUDGET, WHICH IS WHY THIS FILE IS SHAPED THIS WAY. review.js already fetches
// /stop/info/{pro}/DAVIS on every submission to attribute the driver, and then throws the rest
// of the response away. The customer block AND the photo references are both already in that
// payload. So EVERYTHING here is a PURE READ of a response we have already paid for — the
// customer block and the photo counts alike cost ZERO additional NuVizz calls, and nothing in
// this file performs any I/O at all. See the note above photosBlockHtml for why the image
// bytes are linked rather than fetched.
//
// Field paths mirror dispatch-map/netlify/functions/lib/nuvizz-scan.mts (normalizeStop). They
// are duplicated rather than shared because these are two separate repos and two separate
// Netlify sites; if NuVizz moves a field, both move. The paths are pinned by tests here.

// NuVizz hands back free text written by other people — customer names, address lines and
// contact fields all originate outside Davis. It lands in an HTML email, so it gets escaped.
// The existing templates escaped only "<" on the review comment; that is not enough for an
// attribute-adjacent value and it is not enough for a quote.
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First non-empty value across candidate key paths, e.g. "to.address.name". */
function pick(obj, paths) {
  if (!obj) return null;
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// A delivery (DO) hangs its customer off .to; a pickup (PU) off .from. Getting this backwards
// puts the Davis terminal in the email instead of the customer.
function primarySide(stop) {
  const stopType = (stop && stop.stopType) || 'DO';
  return stopType === 'PU' ? (stop.from || {}) : (stop.to || stop.from || {});
}

/**
 * The customer of record for a stop, from the /stop/info payload review.js already holds.
 * `wrap` is the `Stop` object — { stop, stopExecutionInfo, load }.
 * Every field is independently optional: a stop with an address but no contact still yields
 * a useful block, and `present` says whether there is anything worth printing at all.
 */
function extractCustomer(wrap) {
  const stop = (wrap && wrap.stop) || wrap || {};
  const primary = primarySide(stop);
  const addr = primary.address || stop.address || {};
  const contact = primary.contact || {};
  const out = {
    name: pick(addr, ['name']) || pick(stop, ['custInfo.custName']),
    addr1: pick(addr, ['addr1']),
    addr2: pick(addr, ['addr2']),
    city: pick(addr, ['city']),
    state: pick(addr, ['state']),
    zip: pick(addr, ['zip']),
    contactName: pick(contact, ['contactName', 'name']),
    phone: pick(contact, ['phone', 'sms']),
    email: pick(contact, ['email']),
  };
  out.present = Object.keys(out).some((k) => k !== 'present' && out[k]);
  return out;
}

/** "123 Main St, Suite 4, Duluth, GA 30096" — skipping whatever is absent. */
function formatAddress(c) {
  if (!c) return '';
  const cityLine = [c.city, c.state].filter(Boolean).join(', ');
  return [c.addr1, c.addr2, cityLine, c.zip].filter(Boolean).join(', ');
}

// NuVizz exposes delivery documents in FOUR places and the portal merges all of them, so we
// must too. exec.to/from.podDoc is the signed POD bundle; stop.to/from.documents is the
// driver's Document Capture photos — the ones a driver takes at the door, which are precisely
// what "photos of the delivery" means here. A stop with capture photos but no signed POD
// would show nothing at all if only podDoc were read.
const DOC_SOURCES = [
  ['stopExecutionInfo', 'to', 'podDoc'],
  ['stopExecutionInfo', 'from', 'podDoc'],
  ['stop', 'to', 'documents'],
  ['stop', 'from', 'documents'],
];

/** Deduped document metadata for a stop. Order preserved; first occurrence of a guid wins. */
function extractPodDocs(wrap) {
  if (!wrap) return [];
  const raw = [];
  for (const [a, b, c] of DOC_SOURCES) {
    const arr = wrap && wrap[a] && wrap[a][b] && wrap[a][b][c];
    if (Array.isArray(arr)) raw.push(...arr);
  }
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    if (!d) continue;
    const doc = {
      documentName: d.documentName || null,
      documentGuid: d.documentGuid || null,
      documentPath: d.documentPath || null,
      // Capture docs key the extension as documentExtType ("JPG"); POD docs use extension.
      extension: (d.extension || d.documentExtType || null),
      // THE FIELD THAT ACTUALLY SAYS WHAT A DOCUMENT IS. "02" is a driver's delivery photo,
      // "03" is the signed POD. This repo's own customer-facing tracker has always keyed off
      // it (public/index.html: docs.find(x => x.documentType === "03") for the POD,
      // docs.filter(x => x.documentType === "02") for the photos). Classifying by file
      // extension instead counts the signed POD as a delivery photo, because it is a .jpg too.
      documentType: d.documentType || null,
      createdTime: d.createdTime || d.createdDTTM || null,
    };
    if (!(doc.documentGuid || doc.documentPath || doc.documentName)) continue;
    const key = doc.documentGuid || doc.documentPath || doc.documentName;
    if (seen.has(key)) continue;
    seen.add(key);
    if (doc.extension) doc.extension = String(doc.extension).toLowerCase().replace(/^\./, '');
    out.push(doc);
  }
  return out;
}

const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic']);
const TYPE_DELIVERY_PHOTO = '02';
const TYPE_SIGNED_POD = '03';

// A signed POD is a document, not a photo of the delivery. Both are .jpg, so the EXTENSION
// cannot tell them apart — documentType can, and the live tracker in this repo already uses
// it that way. Extension is only the fallback for entries that carry no type at all (podDoc
// bundle entries may not).
function isPhotoDoc(doc) {
  if (!doc) return false;
  const t = doc.documentType == null ? '' : String(doc.documentType).trim();
  if (t === TYPE_DELIVERY_PHOTO) return true;
  if (t === TYPE_SIGNED_POD) return false;
  return PHOTO_EXTS.has(String(doc.extension || '').toLowerCase());
}

// WHY THE PHOTOS ARE LINKED AND NOT SHIPPED.
//
// The first version of this fetched the image bytes at submit time and attached them to the
// alert. An adversarial read of it, with the timings actually measured against a stubbed
// document server, killed that design outright:
//
//   * It sat on the CUSTOMER'S critical path. review.js answers the rating POST only after the
//     enrichment finishes; six photos measured 9-19 seconds. Netlify kills a synchronous
//     function well before that, and public/review.html turns the resulting 502 into
//     "Something went wrong. Please try again." — shown to the angriest customer we have,
//     whose complaint we most need to keep.
//   * THE DEGRADED PATH WAS THE SLOWEST PATH. With the host/company failover, a stop whose
//     documents never resolve costs 24 sequential round trips and ~19s to produce an email
//     with no photos in it. "It just degrades to no photos" was the opposite of true.
//   * It could lose the ALERT. A hanging document host wedges the handler before the Resend
//     call is ever reached, so a 1-star review is stored and nobody is ever told — and a
//     platform kill is not a throw, so the best-effort catch never runs and nothing logs it.
//   * It turned a PUBLIC, unauthenticated, CORS-open POST into up to ~40 metered NuVizz calls
//     per request. Against a vendor API this repo's owner meters carefully, that is an abuse
//     amplifier, and a customer retrying after the 502 above pays it again.
//
// So: DO NOT FETCH. The document references are already in the /stop/info response
// resolveDriver paid for, which means the alert can say how many photos exist and what they
// are for ZERO calls and zero added latency — and then link to the tracking page for that PRO,
// where public/index.html ALREADY renders a working photo viewer with a download-all. Chad is
// one tap from the pictures instead of scrolling an attachment list, the alert is instant, and
// a document-server outage cannot touch either the review or the email.
//
// The bytes are fetched exactly when somebody looks at them, which is the cost-correct shape.
const TRACKING_ORIGIN = 'https://tracking.davisdelivery.com/';

/** The tracker deep-link for a PRO — public/index.html auto-loads from ?pro=. */
function trackingUrl(pro, origin = TRACKING_ORIGIN) {
  const p = String(pro == null ? '' : pro).trim();
  return p ? `${origin}?pro=${encodeURIComponent(p)}` : origin;
}

/** Split a stop's documents into the delivery photos and everything else (POD, BOL, ...). */
function selectPhotos(docs) {
  const all = Array.isArray(docs) ? docs : [];
  return {
    photos: all.filter(isPhotoDoc),
    otherDocs: all.filter((d) => d && !isPhotoDoc(d)),
  };
}

// ── EMAIL BLOCKS ─────────────────────────────────────────────────────────────
// Returned as HTML strings so review.js stays a thin edge and these are unit-testable
// without Resend, NuVizz or Netlify Blobs in the room.

const LABEL = 'color:#667;font-size:11px;text-transform:uppercase;letter-spacing:.5px';

/**
 * WHO the delivery was for. Phone and email are real links — the entire point is that Chad
 * can act from the alert instead of navigating to the dashboard first, and on a phone a
 * tel: link is one tap.
 */
function customerBlockHtml(customer, { pro = '', origin } = {}) {
  if (!customer || !customer.present) {
    // Saying nothing would read as "this stop has no customer", which is never true. Naming
    // the miss is what tells somebody the lookup failed rather than the data being empty.
    //
    // And it points at the TRACKING page, not the admin dashboard. public/admin.html renders
    // the review record only — rating, reviewer, comment, PRO, driver, source. It has never
    // shown a customer or a photo, so sending him there to "look it up" sent him somewhere
    // that could not answer.
    const link = pro ? `<div style="margin-top:8px"><a href="${esc(trackingUrl(pro, origin))}" style="color:#1e5b92;font-size:12px">Open the tracking page</a></div>` : '';
    return `<div style="background:#f7f8fa;padding:14px;border-radius:6px;margin:16px 0">
      <div style="${LABEL}">Customer</div>
      <div style="color:#667;font-size:13px;margin-top:4px">Couldn't be resolved from the PRO.</div>
      ${link}
    </div>`;
  }
  const addr = formatAddress(customer);
  const rows = [];
  if (customer.name) rows.push(`<div style="font-size:16px;font-weight:600;color:#0a2744">${esc(customer.name)}</div>`);
  if (addr) rows.push(`<div style="font-size:13px;color:#445;margin-top:3px">${esc(addr)}</div>`);
  const contactBits = [];
  if (customer.contactName) contactBits.push(esc(customer.contactName));
  if (customer.phone) contactBits.push(`<a href="tel:${esc(String(customer.phone).replace(/[^0-9+]/g, ''))}" style="color:#1e5b92;text-decoration:none">${esc(customer.phone)}</a>`);
  if (customer.email) contactBits.push(`<a href="mailto:${esc(customer.email)}" style="color:#1e5b92;text-decoration:none">${esc(customer.email)}</a>`);
  if (contactBits.length) rows.push(`<div style="font-size:13px;color:#445;margin-top:6px">${contactBits.join(' &middot; ')}</div>`);
  return `<div style="background:#f7f8fa;padding:14px;border-radius:6px;margin:16px 0">
    <div style="${LABEL}">Customer</div>
    <div style="margin-top:6px">${rows.join('')}</div>
  </div>`;
}

/**
 * WHAT THE DRIVER LEFT. A count and a way to see them — never a claim about bytes we did not
 * move. The counts come from the stop response resolveDriver already fetched, so this block
 * costs nothing and cannot fail.
 *
 * The wording is deliberately exact. An earlier draft could print "No delivery photos were
 * available for this PRO" and "4 more photos were not attached" in the same block, because the
 * empty branch tested only whether any bytes had arrived. The first sentence was false, and it
 * is the one a reader believes. There is no such ambiguity here: either the stop has photos or
 * it does not, and that is a fact read straight off the payload.
 */
function photosBlockHtml({ photos = [], otherDocs = [], pro = '', origin, resolved = true } = {}) {
  const n = photos.length;
  // WE ONLY GET TO SAY "NONE" IF WE ACTUALLY LOOKED. When the PRO lookup fails, wrap is null
  // and extractPodDocs returns [] — indistinguishable, at this layer, from a stop the driver
  // photographed nothing on. Printing "the driver captured no delivery photos" there states as
  // fact something never observed, about a driver, on a complaint email. It is the same defect
  // the empty-vs-missing branch had, wearing different clothes.
  if (!resolved) {
    return `<div style="background:#f7f8fa;padding:14px;border-radius:6px;margin:16px 0">`
      + `<div style="${LABEL}">Delivery photos</div>`
      + `<div style="font-size:13px;color:#667;margin-top:4px">Couldn't be checked — the PRO didn't resolve.</div>`
      + (pro ? `<div style="margin-top:8px"><a href="${esc(trackingUrl(pro, origin))}" style="color:#1e5b92;font-size:12px">Open the tracking page</a></div>` : '')
      + `</div>`;
  }
  const link = trackingUrl(pro, origin);
  const parts = [`<div style="${LABEL}">Delivery photos</div>`];
  if (n) {
    parts.push(`<div style="font-size:13px;color:#445;margin-top:4px">${n} photo${n === 1 ? '' : 's'} on this delivery.</div>`);
    const stamps = photos.map((p) => p.createdTime).filter(Boolean);
    if (stamps.length) {
      parts.push(`<div style="font-size:12px;color:#667;margin-top:3px">Taken ${esc(stamps[0])}${stamps.length > 1 ? ` – ${esc(stamps[stamps.length - 1])}` : ''}</div>`);
    }
    parts.push(`<div style="margin-top:9px"><a href="${esc(link)}" style="display:inline-block;background:#1e5b92;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">View the ${n === 1 ? 'photo' : `${n} photos`}</a></div>`);
  } else {
    // "None on this stop" is a real answer and a useful one — it says the driver captured
    // nothing, which is itself worth knowing on a complaint about where freight was left.
    parts.push(`<div style="font-size:13px;color:#445;margin-top:4px">The driver captured no delivery photos on this stop.</div>`);
    if (pro) parts.push(`<div style="margin-top:8px"><a href="${esc(link)}" style="color:#1e5b92;font-size:12px">Open the tracking page</a></div>`);
  }
  if (otherDocs.length) {
    parts.push(`<div style="font-size:12px;color:#667;margin-top:8px">Also on file: ${otherDocs.map((d) => esc(d.documentName || d.extension || 'document')).join(', ')}</div>`);
  }
  return `<div style="background:#f7f8fa;padding:14px;border-radius:6px;margin:16px 0">${parts.join('')}</div>`;
}

module.exports = {
  esc,
  extractCustomer,
  formatAddress,
  extractPodDocs,
  isPhotoDoc,
  selectPhotos,
  trackingUrl,
  customerBlockHtml,
  photosBlockHtml,
  PHOTO_EXTS,
  TRACKING_ORIGIN,
};
