import assert from "node:assert/strict";
import test from "node:test";
import {
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
