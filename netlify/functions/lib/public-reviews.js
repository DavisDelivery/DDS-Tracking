// Sanitiser for the PUBLIC review feed served to davisdelivery.com.
//
// ─── READ THIS BEFORE CHANGING ANYTHING ───────────────────────────────────
// The `reviews` store holds customer PII: email addresses, phone numbers, full
// names, PRO numbers, and the delivering driver. NONE of that may leave this
// module. Output is built by an explicit ALLOW-LIST — fields are copied one at
// a time into a fresh object. Never spread a source record, and never "just
// add" a field without deciding it is safe to show a stranger.
//
// What goes out: rating, comment, a display name, a date, and an opaque id.
//
// ─── PRO NUMBERS: NEVER PUBLISHED, NO EXCEPTIONS ──────────────────────────
// Standing instruction from the owner: "Don't publish the pro numbers at all."
// Three independent layers enforce it, and each one is load-bearing:
//   1. `proNumber` is not in the allow-list, and the store's own id is hashed —
//      backfilled records are keyed `restored-20260617-007130000`, and the
//      trailing segment IS the PRO number.
//   2. `scrubComment()` strips PRO-shaped text a customer may have typed into
//      the free-text box, including spaced, hyphenated and leading-zero-dropped
//      forms, plus anything following a PRO/BOL/tracking label.
//   3. `containsPro()` is the final gate: the finished object is re-scanned
//      digits-only against that record's PRO. A hit DROPS the record rather
//      than patching it. Silence beats a leak.
// If you relax any of these you are overriding an explicit owner instruction.
//
// Everything here is PURE — no Blobs, no network — so test/public-reviews.test.mjs
// can run the real 23 records through it with no infrastructure.

const crypto = require("crypto");

// Words that stay upper-case when tidying a shouty company name.
const KEEP_UPPER = new Set([
  "LLC", "INC", "LTD", "CO", "USA", "US", "HVAC", "IT", "AC", "TV", "RV",
  "LP", "LLP", "PC", "DC", "NE", "NW", "SE", "SW", "II", "III", "IV",
]);

function tidyCompany(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  // Leave mixed-case names alone — they were typed deliberately.
  if (s !== s.toUpperCase()) return s;
  return s
    .split(/\s+/)
    .map((w) => {
      const bare = w.replace(/[^A-Za-z0-9]/g, "");
      if (KEEP_UPPER.has(bare)) return w;
      if (bare.length <= 2 && /\d/.test(bare)) return w; // E2, 3M, A1
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join(" ");
}

// The name shown publicly. A surname is never published in full.
//   "Yvette Summerour"        -> "Yvette S."
//   "Sean"                    -> "Sean"
//   "" + "WESCO DISTRIBUTION" -> "Wesco Distribution"
//   nothing                   -> "Verified customer"
function displayName(personal, company) {
  const p = (personal || "").trim();
  if (p) {
    const parts = p.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
  }
  return tidyCompany(company) || "Verified customer";
}

// Every punctuation-tolerant way a customer might write a given PRO.
// "007169763" also has to be caught as "7169763", "007 169 763", "007-169-763".
function proVariants(pro) {
  const digits = String(pro || "").replace(/\D/g, "");
  if (digits.length < 6) return [];
  const out = new Set([digits]);
  const trimmed = digits.replace(/^0+/, "");
  if (trimmed.length >= 6) out.add(trimmed);
  return [...out];
}

// Match a digit string even when broken up by spaces, hyphens, dots or slashes.
function loosePattern(digits) {
  return new RegExp(digits.split("").join("[\\s.\\-/]*"), "g");
}

// Strip contact details and shipment references from the free-text comment box.
// `pro` is this record's own PRO when we have it — an exact strip on top of the
// shape-based rules.
function scrubComment(raw, pro) {
  let s = (raw || "").trim();
  if (!s) return null;

  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[removed]");
  s = s.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "[removed]");

  for (const v of proVariants(pro)) s = s.replace(loosePattern(v), "[removed]");

  // Labelled references: "PRO 7169763", "pro# 007-169-763", "BOL 12345",
  // "tracking number 007169763".
  s = s.replace(
    /\b(?:pro|p\.?r\.?o\.?|bol|b\/l|tracking|track|shipment|order|invoice|ref(?:erence)?)\b\s*(?:#|no\.?|num(?:ber)?|:)?\s*[A-Za-z]{0,3}[-\s]?[\d][\d\s.\-/]{2,}\d/gi,
    "[removed]"
  );

  // Any remaining long digit run, spaced or not (6+ digits total).
  s = s.replace(/\d(?:[\s.\-/]*\d){5,}/g, "[removed]");

  s = s.replace(/\s+/g, " ").trim();
  return s || null;
}

// The store's own ids are NOT safe to publish (see the header note). An opaque
// hash keeps a stable render key without carrying any data out.
function opaqueId(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 12);
}

// FINAL GATE. Flatten the finished public object to digits only and look for
// this record's PRO, so spacing, punctuation and interleaved words all collapse.
function containsPro(publicObj, pro) {
  const variants = proVariants(pro);
  if (!variants.length) return false;
  const digits = [publicObj.comment, publicObj.author, publicObj.id, publicObj.date]
    .map((v) => String(v == null ? "" : v))
    .join(" ")
    .replace(/\D/g, "");
  return variants.some((v) => digits.includes(v));
}

function toPublic(r) {
  // ALLOW-LIST. Build a new object; never spread `r`.
  const rating = Number(r.rating);
  if (!Number.isFinite(rating)) return null;

  const pub = {
    id: opaqueId(r.id),
    rating,
    comment: scrubComment(r.comment, r.proNumber),
    author: displayName(r.name, r.customerName),
    date: r.submittedAt ? String(r.submittedAt).slice(0, 10) : null,
  };

  // Fail closed. Dropping one review costs nothing; publishing a PRO does.
  if (containsPro(pub, r.proNumber)) return null;

  return pub;
}

// Reviews at or above MIN_RATING, with words in them, newest first.
// The averages describe the PUBLISHED set only, so the page that renders them
// cannot imply the filtered selection is every review received.
const DEFAULT_MIN_RATING = 4;
const DEFAULT_MAX = 60;

function buildFeed(all, opts = {}) {
  const minRating = Number.isFinite(opts.minRating) ? opts.minRating : DEFAULT_MIN_RATING;
  const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX;

  const published = (Array.isArray(all) ? all : [])
    .filter((r) => Number(r.rating) >= minRating)
    .map(toPublic)
    .filter(Boolean)
    .filter((r) => r.comment) // a bare star with no words isn't worth showing
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, max);

  const count = published.length;
  const average = count ? published.reduce((s, r) => s + r.rating, 0) / count : null;

  return {
    minRating,
    publishedCount: count,
    publishedAverage: average === null ? null : Number(average.toFixed(2)),
    reviews: published,
  };
}

module.exports = {
  DEFAULT_MIN_RATING,
  DEFAULT_MAX,
  buildFeed,
  containsPro,
  displayName,
  opaqueId,
  proVariants,
  scrubComment,
  tidyCompany,
  toPublic,
};
