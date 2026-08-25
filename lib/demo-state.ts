/**
 * The whole business domain of the Northlane Auto Insurance demo, as one pure
 * state machine.
 *
 * Nothing in here touches the network, the database, or React. The Worker owns
 * persistence (lib/mfa-db.ts) and the UI owns presentation (shared/NorthlaneApp
 * .tsx); this module owns the answer to "is that transition legal, and what does
 * the state look like afterwards". That split is what lets the unit tests drive
 * every business rule without a running server.
 *
 * Every value here is fictional. No money moves and no policy exists.
 */

export type DemoActorRole = "customer" | "agent";

/* -------------------------------------------------------------------------- */
/* Fixed demo clock                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The demo has no real clock. Every timestamp a transition writes is one of
 * these literals, so a test can assert on the exact string it will get and the
 * shared environment reads the same on Tuesday as it does on Friday.
 */
export const DEMO_TODAY = "July 24, 2026";
export const DEMO_NOW = "July 24, 2026 at 10:05 AM";
export const DEMO_MESSAGE_NOW = "Jul 24 · Now";

/* -------------------------------------------------------------------------- */
/* Policy, vehicle, driver                                                     */
/* -------------------------------------------------------------------------- */

export type CoverageTier = "Liability" | "Standard" | "Comprehensive";
export const COVERAGE_TIERS: CoverageTier[] = [
  "Liability",
  "Standard",
  "Comprehensive",
];

export type VehicleUse = "Commute" | "Pleasure" | "Business";
export const VEHICLE_USES: VehicleUse[] = ["Commute", "Pleasure", "Business"];

export type Vehicle = {
  year: string;
  make: string;
  model: string;
  vin: string;
  plate: string;
  primaryUse: VehicleUse;
  updatedAt: string;
};

export type Driver = {
  fullName: string;
  licenseNumber: string;
  licenseState: string;
  yearsLicensed: string;
  updatedAt: string;
};

/** A price the customer has been shown but has not accepted yet. */
export type Quote = {
  reference: string;
  coverage: CoverageTier;
  annualPremium: number;
  monthlyPremium: number;
  deductible: number;
  /** Every line that moved the price, so the number is never unexplained. */
  breakdown: { label: string; amount: number }[];
  quotedAt: string;
};

export type Policy = {
  number: string;
  coverage: CoverageTier;
  annualPremium: number;
  deductible: number;
  effectiveFrom: string;
  renewsOn: string;
  updatedAt: string;
};

/* -------------------------------------------------------------------------- */
/* Claims                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `approved` is reachable two ways: an agent decision, or the fast-track rule
 * below. `autoApproved` is what tells the two apart on screen, because a demo
 * audience that sees "Approved" with no agent action needs to be told why.
 */
export type ClaimStatus =
  | "submitted"
  | "in-review"
  | "more-info-needed"
  | "approved"
  | "rejected"
  | "settled";

export type ClaimType = "Collision" | "Theft" | "Glass" | "Weather";
export const CLAIM_TYPES: ClaimType[] = [
  "Collision",
  "Theft",
  "Glass",
  "Weather",
];

/** Only the file's name and size are kept. Nothing is stored or read. */
export type ClaimDocument = {
  id: string;
  fileName: string;
  sizeLabel: string;
  uploadedAt: string;
};

export type Claim = {
  reference: string;
  type: ClaimType;
  incidentDate: string;
  description: string;
  estimatedAmount: number;
  status: ClaimStatus;
  filedAt: string;
  autoApproved: boolean;
  /** The agent's last written decision or information request. */
  reviewNote: string | null;
  documents: ClaimDocument[];
  settlementAmount: number | null;
};

/** Claim statuses that still need somebody to act. */
export const OPEN_CLAIM_STATUSES: ClaimStatus[] = [
  "submitted",
  "in-review",
  "more-info-needed",
  "approved",
];

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

export type InvoiceStatus = "unpaid" | "paid";
export type Invoice = {
  id: string;
  description: string;
  amount: number;
  dueOn: string;
  status: InvoiceStatus;
  /** "Visa ending 1111", or null while unpaid. */
  paidWith: string | null;
  paidAt: string | null;
};

