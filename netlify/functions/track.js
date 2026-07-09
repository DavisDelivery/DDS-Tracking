const fetch = require("node-fetch");

const DAVIS_USER = process.env.NUVIZZ_DAVIS_USER || "Chad";
const DAVIS_PASS = process.env.NUVIZZ_DAVIS_PASS;
const ULINE_USER = process.env.NUVIZZ_ULINE_USER || "Chad";
const ULINE_PASS = process.env.NUVIZZ_ULINE_PASS;
const BASE = "https://portal.nuvizz.com/deliverit/openapi/v7";

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
  // resolvable via the DAVIS company code. Build a list of candidates to try:
  //  - Uline style: all-digits, usually zero-padded to 9 (e.g. 007107386)
  //  - Prefixed style: ARY/MCC/SHP + digits (e.g. ARY245516, SHP27000) -> use as-is
  const trimmed = rawPro.trim().toUpperCase();
  if (!trimmed) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid PRO number" }) };
  }

  let candidates;
  if (/^\d+$/.test(trimmed)) {
    const padded = trimmed.padStart(9, "0");
    candidates = padded === trimmed ? [trimmed] : [padded, trimmed];
  } else if (/^[A-Z0-9]+$/.test(trimmed)) {
    candidates = [trimmed];
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid PRO number" }) };
  }

  const davisAuth = Buffer.from(`${DAVIS_USER}:${DAVIS_PASS}`).toString("base64");

  try {
    // Call 1: resolve the stop. Try each candidate against /stop/info/{stopNbr}/DAVIS
    let stopData = null;
    let stopNbr = null;
    for (const cand of candidates) {
      const stopRes = await fetch(`${BASE}/stop/info/${cand}/DAVIS`, {
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
    let stopsAway = 0;
    let stopsOnRoute = 0;
    if (load && load.loadNbr) {
      try {
        const loadRes = await fetch(`${BASE}/load/info/${load.loadNbr}/DAVIS`, {
          headers: { Authorization: `Basic ${davisAuth}` },
        });
        if (loadRes.ok) {
          const loadData = await loadRes.json();
          const lexe = (loadData.Load && loadData.Load.loadExecutionInfo) || {};
          loadStatus = lexe.loadStatus || "";
          loadStarted = !!lexe.actualStartDTTM;
          stopsOnRoute = lexe.stopsOnRoute || 0;

          const stops = (loadData.Load && loadData.Load.stops) || [];
          let foundTarget = false;
          let undeliveredBefore = 0;
          for (const s of stops) {
            const sStop = s.stop || {};
            const sExe = s.stopExecutionInfo || {};
            if (sStop.stopNbr === stopNbr) {
              foundTarget = true;
              break;
            }
            // Only count delivery (DO) stops that are not yet delivered.
            if (sStop.stopType === "DO" && sExe.stopStatus !== "90") {
              undeliveredBefore++;
            }
          }
          if (foundTarget) stopsAway = undeliveredBefore;
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
      stopsAway,
      stopsOnRoute,
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error("Stop lookup error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Internal error" }) };
  }
};
