// Live customer-review carousel for davisdelivery.com.
//
// Loaded by an Elementor HTML widget on /testimonials/, which is nothing but a
// mount point and a script tag. Keeping the real code here rather than pasted
// into _elementor_data means it is version-controlled and reviewable, and that
// changing the carousel later is a normal deploy rather than a 40KB write into
// WordPress post meta.
//
// It reads the same public feed this site already serves. That endpoint
// publishes a rating, a scrubbed comment, a shortened name and a date, and
// nothing else — see netlify/functions/lib/public-reviews.js for what is
// deliberately held back. Everything rendered here is escaped anyway: the feed
// is public, so this file treats it as untrusted input rather than assuming so.
//
// Usage, in the Elementor HTML widget:
//   <div id="dd-rc"></div>
//   <script src="https://tracking.davisdelivery.com/reviews-widget.js" defer></script>
(function () {
  "use strict";

  var FEED = "https://tracking.davisdelivery.com/api/public-reviews";
  var GOOGLE = "https://www.google.com/maps/place/Davis+Delivery+Service/";

  var root = document.getElementById("dd-rc");
  if (!root) return;

  var CSS = [
    '.dd-rc{--dd-ink:#01164E;--dd-mut:#6b7784;--dd-line:#e3e8ed;--dd-star:#EEAA2A;',
    '  max-width:1083px;margin:0 auto;font-family:inherit}',
    '.dd-rc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;',
    '  justify-content:center;padding-bottom:14px;margin-bottom:16px;',
    '  border-bottom:1px solid var(--dd-line)}',
    '.dd-rc-avg{font-size:30px;font-weight:800;color:var(--dd-ink);line-height:1}',
    '.dd-rc-stars{color:var(--dd-star);letter-spacing:2px;font-size:17px}',
    '.dd-rc-count{color:var(--dd-mut);font-size:14px}',
    '.dd-rc-view{position:relative;display:flex;align-items:stretch}',
    '.dd-rc-track{flex:1;display:flex;overflow-x:auto;scroll-snap-type:x mandatory;',
    '  scroll-behavior:smooth;gap:16px;padding:2px;scrollbar-width:none}',
    '.dd-rc-track::-webkit-scrollbar{display:none}',
    '.dd-rc-card{scroll-snap-align:center;flex:0 0 100%;box-sizing:border-box;',
    '  border:1px solid var(--dd-line);border-radius:12px;padding:22px 24px;',
    '  background:#fff;display:flex;flex-direction:column;min-height:190px}',
    '@media(min-width:760px){.dd-rc-card{flex-basis:calc(50% - 8px)}}',
    '@media(min-width:1060px){.dd-rc-card{flex-basis:calc(33.333% - 11px)}}',
    '.dd-rc-card .dd-rc-stars{font-size:15px;letter-spacing:1px}',
    '.dd-rc-text{margin:10px 0 14px;color:#363636;font-size:19px;line-height:1.6;flex:1}',
    '.dd-rc-meta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;',
    '  border-top:1px solid #eef1f4;padding-top:10px;font-size:13px;color:#8a95a1}',
    '.dd-rc-author{font-weight:600;color:var(--dd-ink)}',
    '.dd-rc-nav{flex:0 0 auto;align-self:center;width:38px;height:38px;',
    '  border-radius:50%;border:1px solid var(--dd-line);background:#fff;',
    '  color:var(--dd-ink);font-size:22px;line-height:1;cursor:pointer;margin:0 6px}',
    '.dd-rc-nav:hover{background:#f5f8fa}',
    '.dd-rc-nav[disabled]{opacity:.35;cursor:default}',
    '.dd-rc-dots{display:flex;justify-content:center;gap:7px;margin-top:16px}',
    '.dd-rc-dot{width:8px;height:8px;border-radius:50%;border:0;padding:0;',
    '  cursor:pointer;background:#cfd7df}',
    '.dd-rc-dot[aria-current="true"]{background:var(--dd-ink)}',
    '.dd-rc-msg{text-align:center;color:var(--dd-mut);font-size:15px;padding:18px 0}',
    '@media(prefers-reduced-motion:reduce){.dd-rc-track{scroll-behavior:auto}}'
  ].join("\n");

  var MARKUP = [
    '<div class="dd-rc-head">',
    '  <span class="dd-rc-avg" id="dd-rc-avg"></span>',
    '  <span class="dd-rc-stars" id="dd-rc-hs"></span>',
    '  <span class="dd-rc-count" id="dd-rc-n">Loading recent reviews…</span>',
    '</div>',
    '<div class="dd-rc-view">',
    '  <button class="dd-rc-nav dd-rc-prev" type="button" aria-label="Previous review">&#8249;</button>',
    '  <div class="dd-rc-track" id="dd-rc-track" aria-live="polite"></div>',
    '  <button class="dd-rc-nav dd-rc-next" type="button" aria-label="Next review">&#8250;</button>',
    '</div>',
    '<div class="dd-rc-dots" id="dd-rc-dots"></div>'
  ].join("\n");

  root.className = "dd-rc";
  root.innerHTML = MARKUP;
  var style = document.createElement("style");
  style.appendChild(document.createTextNode(CSS));
  document.head.appendChild(style);

  var track = document.getElementById("dd-rc-track");
  var dots = document.getElementById("dd-rc-dots");
  var prev = root.querySelector(".dd-rc-prev");
  var next = root.querySelector(".dd-rc-next");

  function esc(s) {
    return String(s == null ? "" : s)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;")
      .split("'").join("&#39;");
  }

  function stars(n) {
    n = Number(n) || 0;
    n = Math.max(0, Math.min(5, Math.round(n)));
    var full = "", rest = "";
    for (var i = 0; i < n; i++) full += "★";
    for (var j = 0; j < 5 - n; j++) rest += "★";
    return full + '<span style="color:#d8dee5">' + rest + "</span>";
  }

  // "2026-09-02" -> "September 2026". A date-only string, split rather than
  // parsed, so no timezone can shift it back a day.
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  function when(d) {
    var p = String(d || "").split("-");
    if (p.length < 3) return "";
    var m = Number(p[1]);
    if (!(m >= 1 && m <= 12)) return "";
    return MONTHS[m - 1] + " " + p[0];
  }

  function fail() {
    root.innerHTML = '<div class="dd-rc-msg">Our live review feed is temporarily ' +
      'unavailable. You can read our reviews on <a rel="noopener" href="' +
      GOOGLE + '">Google</a>.</div>';
  }

  function render(data) {
    var list = (data && data.reviews) || [];
    if (!list.length) { fail(); return; }

    // publishedAverage describes the PUBLISHED set only, and the feed sends
    // null when nothing qualifies — guard the format rather than assume a
    // number, because null.toFixed throws.
    var avg = Number(data.publishedAverage);
    document.getElementById("dd-rc-avg").textContent = isFinite(avg) ? avg.toFixed(1) : "";
    document.getElementById("dd-rc-hs").innerHTML = isFinite(avg) ? stars(avg) : "";
    document.getElementById("dd-rc-n").textContent =
      "across " + list.length + " recent published reviews";

    var html = "";
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      html += '<div class="dd-rc-card">' +
        '<div class="dd-rc-stars">' + stars(r.rating) + "</div>" +
        '<p class="dd-rc-text">' + esc(r.comment) + "</p>" +
        '<div class="dd-rc-meta"><span class="dd-rc-author">' + esc(r.author) +
        "</span><span>" + esc(when(r.date)) + "</span></div></div>";
    }
    track.innerHTML = html;

    var cards = track.children;
    var idx = 0;

    function perView() {
      if (!cards.length || !cards[0].offsetWidth) return 1;
      return Math.max(1, Math.round(track.clientWidth / cards[0].offsetWidth));
    }
    function pages() { return Math.max(1, Math.ceil(cards.length / perView())); }

    function go(p) {
      idx = Math.max(0, Math.min(pages() - 1, p));
      var card = cards[Math.min(idx * perView(), cards.length - 1)];
      if (card) track.scrollLeft = card.offsetLeft - track.offsetLeft;
      paint();
    }

    function paint() {
      prev.disabled = idx <= 0;
      next.disabled = idx >= pages() - 1;
      dots.innerHTML = "";
      for (var i = 0; i < pages(); i++) {
        dots.appendChild(dot(i));
      }
    }

    function dot(i) {
      var b = document.createElement("button");
      b.className = "dd-rc-dot";
      b.type = "button";
      b.setAttribute("aria-label", "Go to review page " + (i + 1));
      if (i === idx) b.setAttribute("aria-current", "true");
      b.onclick = function () { go(i); };
      return b;
    }

    prev.onclick = function () { go(idx - 1); };
    next.onclick = function () { go(idx + 1); };
    window.addEventListener("resize", paint);
    paint();

    // Auto-advance, but never fight the reader: it stops on hover, on focus,
    // on touch, and for anyone who asked for reduced motion.
    var reduce = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && pages() > 1) {
      var timer = setInterval(function () {
        go(idx >= pages() - 1 ? 0 : idx + 1);
      }, 7000);
      var stop = function () { clearInterval(timer); };
      root.addEventListener("mouseenter", stop);
      root.addEventListener("focusin", stop);
      root.addEventListener("touchstart", stop);
    }
  }

  function load() {
    var x = new XMLHttpRequest();
    x.open("GET", FEED, true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status !== 200) { fail(); return; }
      var data;
      try { data = JSON.parse(x.responseText); } catch (e) { fail(); return; }
      try { render(data); } catch (e) { fail(); }
    };
    x.onerror = fail;
    x.send();
  }

  load();
})();
