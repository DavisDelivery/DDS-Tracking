// stop-status.js — the one place that decides what a customer is told about a stop.
//
// Chad, 2026-09-22, holding two PRO numbers: "these were tracked last night before being
// planned today for delivery and they showed canceled ... I'm sure we are just presenting
// the incorrect status to the customer."
//
// He was right that the mapping was the problem. track.js used to make this decision inline
// against three of NuVizz's status codes, and NuVizz uses eight. Verified in live data by the
// dispatch app's scanner (dispatch-map/netlify/functions/lib/nuvizz-scan.mts, which reads the
// same tenant): 10, 20, 30, 40, 50, 80, 90, 91. Everything the old branch did not name fell
// through a final `else` to "Scheduled", so:
//
//   • 80 — NuVizz's explicit "unable to deliver" — told the customer their delivery was
//     scheduled. A refusal, a damaged pallet and a closed business all read as on its way.
//   • A stop NuVizz had CANCELLED read as scheduled too: stopExecutionInfo.cancellation was
//     never looked at. Nobody is delivering that freight and the page said a truck was coming.
//   • An order that exists but is on no route at all — received overnight, not yet planned —
//     also read "Scheduled", under a heading with no date and no ETA beneath it.
//
// The field paths mirror dispatch-map's nuvizz-scan.mts and stop-cancelled.js. They are
// duplicated rather than shared because these are two separate repos and two separate Netlify
// sites — the same call stop-context.js already documents. If NuVizz moves a field, both move.
//
// PURE. No network, no clock, no I/O. Everything here is decided from one payload, so the
// rules are pinned by tests instead of by curl against a live stop that changes hourly.

// The display codes the customer page renders. They are deliberately NOT NuVizz's codes:
// several NuVizz states collapse onto one thing worth saying, and the page has to keep
// rendering older payloads through a deploy.
const DISPLAY = {
  DELIVERED: "90",
  EXCEPTION: "50",
  ARRIVED: "45",
  OUT_FOR_DELIVERY: "40",
  SCHEDULED: "30",
  CANCELLED: "20",
  UNSCHEDULED: "10",
};

// NuVizz's own cancellation record for this stop, or null.
//
// AN EMPTY `cancellation: {}` IS NOT A CANCELLATION. NuVizz ships that shape on ordinary
// stops — it is present on both of the stops in the report above, neither of which was
// cancelled — so treating "the key exists" as the signal would mark the whole board dead.
// A real one carries a cancelDTTM or an explicit CANCELLED reason code.
//
// FREE TEXT IS NOT ENOUGH EITHER. The dispatch repo has a live row whose orderInstructions
// and comments both read "Cancelled" while the order was perfectly alive; a rule that reads
// the word rather than the record will one day tell a customer their delivery is off when a
// truck is on the way to them.
function readCancellation(exe) {
  const c = exe && exe.cancellation;
  if (!c || typeof c !== "object") return null;
  const at = typeof c.cancelDTTM === "string" && c.cancelDTTM.trim() ? c.cancelDTTM.trim() : "";
  const code = typeof c.reasonCode === "string" ? c.reasonCode.trim().toUpperCase() : "";
  if (!at && code !== "CANCELLED") return null;
  const desc = typeof c.reasonDesc === "string" && c.reasonDesc.trim() ? c.reasonDesc.trim() : "";
  return { at, reasonCode: code, reasonDesc: desc };
}

// Two different things live in NuVizz's exception fields, and conflating them is what makes
// a re-delivery look like a disaster.
//
//   exceptionPresent  — a flag describing the stop NOW.
//   exceptions[]      — the list of exception events RECORDED against it, which survives the
//                       stop being re-planned for another day.
//
// So a stop that failed yesterday, was unplanned by customer service and is on a truck this
// morning still carries yesterday's entry in exceptions[]. Reading the list as current state
// would put a red "Delivery Exception — call us" card on a delivery that is thirty minutes
// away. `current` is what decides the status; `recorded` is kept so a stop that is NOT on a
// route can still say why.
function exceptionSignal(exe, opts) {
  const e = exe || {};
  const onRoute = !!(opts && opts.onRoute);
  const list = Array.isArray(e.exceptions) ? e.exceptions : [];
  const recorded = list.length > 0;
  const flagged = e.exceptionPresent === true;
  const unableToDeliver = String(e.stopStatus || "").trim() === "80";
  return {
    recorded,
    flagged,
    unableToDeliver,
    // NuVizz's live flag and its explicit failure code are current by definition. A bare
    // history entry is only current while nothing newer has happened to the stop — and being
    // planned onto a route is something newer.
    current: flagged || unableToDeliver || (recorded && !onRoute),
  };
}

