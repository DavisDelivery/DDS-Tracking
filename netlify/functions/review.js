const fetch = require("node-fetch");

// Resend's shared onboarding@resend.dev sender only delivers to the Resend
// account owner's address, and matches it case-sensitively — so normalize to
// lowercase (a capital-C "Chad@..." was being rejected with HTTP 403, which is
// why no alert emails were going out). To email recipients other than the
// owner, verify a domain at resend.com/domains and set REVIEW_FROM to an
// address on that domain.
const REVIEW_EMAIL = (process.env.REVIEW_EMAIL || "chad@davisdelivery.com").trim().toLowerCase();
const MAIL_FROM = process.env.REVIEW_FROM || "Davis Delivery Alerts <onboarding@resend.dev>";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// NuVizz credentials — same env vars track.js uses. Reviews carry only a PRO,
// so we resolve the delivering driver from NuVizz once (at submit time) and
// store it on the review, giving the dashboard per-driver attribution.
//
// This comment used to name a "MarginIQ Reviews tab" and a "Driver Scorecard
// Reviews tab" as further readers. NEITHER EXISTS. Searched the dispatch app
// for the blob store, this function's URL, DASHBOARD_KEY and the record's own
// field names: nothing over there reads a review record at all. The only
// consumers are public/admin.html and lib/followup-core.js, both in this repo.
// Corrected rather than deleted because the false version was load-bearing —
// it was cited as the reason not to rename routedTo.
const DAVIS_USER = process.env.NUVIZZ_DAVIS_USER || "Chad";
const DAVIS_PASS = process.env.NUVIZZ_DAVIS_PASS;
const ULINE_USER = process.env.NUVIZZ_ULINE_USER || "Chad";
const ULINE_PASS = process.env.NUVIZZ_ULINE_PASS;
const NUVIZZ_BASE = "https://portal.nuvizz.com/deliverit/openapi/v7";