export type CardInput = {
  cardNumber: string;
  expiry: string;
  cvv: string;
  nameOnCard: string;
};

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export type DemoMessage = {
  id: string;
  sender: DemoActorRole;
  body: string;
  sentAt: string;
};

/** Last message id each role has read, used to derive an unread count. */
export type MessageReadState = { customer: string | null; agent: string | null };

/* -------------------------------------------------------------------------- */
/* The state                                                                   */
/* -------------------------------------------------------------------------- */

export type DemoState = {
  policy: Policy;
  vehicle: Vehicle;
  driver: Driver;
  /** A price on the table. Null once accepted or discarded. */
  quote: Quote | null;
  /** Null until the customer files one. Kept after settlement as history. */
  claim: Claim | null;
  invoice: Invoice;
  messages: DemoMessage[];
  lastRead: MessageReadState;
};

export type DemoStateAction =
  | "request-quote"
  | "accept-quote"
  | "discard-quote"
  | "update-vehicle"
  | "update-driver"
  | "file-claim"
  | "upload-claim-document"
  | "respond-to-claim-review"
  | "pay-invoice"
  | "send-message"
  | "mark-messages-read"
  | "start-claim-review"
  | "request-claim-information"
  | "approve-claim"
  | "reject-claim"
  | "settle-claim";

export type DemoActionInput = {
  coverage?: unknown;
  vehicle?: unknown;
  driver?: unknown;
  claim?: unknown;
  document?: unknown;
  reviewNote?: unknown;
  card?: unknown;
  messageBody?: unknown;
};

export type DemoTransitionResult =
  | { ok: true; state: DemoState }
  | { ok: false; status: 400 | 403 | 409; error: string };

/* -------------------------------------------------------------------------- */
/* Business rules                                                              */
/* -------------------------------------------------------------------------- */

/**
 * "Insurance claim over $2,000 starts as Pending Review" is the rule the demo
 * brief asks for. Anything at or below the limit is approved the moment it is
 * filed, which gives the demo two claim paths that diverge on one number.
 */
export const FAST_TRACK_CLAIM_LIMIT = 2000;

/** The largest estimate the form accepts, so a typo cannot produce nonsense. */
export const MAX_CLAIM_ESTIMATE = 100000;

/** Annual base rate per coverage tier, in whole dollars. */
export const COVERAGE_BASE_PREMIUM: Record<CoverageTier, number> = {
  Liability: 640,
  Standard: 980,
  Comprehensive: 1420,
};

export const COVERAGE_DEDUCTIBLE: Record<CoverageTier, number> = {
  Liability: 1000,
  Standard: 750,
  Comprehensive: 500,
};

export const OLDER_VEHICLE_SURCHARGE = 120;
export const NEW_DRIVER_SURCHARGE = 260;
export const BUSINESS_USE_SURCHARGE = 180;

/** A vehicle from this year or earlier counts as older. */
export const OLDER_VEHICLE_CUTOFF_YEAR = 2016;
/** Fewer licensed years than this counts as a new driver. */
export const NEW_DRIVER_YEARS = 3;

/**
 * The one card number this demo accepts, taken from the build rules. Every
 * other well-formed card is declined, so both outcomes are reachable without
 * anyone having to guess a magic value.
 */
export const DEMO_CARD_NUMBER = "4111111111111111";
export const DEMO_CARD_EXPIRY = "12/30";
export const DEMO_CARD_CVV = "123";

export const CARD_DECLINED_MESSAGE =
  "That card was declined. Use the demo card 4111 1111 1111 1111 with expiry 12/30 and CVV 123.";

/**
 * Prices a coverage tier against the vehicle and driver currently on file.
 *
 * Deliberately arithmetic a demo audience can follow in one reading: a base
 * rate plus at most three named surcharges. It is not risk scoring and is not
 * meant to resemble any.
 */
