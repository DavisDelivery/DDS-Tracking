// ONE GOOGLE REVIEW URL, AND THE REPO AGREES WITH ITSELF ABOUT IT.
//
// Chad, having tested it on a phone: "https://g.page/r/CcBkxtEUiFOGEBM/review that is the link
// that takes them to the review yours took them to a Google Maps page."
//
// The URL lived in THREE places — the server constant plus a hand-written copy in each of the
// two static pages — and nothing checked they matched. Fixing the constant alone would have
// left the tracking page and the review page still sending customers to the wrong one, and
// nothing anywhere would have said so. That is not hypothetical: the first fix in this change
// touched only the module, and the other two turned up by grepping.
//
// The guard never writes the URL down. It reads whatever the constant says and requires every
// other occurrence in the repo to be that string, so changing the listing is a one-line edit
// that this test then enforces everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GOOGLE_REVIEW_URL } = require('../netlify/functions/lib/reviews.js');
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.netlify', 'dist']);
const TEXT = new Set(['.js', '.mjs', '.cjs', '.html', '.json', '.md', '.ts']);
const SELF = 'google-review-url.test.mjs';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.has(extname(name)) && !p.endsWith(SELF)) out.push(p);
  }
  return out;
}

/** Every g.page review link written anywhere in the repo, with where it was found. */
function findAll() {
  const hits = [];
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/https:\/\/g\.page\/[^\s"'`)<>]+/g)) {
        hits.push({ file: file.slice(ROOT.length + 1), line: i + 1, url: m[0] });
      }
    });
  }
  return hits;
}

test('the review URL is the one Chad verified opens the review box, not a Maps page', () => {
  assert.equal(GOOGLE_REVIEW_URL, 'https://g.page/r/CcBkxtEUiFOGEBM/review');
});

test('every g.page link in the repo is the one constant — no second copy drifting', () => {
  const wrong = findAll().filter((h) => h.url !== GOOGLE_REVIEW_URL);
  assert.deepEqual(wrong, [], 'these do not match GOOGLE_REVIEW_URL:\n'
    + wrong.map((h) => `  ${h.file}:${h.line} → ${h.url}`).join('\n'));
});

test('THE CONTROL: the scan actually reads files and finds the copies', () => {
  // A repo scan that finds nothing looks identical whether it is working or broken. The two
  // static pages each carry a copy, so a healthy run sees the constant plus those.
  const hits = findAll();
  assert.ok(hits.length >= 3, `only found ${hits.length} g.page links; the scan is not reading the repo`);
  const files = new Set(hits.map((h) => h.file));
  assert.ok(files.has('public/index.html'), 'the tracking page copy was not seen');
  assert.ok(files.has('public/review.html'), 'the review page copy was not seen');
  // And it would notice a wrong one: the same comparison, run against a deliberately bad value.
  assert.ok(hits.some((h) => h.url !== 'https://g.page/r/DELIBERATELY-WRONG/review'));
});
