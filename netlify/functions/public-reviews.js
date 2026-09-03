// PUBLIC reviews feed — the one endpoint on this site that is meant to be open.
//
// davisdelivery.com calls it from the browser to render /customer-reviews/ and
// the homepage review carousel. It is unauthenticated and CORS-open BY DESIGN,
// which is exactly why every field it emits has to be decided on purpose.
//
// All of that deciding lives in lib/public-reviews.js — the allow-list, the
// name shortening, the comment scrub, and the three layers that keep PRO
// numbers out. Read that file's header before changing anything here.
//
// This handler is deliberately thin: read the store, hand the records to
// buildFeed(), serve the result. It reads the `reviews` Blobs store DIRECTLY
// rather than calling review.js over HTTP — no dashboard key, no self-request,
// no second place for the key to leak from.

const { reviewsStore } = require("./lib/reviews.js");
const { buildFeed, DEFAULT_MIN_RATING, DEFAULT_MAX } = require("./lib/public-reviews.js");

const MIN_RATING = Number(process.env.PUBLIC_REVIEWS_MIN_RATING || DEFAULT_MIN_RATING);
const MAX_ITEMS = Number(process.env.PUBLIC_REVIEWS_MAX || DEFAULT_MAX);

// 15 minutes at the CDN. Reviews arrive a few a day; nobody needs this fresher,
// and the cache is what keeps a homepage widget off the Blobs store.
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=900",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const store = reviewsStore();
    const list = await store.list();
    const all = [];
    for (const blob of list.blobs) {
      const data = await store.get(blob.key, { type: "json" });
      if (data) all.push(data);
    }

    const feed = buildFeed(all, { minRating: MIN_RATING, max: MAX_ITEMS });

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ generatedAt: new Date().toISOString(), ...feed }),
    };
  } catch (err) {
    // Never leak an internal error message to a public endpoint, and never
    // return a partial or unsanitised list as a "best effort".
    console.error("public-reviews failed:", err && err.message);
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ error: "Reviews are temporarily unavailable", reviews: [] }),
    };
  }
};
