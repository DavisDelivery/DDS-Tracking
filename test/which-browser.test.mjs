// WHY DOES ONLY HALF OF THIS REACH GOOGLE?
//
// Chad: "You currently think it's them not logging in that is stopping them." He was right to
// push, because that was an assumption wearing a measurement's clothes. What was actually
// proven is that Google's server 302s a signed-out request on the review link to
// accounts.google.com/ServiceLogin. Nothing was known about whether any real customer was
// signed out — and most people are signed into Google on a phone.
//
// Three explanations fit "arrived at Google, no review appeared" equally well: signed out of
// an in-app webview, having to start over on a blank Google form, or Google filtering a
// solicited review. Only the first predicts that the failures CONCENTRATE in in-app browsers.
// These tests pin the machinery that tests that prediction — and, just as importantly, its
// refusal to answer before there is enough data to answer with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { clientKind, isInAppWebview, postRateByClient, MIN_PER_ARM, CLIENT_MAX } = require('../netlify/functions/lib/reviews.js');

// Real user-agent strings, not invented ones — an invented UA proves the regex matches the
// regex. These are the shapes the customers in question actually arrive with.
const UA = {
  iosMailWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  mobileSafari:   'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIOS:      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1',
  googleApp:      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/318.0.583722196 Mobile/15E148 Safari/604.1',
  outlookIOS:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Outlook-iOS/709.2226530.prod.iphone',
  androidWebview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36',
  chromeAndroid:  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  desktopChrome:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36',
  facebook:       'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
};

test('THE SIGNATURE THAT MATTERS: an iOS webview has no Safari/ token, Mobile Safari does', () => {
  // This one distinction is the whole experiment. Get it wrong and the two arms are mixed,
  // and the answer that comes out is a coin flip dressed as evidence.
  assert.equal(clientKind(UA.iosMailWebview), 'ios-inapp');
  assert.equal(clientKind(UA.mobileSafari), 'safari-ios');
  assert.ok(isInAppWebview(clientKind(UA.iosMailWebview)));
  assert.ok(!isInAppWebview(clientKind(UA.mobileSafari)));
});

test('a branded iOS browser is never mistaken for a webview', () => {
  // CriOS carries no Version/ token either; a naive "no Safari/" rule would file real Chrome
  // as an in-app webview and poison the arm it is supposed to be the control for.
  assert.equal(clientKind(UA.chromeIOS), 'chrome-ios');
  assert.ok(!isInAppWebview(clientKind(UA.chromeIOS)));
});

test('the named in-app browsers are caught by their own name, not by inference', () => {
  assert.equal(clientKind(UA.googleApp), 'google-app-inapp');
  assert.equal(clientKind(UA.outlookIOS), 'outlook-inapp');
  assert.equal(clientKind(UA.facebook), 'facebook-inapp');
  for (const k of ['google-app-inapp', 'outlook-inapp', 'facebook-inapp']) assert.ok(isInAppWebview(k));
});

test('Android tells us outright with the wv token', () => {
  assert.equal(clientKind(UA.androidWebview), 'android-inapp');
  assert.equal(clientKind(UA.chromeAndroid), 'chrome-android');
  assert.ok(isInAppWebview(clientKind(UA.androidWebview)));
  assert.ok(!isInAppWebview(clientKind(UA.chromeAndroid)));
});

test('a desktop browser is a real browser', () => {
  assert.equal(clientKind(UA.desktopChrome), 'chrome-desktop');
  assert.ok(!isInAppWebview(clientKind(UA.desktopChrome)));
});

test('no user agent is "unknown", and unknown is not an in-app webview', () => {
  // A missing UA must never land in the arm that carries the hypothesis.
  for (const v of ['', null, undefined, '   ', 42, {}]) assert.equal(clientKind(v), 'unknown', String(v));
  assert.ok(!isInAppWebview('unknown'));
  assert.ok(!isInAppWebview(null));
  assert.ok(!isInAppWebview(''));
});

// ── THE SPLIT, AND ITS REFUSAL TO SPEAK TOO SOON ─────────────────────────────
const arrived = (client, posted) => ({
  googleClickAt: '2026-08-27T14:00:00Z', googleClient: client, postedOnGoogle: posted,
});
const many = (n, client, posted) => Array.from({ length: n }, () => arrived(client, posted));

test('TODAY: eleven arrived, none checked — it reports counts and NO answer', () => {
  // The exact state of the store right now: every click predates browser capture and nothing
  // has been marked. A function that returned a verdict here would be inventing one.
  const p = postRateByClient(Array.from({ length: 11 }, () => ({ googleClickAt: '2026-08-27T14:00:00Z' })));
  assert.equal(p.arrived, 11);
  assert.equal(p.checked, 0);
  assert.equal(p.unchecked, 11);
  assert.equal(p.sufficient, false);
  assert.equal(p.leans, null);
  assert.equal(p.notRecorded.arrived, 11, 'a click with no client is its own bucket');
  assert.equal(p.inApp.arrived, 0);
  assert.equal(p.browser.arrived, 0);
});

test('a click from before browser capture is never averaged into either arm', () => {
  // "Not recorded" is a period when nothing was looking. Folding it into the control arm
  // would move the answer with data that cannot speak to the question.
  const p = postRateByClient([
    ...many(3, null, false),
    ...many(2, 'safari-ios', true),
  ]);
  assert.equal(p.notRecorded.checked, 3);
  assert.equal(p.browser.checked, 2);
  assert.equal(p.inApp.checked, 0);
});

