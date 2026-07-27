const fetch = require("node-fetch");

const DAVIS_USER = process.env.NUVIZZ_DAVIS_USER || "Chad";
const DAVIS_PASS = process.env.NUVIZZ_DAVIS_PASS;
const ULINE_USER = process.env.NUVIZZ_ULINE_USER || "Chad";
const ULINE_PASS = process.env.NUVIZZ_ULINE_PASS;
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

function getCachedLoad(loadNbr) {
  const hit = loadCache.get(loadNbr);
  if (!hit) return null;
  if (Date.now() - hit.at > LOAD_CACHE_TTL_MS) {
    loadCache.delete(loadNbr);
    return null;
  }
  return hit.data;
}

function setCachedLoad(loadNbr, data) {
  // Bounded; Map preserves insertion order so the oldest key evicts first.
  if (loadCache.size >= LOAD_CACHE_MAX) {
    const oldest = loadCache.keys().next().value;
    if (oldest !== undefined) loadCache.delete(oldest);
  }
  loadCache.set(loadNbr, { at: Date.now(), data });
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

  // Davis serves multiple customers with different stop-number formats, all
  // resolvable via the DAVIS company code:
  //  - Uline style: all-digits, usually zero-padded to 9 (e.g. 007107386)
  //  - Prefixed style: ARY/MCC/SHP + digits (e.g. ARY245516, SHP27000)
  //  - Split shipments, which dispatch suffixes (e.g. 007150315-1)
  // Spaces are dropped so a number read off a printed label still resolves.
  const trimmed = rawPro.trim().toUpperCase().replace(/\s+/g, "");

  // Restricting the charset here also keeps the value safe to interpolate into
  // the upstream path below.
  if (!/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(trimmed)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid PRO number" }) };
  }

  const candidates = [];
  const addCandidate = (v) => {
    if (v && !candidates.includes(v)) candidates.push(v);
  };

  // A suffixed stop is its own shipment rather than an alias for the bare
  // number — 007150315-1 and 007150315 are different deliveries — so the
  // suffix is carried through every candidate and never stripped to widen a
  // search. Zero-padding is tried first because customers routinely drop the
  // leading zeros when typing.
  const numeric = trimmed.match(/^(\d+)(-[A-Z0-9-]+)?$/);
  if (numeric) {
    const digits = numeric[1];
    const suffix = numeric[2] || "";
    addCandidate(digits.padStart(9, "0") + suffix);
    addCandidate(trimmed);
  } else {
    addCandidate(trimmed);
  }

  const davisAuth = Buffer.from(`${DAVIS_USER}:${DAVIS_PASS}`).toString("base64");

  try {
    // Call 1: resolve the stop. Try each candidate against /stop/info/{stopNbr}/DAVIS
    let stopData = null;
    let stopNbr = null;
    for (const cand of candidates) {
      const stopRes = await fetch(`${BASE}/stop/info/${encodeURIComponent(cand)}/DAVIS`, {
        headers: { Authorization: `Basic ${davisAuth}` },
      });
      if (stopRes.ok) {
        const json = await stopRes.json();
        if (json && json.Stop && json.Stop.stop) {
          stopData = json;
          stopNbr = json.Stop.stop.stopNbr || cand;
          break;
        }
      }
    }

    if (!stopData) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "No data for this PRO" }) };
    }

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
        let loadData = getCachedLoad(load.loadNbr);
        if (!loadData) {
          const loadRes = await fetch(`${BASE}/load/info/${load.loadNbr}/DAVIS`, {
            headers: { Authorization: `Basic ${davisAuth}` },
          });
          if (loadRes.ok) {
            loadData = await loadRes.json();
            setCachedLoad(load.loadNbr, loadData);
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
                loadNbr: load.loadNbr,
                loadKeys: Object.keys((loadData && loadData.Load) || {}),
                lexeKeys: Object.keys(lexe),
                stopCount: stops.length,
                sample: stops.slice(0, 20).map((s) => ({
                  stopKeys: Object.keys(s.stop || {}),
                  exeKeys: Object.keys(s.stopExecutionInfo || {}),
                  stopNbr: (s.stop || {}).stopNbr,
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
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error("Stop lookup error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