// What the customer is told, from one stop payload.
//
// ORDER IS THE WHOLE DESIGN. Most-progressed outcome wins, with the two inversions the
// dispatch app arrived at against live data:
//
//   • A REAL exception beats a driver arrival. NuVizz parks an arrived-but-not-completed stop
//     at status 50 with no exception data at all — that is unfinished paperwork on a driver
//     who is standing at the customer's door, and it has to read "Driver Arrived", not
//     "Exception". A genuine failure still outranks it.
//   • CANCELLED is not an exception. An exception is still freight and still somebody's job:
//     a phone call, a re-delivery, a conversation. A cancelled stop is not freight at all.
//     Same red card, two completely different phone calls.
//
// AND A LIVE PLAN SUPERSEDES A STALE CANCELLATION. This is the case in the report at the top
// of this file. Freight that comes off a route at the end of the day — NuVizz cancels the
// route when dispatch empties a load — sits overnight carrying yesterday's record, and is
// planned onto a truck the next morning. If the stop is on a route right now, then dispatch
// has planned it since, and the newer fact is the plan. Without this, every order that rolls
// to the next day reads "Cancelled" to whoever tracks it that evening.
function displayStatus(input) {
  const exe = (input && input.exe) || {};
  const raw = String(exe.stopStatus || "").trim();
  const loadStatus = String((input && input.loadStatus) || "").trim();
  const loadStarted = !!(input && input.loadStarted);
  const onRoute = !!(input && input.onRoute);

  const to = exe.to || {};
  const confirmed = to.confirmedDTTM || "";
  const arrived = to.arrivalDTTM || "";
  const exc = exceptionSignal(exe, { onRoute });

  // Delivered, by NuVizz's code (90 driver-confirmed, 91 completed by dispatch) or by the
  // delivery having been confirmed through some other path. A confirmation time is the stop
  // having been worked; the only reason to distrust it is a live exception alongside it.
  if (raw === "90" || raw === "91") return DISPLAY.DELIVERED;
  if (confirmed && !exc.current) return DISPLAY.DELIVERED;

  // Cancelled, on NuVizz's own record and nothing softer — and only while nothing newer has
  // happened to the stop.
  if (readCancellation(exe) && !onRoute) return DISPLAY.CANCELLED;

  if (exc.current) return DISPLAY.EXCEPTION;

  // Driver on site. arrivalDTTM is the fact; 50 is the code that usually accompanies it and
  // sometimes arrives without it.
  if (arrived || raw === "50") return DISPLAY.ARRIVED;

  // Rolling. 40 on the stop is NuVizz saying so directly; the load is the fallback, because
  // the stop's own code only flips when the driver physically works it and the load knows
  // the truck left the yard long before that.
  //
  // 38 is kept alongside it. It is the code the old inline mapping tested for "enroute to
  // destination", and it is NOT in the eight the dispatch scanner has observed — so on the
  // evidence it never fires. Keeping it costs one comparison, and dropping a code that turns
  // out to be real would quietly park a moving truck back at "Scheduled".
  if (raw === "40" || raw === "38" || (loadStatus === "40" && loadStarted)) {
    return DISPLAY.OUT_FOR_DELIVERY;
  }

  // On a route but not yet worked.
  if (onRoute) return DISPLAY.SCHEDULED;

  // In the system, on no route. "Scheduled" is a promise this state cannot keep: there is no
  // day, no driver and no ETA behind it. Saying so is better than implying a truck.
  return DISPLAY.UNSCHEDULED;
}

module.exports = {
  DISPLAY,
  displayStatus,
  exceptionSignal,
  readCancellation,
};
