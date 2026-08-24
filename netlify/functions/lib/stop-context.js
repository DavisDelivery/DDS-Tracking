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
// payload. So everything here is a PURE READ of a response we have already paid for: adding
// the customer costs ZERO additional NuVizz calls. Only the photo BYTES cost anything, one
// documentapi call each, capped and counted below.
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

// A signed BOL PDF is a document, not a photo of the delivery. It still gets NAMED in the
// email — "there is paperwork here" is worth knowing — but it is not what Chad asked to see
// and it is not worth spending a fetch on.
function isPhotoDoc(doc) {
  return !!doc && PHOTO_EXTS.has(String(doc.extension || '').toLowerCase());
}

// HOW MANY PHOTOS TRAVEL, AND WHY THERE IS A CAP AT ALL.
//
// Each photo is one metered documentapi call and rides along as an email attachment. A phone
// camera capture runs 1-3MB, so an 8-photo delivery is ~20MB before base64 — past what is
// sensible to push through Resend on every low rating, and slow to open on a phone.
//
// Six is chosen against the real failure: a delivery gone wrong that the driver documented
// heavily. Six photos is enough to see the door, the freight and the paperwork; beyond that
// the extra frames are duplicates of the same pallet. Whatever is left over is NAMED in the
// email rather than silently dropped — a cap nobody is told about reads as "this is all of
// them", which is exactly the kind of confident wrong sentence this repo has shipped before.
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

/**
 * Split the document list into what travels and what only gets named.
 * Returns { photos, skippedPhotos, otherDocs } — `skippedPhotos` is the honest overflow.
 */
function selectPhotos(docs, max = MAX_PHOTOS) {
  const all = Array.isArray(docs) ? docs : [];
  const photos = all.filter(isPhotoDoc);
  return {
    photos: photos.slice(0, max),
    skippedPhotos: photos.slice(max),
    otherDocs: all.filter((d) => !isPhotoDoc(d)),
  };
}

/**
 * Stop adding attachments once the running total would pass the byte ceiling. Returns the
 * ones that fit plus the ones that did not, so the email can say so.
 */
function fitWithinBudget(fetched, maxBytes = MAX_PHOTO_BYTES) {
  const kept = [];
  const dropped = [];
  let total = 0;
  for (const f of fetched || []) {
    const size = f && f.bytes ? f.bytes : 0;
    if (!f || !f.base64) { dropped.push(f); continue; }
    if (total + size > maxBytes) { dropped.push(f); continue; }
    total += size;
    kept.push(f);
  }
  return { kept, dropped, totalBytes: total };
}

/** A stable, human filename for an attachment: PRO + index + real extension. */
function attachmentName(pro, i, doc) {
  const ext = (doc && doc.extension) || 'jpg';
  const base = String(pro || 'delivery').replace(/[^A-Za-z0-9_-]+/g, '') || 'delivery';
  return `${base}-photo-${i + 1}.${ext}`;
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
function customerBlockHtml(customer) {
  if (!customer || !customer.present) {
    // Saying nothing would read as "this stop has no customer", which is never true. Naming
    // the miss is what tells somebody the lookup failed rather than the data being empty.
    return `<div style="background:#f7f8fa;padding:14px;border-radius:6px;margin:16px 0">
      <div style="${LABEL}">Customer</div>
      <div style="color:#667;font-size:13px;margin-top:4px">Couldn't be resolved from the PRO — look it up on the dashboard.</div>
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
 * WHAT THE DRIVER LEFT. The photos ride as attachments rather than inline base64: Gmail clips
 * an HTML body past roughly 102KB and hides everything after the cut — which would include
 * the dashboard link — while an image attachment previews in the client anyway, on a phone as
 * well as a desktop. So this block is the caption, and the pictures come with it.
 *
 * `attached` are the ones that made it; `missing` covers a fetch that failed, the per-email
 * cap and the byte ceiling. All three are stated, because "3 photos" printed over a delivery
 * that had eight is the sentence that gets believed.
 */
function photosBlockHtml({ attached = [], missing = 0, otherDocs = [] } = {}) {
  const parts = [`<div style="${LABEL}">Delivery photos</div>`];
  if (attached.length) {
    parts.push(`<div style="font-size:13px;color:#445;margin-top:4px">${attached.length} photo${attached.length === 1 ? '' : 's'} attached to this email.</div>`);
    const names = attached.map((a) => {
      const when = a.createdTime ? ` <span style="color:#889">${esc(a.createdTime)}</span>` : '';
      return `<li style="margin:2px 0">${esc(a.filename)}${when}</li>`;
    }).join('');
    parts.push(`<ul style="font-size:12px;color:#667;margin:6px 0 0;padding-left:18px">${names}</ul>`);
  } else {
    parts.push(`<div style="font-size:13px;color:#445;margin-top:4px">No delivery photos were available for this PRO.</div>`);
  }
  if (missing > 0) {
    parts.push(`<div style="font-size:12px;color:#a15c00;margin-top:6px">${missing} more photo${missing === 1 ? '' : 's'} on this stop ${missing === 1 ? 'was' : 'were'} not attached — see the dashboard.</div>`);
  }
  if (otherDocs.length) {
    parts.push(`<div style="font-size:12px;color:#667;margin-top:6px">Also on file: ${otherDocs.map((d) => esc(d.documentName || d.extension || 'document')).join(', ')}</div>`);
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
  fitWithinBudget,
  attachmentName,
  customerBlockHtml,
  photosBlockHtml,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  PHOTO_EXTS,
};
