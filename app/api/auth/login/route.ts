import { NextRequest, NextResponse } from "next/server";
import {
  MFA_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createUserAccount,
  findAccount,
  hashMfaCode,
  hashPassword,
  isDemoAccount,
  isSecureRequest,
  maskEmail,
  planVerification,
  sendMfaEmail,
  signSession,
  verifyPassword,
} from "../../../../lib/auth";
import { evaluateMfaRequest } from "../../../../lib/mfa-policy";
import { getMfaDb } from "../../../../lib/mfa-db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: {
    email?: unknown;
    password?: unknown;
    role?: unknown;
    skipMfa?: unknown;
    deliverByEmail?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Enter a valid email and password." },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const skipMfa = body.skipMfa === true;
  // Only meaningful for the two shared demo accounts, which default to their
  // documented fixed code so that automation and a live demo never depend on a
  // mailbox. An account someone registered always verifies by email when a mail
  // provider is configured, asked for or not.
  const deliverByEmail = body.deliverByEmail === true;
  const requestedRole =
    body.role === "agent" ? "agent" : body.role === "customer" ? "customer" : undefined;

  const existingAccount = await findAccount(email);
  let account = existingAccount;
  let isPendingPersonalAccount = false;

  if (!account) {
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Choose a password with at least 8 characters." },
        { status: 400 },
      );
    }
    account = createUserAccount(
      email,
      await hashPassword(password),
      requestedRole ?? "customer",
    );
    isPendingPersonalAccount = Boolean(account);
  }

  if (
    !account ||
    (existingAccount && requestedRole && account.role !== requestedRole) ||
    (existingAccount && !(await verifyPassword(account, password)))
  ) {
    return NextResponse.json(
      { error: "The email or password is incorrect." },
      { status: 401 },
    );
  }

  if (skipMfa) {
    if (!isDemoAccount(account.email)) {
      return NextResponse.json(
        {
          error:
            "Two-step verification can only be skipped for the fixed demo accounts.",
        },
        { status: 403 },
      );
    }

    const token = await signSession(account);
    const response = NextResponse.json({
      user: { email: account.email, name: account.name, role: account.role },
    });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecureRequest(request),
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return response;
  }

  const plan = planVerification(account, deliverByEmail);

  try {
    const db = await getMfaDb();
    const now = Date.now();

    // Rate limiting exists to protect a mail provider. A fixed code sends no
    // mail, so throttling it would only slow a test suite down for nothing.
    if (plan.delivery === "email") {
      // Only challenges that actually sent mail count. Counting every challenge
      // let a suite signing in with fixed codes exhaust a budget it never used,
      // which then blocked the one sign-in that wanted to demonstrate email.
      const recent = await db
        .prepare(
          `SELECT created_at FROM mfa_challenges
           WHERE email = ? AND created_at > ? AND delivery = 'email'
           ORDER BY created_at DESC`,
        )
        .bind(account.email, now - 60 * 60 * 1000)
        .all<{ created_at: number }>();

      const decision = evaluateMfaRequest(
        recent.results.map(item => item.created_at),
        now,
      );
      if (!decision.allowed && decision.reason === "cooldown") {
        return NextResponse.json(
          {
            error: `Please wait ${decision.retryAfterSeconds} seconds before requesting another code.`,
          },
          {
            status: 429,
            headers: { "Retry-After": String(decision.retryAfterSeconds) },
          },
        );
      }
      if (!decision.allowed) {
        return NextResponse.json(
          { error: "Too many codes were requested. Please try again later." },
          { status: 429 },
        );
      }
    }

    const challengeId = crypto.randomUUID();
    const codeHash = await hashMfaCode(challengeId, plan.code);

    const statements = [
      db
        .prepare(
          "UPDATE mfa_challenges SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
        )
        .bind(now, account.email),
      db.prepare("DELETE FROM pending_users WHERE email = ?").bind(account.email),
      db
        .prepare(
          `INSERT INTO mfa_challenges
           (id, email, role, code_hash, attempts, created_at, expires_at, consumed_at, delivery)
           VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
        )
        .bind(
          challengeId,
          account.email,
          account.role,
          codeHash,
          now,
          now + MFA_TTL_MS,
          plan.delivery,
        ),
    ];

    if (isPendingPersonalAccount) {
      statements.push(
        db
          .prepare(
            `INSERT INTO pending_users
             (challenge_id, email, name, role, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            challengeId,
            account.email,
            account.name,
            account.role,
            account.passwordHash,
            now,
          ),
      );
    }

    await db.batch(statements);

    if (plan.delivery === "email") {
      try {
        await sendMfaEmail(account.email, plan.code, challengeId);
      } catch (error) {
        await db.batch([
          db.prepare("DELETE FROM mfa_challenges WHERE id = ?").bind(challengeId),
          db
            .prepare("DELETE FROM pending_users WHERE challenge_id = ?")
            .bind(challengeId),
        ]);
        throw error;
      }
    }

    return NextResponse.json({
      challengeId,
      destination: maskEmail(account.email),
      expiresInSeconds: MFA_TTL_MS / 1000,
      // The client shows a different second step for each: a mailbox to check,
      // or the documented code printed on screen.
      codeDelivery: plan.delivery,
    });
  } catch (error) {
    console.error("Could not create an MFA challenge", error);
    return NextResponse.json(
      { error: "We could not start two-step verification. Please try again." },
      { status: 502 },
    );
  }
}
