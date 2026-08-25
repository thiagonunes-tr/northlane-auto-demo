import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseDelivery,
  evaluateMfaRequest,
  getMfaChallengeState,
  getRemainingMfaAttempts,
} from "../lib/mfa-policy";

test("MFA challenge policy distinguishes active terminal states", () => {
  const now = 1_000_000;
  assert.equal(
    getMfaChallengeState(
      { attempts: 0, expiresAt: now + 1, consumedAt: null },
      now,
    ),
    "available",
  );
  assert.equal(
    getMfaChallengeState(
      { attempts: 0, expiresAt: now + 1, consumedAt: now - 1 },
      now,
    ),
    "consumed",
  );
  assert.equal(
    getMfaChallengeState(
      { attempts: 0, expiresAt: now, consumedAt: null },
      now,
    ),
    "expired",
  );
  assert.equal(
    getMfaChallengeState(
      { attempts: 5, expiresAt: now + 1, consumedAt: null },
      now,
    ),
    "locked",
  );
});

test("MFA attempts never report a negative remainder", () => {
  assert.equal(getRemainingMfaAttempts(0), 4);
  assert.equal(getRemainingMfaAttempts(3), 1);
  assert.equal(getRemainingMfaAttempts(4), 0);
  assert.equal(getRemainingMfaAttempts(9), 0);
});

test("MFA request policy enforces cooldown before hourly limit", () => {
  const now = 1_000_000;
  assert.deepEqual(evaluateMfaRequest([], now), { allowed: true });
  assert.deepEqual(evaluateMfaRequest([now - 30_001], now), {
    allowed: false,
    reason: "cooldown",
    retryAfterSeconds: 30,
  });
  assert.deepEqual(
    evaluateMfaRequest(
      [now - 61_000, now - 120_000, now - 180_000, now - 240_000, now - 300_000],
      now,
    ),
    { allowed: false, reason: "hourly-limit" },
  );
});

/* -------------------------------------------------------------------------- */
/* Code delivery                                                               */
/* -------------------------------------------------------------------------- */

/** Every combination of the three inputs, so no branch is assumed. */
function delivery(
  isSharedDemoAccount: boolean,
  mailConfigured: boolean,
  requestedEmail: boolean,
) {
  return chooseDelivery({ isSharedDemoAccount, mailConfigured, requestedEmail });
}

test("without a mail provider nothing is ever delivered by email", () => {
  // The case that keeps a local checkout and CI working with no secrets at all.
  for (const shared of [true, false]) {
    for (const asked of [true, false]) {
      assert.equal(
        delivery(shared, false, asked),
        "fixed",
        `shared=${shared} asked=${asked} must fall back to a fixed code`,
      );
    }
  }
});

test("a shared demo account keeps its printed code unless email is asked for", () => {
  // Tying shared credentials to a mailbox means one mail outage breaks every
  // automated suite and every live demo at once.
  assert.equal(delivery(true, true, false), "fixed");
  assert.equal(delivery(true, true, true), "email");
});

test("a registered account verifies by email whether or not it asked", () => {
  // Its address is real and was chosen by whoever owns it, which is the case
  // real verification exists for.
  assert.equal(delivery(false, true, false), "email");
  assert.equal(delivery(false, true, true), "email");
});

test("asking for email never downgrades a delivery that would already be email", () => {
  const asked = delivery(false, true, true);
  const unasked = delivery(false, true, false);
  assert.equal(asked, unasked);
});

test("the decision depends on nothing but its three inputs", () => {
  // Called twice with the same context it must answer the same way: no clock,
  // no randomness, no environment read behind the caller's back.
  const context = {
    isSharedDemoAccount: true,
    mailConfigured: true,
    requestedEmail: true,
  } as const;
  assert.equal(chooseDelivery({ ...context }), chooseDelivery({ ...context }));
});
