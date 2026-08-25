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

/** How a verification code reaches the person signing in. */
export type CodeDelivery = "fixed" | "email";

export type DeliveryContext = {
  /** One of the two shared demo accounts printed on the sign-in screen. */
  isSharedDemoAccount: boolean;
  /** A mail provider is configured and could actually send right now. */
  mailConfigured: boolean;
  /** The person signing in explicitly asked for an emailed code. */
  requestedEmail: boolean;
};

/**
 * Decides whether this sign-in gets a real emailed code or a documented fixed
 * one.
 *
 * Three rules, in order, each earning its place:
 *
 * 1. **No mail provider means no email.** A local checkout and CI have no
 *    Brevo key, and the sign-in flow still has to complete there. Without this
 *    the whole demo would need a cloud account to run.
 * 2. **A shared demo account uses a fixed code unless asked otherwise.** Those
 *    credentials are printed on the screen and used by every automated suite;
 *    tying them to a mailbox means one mail outage breaks every test and every
 *    live demo at once. Asking explicitly opts into the mailbox flow for the
 *    one sign-in that wants to show it.
 * 3. **An account someone registered uses email.** Its address is real and was
 *    chosen by whoever owns it, which is the case real verification is for.
 *
 * Pure and separate from the Worker environment so both branches are provable
 * without a mail provider, a database, or a network.
 */
export function chooseDelivery(context: DeliveryContext): CodeDelivery {
  if (!context.mailConfigured) return "fixed";
  if (context.isSharedDemoAccount) return context.requestedEmail ? "email" : "fixed";
  return "email";
}