export function priceQuote(
  coverage: CoverageTier,
  vehicle: Vehicle,
  driver: Driver,
): { annualPremium: number; monthlyPremium: number; deductible: number; breakdown: { label: string; amount: number }[] } {
  const breakdown: { label: string; amount: number }[] = [
    { label: `${coverage} base rate`, amount: COVERAGE_BASE_PREMIUM[coverage] },
  ];

  const year = Number.parseInt(vehicle.year, 10);
  if (Number.isFinite(year) && year <= OLDER_VEHICLE_CUTOFF_YEAR) {
    breakdown.push({
      label: `Vehicle ${OLDER_VEHICLE_CUTOFF_YEAR} or older`,
      amount: OLDER_VEHICLE_SURCHARGE,
    });
  }

  const licensedYears = Number.parseInt(driver.yearsLicensed, 10);
  if (Number.isFinite(licensedYears) && licensedYears < NEW_DRIVER_YEARS) {
    breakdown.push({
      label: `Licensed under ${NEW_DRIVER_YEARS} years`,
      amount: NEW_DRIVER_SURCHARGE,
    });
  }

  if (vehicle.primaryUse === "Business") {
    breakdown.push({ label: "Business use", amount: BUSINESS_USE_SURCHARGE });
  }

  const annualPremium = breakdown.reduce((total, line) => total + line.amount, 0);
  return {
    annualPremium,
    monthlyPremium: Math.round(annualPremium / 12),
    deductible: COVERAGE_DEDUCTIBLE[coverage],
    breakdown,
  };
}

/** What a claim pays out: the estimate less the policy deductible, never below zero. */
export function settlementFor(estimate: number, deductible: number): number {
  return Math.max(0, estimate - deductible);
}

