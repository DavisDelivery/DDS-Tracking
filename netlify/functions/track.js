const fetch = require("node-fetch");

const BASE = "https://portal.nuvizz.com/deliverit/openapi/v7";

// Davis runs Eastern time. NuVizz returns wall-clock timestamps with no zone
// ("2026-07-27T12:13:09"), which JS would otherwise read against the running
// container's clock — UTC on Netlify — putting every ETA four hours out.
const ROUTE_TZ = "America/New_York";

const TZ_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ROUTE_TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// How far ROUTE_TZ sits from UTC at a given instant (DST-aware).
function tzOffsetMs(utcMs) {
  const p = {};
  for (const part of TZ_PARTS.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return wall - utcMs;
}

// Parse a NuVizz timestamp to epoch ms, treating zone-less values as ROUTE_TZ.
function parseRouteTime(s) {
  if (!s) return null;
  const str = String(s);
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) {
    const t = Date.parse(str);
    return Number.isFinite(t) ? t : null;
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // Two passes so instants near a DST boundary resolve to the right offset.
  const once = asUTC - tzOffsetMs(asUTC);
  return asUTC - tzOffsetMs(once);
}

// Guard rails for the drift correction below. A stop dispatch never closed out
// would otherwise read as a driver days behind schedule, so ignore stops whose
// ETA is implausibly old, and never project a delay beyond a working day.
const STALE_STOP_MS = 12 * 60 * 60 * 1000;
const MAX_SLIP_MS = 6 * 60 * 60 * 1000;

// Warm-container cache for load lookups. Every viewer of a given route pulls
// the same load payload, and it changes only as the driver works stops, so a
// short shared TTL removes the redundant round trip per viewer.
const LOAD_CACHE_TTL_MS = 60 * 1000;
const LOAD_CACHE_MAX = 200;
const loadCache = new Map();

// Keyed by company + load number: the lookup now spans more than one company
// code, and a load number is only unique within its own company.
function getCachedLoad(key) {
  const hit = loadCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LOAD_CACHE_TTL_MS) {
    loadCache.delete(key);
    return null;
  }
  return hit.data;
}

function setCachedLoad(key, data) {
  // Bounded; Map preserves insertion order so the oldest key evicts first.
  if (loadCache.size >= LOAD_CACHE_MAX) {
    const oldest = loadCache.keys().next().value;
    if (oldest !== undefined) loadCache.delete(oldest);
  }
  loadCache.set(key, { at: Date.now(), data });
}

// Company codes a stop can live under, searched in order. Davis dispatches
// most work under DAVIS and Uline-originated stops are filed under ULINE; the
// lookup used to ask DAVIS only, so anything filed elsewhere was unfindable no
// matter how the customer typed it.
//
// Credentials are per company code and authorize only that code — DAVIS
// credentials against the ULINE company return 401, and vice versa. So
// reaching an agent or carrier filed under its own company code needs its own
// credentials, and NUVIZZ_COMPANIES adds one without a code change: list the
// code here and supply NUVIZZ_<CODE>_USER / NUVIZZ_<CODE>_PASS, the same
// naming the existing two already use.
const COMPANIES = (process.env.NUVIZZ_COMPANIES || "DAVIS,ULINE")
  .toUpperCase()
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean)
  .map((code) => ({
    code,
    user: process.env[`NUVIZZ_${code}_USER`] || "Chad",
    pass: process.env[`NUVIZZ_${code}_PASS`],
  }));

function authHeaderFor(company) {
  if (!company.pass) return null;
  return "Basic " + Buffer.from(`${company.user}:${company.pass}`).toString("base64");
}

// Carriers whose freight Davis runs the final mile for. The dispatch board
// writes these orders into NuVizz with the carrier in the stop number itself —
// "<CARRIER>-<PRO digits>", e.g. ESTES-0831846593 — so the hyphen is part of
// the identifier, not punctuation to be cleaned off. `codes` are the prefixes
// the board actually writes; `re` matches what a customer types.
const CARRIER_LABELS = [
  { name: "Estes Express", re: /^(?:ESTESEXPRESSLINES|ESTESEXPRESS|ESTES|EXLA)/, codes: ["ESTES"] },
  { name: "Averitt Express", re: /^(?:AVERITTEXPRESS|AVERITT|AVRT)/, codes: ["AVRT", "AVERITT"] },
];
const GENERIC_LABEL = /^(?:PRONUMBER|PRONBR|PRO|TRACKINGNUMBER|TRACKING|BOLNUMBER|BOL)/;

