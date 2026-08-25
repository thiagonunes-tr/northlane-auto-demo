import { NextRequest, NextResponse } from "next/server";
import { isDemoAccount, readSession, SESSION_COOKIE } from "../../../lib/auth";
import { isDemoStateAction } from "../../../lib/demo-state";
import {
  applyDemoStateAction,
  getDemoState,
  resetDemoState,
} from "../../../lib/mfa-db";

export const dynamic = "force-dynamic";

async function requireSession(request: NextRequest) {
  return readSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export async function GET(request: NextRequest) {
  if (!(await requireSession(request))) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  return NextResponse.json({ state: await getDemoState() });
}

export async function PATCH(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let body: {
    action?: unknown;
    coverage?: unknown;
    addOns?: unknown;
    deductible?: unknown;
    vehicle?: unknown;
    vehicleId?: unknown;
    driver?: unknown;
    driverId?: unknown;
    claim?: unknown;
    document?: unknown;
    reviewNote?: unknown;
    repairShop?: unknown;
    inspection?: unknown;
    assistance?: unknown;
    assistanceId?: unknown;
    card?: unknown;
    paymentMethodId?: unknown;
    invoiceId?: unknown;
    instalmentPlan?: unknown;
    reason?: unknown;
    messageBody?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Choose a valid demo action." },
      { status: 400 },
    );
  }

  if (!isDemoStateAction(body.action)) {
    return NextResponse.json(
      { error: "Choose a valid demo action." },
      { status: 400 },
    );
  }

  const result = await applyDemoStateAction(body.action, session.role, {
    coverage: body.coverage,
    addOns: body.addOns,
    deductible: body.deductible,
    vehicle: body.vehicle,
    vehicleId: body.vehicleId,
    driver: body.driver,
    driverId: body.driverId,
    claim: body.claim,
    document: body.document,
    reviewNote: body.reviewNote,
    repairShop: body.repairShop,
    inspection: body.inspection,
    assistance: body.assistance,
    assistanceId: body.assistanceId,
    card: body.card,
    paymentMethodId: body.paymentMethodId,
    invoiceId: body.invoiceId,
    instalmentPlan: body.instalmentPlan,
    reason: body.reason,
    messageBody: body.messageBody,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ state: result.state });
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession(request);
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  if (!isDemoAccount(session.email)) {
    return NextResponse.json(
      { error: "Only fixed demo accounts can reset the shared environment." },
      { status: 403 },
    );
  }
  return NextResponse.json({ state: await resetDemoState() });
}