/* -------------------------------------------------------------------------- */
/* Seed data                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_VEHICLE: Vehicle = {
  year: "2019",
  make: "Honda",
  model: "Civic LX",
  vin: "1HGBH41JXMN109186",
  plate: "8KTR429",
  primaryUse: "Commute",
  updatedAt: "Initial demo record",
};

export const DEFAULT_DRIVER: Driver = {
  fullName: "Alex Carter",
  licenseNumber: "C0482-9915-3320",
  licenseState: "California",
  yearsLicensed: "11",
  updatedAt: "Initial demo record",
};

export const DEFAULT_POLICY: Policy = {
  number: "NL-2026-004821",
  coverage: "Standard",
  annualPremium: 980,
  deductible: 750,
  effectiveFrom: "February 1, 2026",
  renewsOn: "February 1, 2027",
  updatedAt: "Initial demo record",
};

export const DEFAULT_INVOICE: Invoice = {
  id: "invoice-jul",
  description: "Monthly premium · July 2026",
  amount: 82,
  dueOn: "August 5, 2026",
  status: "unpaid",
  paidWith: null,
  paidAt: null,
};

export const DEFAULT_MESSAGES: DemoMessage[] = [
  {
    id: "message-1",
    sender: "agent",
    body: "Hi Alex, your policy renews in February. Let us know if anything about the car or your licence has changed.",
    sentAt: "Jul 24 · 9:10 AM",
  },
  {
    id: "message-2",
    sender: "customer",
    body: "Thanks. Nothing has changed for now.",
    sentAt: "Jul 24 · 9:18 AM",
  },
];

export const DEFAULT_LAST_READ: MessageReadState = {
  customer: null,
  agent: null,
};

export const DEFAULT_DEMO_STATE: DemoState = {
  policy: DEFAULT_POLICY,
  vehicle: DEFAULT_VEHICLE,
  driver: DEFAULT_DRIVER,
  quote: null,
  claim: null,
  invoice: DEFAULT_INVOICE,
  messages: DEFAULT_MESSAGES,
  lastRead: DEFAULT_LAST_READ,
};

export const DEMO_STATE_ACTIONS: DemoStateAction[] = [
  "request-quote",
  "accept-quote",
  "discard-quote",
  "update-vehicle",
  "update-driver",
  "file-claim",
  "upload-claim-document",
  "respond-to-claim-review",
  "pay-invoice",
  "send-message",
  "mark-messages-read",
  "start-claim-review",
  "request-claim-information",
  "approve-claim",
  "reject-claim",
  "settle-claim",
];

const CUSTOMER_ACTIONS: DemoStateAction[] = [
  "request-quote",
  "accept-quote",
  "discard-quote",
  "update-vehicle",
  "update-driver",
  "file-claim",
  "upload-claim-document",
  "respond-to-claim-review",
  "pay-invoice",
  "send-message",
  "mark-messages-read",
];

const AGENT_ACTIONS: DemoStateAction[] = [
  "start-claim-review",
  "request-claim-information",
  "approve-claim",
  "reject-claim",
  "settle-claim",
  "send-message",
  "mark-messages-read",
];

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

export function isDemoStateAction(value: unknown): value is DemoStateAction {
  return (
    typeof value === "string" &&
    DEMO_STATE_ACTIONS.includes(value as DemoStateAction)
  );
}

export function isCoverageTier(value: unknown): value is CoverageTier {
  return COVERAGE_TIERS.includes(String(value) as CoverageTier);
}

export function isVehicleUse(value: unknown): value is VehicleUse {
  return VEHICLE_USES.includes(String(value) as VehicleUse);
}

export function isClaimType(value: unknown): value is ClaimType {
  return CLAIM_TYPES.includes(String(value) as ClaimType);
}

function isRequiredText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

export function isVehicle(value: unknown): value is Vehicle {
  if (!value || typeof value !== "object") return false;
  const vehicle = value as Partial<Vehicle>;
  return (
    isRequiredText(vehicle.year, 4) &&
    isRequiredText(vehicle.make, 40) &&
    isRequiredText(vehicle.model, 40) &&
    isRequiredText(vehicle.vin, 20) &&
    isRequiredText(vehicle.plate, 12) &&
    isVehicleUse(vehicle.primaryUse) &&
    typeof vehicle.updatedAt === "string"
  );
}

export function isDriver(value: unknown): value is Driver {
  if (!value || typeof value !== "object") return false;
  const driver = value as Partial<Driver>;
  return (
    isRequiredText(driver.fullName, 80) &&
    isRequiredText(driver.licenseNumber, 30) &&
    isRequiredText(driver.licenseState, 40) &&
    isRequiredText(driver.yearsLicensed, 2) &&
    typeof driver.updatedAt === "string"
  );
}

export function isQuote(value: unknown): value is Quote {
  if (!value || typeof value !== "object") return false;
  const quote = value as Partial<Quote>;
  return (
    isRequiredText(quote.reference, 40) &&
    isCoverageTier(quote.coverage) &&
    isPositiveAmount(quote.annualPremium) &&
    isPositiveAmount(quote.monthlyPremium) &&
    isPositiveAmount(quote.deductible) &&
    Array.isArray(quote.breakdown) &&
    quote.breakdown.every(
      line =>
        !!line &&
        typeof line === "object" &&
        isRequiredText((line as { label?: unknown }).label, 60) &&
        isPositiveAmount((line as { amount?: unknown }).amount),
    ) &&
    typeof quote.quotedAt === "string"
  );
}

export function isPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<Policy>;
  return (
    isRequiredText(policy.number, 40) &&
    isCoverageTier(policy.coverage) &&
    isPositiveAmount(policy.annualPremium) &&
    isPositiveAmount(policy.deductible) &&
    typeof policy.effectiveFrom === "string" &&
    typeof policy.renewsOn === "string" &&
    typeof policy.updatedAt === "string"
  );
}

export function isClaimDocument(value: unknown): value is ClaimDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<ClaimDocument>;
  return (
    isRequiredText(document.id, 60) &&
    isRequiredText(document.fileName, 160) &&
    typeof document.sizeLabel === "string" &&
    typeof document.uploadedAt === "string"
  );
}

export function isClaim(value: unknown): value is Claim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<Claim>;
  return (
    isRequiredText(claim.reference, 40) &&
    isClaimType(claim.type) &&
    typeof claim.incidentDate === "string" &&
    isRequiredText(claim.description, 400) &&
    isPositiveAmount(claim.estimatedAmount) &&
    [
      "submitted",
      "in-review",
      "more-info-needed",
      "approved",
      "rejected",
      "settled",
    ].includes(String(claim.status)) &&
    typeof claim.filedAt === "string" &&
    typeof claim.autoApproved === "boolean" &&
    (claim.reviewNote === null || typeof claim.reviewNote === "string") &&
    Array.isArray(claim.documents) &&
    claim.documents.every(isClaimDocument) &&
    (claim.settlementAmount === null ||
      (typeof claim.settlementAmount === "number" &&
        Number.isFinite(claim.settlementAmount) &&
        claim.settlementAmount >= 0))
  );
}

export function isInvoice(value: unknown): value is Invoice {
  if (!value || typeof value !== "object") return false;
  const invoice = value as Partial<Invoice>;
  return (
    isRequiredText(invoice.id, 60) &&
    isRequiredText(invoice.description, 200) &&
    isPositiveAmount(invoice.amount) &&
    typeof invoice.dueOn === "string" &&
    ["unpaid", "paid"].includes(String(invoice.status)) &&
    (invoice.paidWith === null || typeof invoice.paidWith === "string") &&
    (invoice.paidAt === null || typeof invoice.paidAt === "string")
  );
}

export function isDemoMessage(value: unknown): value is DemoMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DemoMessage>;
  return (
    typeof message.id === "string" &&
    (message.sender === "customer" || message.sender === "agent") &&
    isRequiredText(message.body, 500) &&
    typeof message.sentAt === "string"
  );
}

export function isMessageReadState(value: unknown): value is MessageReadState {
  if (!value || typeof value !== "object") return false;
  const read = value as Partial<MessageReadState>;
  return (
    (read.customer === null || typeof read.customer === "string") &&
    (read.agent === null || typeof read.agent === "string")
  );
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/* -------------------------------------------------------------------------- */
/* Derived counts                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Messages addressed to `role` that arrived after the last one it read. The
 * reader's own sent messages never count, which is the whole point of tracking
 * a per-role marker rather than a thread length.
 */
