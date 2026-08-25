import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  findAccount,
  isDemoAccount,
  isSecureRequest,
  readSession,
  verifyPassword,
} from "../../../../lib/auth";
import { deleteStoredUser } from "../../../../lib/mfa-db";

export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest) {
  const session = await readSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session) {
    return NextResponse.json(
      { error: "Sign in to continue." },
      { status: 401 },
    );
  }
  if (isDemoAccount(session.email)) {
    return NextResponse.json(
      { error: "Fixed demo accounts cannot be deleted." },
      { status: 403 },
    );
  }

  let body: { confirmation?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Enter your password and type DELETE to confirm." },
      { status: 400 },
    );
  }
  if (body.confirmation !== "DELETE" || typeof body.password !== "string") {
    return NextResponse.json(
      { error: "Enter your password and type DELETE to confirm." },
      { status: 400 },
    );
  }

  const account = await findAccount(session.email);
  if (!account || !(await verifyPassword(account, body.password))) {
    return NextResponse.json(
      { error: "The password is incorrect." },
      { status: 401 },
    );
  }

  const deleted = await deleteStoredUser(session.email);
  if (!deleted) {
    return NextResponse.json(
      { error: "This account is unavailable." },
      { status: 404 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
