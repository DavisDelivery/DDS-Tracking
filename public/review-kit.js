/* Davis Delivery — the review hand-off, shared by the tracking page and /review.
 *
 * ONE FILE BECAUSE THERE USED TO BE THREE. index.html, review.html and the orphaned
 * index_4.html each carried their own copy of this logic, and each copy carried the same
 * bug. Fixing it in two places and missing the third is how a broken hand-off stays live.
 *
 * ── WHAT WENT WRONG, so nobody reintroduces it ──────────────────────────────
 *
 * The old flow was: await the review POST, then copy to the clipboard, then
 * setTimeout(1800) and window.open(google). Every step of that is a mistake.
 *
 *   • window.open from inside a promise callback and a 1.8s timer has no transient
 *     activation. iOS Safari blocks it at anything past ~1s, and the POST alone takes
 *     1.5-5s because it waits on NuVizz. Blocked essentially always on a phone.
 *
 *   • target="_blank" is not a fallback for that. Inside an iOS email client's in-app
 *     browser (WKWebView), a host app that does not implement WKUIDelegate's
 *     createWebViewWith cannot open new windows AT ALL — window.open returns null and
 *     <a target="_blank"> is silently inert. No error, no popup-blocked bar, nothing
 *     happens. Most of these customers arrive by tapping a button in a delivery email,
 *     so that is not an edge case; it is the main path.
 *
 *   • navigator.clipboard.writeText requires a user gesture. Calling it AFTER an awaited
 *     fetch means Safari rejects it — and the old card then told the customer "Your
 *     comment has been copied" anyway, so they tapped-and-held on Google, got no Paste,
 *     and stopped trusting the page at the worst possible moment.
 *
 * ── WHAT IT DOES NOW ────────────────────────────────────────────────────────
 *
 * For a 4-5 star rating the submit control IS the Google link: a real anchor, in the same
 * tab, with no JavaScript anywhere in the navigation path. The browser navigates natively,
 * so there is no popup to block and no activation to lose — and, critically, iOS treats a
 * genuine anchor tap as user-initiated, which is the ONLY thing that triggers the Universal
 * Link hand-off into the Google Maps app. That matters more than it sounds: inside an iOS
 * email webview the cookie jar is isolated from Safari, so a customer who merely LANDS on
 * google.com is signed out and hits a sign-in wall. Reaching the app is the difference
 * between "could post" and "could not".
 *
 * The review POST rides alongside it, fire-and-forget with keepalive so it survives the
 * navigation. That makes the POST best-effort, which is a real cost and the right trade:
 * it used to block the customer for seconds behind NuVizz lookups they do not care about.
 *
 * A 1-3 star rating keeps the old awaited path. Nobody navigates away, so the latency is
 * harmless and confirming the write is worth more there.
 */
(function (global) {
  'use strict';

  var API_REVIEW = '/.netlify/functions/review';
  var CLICK_PATH = '/g';
  var SRC_KEY = 'dds_review_src';
  var KNOWN_SOURCES = ['review-email', 'track-email', 'review-followup', 'direct', 'other'];

  /* Which link brought them here. Chad: "i want to track where the review came from
   * tracking or delivery emails."
   *
   * Read once and kept for the session, because the query string does not survive the
   * page's own re-renders or a customer reloading — and an attribution that evaporates on
   * refresh would quietly relabel email traffic as "direct", which is worse than not
   * measuring it, because it looks measured. */
  function source() {
    var fromUrl = '';
    try {
      fromUrl = new URLSearchParams(global.location.search).get('src') || '';
    } catch (e) { /* very old browser; fall through to storage */ }
    fromUrl = String(fromUrl).trim().toLowerCase().slice(0, 40);
    if (fromUrl && KNOWN_SOURCES.indexOf(fromUrl) === -1) fromUrl = 'other';
    if (fromUrl) {
      try { global.sessionStorage.setItem(SRC_KEY, fromUrl); } catch (e) { /* private mode */ }
      return fromUrl;
    }
    try {
      var saved = global.sessionStorage.getItem(SRC_KEY);
      if (saved && KNOWN_SOURCES.indexOf(saved) !== -1) return saved;
    } catch (e) { /* private mode */ }
    return 'direct';
  }

  /* A ref for the click record, minted HERE rather than by the server, because the anchor's
   * href has to be final before the customer taps it and there is no round-trip to wait for.
   * It is not the review's key — the server keeps its own id — so a forged one is worthless.
   * Lowercase alphanumeric to match the server's REF_RE. */
  function newRef() {
    var s = '';
    try {
      var b = new Uint8Array(12);
      global.crypto.getRandomValues(b);
      for (var i = 0; i < b.length; i++) s += (b[i] % 36).toString(36);
    } catch (e) {
      s = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    return (s + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 32);
  }

  /* Where the Google button points. One hop through our own site so the click is observed,
   * then a 302 on to Google. See netlify/functions/g.js. */
  function googleHref(ref, src) {
    var q = '?rid=' + encodeURIComponent(ref);
    if (src) q += '&src=' + encodeURIComponent(src);
    return CLICK_PATH + q;
  }

  /* Send the review without blocking, and without being cancelled by the navigation that is
   * about to happen. keepalive is exactly this case; sendBeacon covers browsers without it.
   * Never throws — a bookkeeping failure must not stop the hand-off. */
  function postReview(payload) {
    var body = JSON.stringify(payload);
    try {
      if (global.fetch) {
        return global.fetch(API_REVIEW, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () { return null; });
      }
    } catch (e) { /* fall through */ }
    try {
      // text/plain keeps it a simple request (no preflight); the function JSON.parses the
      // body regardless of content type.
      global.navigator.sendBeacon(API_REVIEW, new Blob([body], { type: 'text/plain' }));
    } catch (e) { /* nothing left to try */ }
    return null;
  }

  /* The clipboard write, called synchronously from inside the tap so Safari still counts it
   * as gestured. Returns the promise so the caller can CORRECT the card if it rejects
   * instead of asserting a copy that never happened. */
  function copyComment(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    try {
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        return global.navigator.clipboard.writeText(t);
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  /* Remember that this delivery was already rated.
   *
   * The 4-5 star hand-off navigates the SAME TAB to Google, so the customer leaves the
   * page entirely. When they come back — back button, bfcache restore, or a fresh reload —
   * the naive result is the star form again, asking them to rate a delivery they just
   * rated. This flag is what lets the page greet them with the thank-you card instead, and
   * keep the Google link in reach for anyone who bounced off the sign-in wall.
   *
   * Deliberately NOT done by rewriting the card during the tap: removing the anchor the
   * browser is mid-click on can cancel the very navigation we are trying to guarantee. */
  function submittedKey(pro) { return 'dds_rated_' + String(pro || 'nopro'); }

  function markSubmitted(pro, rating) {
    try { global.sessionStorage.setItem(submittedKey(pro), String(rating || '')); } catch (e) { /* private mode */ }
  }

  function submittedRating(pro) {
    try {
      var v = global.sessionStorage.getItem(submittedKey(pro));
      return v == null || v === '' ? null : Number(v);
    } catch (e) { return null; }
  }

  global.DDSReview = {
    source: source,
    newRef: newRef,
    googleHref: googleHref,
    postReview: postReview,
    copyComment: copyComment,
    markSubmitted: markSubmitted,
    submittedRating: submittedRating,
    KNOWN_SOURCES: KNOWN_SOURCES,
  };
})(window);
