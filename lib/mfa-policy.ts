export const MAX_MFA_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const HOURLY_EMAIL_LIMIT = 5;

export type MfaChallengePolicyInput = {
  attempts: number;
  expiresAt: number;
  consumedAt: number | null;
};

export type MfaChallengeState =
  | "available"
  | "consumed"
  | "expired"
  | "locked";

export type MfaRequestDecision =
  | { allowed: true }
  | { allowed: false; reason: "cooldown"; retryAfterSeconds: number }
  | { allowed: false; reason: "hourly-limit" };

export function getMfaChallengeState(
  challenge: MfaChallengePolicyInput,
  now: number,
): MfaChallengeState {
  if (challenge.consumedAt !== null) return "consumed";
  if (challenge.expiresAt <= now) return "expired";
  if (challenge.attempts >= MAX_MFA_ATTEMPTS) return "locked";
  return "available";
}

export function getRemainingMfaAttempts(attemptsBeforeFailure: number): number {
  return Math.max(0, MAX_MFA_ATTEMPTS - attemptsBeforeFailure - 1);
}

export function evaluateMfaRequest(
  recentCreationTimes: number[],
  now: number,
): MfaRequestDecision {
  const latest = recentCreationTimes[0];
  if (latest !== undefined && now - latest < RESEND_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterSeconds: Math.ceil(
        (RESEND_COOLDOWN_MS - (now - latest)) / 1000,
      ),
    };
  }
  if (recentCreationTimes.length >= HOURLY_EMAIL_LIMIT) {
    return { allowed: false, reason: "hourly-limit" };
  }
  return { allowed: true };
}