export function countUnreadMessages(
  state: DemoState,
  role: DemoActorRole,
): number {
  const lastReadId = state.lastRead[role];
  const lastReadIndex = lastReadId
    ? state.messages.findIndex(message => message.id === lastReadId)
    : -1;
  return state.messages
    .slice(lastReadIndex + 1)
    .filter(message => message.sender !== role).length;
}

/** Claims sitting on an agent's desk right now. */
export function countClaimsAwaitingAgent(state: DemoState): number {
  if (!state.claim) return 0;
  return ["submitted", "in-review", "approved"].includes(state.claim.status)
    ? 1
    : 0;
}

/** Things the customer has to do before anything else can move. */
export function countCustomerTodos(state: DemoState): number {
  let total = 0;
  if (state.invoice.status === "unpaid") total += 1;
  if (state.quote !== null) total += 1;
  if (state.claim?.status === "more-info-needed") total += 1;
  return total;
}

/** True when there is a claim that has not reached a terminal status. */
export function hasOpenClaim(state: DemoState): boolean {
  return state.claim !== null && OPEN_CLAIM_STATUSES.includes(state.claim.status);
}

export function claimStatusLabel(status: ClaimStatus): string {
  return {
    submitted: "Pending review",
    "in-review": "In review",
    "more-info-needed": "Needs more information",
    approved: "Approved",
    rejected: "Rejected",
    settled: "Settled",
  }[status];
}

/** Whole dollars as "$1,420". Money is never a bare number on screen. */
export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                               */
/* -------------------------------------------------------------------------- */

function parseVehicle(value: unknown): Omit<Vehicle, "updatedAt"> | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Vehicle>;
  if (
    !isRequiredText(input.year, 4) ||
    !/^(19|20)\d{2}$/.test(input.year.trim()) ||
    !isRequiredText(input.make, 40) ||
    !isRequiredText(input.model, 40) ||
    !isRequiredText(input.vin, 20) ||
    !isRequiredText(input.plate, 12) ||
    !isVehicleUse(input.primaryUse)
  ) {
    return null;
  }
  return {
    year: input.year.trim(),
    make: input.make.trim(),
    model: input.model.trim(),
    vin: input.vin.trim().toUpperCase(),
    plate: input.plate.trim().toUpperCase(),
    primaryUse: input.primaryUse,
  };
}

