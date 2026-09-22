// What the customer is told about a stop, pinned.
//
// This suite exists because of two PRO numbers and one sentence from Chad, 2026-09-22:
// "these were tracked last night before being planned today for delivery and they showed
// canceled ... I'm sure we are just presenting the incorrect status to the customer."
//
// The mapping it replaced knew three of NuVizz's eight stop status codes. Everything else
// fell through a final `else` to "Scheduled", so a stop NuVizz had marked UNABLE TO DELIVER,
// a stop it had CANCELLED, and an order sitting on no route at all were all reported to the
// customer as a delivery on its way. Each of those is a test below, by name.
//
// The two rules that are easy to get backwards, and are therefore pinned hardest:
//
//   • A LIVE PLAN SUPERSEDES A STALE CANCELLATION. Freight that comes off a route overnight
//     carries yesterday's record until dispatch plans it again. If it is on a route now, the
//     plan is the newer fact. Without this every rolled order reads "Cancelled" that evening.
//   • AN EMPTY `cancellation: {}` IS NOT A CANCELLATION. NuVizz ships that shape on ordinary
//     stops — it was present on both of the live stops in the report above, neither cancelled.
//
// FIXTURES ARE FABRICATED. Status codes and timestamps only; no customer, address, contact or
// real PRO appears here. This repository is public.
//
// PURE — no network, no Netlify, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DISPLAY, displayStatus, exceptionSignal, readCancellation } =
  require('../netlify/functions/lib/stop-status.js');

/** One stop payload. Defaults are an ordinary stop planned on today's route. */
function stop(exe = {}, opts = {}) {
  return {
    exe: { stopStatus: '20', to: {}, ...exe },
    loadStatus: '30',
    loadStarted: false,
    onRoute: true,
    ...opts,
  };
}

test('delivered: NuVizz 90 (driver) and 91 (completed by dispatch)', () => {
  assert.equal(displayStatus(stop({ stopStatus: '90' })), DISPLAY.DELIVERED);
  assert.equal(displayStatus(stop({ stopStatus: '91' })), DISPLAY.DELIVERED);
});

test('delivered: a confirmation time counts even when the code never flipped', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '50', to: { confirmedDTTM: '2026-09-21T10:32:45' } })),
    DISPLAY.DELIVERED
  );
});

test('delivered: a live exception alongside a confirmation is still an exception', () => {
  assert.equal(
    displayStatus(
      stop({ stopStatus: '50', exceptionPresent: true, to: { confirmedDTTM: '2026-09-21T10:32:45' } })
    ),
    DISPLAY.EXCEPTION
  );
});

// ── The three states that used to read "Scheduled" ──────────────────────────

test('REGRESSION: status 80, unable to deliver, is an exception and not "Scheduled"', () => {
  assert.equal(displayStatus(stop({ stopStatus: '80' })), DISPLAY.EXCEPTION);
});

test('REGRESSION: a cancelled stop is not "Scheduled"', () => {
  const exe = { stopStatus: '20', cancellation: { reasonCode: 'CANCELLED', cancelDTTM: '2026-09-20T21:00:55' } };
  assert.equal(displayStatus(stop(exe, { onRoute: false, loadStatus: '' })), DISPLAY.CANCELLED);
});

test('REGRESSION: an order on no route is "Not Yet Scheduled", not "Scheduled"', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '20' }, { onRoute: false, loadStatus: '' })),
    DISPLAY.UNSCHEDULED
  );
});

// ── Cancellation: NuVizz's own record, and nothing softer ───────────────────

test('an empty cancellation:{} is not a cancellation', () => {
  assert.equal(readCancellation({ cancellation: {} }), null);
  assert.equal(
    displayStatus(stop({ cancellation: {} }, { onRoute: false, loadStatus: '' })),
    DISPLAY.UNSCHEDULED
  );
});

test('cancellation is read from a reason code alone, or a date alone', () => {
  assert.deepEqual(readCancellation({ cancellation: { reasonCode: 'cancelled' } }), {
    at: '',
    reasonCode: 'CANCELLED',
    reasonDesc: '',
  });
  assert.deepEqual(readCancellation({ cancellation: { cancelDTTM: '2026-09-20T21:00:55' } }), {
    at: '2026-09-20T21:00:55',
    reasonCode: '',
    reasonDesc: '',
  });
});

test('a reason code that is not CANCELLED, with no date, is not a cancellation', () => {
  assert.equal(readCancellation({ cancellation: { reasonCode: 'RESCHEDULED' } }), null);
});

test('missing, null and non-object cancellation blocks are handled', () => {
  assert.equal(readCancellation({}), null);
  assert.equal(readCancellation({ cancellation: null }), null);
  assert.equal(readCancellation({ cancellation: 'CANCELLED' }), null);
  assert.equal(readCancellation(undefined), null);
  assert.equal(readCancellation({ cancellation: { cancelDTTM: '   ' } }), null);
});

test('THE REPORTED BUG: a stop planned on a route today is not cancelled by last night', () => {
  const exe = {
    stopStatus: '20',
    cancellation: { reasonCode: 'CANCELLED', cancelDTTM: '2026-09-21T21:00:55' },
  };
  assert.equal(displayStatus(stop(exe, { onRoute: true })), DISPLAY.SCHEDULED);
});

