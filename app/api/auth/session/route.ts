import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, readSession } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      email: session.email,
      name: session.name,
      role: session.role,
    },
  });
}