function parseDriver(value: unknown): Omit<Driver, "updatedAt"> | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<Driver>;
  if (
    !isRequiredText(input.fullName, 80) ||
    !isRequiredText(input.licenseNumber, 30) ||
    !isRequiredText(input.licenseState, 40) ||
    !isRequiredText(input.yearsLicensed, 2) ||
    !/^\d{1,2}$/.test(input.yearsLicensed.trim())
  ) {
    return null;
  }
  return {
    fullName: input.fullName.trim(),
    licenseNumber: input.licenseNumber.trim(),
    licenseState: input.licenseState.trim(),
    yearsLicensed: input.yearsLicensed.trim(),
  };
}

type ClaimInput = {
  type: ClaimType;
  incidentDate: string;
  description: string;
  estimatedAmount: number;
};

function parseClaim(value: unknown): ClaimInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as {
    type?: unknown;
    incidentDate?: unknown;
    description?: unknown;
    estimatedAmount?: unknown;
  };
  if (
    !isClaimType(input.type) ||
    !isRequiredText(input.incidentDate, 20) ||
    // An ISO date from <input type="date">. Rejecting anything else keeps the
    // rendered string predictable for a test that asserts on it.
    !/^\d{4}-\d{2}-\d{2}$/.test(input.incidentDate.trim()) ||
    !isRequiredText(input.description, 400)
  ) {
    return null;
  }
  const estimate = Number(input.estimatedAmount);
  if (
    !Number.isFinite(estimate) ||
    !Number.isInteger(estimate) ||
    estimate <= 0 ||
    estimate > MAX_CLAIM_ESTIMATE
  ) {
    return null;
  }
  return {
    type: input.type,
    incidentDate: input.incidentDate.trim(),
    description: input.description.trim(),
    estimatedAmount: estimate,
  };
}

function parseDocument(value: unknown): { fileName: string; sizeLabel: string } | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { fileName?: unknown; sizeLabel?: unknown };
  if (!isRequiredText(input.fileName, 160)) return null;
  return {
    fileName: input.fileName.trim(),
    sizeLabel: isRequiredText(input.sizeLabel, 20)
      ? input.sizeLabel.trim()
      : "unknown size",
  };
}

/**
 * Card outcomes are deterministic: the documented demo card is accepted and
 * every other well-formed card is declined. Malformed input is a 400 because
 * the form is wrong, not the card.
 */
type CardVerdict =
  | { ok: true; label: string }
  | { ok: false; status: 400 | 409; error: string };

export function verifyCard(value: unknown): CardVerdict {
  if (!value || typeof value !== "object") {
    return { ok: false, status: 400, error: "Complete every payment field." };
  }
  const input = value as Partial<CardInput>;
  const digits = String(input.cardNumber ?? "").replace(/\s|-/g, "");
  const expiry = String(input.expiry ?? "").trim();
  const cvv = String(input.cvv ?? "").trim();
  const nameOnCard = String(input.nameOnCard ?? "").trim();

  if (
    !/^\d{16}$/.test(digits) ||
    !/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry) ||
    !/^\d{3}$/.test(cvv) ||
    nameOnCard.length === 0 ||
    nameOnCard.length > 80
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "Enter a 16-digit card number, an MM/YY expiry, a 3-digit CVV, and the name on the card.",
    };
  }

  if (digits !== DEMO_CARD_NUMBER || expiry !== DEMO_CARD_EXPIRY || cvv !== DEMO_CARD_CVV) {
    return { ok: false, status: 409, error: CARD_DECLINED_MESSAGE };
  }

  return { ok: true, label: `Visa ending ${digits.slice(-4)}` };
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The only way the demo state ever changes.
 *
 * Status codes carry meaning and the tests assert on them: 403 is "your role
 * cannot do this at all", 400 is "the request is malformed", 409 is "the
 * request is fine but the state is not ready for it".
 */