test('a delivered stop is not re-opened by a cancellation record', () => {
  const exe = {
    stopStatus: '90',
    cancellation: { reasonCode: 'CANCELLED', cancelDTTM: '2026-09-20T21:00:55' },
  };
  assert.equal(displayStatus(stop(exe, { onRoute: false, loadStatus: '' })), DISPLAY.DELIVERED);
});

// ── Exceptions: the live flag is now, the list is history ───────────────────

test("NuVizz's own exceptionPresent flag is current even on a planned stop", () => {
  assert.equal(displayStatus(stop({ exceptionPresent: true })), DISPLAY.EXCEPTION);
});

test('a recorded exception on a stop with no route still shows', () => {
  const exe = { stopStatus: '20', exceptions: [{ exceptionComments: 'Business closed' }] };
  assert.equal(displayStatus(stop(exe, { onRoute: false, loadStatus: '' })), DISPLAY.EXCEPTION);
});

test('a re-planned stop is not held to yesterday\'s exception history', () => {
  const exe = { stopStatus: '20', exceptionPresent: false, exceptions: [{ exceptionComments: 'Business closed' }] };
  assert.equal(displayStatus(stop(exe, { onRoute: true })), DISPLAY.SCHEDULED);
});

test('exceptionSignal separates the flag, the history and the failure code', () => {
  const s = exceptionSignal({ stopStatus: '80', exceptions: [{}] }, { onRoute: true });
  assert.equal(s.unableToDeliver, true);
  assert.equal(s.recorded, true);
  assert.equal(s.flagged, false);
  assert.equal(s.current, true);
});

// ── Driver on site ──────────────────────────────────────────────────────────

test('status 50 with no exception data is the driver at the door, not an exception', () => {
  assert.equal(displayStatus(stop({ stopStatus: '50' })), DISPLAY.ARRIVED);
});

test('an arrival time is enough on its own', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '20', to: { arrivalDTTM: '2026-09-21T09:36:33' } })),
    DISPLAY.ARRIVED
  );
});

test('a real exception outranks an arrival', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '50', exceptionPresent: true, to: { arrivalDTTM: '2026-09-21T09:36:33' } })),
    DISPLAY.EXCEPTION
  );
});

// ── Rolling ─────────────────────────────────────────────────────────────────

test('status 40 on the stop is out for delivery without asking the load', () => {
  assert.equal(displayStatus(stop({ stopStatus: '40' }, { loadStatus: '', loadStarted: false })), DISPLAY.OUT_FOR_DELIVERY);
});

test('the legacy 38 "enroute" code still rolls, in case this tenant uses it', () => {
  assert.equal(displayStatus(stop({ stopStatus: '38' }, { loadStatus: '', loadStarted: false })), DISPLAY.OUT_FOR_DELIVERY);
});

test('a started load rolls its stops even while their own codes lag', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '20' }, { loadStatus: '40', loadStarted: true })),
    DISPLAY.OUT_FOR_DELIVERY
  );
});

test('a load that has not left the yard has not started delivering', () => {
  assert.equal(
    displayStatus(stop({ stopStatus: '20' }, { loadStatus: '40', loadStarted: false })),
    DISPLAY.SCHEDULED
  );
});

// ── The two live stops from the report, as they stand now ───────────────────
//
// Both were correct on the morning the report came in, and the fix must not move them.

test('LIVE SHAPE: planned this morning, nothing worked yet → Scheduled', () => {
  const exe = { stopStatus: '20', exceptionPresent: false, exceptions: [], cancellation: {}, to: { etaCode: 'ONTIME' } };
  assert.equal(
    displayStatus(stop(exe, { onRoute: true, loadStatus: '30', loadStarted: false })),
    DISPLAY.SCHEDULED
  );
});

test('LIVE SHAPE: worked yesterday, POD on file → Delivered', () => {
  const exe = {
    stopStatus: '90',
    exceptionPresent: false,
    exceptions: [],
    cancellation: {},
    to: { arrivalDTTM: '2026-09-21T09:36:33', confirmedDTTM: '2026-09-21T10:32:45' },
  };
  assert.equal(
    displayStatus(stop(exe, { onRoute: true, loadStatus: '90', loadStarted: true })),
    DISPLAY.DELIVERED
  );
});

// ── Shape guards ────────────────────────────────────────────────────────────

test('an absent execution block does not throw', () => {
  assert.equal(displayStatus({}), DISPLAY.UNSCHEDULED);
  assert.equal(displayStatus({ exe: {}, onRoute: true }), DISPLAY.SCHEDULED);
});

test('numeric status codes from NuVizz are read the same as strings', () => {
  assert.equal(displayStatus(stop({ stopStatus: 90 })), DISPLAY.DELIVERED);
  assert.equal(displayStatus(stop({ stopStatus: 80 })), DISPLAY.EXCEPTION);
});

test('every display code is distinct', () => {
  const codes = Object.values(DISPLAY);
  assert.equal(new Set(codes).size, codes.length);
});