// Two normalizations, because two stop-number shapes are in play. Uline stops
// are bare zero-padded digits; carrier stops carry a hyphenated prefix. Keeping
// the hyphen is what makes "estes-0831846593" resolve — stripping it was why it
// could not.
function hyphenForm(raw) {
  return String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizePro(raw) {
  return String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Split a recognised label off the front of an alphanumeric value. Returns the
// carrier name (for the not-found message), the bare number underneath, and the
// stop-number prefixes that carrier is filed under.
function detectLabel(alnum) {
  for (const c of CARRIER_LABELS) {
    const m = alnum.match(c.re);
    if (m && m[0].length < alnum.length && /^\d/.test(alnum.slice(m[0].length))) {
      return { carrier: c.name, rest: alnum.slice(m[0].length), codes: c.codes };
    }
  }
  const g = alnum.match(GENERIC_LABEL);
  if (g && g[0].length < alnum.length && /^\d/.test(alnum.slice(g[0].length))) {
    return { carrier: "", rest: alnum.slice(g[0].length), codes: [] };
  }
  return { carrier: "", rest: "", codes: [] };
}

const MAX_CANDIDATES = 8;
const VALID_STOP_NBR = /^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/;

// Every shape the same shipment might be filed under, most-likely first.
function buildCandidates(raw) {
  const out = [];
  const add = (v) => {
    if (!v || out.length >= MAX_CANDIDATES) return;
    if (!VALID_STOP_NBR.test(v)) return;
    if (!out.includes(v)) out.push(v);
  };
  // Uline-style stop numbers are zero-padded to nine digits and customers drop
  // the padding; carrier PROs carry a leading zero that Uline numbers do not.
  const addNumberShapes = (v) => {
    if (!/^\d+$/.test(v)) { add(v); return; }
    if (v.length < 9) add(v.padStart(9, "0"));
    add(v);
    const bare = v.replace(/^0+/, "");
    if (bare && bare !== v) {
      if (bare.length < 9) add(bare.padStart(9, "0"));
      add(bare);
    }
  };

  const hyph = hyphenForm(raw);
  const alnum = normalizePro(raw);

  if (/^\d+$/.test(alnum) && hyph === alnum) {
    // Purely numeric: the zero-padded nine-digit form is the Uline stop number,
    // so it has to lead — the unpadded form almost never exists.
    addNumberShapes(alnum);
  } else {
    // Otherwise the board's own convention comes first, so a carrier order
    // resolves on the very first request.
    add(hyph);
    if (alnum !== hyph) add(alnum);
    addNumberShapes(alnum);
  }

  const { rest, codes } = detectLabel(alnum);
  if (rest) {
    // Labelled but typed without the hyphen the board writes — rebuild it.
    for (const code of codes) add(`${code}-${rest}`);
    addNumberShapes(rest);
  } else if (/^\d{10,11}$/.test(alnum)) {
    // Ten or eleven digits, not the nine a Uline stop number has.
    // A bare carrier PRO with no label at all: the board files it under a
    // carrier prefix, so try the prefixes it actually writes.
    for (const c of CARRIER_LABELS) for (const code of c.codes) add(`${code}-${alnum}`);
  }

  return out;
}

async function fetchStop(cand, companyCode, auth) {
  const res = await fetch(`${BASE}/stop/info/${encodeURIComponent(cand)}/${companyCode}`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return json && json.Stop && json.Stop.stop ? json : null;
}

// Resolve a stop across every candidate shape and every company code.
//
// The happy path is unchanged in cost: a well-formed stop number is one
// request against DAVIS, exactly as before. The wider fan-out only runs for
// lookups that previously ended in a flat "Shipment Not Found", so nothing
// that works today gets slower.
async function resolveStop(candidates) {
  const companies = COMPANIES
    .map((c) => ({ code: c.code, auth: authHeaderFor(c) }))
    .filter((c) => c.auth);
  const tried = [];
  const miss = { data: null, company: "", matched: "", tried };

  if (!candidates.length) return miss;

  for (const company of companies) {
    const head = candidates[0];
    tried.push(`${head}@${company.code}`);
    const first = await fetchStop(head, company.code, company.auth).catch(() => null);
    if (first) return { data: first, company: company.code, matched: head, tried };

    const rest = candidates.slice(1);
    if (!rest.length) continue;
    for (const c of rest) tried.push(`${c}@${company.code}`);
    const results = await Promise.all(
      rest.map((c) => fetchStop(c, company.code, company.auth).catch(() => null))
    );
    // findIndex keeps candidate priority even though the calls ran together.
    const hit = results.findIndex(Boolean);
    if (hit !== -1) {
      return { data: results[hit], company: company.code, matched: rest[hit], tried };
    }
  }

  return miss;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const rawPro = (event.queryStringParameters || {}).pro;
  if (!rawPro) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing pro parameter" }) };
  }

  // Davis serves several customers and several linehaul carriers, each with a
  // different number format, and the number reaches us in whatever shape the
  // customer's paperwork printed it. Normalize first, then try every plausible
  // shape of it against every company code we hold credentials for.
  const norm = normalizePro(rawPro);
  if (!norm) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid PRO number" }) };
  }

  const candidates = buildCandidates(rawPro);
  if (!candidates.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid PRO number" }) };
  }

  const { carrier } = detectLabel(norm);

  const qsp = event.queryStringParameters || {};
  const debugOk = qsp.debug === "1" && qsp.key === (process.env.DASHBOARD_KEY || "davis2026");

  // Key-gated: probe company codes we hold no dedicated credentials for.
  // NuVizz tenants commonly file each customer or agent under its own company
  // code, so "which company is this stop filed under" is a question worth
  // being able to ask without a redeploy. Reports the raw HTTP status per
  // candidate so a 401 (code exists, wrong credentials) is distinguishable
  // from a 404 (no such stop).
  if (debugOk && qsp.co) {
    const codes = String(qsp.co).toUpperCase().split(",").map((c) => c.trim()).filter(Boolean).slice(0, 8);
    const creds = COMPANIES.filter((c) => c.pass);
    const probes = [];
    for (const code of codes) {
      for (const cred of creds) {
        for (const cand of candidates) {
          probes.push({ code, as: cred.code, cand });
        }
      }
    }
    const out = await Promise.all(probes.slice(0, 60).map(async (pr) => {
      const cred = COMPANIES.find((c) => c.code === pr.as);
      try {
        const r = await fetch(`${BASE}/stop/info/${encodeURIComponent(pr.cand)}/${pr.code}`, {
          headers: { Authorization: authHeaderFor(cred) },
        });
        return `${pr.cand}@${pr.code} as ${pr.as} -> ${r.status}`;
      } catch (e) {
        return `${pr.cand}@${pr.code} as ${pr.as} -> ERR ${e.message}`;
      }
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ probe: out }, null, 2) };
  }

  try {
    const resolved = await resolveStop(candidates);
    const stopData = resolved.data;
    const companyCode = resolved.company || "DAVIS";
    const auth = authHeaderFor(
      COMPANIES.find((c) => c.code === companyCode) || COMPANIES[0]
    );

    if (!stopData) {
      // "Why can't I track this?" is answerable only if we can see what was
      // actually asked for, so the key-gated trace has to survive a miss —
      // that is the case worth diagnosing.
      const dq = event.queryStringParameters || {};
      if (dq.debug === "1" && dq.key === (process.env.DASHBOARD_KEY || "davis2026")) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            found: false,
            input: { raw: rawPro, normalized: norm, carrier },
            candidates,
            tried: resolved.tried,
            companiesConfigured: COMPANIES.filter((c) => c.pass).map((c) => c.code),
          }, null, 2),
        };
      }

      // Say which shapes were actually looked up, and name the carrier when the
      // number was labelled with one. A customer holding a linehaul carrier's
      // PRO needs to know that number is not what identifies the stop here,
      // not just that we came up empty.
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "No data for this PRO",
          searched: candidates,
          carrier: carrier || "",
        }),
      };
    }

    const stopNbr = stopData.Stop.stop.stopNbr || resolved.matched;

    const stop = stopData.Stop.stop;
    const load = stopData.Stop.load || {};
    const exe = stopData.Stop.stopExecutionInfo || {};
    const toAddr = stop.to || {};
    const contact = toAddr.contact || {};
    const docs = toAddr.documents || [];

    const rawStopStatus = exe.stopStatus || "";

    // Always pull the load to (a) get the load-level status and (b) compute
    // how many delivery stops remain before this one. Individual stop status
    // lags reality (it only flips when the driver physically works the stop),
    // so the load is the source of truth for "Out for Delivery".
    let loadStatus = "";
    let loadStarted = false;
    let stopsAway = null;
    let stopsOnRoute = 0;
    let latenessMs = 0;
    if (load && load.loadNbr) {
      try {
        const loadKey = `${companyCode}:${load.loadNbr}`;
        let loadData = getCachedLoad(loadKey);
        if (!loadData) {
          const loadRes = await fetch(`${BASE}/load/info/${load.loadNbr}/${companyCode}`, {
            headers: { Authorization: auth },
          });
          if (loadRes.ok) {
            loadData = await loadRes.json();
            setCachedLoad(loadKey, loadData);
          }
        }
        if (loadData) {
          const lexe = (loadData.Load && loadData.Load.loadExecutionInfo) || {};
          loadStatus = lexe.loadStatus || "";
          loadStarted = !!lexe.actualStartDTTM;
          stopsOnRoute = lexe.stopsOnRoute || 0;

          const stops = (loadData.Load && loadData.Load.stops) || [];

          // Key-gated diagnostic: return the raw shape of the load's stop list
          // so we can see the actual identity/sequence/status field names.
          const qp = event.queryStringParameters || {};
          if (qp.debug === "1" && qp.key === (process.env.DASHBOARD_KEY || "davis2026")) {
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({
                lookingFor: stopNbr,
                input: { raw: rawPro, normalized: norm, candidates, carrier },
                resolvedBy: { candidate: resolved.matched, company: companyCode },
                tried: resolved.tried,
                loadNbr: load.loadNbr,
                loadKeys: Object.keys((loadData && loadData.Load) || {}),
                lexeKeys: Object.keys(lexe),
                stopCount: stops.length,
                sample: stops.slice(0, 20).map((s) => ({
                  stopKeys: Object.keys(s.stop || {}),
                  exeKeys: Object.keys(s.stopExecutionInfo || {}),
                  stopNbr: (s.stop || {}).stopNbr,
                  // The identifiers a customer might quote instead of the stop
                  // number. NuVizz can only be queried by stopNbr, so seeing
                  // what actually lands in these fields is the only way to tell
                  // whether a carrier PRO is recorded at all.
                  altIds: {
                    stopId: (s.stop || {}).stopId,
                    shipmentNbr: (s.stop || {}).shipmentNbr,
                    proNumber: (s.stop || {}).proNumber,
                    bol: (s.stop || {}).bol,
                    reference1: (s.stop || {}).reference1,
                    reference2: (s.stop || {}).reference2,
                  },
                  stopType: (s.stop || {}).stopType,
                  stopSeq: (s.stop || {}).stopSeq,
                  seqNbr: (s.stop || {}).seqNbr,
                  sequence: (s.stop || {}).sequence,
                  status: (s.stopExecutionInfo || {}).stopStatus,
                  eta: ((s.stopExecutionInfo || {}).to || {}).etaDttm,
                  confirmed: ((s.stopExecutionInfo || {}).to || {}).confirmedDTTM,
                })),
              }, null, 2),
            };
          }

          // Match the target stop robustly. Dispatch labels stops with a type
          // suffix (e.g. "007150559-DO") while the stop lookup returns the bare
          // number, so a strict === comparison never matches and every stop
          // silently reported "Next delivery". Compare on a normalized id and
          // check every plausible identity field on the stop.
          const normId = (v) =>
            String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
          const stripType = (v) => v.replace(/(DO|PU|DEL|PICK)$/, "");
          const idsOf = (sStop) =>
            [sStop.stopNbr, sStop.stopId, sStop.refNbr, sStop.orderNbr, sStop.stopRef]
              .map(normId)
              .filter(Boolean);
          const target = normId(stopNbr);
          const targetBase = stripType(target);
          const isTarget = (sStop) =>
            idsOf(sStop).some((id) => id === target || stripType(id) === targetBase);

          // Put the route in the order the driver actually runs it.
          //
          // NuVizz returns stopSeq = 1 on EVERY stop of the load (it is a
          // per-shipment leg number, not a route position), and the stops array
          // itself comes back in no meaningful order. Sorting on stopSeq was
          // therefore a no-op that left the arbitrary array order in place — so
          // whichever stop happened to sit at index 0 counted zero stops ahead
          // of it and was told "Next delivery".
          //
          // ETA is the only field that reflects real route order, so sequence on
          // it. A genuine sequence field is still preferred, but only when it
          // actually varies across the load.
          const seqOf = (s) => {
            const st = s.stop || {};
            const v = st.stopSeq != null ? st.stopSeq
              : st.seqNbr != null ? st.seqNbr
              : st.sequence != null ? st.sequence
              : st.stopSequence != null ? st.stopSequence
              : null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const etaOf = (s) =>
            parseRouteTime(((s.stopExecutionInfo || {}).to || {}).etaDttm || "");
          const distinct = (fn) =>
            new Set(stops.map(fn).filter((v) => v !== null)).size;

          const rankBy = distinct(seqOf) > 1 ? seqOf : distinct(etaOf) > 1 ? etaOf : null;
          // Stops with no rank sort last; equal ranks keep their original order.
          const ordered = rankBy
            ? [...stops].sort((a, b) => (rankBy(a) ?? Infinity) - (rankBy(b) ?? Infinity))
            : stops;

          // 90 = driver-confirmed delivered, 91 = manually completed by dispatch.
          const isDone = (sExe) => {
            const st = String(sExe.stopStatus || "");
            if (st === "90" || st === "91") return true;
            return !!((sExe.to || {}).confirmedDTTM) && !sExe.exceptionPresent;
          };

          let foundTarget = false;
          let undeliveredBefore = 0;
          for (const s of ordered) {
            const sStop = s.stop || {};
            const sExe = s.stopExecutionInfo || {};
            if (isTarget(sStop)) {
              foundTarget = true;
              break;
            }
            // Only count delivery (DO) stops that are not yet delivered.
            if (sStop.stopType === "DO" && !isDone(sExe)) {
              undeliveredBefore++;
            }
          }
          // Leave stopsAway null when the stop can't be located on the route —
          // "unknown" must not be reported to the customer as "you're next".
          stopsAway = foundTarget ? undeliveredBefore : null;

          // Measure how far the route has slipped.
          //
          // NuVizz gives one ETA per stop and does not visibly re-forecast when
          // a driver falls behind — the remaining ETAs just go stale into the
          // past. The earliest stop still awaiting delivery is where the route
          // actually stands, so how far its ETA has fallen behind now is the
          // running delay, which we carry forward to the stops after it.
          //
          // This is self-cancelling: when the driver is on time (or NuVizz does
          // re-forecast) the gap is zero and no adjustment is applied.
          const nowMs = Date.now();
          const pendingEtas = ordered
            .filter((s) => {
              const sExe = s.stopExecutionInfo || {};
              return (s.stop || {}).stopType === "DO" &&
                !isDone(sExe) &&
                !sExe.exceptionPresent;
            })
            .map(etaOf)
            .filter((t) => t !== null && nowMs - t < STALE_STOP_MS);

          if (pendingEtas.length) {
            const slip = nowMs - Math.min(...pendingEtas);
            if (slip > 0) latenessMs = Math.min(slip, MAX_SLIP_MS);
          }
        }
      } catch (e) {
        console.log("Load fetch error (non-fatal):", e.message);
      }
    }

    // Compute the status the customer actually sees.
    // NuVizz stop status codes (v7 docs): 50 = "Arrived at DropOff" — the
    // driver is AT the customer's door, NOT an exception. Exceptions are a
    // separate flag (exceptionPresent), never a status code.
    // Display codes sent to the frontend:
    //   90 Delivered · 50 Exception · 45 Driver Arrived · 40 Out for Delivery
    //   30 Scheduled
    // A confirmed delivery time is the ground truth that the stop was worked,
    // even when the status code wasn't set through the normal driver flow.
    const confirmed = (exe.to && exe.to.confirmedDTTM) || "";
    let displayStatus;
    if (rawStopStatus === "90" || rawStopStatus === "91") {
      // 90 = driver-confirmed delivered; 91 = manually completed by dispatch.
      displayStatus = "90";
    } else if (confirmed && !exe.exceptionPresent) {
      // Safety net: any other completion path (e.g. status 80) that still
      // stamped a delivery confirmation time counts as delivered.
      displayStatus = "90";
    } else if (exe.exceptionPresent) {
      displayStatus = "50";
    } else if (rawStopStatus === "50") {
      displayStatus = "45";
    } else if (rawStopStatus === "38" || (loadStatus === "40" && loadStarted)) {
      // 38 = enroute to destination; otherwise infer from the rolling load.
      displayStatus = "40";
    } else {
      displayStatus = "30";
    }

    // Resolve the ETA the customer is actually shown.
    //
    // Two things happen here. The raw value is re-emitted with an explicit zone
    // so the browser cannot reinterpret a zone-less timestamp against the
    // viewer's own clock, and the route slip measured above is added while the
    // delivery is still pending. Once the driver has arrived or delivered, the
    // timestamps are fact rather than forecast and are left untouched.
    const rawEta = (exe.to && exe.to.etaDttm) || "";
    const rawEtaMs = parseRouteTime(rawEta);
    const pendingDelivery = displayStatus === "40" || displayStatus === "30";
    const appliedMs = pendingDelivery ? latenessMs : 0;
    const etaInfo = {
      effective: rawEtaMs === null ? "" : new Date(rawEtaMs + appliedMs).toISOString(),
      raw: rawEta,
      latenessMin: Math.round(appliedMs / 60000),
      adjusted: appliedMs > 0,
    };

    // Build clean response — only fields the frontend needs.
    const result = {
      stop: {
        stopNbr: stop.stopNbr,
        to: {
          address: {
            name: toAddr.address?.name || "",
            addr1: toAddr.address?.addr1 || "",
            city: toAddr.address?.city || "",
            state: toAddr.address?.state || "",
            zip: toAddr.address?.zip || "",
            latitude: toAddr.address?.latitude,
            longitude: toAddr.address?.longitude,
          },
          contact: {
            contactName: contact.contactName || "",
            email: contact.email || "",
            phone: contact.phone || "",
          },
          documents: docs.map((d) => ({
            documentName: d.documentName || "",
            documentExtType: d.documentExtType || "",
            documentType: d.documentType || "",
            documentGuid: d.documentGuid || "",
            createdDTTM: d.createdDTTM || "",
          })),
        },
        bol: stop.bol || "",
        totalPallets: stop.totalPallets || 0,
        totalCartons: stop.totalCartons || 0,
        weight: stop.weight || 0,
        weightUOM: stop.weightUOM || "Lbs",
        volume: stop.volume || 0,
        stopDetails: (stop.stopDetails || []).map((item) => ({
          product: item.product || "",
          quantity: item.quantity || 0,
          quantityUOM: item.quantityUOM || "",
          weight: item.weight || 0,
        })),
      },
      exe: {
        stopStatus: displayStatus,
        rawStopStatus,
        loadStatus,
        loadStarted,
        exceptionPresent: exe.exceptionPresent || false,
        exceptions: (exe.exceptions || []).map((e) => ({
          exceptionComments: e.exceptionComments || "",
        })),
        to: {
          etaDttm: exe.to?.etaDttm || "",
          confirmedDTTM: exe.to?.confirmedDTTM || "",
          arrivalDTTM: exe.to?.arrivalDTTM || "",
          etaCode: exe.to?.etaCode || "",
          podDoc: (exe.to?.podDoc || []).map((p) => ({
            documentName: p.documentName || "",
            documentGuid: p.documentGuid || "",
            extension: p.extension || "",
            createdTime: p.createdTime || "",
          })),
        },
      },
      eta: etaInfo,
      stopsAway,
      stopsOnRoute,
      company: companyCode,
      matchedPro: resolved.matched,
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error("Stop lookup error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