export function transitionDemoState(
  state: DemoState,
  action: DemoStateAction,
  role: DemoActorRole,
  input: DemoActionInput = {},
): DemoTransitionResult {
  if (role === "customer" && !CUSTOMER_ACTIONS.includes(action)) {
    return {
      ok: false,
      status: 403,
      error: "Only a claims agent can perform this action.",
    };
  }
  if (role === "agent" && !AGENT_ACTIONS.includes(action)) {
    return {
      ok: false,
      status: 403,
      error: "Only the policyholder can perform this action.",
    };
  }

  switch (action) {
    case "request-quote": {
      if (!isCoverageTier(input.coverage)) {
        return { ok: false, status: 400, error: "Choose a coverage level." };
      }
      if (input.coverage === state.policy.coverage) {
        return {
          ok: false,
          status: 409,
          error: `Your policy is already on ${input.coverage} coverage. Choose a different level to see a new price.`,
        };
      }
      const priced = priceQuote(input.coverage, state.vehicle, state.driver);
      return {
        ok: true,
        state: {
          ...state,
          quote: {
            reference: "QT-2026-3390",
            coverage: input.coverage,
            annualPremium: priced.annualPremium,
            monthlyPremium: priced.monthlyPremium,
            deductible: priced.deductible,
            breakdown: priced.breakdown,
            quotedAt: DEMO_NOW,
          },
        },
      };
    }

    case "accept-quote": {
      const { quote } = state;
      if (!quote) {
        return {
          ok: false,
          status: 409,
          error: "Request a quote before changing your coverage.",
        };
      }
      return {
        ok: true,
        state: {
          ...state,
          quote: null,
          policy: {
            ...state.policy,
            coverage: quote.coverage,
            annualPremium: quote.annualPremium,
            deductible: quote.deductible,
            updatedAt: DEMO_NOW,
          },
          // A coverage change reprices the premium, so the open invoice is
          // reissued rather than left describing the old policy.
          invoice: {
            ...state.invoice,
            id: "invoice-jul-revised",
            description: `Monthly premium · ${quote.coverage} coverage`,
            amount: quote.monthlyPremium,
            status: "unpaid",
            paidWith: null,
            paidAt: null,
          },
        },
      };
    }

    case "discard-quote":
      if (!state.quote) {
        return { ok: false, status: 409, error: "There is no quote to discard." };
      }
      return { ok: true, state: { ...state, quote: null } };

    case "update-vehicle": {
      const vehicle = parseVehicle(input.vehicle);
      if (!vehicle) {
        return {
          ok: false,
          status: 400,
          error:
            "Complete every vehicle field. The year must be four digits and the use must be one of the listed options.",
        };
      }
      // A repriced vehicle invalidates an outstanding quote: the price on the
      // table was calculated against the car that is no longer on file.
      return {
        ok: true,
        state: {
          ...state,
          vehicle: { ...vehicle, updatedAt: DEMO_NOW },
          quote: null,
        },
      };
    }

    case "update-driver": {
      const driver = parseDriver(input.driver);
      if (!driver) {
        return {
          ok: false,
          status: 400,
          error:
            "Complete every driver field. Years licensed must be a whole number.",
        };
      }
      return {
        ok: true,
        state: {
          ...state,
          driver: { ...driver, updatedAt: DEMO_NOW },
          quote: null,
        },
      };
    }

    case "file-claim": {
      if (hasOpenClaim(state)) {
        return {
          ok: false,
          status: 409,
          error: "Your existing claim has to be closed before you file another one.",
        };
      }
      const claim = parseClaim(input.claim);
      if (!claim) {
        return {
          ok: false,
          status: 400,
          error: `Complete every claim field. The estimate must be a whole number of dollars up to ${formatMoney(MAX_CLAIM_ESTIMATE)}.`,
        };
      }
      // The fast-track rule. At or below the limit the claim is approved on
      // arrival; above it, an agent has to look at it.
      const fastTracked = claim.estimatedAmount <= FAST_TRACK_CLAIM_LIMIT;
      return {
        ok: true,
        state: {
          ...state,
          claim: {
            reference: "CLM-2026-7714",
            type: claim.type,
            incidentDate: claim.incidentDate,
            description: claim.description,
            estimatedAmount: claim.estimatedAmount,
            status: fastTracked ? "approved" : "submitted",
            filedAt: DEMO_NOW,
            autoApproved: fastTracked,
            reviewNote: fastTracked
              ? `Approved automatically: estimates of ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} or less do not need an agent review.`
              : null,
            documents: [],
            settlementAmount: null,
          },
        },
      };
    }

    case "upload-claim-document": {
      const { claim } = state;
      if (!claim) {
        return {
          ok: false,
          status: 409,
          error: "File a claim before attaching documents to it.",
        };
      }
      if (claim.status === "settled" || claim.status === "rejected") {
        return {
          ok: false,
          status: 409,
          error: "This claim is closed, so no more documents can be attached.",
        };
      }
      const document = parseDocument(input.document);
      if (!document) {
        return { ok: false, status: 400, error: "Choose a file to attach." };
      }
      return {
        ok: true,
        state: {
          ...state,
          claim: {
            ...claim,
            documents: [
              ...claim.documents,
              {
                id: `document-${claim.documents.length + 1}`,
                fileName: document.fileName,
                sizeLabel: document.sizeLabel,
                uploadedAt: DEMO_NOW,
              },
            ],
          },
        },
      };
    }

    case "respond-to-claim-review": {
      const { claim } = state;
      if (!claim || claim.status !== "more-info-needed") {
        return {
          ok: false,
          status: 409,
          error: "This claim is not waiting on information from you.",
        };
      }
      if (claim.documents.length === 0) {
        return {
          ok: false,
          status: 409,
          error: "Attach at least one document before sending the claim back for review.",
        };
      }
      return {
        ok: true,
        state: { ...state, claim: { ...claim, status: "in-review" } },
      };
    }

    case "pay-invoice": {
      if (state.invoice.status === "paid") {
        return {
          ok: false,
          status: 409,
          error: "This invoice has already been settled.",
        };
      }
      const verdict = verifyCard(input.card);
      if (!verdict.ok) {
        return { ok: false, status: verdict.status, error: verdict.error };
      }
      return {
        ok: true,
        state: {
          ...state,
          invoice: {
            ...state.invoice,
            status: "paid",
            paidWith: verdict.label,
            paidAt: DEMO_NOW,
          },
        },
      };
    }

    case "mark-messages-read": {
      const lastMessage = state.messages[state.messages.length - 1];
      if (!lastMessage || state.lastRead[role] === lastMessage.id) {
        return { ok: true, state };
      }
      return {
        ok: true,
        state: {
          ...state,
          lastRead: { ...state.lastRead, [role]: lastMessage.id },
        },
      };
    }

    case "send-message": {
      if (!isRequiredText(input.messageBody, 500)) {
        return {
          ok: false,
          status: 400,
          error: "Enter a message with no more than 500 characters.",
        };
      }
      return {
        ok: true,
        state: {
          ...state,
          messages: [
            ...state.messages,
            {
              id: `message-${state.messages.length + 1}`,
              sender: role,
              body: input.messageBody.trim(),
              sentAt: DEMO_MESSAGE_NOW,
            },
          ],
        },
      };
    }

    case "start-claim-review": {
      const { claim } = state;
      if (!claim || claim.status !== "submitted") {
        return {
          ok: false,
          status: 409,
          error: "Only a claim pending review can be opened for review.",
        };
      }
      return {
        ok: true,
        state: { ...state, claim: { ...claim, status: "in-review" } },
      };
    }

    case "request-claim-information":
    case "approve-claim":
    case "reject-claim": {
      const { claim } = state;
      if (!claim || claim.status !== "in-review") {
        return {
          ok: false,
          status: 409,
          error: "Only a claim in review can be decided.",
        };
      }
      // Every decision is written down. A rejection or an information request
      // with no reason is the one thing a policyholder cannot act on.
      if (!isRequiredText(input.reviewNote, 400)) {
        return {
          ok: false,
          status: 400,
          error: "Write a note of up to 400 characters explaining this decision.",
        };
      }
      const reviewNote = input.reviewNote.trim();
      const status: ClaimStatus =
        action === "approve-claim"
          ? "approved"
          : action === "reject-claim"
            ? "rejected"
            : "more-info-needed";
      return {
        ok: true,
        state: { ...state, claim: { ...claim, status, reviewNote } },
      };
    }

    case "settle-claim": {
      const { claim } = state;
      if (!claim || claim.status !== "approved") {
        return {
          ok: false,
          status: 409,
          error: "Only an approved claim can be settled.",
        };
      }
      return {
        ok: true,
        state: {
          ...state,
          claim: {
            ...claim,
            status: "settled",
            settlementAmount: settlementFor(
              claim.estimatedAmount,
              state.policy.deductible,
            ),
          },
        },
      };
    }
  }
}