// Pull the first present value across a set of candidate key paths. NuVizz
// surfaces the driver under different keys depending on load vs stop payload,
// so we probe several rather than hard-coding one that may be absent.
function firstVal(obj, paths) {
  if (!obj) return "";
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Resolve { driver, driverId, wrap } for a PRO via NuVizz. Best-effort: returns empty
// strings (never throws) so a NuVizz hiccup never blocks a review submission.
//
// `wrap` is the WHOLE /stop/info response object this call already paid for. It used to be
// read for two fields and discarded, while the customer of record and the delivery-photo
// references — both things the alert email was missing — were sitting in it the entire time.
// Returning it is what makes the customer block cost ZERO extra NuVizz calls.
async function resolveDriver(rawPro) {
  // Same normalization the tracking lookup uses: a review can be submitted with
  // whatever the customer had in front of them ("SHP-27000", "PRO # 007107386",
  // "estes-0831846593"), and punctuation used to drop driver attribution
  // entirely. Carrier orders are filed under a hyphenated stop number, so the
  // hyphen is kept as well as stripped.
  const hyph = String(rawPro == null ? "" : rawPro)
    .toUpperCase().replace(/[^A-Z0-9-]+/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const norm = String(rawPro == null ? "" : rawPro).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm || !DAVIS_PASS) return { driver: "", driverId: "", wrap: null };

  const candidates = [];
  const add = (v) => {
    if (v && /^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/.test(v) && !candidates.includes(v)) candidates.push(v);
  };
  if (hyph !== norm) add(hyph);
  if (/^\d+$/.test(norm)) {
    if (norm.length < 9) add(norm.padStart(9, "0"));
    add(norm);
    const bare = norm.replace(/^0+/, "");
    if (bare && bare !== norm) {
      if (bare.length < 9) add(bare.padStart(9, "0"));
      add(bare);
    }
  } else {
    add(norm);
  }
  if (!candidates.length) return { driver: "", driverId: "", wrap: null };

  const davisAuth = "Basic " + Buffer.from(`${DAVIS_USER}:${DAVIS_PASS}`).toString("base64");

  try {
    let stopData = null;
    let load = null;
    for (const cand of candidates) {
      const r = await fetch(`${NUVIZZ_BASE}/stop/info/${cand}/DAVIS`, {
        headers: { Authorization: davisAuth },
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.Stop && j.Stop.stop) {
          stopData = j.Stop;
          load = j.Stop.load || null;
          break;
        }
      }
    }
    if (!stopData) return { driver: "", driverId: "", wrap: null };

    // The assigned driver rides on the load object embedded in the stop
    // response (load.driverName / load.driverId) — check there first, then
    // the stop-level execution info.
    const exe = stopData.stopExecutionInfo || {};
    let driver = firstVal(load, ["driverName", "driver.driverName", "driver.name"]) ||
      firstVal(exe, ["driverName", "driver.driverName", "driver.name", "assignedDriver"]);
    let driverId = firstVal(load, ["driverId", "driver.driverId", "driver.id"]) ||
      firstVal(exe, ["driverId", "driver.driverId", "driver.id"]);

    // Fall back to a load/info call — the assigned driver lives on the route header.
    if ((!driver || !driverId) && load && load.loadNbr) {
      const r = await fetch(`${NUVIZZ_BASE}/load/info/${load.loadNbr}/DAVIS`, {
        headers: { Authorization: davisAuth },
      });
      if (r.ok) {
        const ld = await r.json();
        const L = (ld && ld.Load) || {};
        const lexe = L.loadExecutionInfo || {};
        driver = driver || firstVal(L, ["driverName", "driver.driverName", "driver.name"]) ||
          firstVal(lexe, ["driverName", "driver.driverName", "driver.name", "assignedDriver"]);
        driverId = driverId || firstVal(L, ["driverId", "driver.driverId", "driver.id"]) ||
          firstVal(lexe, ["driverId", "driver.driverId", "driver.id"]);
      }
    }
    return { driver: driver || "", driverId: driverId || "", wrap: stopData };
  } catch (err) {
    console.log("resolveDriver error (non-fatal):", err.message);
    return { driver: "", driverId: "", wrap: null };
  }
}

// The store, the Google URL and the source allow-list all live in lib/reviews now — the
// click redirect and the follow-up mailer have to agree with this file about every one of
// them, and three hand-copied definitions is how they stop agreeing.
const {
  GOOGLE_REVIEW_URL, reviewsStore, clicksStore, normalizeSource, SOURCE_LABEL,
  trackedGoogleUrl, cleanRef, withClicks, postRateByClient,
} = require("./lib/reviews");

const { ownerThanksMailto, mailtoAttr } = require("./lib/owner-thanks");

const {
  extractCustomer, extractPodDocs, selectPhotos, customerBlockHtml, photosBlockHtml, esc,
} = require("./lib/stop-context");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // GET = fetch reviews for the dashboards
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    const pwd = q.key;
    if (pwd !== (process.env.DASHBOARD_KEY || "davis2026")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    // Diagnostic: confirm notification wiring without exposing any secret value.
    if (q.diag === "1") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          resendConfigured: !!RESEND_API_KEY,
          reviewEmail: REVIEW_EMAIL,
          mailFrom: MAIL_FROM,
          nuvizzDavisConfigured: !!DAVIS_PASS,
        }),
      };
    }
    try {
      const store = reviewsStore();
      const list = await store.list();
      const reviews = [];
      for (const blob of list.blobs) {
        const data = await store.get(blob.key, { type: "json" });
        if (data) reviews.push(data);
      }

      // Lazy backfill: attribute any review that predates driver capture or
      // whose earlier lookup came back empty (bounded retries so permanently
      // unresolvable PROs don't hit NuVizz forever). Bounded per request so a
      // big backlog can't time the function out — the rest fill in on
      // subsequent loads.
      const backfillCap = 8;
      const maxAttempts = 3;
      let backfilled = 0;
      for (const rv of reviews) {
        if (backfilled >= backfillCap) break;
        const attempts = rv.driverAttempts || 0;
        if (rv.driverResolved && rv.driver) continue;
        if (rv.driverResolved && attempts >= maxAttempts) continue;
        if (!rv.proNumber) { rv.driver = rv.driver || ""; rv.driverResolved = true; continue; }
        const { driver, driverId } = await resolveDriver(rv.proNumber);
        rv.driver = driver;
        rv.driverId = driverId;
        rv.driverResolved = true;
        rv.driverAttempts = attempts + 1;
        // RE-READ, THEN MERGE ONLY THE DRIVER FIELDS. Writing `rv` back wholesale writes a
        // record that was read at the top of this handler, before a NuVizz round-trip —
        // and in that window the follow-up mailer may have stamped followupClaimedAt or
        // followupSentAt on the same key. A blind write erases them, and the customer gets
        // a second "would you post a review?" on the next hourly run. This dashboard
        // auto-logs-in from localStorage, so this path runs on every admin page load.
        try {
          const current = (await store.get(rv.id, { type: "json" })) || rv;
          await store.setJSON(rv.id, {
            ...current,
            driver: rv.driver,
            driverId: rv.driverId,
            driverResolved: true,
            driverAttempts: rv.driverAttempts,
          });
        } catch (e) { /* non-fatal: the retry counter simply does not advance */ }
        backfilled++;
      }

      reviews.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

      // Join the observed clicks on. Best-effort: if the click store is unreachable, every
      // row reports googleClickAt: null, which reads as "we cannot show a click" rather than
      // as "nobody clicked" — the dashboard is worded for that, and a dead store must not
      // take the whole reviews list down with it.
      let clicksByRef = {};
      let clicksReadable = true;
      try {
        const clicks = clicksStore();
        const refs = [...new Set(reviews.map((r) => r && r.clickRef).filter(Boolean))];
        const rows = await Promise.all(refs.map(async (ref) => {
          try { return [ref, await clicks.get(ref, { type: "json" })]; } catch { return [ref, null]; }
        }));
        for (const [ref, row] of rows) if (row) clicksByRef[ref] = row;
      } catch (err) {
        clicksReadable = false;
        console.error("click store unreadable (non-fatal):", err && err.message);
      }

      // THE SAME NOTE, BUILT WHERE THE ANSWER IS ACTUALLY KNOWN.
      //
      // The alert email is sent the instant the customer hits Send, so it cannot say whether
      // the review reached Google — its own footer says so, and its note is hedged for it.
      // HERE the click has either been stamped or it has not, which is the one place the
      // sentence Chad asked for ("their review didn't make it to Google") is a fact rather
      // than a guess. So each row carries its own note, graded by its own click state:
      //   not taken  → the definite apology and the link
      //   taken      → a thank-you with NO apology, NO link and NO ask. Apologising for a
      //                review that did not fail, and asking again for one they may already
      //                have left, spends goodwill for nothing.
      //   untracked  → the hedged wording, because "no clickRef" means we never could tell.
      // Built server-side from the same lib the alert uses, so the two can never drift.
      const joined = withClicks(reviews, clicksByRef);
      const withNotes = joined.map((r) => {
        const trackable = !!(r && r.clickRef) && clicksReadable;
        // WHAT WE KNOW BEATS WHAT WE INFERRED. googleClickAt says they ARRIVED at Google,
        // which is the best the machine can do alone — and it is the wrong fact for this
        // note. Once Chad has marked the row against his Business Profile we know whether a
        // review actually appeared, so that answer wins outright.
        //
        // Without this the screen contradicts itself: a row marked "did not post" was still
        // offering the no-apology, no-ask thank-you, because arriving had been treated as
        // succeeding. Caught by rendering it and reading the card, not by a test.
        const clicked = r && r.postedOnGoogle === true ? true
          : r && r.postedOnGoogle === false ? false
          : (r && r.googleClickAt ? true : (trackable ? false : null));
        const t = ownerThanksMailto({
          review: r, googleUrl: GOOGLE_REVIEW_URL, fallbackTo: r && r.customerEmail, clicked,
        });
        return t
          ? { ...r, thanksHref: t.href, thanksTo: t.to, thanksRecipient: t.recipient, thanksClicked: t.clicked }
          : r;
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          reviews: withNotes, backfilled, clicksReadable,
          // Why half of them never appear on Google — computed, not guessed, and it declines
          // to answer until both arms have enough rows. See postRateByClient.
          postRate: postRateByClient(withNotes),
        }),
      };
    } catch (err) {
      console.error("Fetch reviews error:", err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Fetch failed", detail: err.message }) };
    }
  }

  // DELETE = remove one or more reviews by id (key-gated). Used to purge test
  // records. ids may be a comma-separated list in ?id= or the JSON body.
  // ── DID IT ACTUALLY LAND ON GOOGLE? ────────────────────────────────────────
  //
  // The one fact this system has never held, and the one it most needs. Google tells us
  // nothing: a click means they ARRIVED, and the dashboard has always said so in as many
  // words. Chad can see on his Business Profile which reviews appeared; until now that
  // knowledge lived only in his head, so the machine could not use it for anything —
  // not for the apology note's wording, and not for answering WHY half of them vanish.
  //
  // PATCH, key-gated, and deliberately BEFORE the customer's unauthenticated POST branch so
  // the two can never be confused. Three states, and null is a real one: "not looked at yet"
  // must stay distinguishable from "looked and it wasn't there", or the first summary this
  // produces will report a 0% post rate for a week nobody has checked.
  if (event.httpMethod === "PATCH") {
    const q = event.queryStringParameters || {};
    if (q.key !== (process.env.DASHBOARD_KEY || "davis2026")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
    }
    const id = String(body.id || "").trim();
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing id" }) };
    // Anything that is not an explicit true/false clears the mark back to "not checked".
    const landed = body.landed === true ? true : body.landed === false ? false : null;
    try {
      const store = reviewsStore();
      // RE-READ, THEN MERGE ONE FIELD. Never write the record we think we have: the driver
      // backfill and the follow-up mailer both touch the same key, and a blind write here
      // would erase followupClaimedAt and mail the customer a second time.
      const current = await store.get(id, { type: "json" });
      if (!current) return { statusCode: 404, headers, body: JSON.stringify({ error: "No such review" }) };
      await store.setJSON(id, {
        ...current,
        postedOnGoogle: landed,
        postedOnGoogleAt: landed === null ? null : new Date().toISOString(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id, landed }) };
    } catch (err) {
      console.error("landed mark failed:", err && err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Write failed" }) };
    }
  }

  if (event.httpMethod === "DELETE") {
    const q = event.queryStringParameters || {};
    if (q.key !== (process.env.DASHBOARD_KEY || "davis2026")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    let ids = [];
    if (q.id) ids = String(q.id).split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length && event.body) {
      try {
        const b = JSON.parse(event.body);
        if (Array.isArray(b.ids)) ids = b.ids;
        else if (b.id) ids = [b.id];
      } catch { /* ignore */ }
    }
    if (!ids.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing id" }) };
    }
    try {
      const store = reviewsStore();
      const clicks = clicksStore();
      const deleted = [];
      for (const id of ids) {
        try {
          // Take the click record with it. Deleting only the review leaves an orphan in
          // review-clicks that nothing will ever read or clean up, and these ids are used
          // to purge test records, so the orphans would be pure accumulation.
          const row = await store.get(id, { type: "json" });
          if (row && row.clickRef) { try { await clicks.delete(row.clickRef); } catch (e) { /* skip */ } }
          await store.delete(id);
          deleted.push(id);
        } catch (e) { /* skip */ }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ deleted }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Delete failed", detail: err.message }) };
    }
  }

  // POST = submit a review
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { rating, comment, name, contact, proNumber, src, ref } = payload;

  if (!rating || rating < 1 || rating > 5) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid rating" }) };
  }

  const proClean = (proNumber || "").trim().slice(0, 50);

  // Resolve the delivering driver up front so every reader is attributed.
  const { driver, driverId, wrap } = await resolveDriver(proClean);

  const review = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    rating: Number(rating),
    comment: (comment || "").trim().slice(0, 2000),
    name: (name || "").trim().slice(0, 100),
    contact: (contact || "").trim().slice(0, 200),
    proNumber: proClean,
    driver: driver || "",
    driverId: driverId || "",
    driverResolved: true,
    driverAttempts: 1,
    submittedAt: new Date().toISOString(),
    // WHICH BUTTON THEY CAME FROM. Chad: "i want to track where the review came from
    // tracking or delivery emails". The delivery email's two CTAs now carry src=review-email
    // and src=track-email; a visit with no tag reads "direct". Allow-listed on the way in —
    // this value arrives in a URL the customer can edit and is rendered on the dashboard.
    source: normalizeSource(src),
    // The browser-minted ref this submission's Google button points at. NOT the record's key
    // — see lib/reviews. Null when the customer never had a Google button (a 1-3 star) or an
    // old cached page posted without one; the join then simply finds no click, which is the
    // truth.
    clickRef: cleanRef(ref),
    // KEPT EXACTLY AS IT WAS, deliberately. `routedTo` says which BRANCH the submission
    // took — public (Google) or private (internal follow-up) — and downstream readers key
    // off that. What it never meant, and was widely read as, is "a review reached Google".
    // That question is now answered by googleClickAt, which g.js writes only when the
    // customer actually takes the link. Renaming this would have broken the readers;
    // leaving it while adding the honest field alongside does not.
    routedTo: rating >= 4 ? "google" : "internal",
  };

  // Store in Netlify Blobs
  try {
    const store = reviewsStore();
    await store.setJSON(review.id, review);
  } catch (err) {
    console.error("Blob storage error:", err);
  }

  // WHO IT WAS FOR, AND WHAT THE DRIVER PHOTOGRAPHED. Chad: "these emails ... i want to start
  // to include the customers information and the photos of the delivery."
  //
  // NO I/O HAPPENS HERE. Both blocks are pure reads of the /stop/info response resolveDriver
  // already fetched, so the whole enrichment costs ZERO additional NuVizz calls and adds no
  // measurable time to the customer's rating POST.
  //
  // The first version of this downloaded the photo bytes here and attached them. That put six
  // sequential multi-megabyte downloads on the customer's critical path (measured at 9-19s
  // against a stubbed document server, against a Netlify ceiling well under it), could wedge
  // the handler before the alert was ever sent, and turned a public unauthenticated POST into
  // up to ~40 metered NuVizz calls. The photos are LINKED instead — see lib/stop-context.
  const customer = wrap ? extractCustomer(wrap) : null;
  const { photos, otherDocs } = selectPhotos(extractPodDocs(wrap));
  const customerHtml = customerBlockHtml(customer, { pro: proClean });
  const photosHtml = photosBlockHtml({ photos, otherDocs, pro: proClean, resolved: !!wrap });

  // KEEP THE ORDER'S ADDRESS ON THE RECORD, so the dashboard can offer the same button.
  //
  // The alert has `customer` in hand; the dashboard does not — it reads the stored review and
  // nothing else, and re-resolving the PRO there would put a NuVizz call on every page load.
  // Without this field an anonymous five-star (the exact case Chad hit) can never get a button
  // on the dashboard either, no matter what we know by then about the Google click.
  //
  // RE-READ, THEN MERGE. Never setDoc-style over the whole record: the follow-up mailer can
  // stamp followupClaimedAt on the same key in this window, and a blind write erases it and
  // sends the customer a second "would you post a review?". Same hazard, same fix as the
  // driver backfill below. Best-effort — a review that stores without this field simply has
  // no dashboard button, which is where it already was.
  if (customer && customer.email) {
    try {
      const store = reviewsStore();
      const current = (await store.get(review.id, { type: "json" })) || review;
      await store.setJSON(review.id, {
        ...current,
        customerEmail: customer.email,
        customerName: customer.name || "",
      });
    } catch (e) { /* non-fatal: the alert below still carries the button */ }
  }

  // Email if rating is 3 or below
  if (rating <= 3 && RESEND_API_KEY) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: REVIEW_EMAIL,
          reply_to: REVIEW_EMAIL,
          subject: `⚠️ ${rating}-Star Review — PRO# ${review.proNumber || "Unknown"}`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <div style="background:linear-gradient(135deg,#0a2744,#1e5b92);color:#fff;padding:20px;border-radius:8px;margin-bottom:16px">
                <h1 style="margin:0;font-size:20px">⚠️ Low Rating Alert</h1>
                <div style="font-size:13px;opacity:.8;margin-top:4px">Davis Delivery Tracking Portal</div>
              </div>
              <div style="background:#fff;padding:20px;border:1px solid #dde2e8;border-radius:8px">
                <div style="font-size:28px;color:#e8a838;letter-spacing:3px;margin-bottom:12px">${"★".repeat(rating)}<span style="color:#dde2e8">${"★".repeat(5 - rating)}</span></div>
                <p style="margin:6px 0"><strong>PRO #:</strong> ${review.proNumber || "Not provided"}</p>
                <p style="margin:6px 0"><strong>Driver:</strong> ${review.driver || "Unattributed"}</p>
                <p style="margin:6px 0"><strong>Review left by:</strong> ${esc(review.name) || "Anonymous"}</p>
                <p style="margin:6px 0"><strong>Their contact:</strong> ${esc(review.contact) || "Not provided"}</p>
                ${review.comment ? `<div style="background:#fef5f5;padding:16px;border-left:4px solid #d63b3b;margin:16px 0;border-radius:4px"><strong>What they said:</strong><br>${review.comment.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>` : ''}
                ${customerHtml}
                ${photosHtml}
                <p style="color:#666;font-size:12px;margin-top:16px;padding-top:16px;border-top:1px solid #f0f2f5">Submitted ${new Date(review.submittedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} EST</p>
                <p style="color:#666;font-size:12px;margin:4px 0">🔒 This review was captured internally and was NOT sent to Google.</p>
                <p style="color:#666;font-size:12px;margin:4px 0">📊 <a href="https://davisdeliverytracking.netlify.app/admin" style="color:#1e5b92">View full dashboard</a></p>
              </div>
            </div>
          `,
        }),
      });
      // Status FIRST, and the body only as text. The last outage this file records was a
      // silent HTTP 403 from Resend (see the header) — and the one number that would have
      // diagnosed it was the one never captured. Worse, .json() ran before the ok-check, so
      // a non-JSON error body threw and the outer catch reported a Resend rejection as
      // "Email send error: Unexpected token", i.e. as a network fault.
      if (!emailRes.ok) {
        console.error("Resend API error:", emailRes.status, await emailRes.text().catch(() => "<unreadable body>"));
      }
    } catch (err) {
      console.error("Email send error:", err);
    }
  }

  // Heads-up on 5-star reviews too — not just route to Google silently — so
  // the owner sees the win in real time. (4-star still routes to Google with
  // no email; ≤3-star sends the alert above.)
  //
  // THE OWNER'S THANK-YOU, prepared but not sent. Chad asked to be able to tap the customer's
  // address in this alert and have a thank-you with the Google link already written — sent
  // from his own mailbox, so it reads like a person rather than a second robot.
  //
  // GOOGLE'S OWN URL, not the tracked /g hop. Chad: "i want it to have a link straight to
  // google ... i don't want to link them back to my page." In a plain-text note there is no
  // anchor text to hide a URL behind, so the customer reads whichever one we put there. The
  // cost — this click cannot stamp googleClickAt, so the automatic follow-up may still nudge
  // someone he has written to personally — is spelled out in lib/owner-thanks.
  //
  // AND WHEN THE REVIEWER LEFT NO ADDRESS, THE ORDER'S CONTACT IS THE FALLBACK. Chad, on a
  // five-star alert with no button on it: "Where is my button to generate my email to customer
  // saying their review didn't make it to Google". That review was anonymous with no contact,
  // so ownerThanksMailto returned null and the button vanished — while the customer's own
  // address sat 200px further down the same email, linked as a bare mailto that opens an EMPTY
  // compose window. The reviewer's address still wins whenever there is one; this only fills
  // the case where there was none at all, and the note says what is actually true (somebody
  // there rated a delivery, anonymously) rather than thanking a named person for a review they
  // may not have written.
  const thanks = ownerThanksMailto({
    review, googleUrl: GOOGLE_REVIEW_URL, fallbackTo: customer && customer.email,
  });
  // No address to write to (the field also collects phone numbers) → the contact stays plain
  // text and no button appears. A mailto: to a phone number opens a compose window that looks
  // fine and goes nowhere, which is worse than no link at all.
  const contactHtml = thanks && thanks.recipient === "reviewer"
    ? `<a href="${mailtoAttr(thanks.href)}" style="color:#1e5b92">${esc(review.contact)}</a>`
    : (esc(review.contact) || "Not provided");
  // WHO THE BUTTON WRITES TO, ON THE BUTTON. Chad taps this on a phone without reading the
  // rest of the card; a button that silently addressed the account contact instead of the
  // reviewer would be the kind of surprise that gets found after it is sent.
  const thanksLabel = thanks && thanks.recipient === "account"
    ? "✉️ Write to the customer &amp; ask for a Google review"
    : "✉️ Thank them &amp; ask for a Google review";
  const thanksNote = thanks && thanks.recipient === "account"
    ? `Goes to <strong>${esc(thanks.to)}</strong>, the contact on the order — the review itself was left anonymously. Opens your mail app with the note already written.`
    : "Opens your mail app with the note already written — read it, change anything, send.";
  const thanksHtml = thanks
    ? `<p style="margin:16px 0 4px"><a href="${mailtoAttr(thanks.href)}" style="display:inline-block;background:#15803d;color:#fff;padding:13px 22px;border-radius:6px;font-weight:700;text-decoration:none;font-size:15px">${thanksLabel}</a></p>
                <p style="color:#666;font-size:12px;margin:0 0 4px">${thanksNote}</p>`
    : '';

  if (rating === 5 && RESEND_API_KEY) {
    try {
      const posRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: REVIEW_EMAIL,
          reply_to: REVIEW_EMAIL,
          subject: `⭐ 5-Star Review — PRO# ${review.proNumber || "Unknown"}`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <div style="background:linear-gradient(135deg,#0a2744,#1e5b92);color:#fff;padding:20px;border-radius:8px;margin-bottom:16px">
                <h1 style="margin:0;font-size:20px">⭐ 5-Star Review</h1>
                <div style="font-size:13px;opacity:.8;margin-top:4px">Davis Delivery Tracking Portal</div>
              </div>
              <div style="background:#fff;padding:20px;border:1px solid #dde2e8;border-radius:8px">
                <div style="font-size:28px;color:#e8a838;letter-spacing:3px;margin-bottom:12px">★★★★★</div>
                <p style="margin:6px 0"><strong>PRO #:</strong> ${review.proNumber || "Not provided"}</p>
                <p style="margin:6px 0"><strong>Driver:</strong> ${review.driver || "Unattributed"}</p>
                <p style="margin:6px 0"><strong>Review left by:</strong> ${esc(review.name) || "Anonymous"}</p>
                <p style="margin:6px 0"><strong>Their contact:</strong> ${contactHtml}</p>
                ${review.comment ? `<div style="background:#f0f9f3;padding:16px;border-left:4px solid #15803d;margin:16px 0;border-radius:4px"><strong>What they said:</strong><br>${review.comment.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>` : ''}
                ${thanksHtml}
                ${customerHtml}
                ${photosHtml}
                <p style="color:#666;font-size:12px;margin-top:16px;padding-top:16px;border-top:1px solid #f0f2f5">Submitted ${new Date(review.submittedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} EST</p>
                <p style="color:#666;font-size:12px;margin:4px 0">🔗 They were handed the Google review link. Whether they actually took it shows on the dashboard — this email is sent the moment they hit Send, so at this instant nobody knows yet.</p>
                <p style="color:#666;font-size:12px;margin:4px 0">📍 Came from: <strong>${SOURCE_LABEL[review.source] || review.source}</strong></p>
                <p style="color:#666;font-size:12px;margin:4px 0">📊 <a href="https://davisdeliverytracking.netlify.app/admin" style="color:#1e5b92">View full dashboard</a></p>
              </div>
            </div>
          `,
        }),
      });
      if (!posRes.ok) {
        console.error("5-star email error:", posRes.status, await posRes.text().catch(() => "<unreadable body>"));
      }
    } catch (err) {
      console.error("5-star email send error:", err);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      routedTo: review.routedTo,
      // Kept for older cached pages, which still read googleUrl off this response and open
      // it themselves. Current pages never wait for it: their Google button is an anchor
      // whose href was final before this request was sent, because waiting on a POST is the
      // thing that broke the hand-off in the first place.
      googleUrl: rating >= 4 ? trackedGoogleUrl(review.clickRef || review.id) : null,
      googleDirectUrl: rating >= 4 ? GOOGLE_REVIEW_URL : null,
      reviewId: review.id,
      source: review.source,
    }),
  };
};