test('it will not conclude until BOTH arms have enough rows', () => {
  const lopsided = postRateByClient([
    ...many(MIN_PER_ARM + 3, 'ios-inapp', false),
    ...many(MIN_PER_ARM - 1, 'safari-ios', true),
  ]);
  assert.equal(lopsided.sufficient, false, 'a big arm cannot carry a thin one');
  assert.equal(lopsided.leans, null);
});

test('with both arms filled it reports the comparison the theory predicts', () => {
  const p = postRateByClient([
    ...many(6, 'ios-inapp', false),
    ...many(1, 'ios-inapp', true),
    ...many(6, 'safari-ios', true),
  ]);
  assert.equal(p.sufficient, true);
  assert.equal(p.inApp.landed, 1);
  assert.equal(p.inApp.checked, 7);
  assert.equal(p.browser.landed, 6);
  assert.match(p.leans, /in-app webviews post less often/);
});

test('and it says so plainly when the theory does NOT hold', () => {
  // The result that matters most: if in-app browsers post just as well, the sign-in story is
  // wrong and chasing it would be a week spent on the wrong fix.
  const even = postRateByClient([
    ...many(3, 'ios-inapp', true), ...many(3, 'ios-inapp', false),
    ...many(3, 'safari-ios', true), ...many(3, 'safari-ios', false),
  ]);
  assert.equal(even.sufficient, true);
  assert.match(even.leans, /no difference/);

  const inverted = postRateByClient([
    ...many(6, 'ios-inapp', true), ...many(5, 'safari-ios', false), ...many(1, 'safari-ios', true),
  ]);
  assert.match(inverted.leans, /does not hold/);
});

test('an unanswered row counts as arrived and nothing else', () => {
  // null is a real third state. Treating "not looked at" as "did not post" would report a
  // catastrophic post rate for a week nobody had checked.
  const p = postRateByClient([
    arrived('ios-inapp', null), arrived('ios-inapp', undefined), arrived('ios-inapp', true),
  ]);
  assert.equal(p.inApp.arrived, 3);
  assert.equal(p.inApp.checked, 1);
  assert.equal(p.inApp.landed, 1);
  assert.equal(p.inApp.rate, 1);
});

test('a review that never reached Google is not in the denominator at all', () => {
  // "Did it post?" is a meaningless question about someone who never took the link.
  const p = postRateByClient([
    { googleClickAt: null, googleClient: 'ios-inapp', postedOnGoogle: false },
    arrived('ios-inapp', true),
  ]);
  assert.equal(p.arrived, 1);
  assert.equal(p.inApp.checked, 1);
});

test('empty and malformed input produce an empty answer, not a crash', () => {
  for (const v of [null, undefined, [], [null], [undefined], ['nope']]) {
    const p = postRateByClient(v);
    assert.equal(p.arrived, 0);
    assert.equal(p.sufficient, false);
    assert.equal(p.leans, null);
  }
});

test('the UA cap is small enough to store and big enough to identify', () => {
  assert.ok(CLIENT_MAX >= 200 && CLIENT_MAX <= 1000, `CLIENT_MAX was ${CLIENT_MAX}`);
  // Every real UA above survives the cap intact — a truncated one that loses its Safari/
  // token at the END would be reclassified as an in-app webview, which is the exact
  // misreading this whole measurement cannot afford.
  for (const [name, ua] of Object.entries(UA)) {
    assert.equal(clientKind(ua.slice(0, CLIENT_MAX)), clientKind(ua), name);
  }
});

test('every browser bucket is deliberately on one side of the line', () => {
  // The in-app test used to be a regex on the bucket NAME. That decides which arm of the
  // experiment a customer lands in, so a bucket added later whose name did not match the
  // pattern would be filed as a real browser silently — no error, no failing test, just a
  // slowly wrong answer. This is the test that makes adding one a decision.
  const { CLIENT_KINDS, IN_APP_KINDS } = require('../netlify/functions/lib/reviews.js');
  const seen = new Set(CLIENT_KINDS);
  assert.equal(seen.size, CLIENT_KINDS.length, 'no duplicate buckets');
  for (const k of IN_APP_KINDS) assert.ok(seen.has(k), `${k} missing from CLIENT_KINDS`);
  for (const k of CLIENT_KINDS) assert.equal(typeof isInAppWebview(k), 'boolean', k);
  // And the control arm must actually contain the browsers the experiment compares against.
  for (const k of ['safari-ios', 'chrome-ios', 'chrome-android', 'chrome-desktop']) {
    assert.ok(!isInAppWebview(k), `${k} must be a real browser`);
  }
  // A kind that is not a declared bucket is never in-app: unrecognised input cannot be
  // allowed to carry the hypothesis.
  for (const k of ['made-up-inapp', 'inapp', 'ios-inapp-x', '', null, undefined]) {
    assert.ok(!isInAppWebview(k), String(k));
  }
});

test('the buckets clientKind actually produces are all declared', () => {
  // Guards the other direction: a verdict the classifier can return but the list does not
  // know about would be invisible to the test above.
  const { CLIENT_KINDS } = require('../netlify/functions/lib/reviews.js');
  const declared = new Set(CLIENT_KINDS);
  for (const [name, ua] of Object.entries(UA)) {
    assert.ok(declared.has(clientKind(ua)), `${name} -> ${clientKind(ua)} is not declared`);
  }
  for (const v of ['', 'total gibberish', null, 7]) {
    assert.ok(declared.has(clientKind(v)), `${String(v)} -> ${clientKind(v)} is not declared`);
  }
});
