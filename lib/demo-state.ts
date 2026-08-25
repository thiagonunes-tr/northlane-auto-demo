/**
 * The whole business domain of the Northlane Auto Insurance demo, as one pure
 * state machine.
 *
 * Nothing here touches the network, the database, or React. The Worker owns
 * persistence (lib/mfa-db.ts) and the UI owns presentation
 * (shared/NorthlaneApp.tsx); this module owns the answer to "is that transition
 * legal, and what does the state look like afterwards". That split is what lets
 * the unit tests drive every business rule without a running server.
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
/** Where a renewal lands. One year on from the current term. */
export const DEMO_NEXT_TERM_START = "February 1, 2027";
export const DEMO_NEXT_TERM_END = "February 1, 2028";

/* -------------------------------------------------------------------------- */
/* Coverage, add-ons, deductible                                               */
/* -------------------------------------------------------------------------- */

export type CoverageTier = "Liability" | "Standard" | "Comprehensive";
export const COVERAGE_TIERS: CoverageTier[] = [
  "Liability",
  "Standard",
  "Comprehensive",
];

/** Annual base rate per coverage tier, per vehicle, in whole dollars. */
export const COVERAGE_BASE_PREMIUM: Record<CoverageTier, number> = {
  Liability: 640,
  Standard: 980,
  Comprehensive: 1420,
};

/**
 * Optional cover the customer adds on top of a tier.
 *
 * Priced as a flat annual amount each, because a demo audience has to be able
 * to add one and see exactly what it cost.
 */
export type AddOnId = "courtesy-car" | "roadside" | "glass" | "third-party-plus";

export type AddOn = {
  id: AddOnId;
  label: string;
  description: string;
  annualPremium: number;
};

export const ADD_ONS: AddOn[] = [
  {
    id: "courtesy-car",
    label: "Courtesy car",
    description: "A replacement car while yours is being repaired.",
    annualPremium: 120,
  },
  {
    id: "roadside",
    label: "Roadside assistance",
    description: "Towing, jump starts, flat tyres, lockouts and fuel delivery.",
    annualPremium: 90,
  },
  {
    id: "glass",
    label: "Glass cover",
    description: "Windscreen and window repair with no deductible.",
    annualPremium: 60,
  },
  {
    id: "third-party-plus",
    label: "Third-party plus",
    description: "Raises the limit on damage you cause to other people.",
    annualPremium: 150,
  },
];

export function isAddOnId(value: unknown): value is AddOnId {
  return ADD_ONS.some(addOn => addOn.id === value);
}

export function addOnFor(id: AddOnId): AddOn {
  const found = ADD_ONS.find(addOn => addOn.id === id);
  if (!found) throw new Error(`Unknown add-on: ${id}`);
  return found;
}

/**
 * Deductibles the customer picks, and what each does to the premium.
 *
 * Carrying more of a claim yourself costs less up front. The numbers are
 * arithmetic a demo audience can follow, not an actuarial table.
 */
export type DeductibleChoice = 250 | 500 | 750 | 1000;
export const DEDUCTIBLE_CHOICES: DeductibleChoice[] = [250, 500, 750, 1000];
export const DEDUCTIBLE_ADJUSTMENT: Record<DeductibleChoice, number> = {
  250: 180,
  500: 80,
  750: 0,
  1000: -90,
};

export function isDeductibleChoice(value: unknown): value is DeductibleChoice {
  return DEDUCTIBLE_CHOICES.includes(Number(value) as DeductibleChoice);
}

/* -------------------------------------------------------------------------- */
/* Risk: vehicles and drivers                                                  */
/* -------------------------------------------------------------------------- */

export type VehicleUse = "Commute" | "Pleasure" | "Business";
export const VEHICLE_USES: VehicleUse[] = ["Commute", "Pleasure", "Business"];

export type Vehicle = {
  id: string;
  year: string;
  make: string;
  model: string;
  vin: string;
  plate: string;
  primaryUse: VehicleUse;
  updatedAt: string;
};

export type Driver = {
  id: string;
  fullName: string;
  licenseNumber: string;
  licenseState: string;
  yearsLicensed: string;
  /** The policyholder. Exactly one driver is primary and it cannot be removed. */
  isPrimary: boolean;
  updatedAt: string;
};

/** A vehicle from this year or earlier counts as older. */
export const OLDER_VEHICLE_CUTOFF_YEAR = 2016;
export const OLDER_VEHICLE_SURCHARGE = 120;
/** Fewer licensed years than this counts as a new driver. */
export const NEW_DRIVER_YEARS = 3;
export const NEW_DRIVER_SURCHARGE = 260;
export const BUSINESS_USE_SURCHARGE = 180;

/** A policy must always keep at least one of each. */
export const MIN_VEHICLES = 1;
export const MIN_DRIVERS = 1;
export const MAX_VEHICLES = 4;
export const MAX_DRIVERS = 4;

/* -------------------------------------------------------------------------- */
/* No-claims bonus                                                             */
/* -------------------------------------------------------------------------- */

/** Discount earned per claim-free year, and the ceiling it stops at. */
export const NO_CLAIMS_DISCOUNT_PER_YEAR = 5;
export const MAX_NO_CLAIMS_DISCOUNT = 25;

export function noClaimsDiscountPercent(years: number): number {
  if (!Number.isFinite(years) || years <= 0) return 0;
  return Math.min(
    Math.floor(years) * NO_CLAIMS_DISCOUNT_PER_YEAR,
    MAX_NO_CLAIMS_DISCOUNT,
  );
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

export type PolicyStatus = "active" | "lapsed" | "cancelled";

/** How the premium is billed. Changing it reissues the open invoice. */
export type InstalmentPlan = "annual" | "monthly";
export const INSTALMENT_PLANS: InstalmentPlan[] = ["annual", "monthly"];

export type Policy = {
  number: string;
  status: PolicyStatus;
  coverage: CoverageTier;
  addOns: AddOnId[];
  deductible: DeductibleChoice;
  annualPremium: number;
  instalmentPlan: InstalmentPlan;
  effectiveFrom: string;
  renewsOn: string;
  /** Claim-free years carried into the next price. Reset when a claim settles. */
  noClaimsYears: number;
  updatedAt: string;
  endedOn: string | null;
  endedReason: string | null;
};

/* -------------------------------------------------------------------------- */
/* Quotes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether accepting this quote changes the policy in force or issues a new one.
 *
 * The two look identical on the pricing screen and behave completely
 * differently on acceptance, so the kind is decided when the quote is created
 * and carried with it rather than re-derived later from policy status that may
 * have moved in between.
 */
export type QuoteKind = "new-business" | "endorsement";

export type PriceLine = { label: string; amount: number };

export type Quote = {
  reference: string;
  kind: QuoteKind;
  coverage: CoverageTier;
  addOns: AddOnId[];
  deductible: DeductibleChoice;
  annualPremium: number;
  monthlyPremium: number;
  /** Every line that moved the price, so the total is never unexplained. */
  breakdown: PriceLine[];
  quotedAt: string;
};

/* -------------------------------------------------------------------------- */
/* Claims                                                                      */
/* -------------------------------------------------------------------------- */

export type ClaimStatus =
  | "submitted"
  | "in-review"
  | "inspection-scheduled"
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

/** The other party in an incident, when there was one. */
export type ThirdParty = {
  name: string;
  plate: string;
  insurer: string;
};

export type InspectionOutcome = "damage-confirmed" | "damage-disputed";

export type Inspection = {
  shop: string;
  scheduledFor: string;
  outcome: InspectionOutcome | null;
  notes: string | null;
};

export const REPAIR_SHOPS = [
  "Northgate Auto Body",
  "Lakeside Collision Centre",
  "Prairie Street Garage",
] as const;
export type RepairShop = (typeof REPAIR_SHOPS)[number];

export function isRepairShop(value: unknown): value is RepairShop {
  return (REPAIR_SHOPS as readonly string[]).includes(String(value));
}

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
  thirdParty: ThirdParty | null;
  repairShop: RepairShop | null;
  inspection: Inspection | null;
  settlementAmount: number | null;
  /** The deductible applied, captured at settlement so history stays true. */
  settledDeductible: number | null;
};

/** Claim statuses that still need somebody to act. */
export const OPEN_CLAIM_STATUSES: ClaimStatus[] = [
  "submitted",
  "in-review",
  "inspection-scheduled",
  "more-info-needed",
  "approved",
];

/**
 * "Insurance claim over $2,000 starts as Pending Review" is the rule the demo
 * brief asks for. Anything at or below the limit is approved the moment it is
 * filed, which gives the demo two claim paths that diverge on one number.
 */
export const FAST_TRACK_CLAIM_LIMIT = 2000;

/** The largest estimate the form accepts, so a typo cannot produce nonsense. */
export const MAX_CLAIM_ESTIMATE = 100000;

/* -------------------------------------------------------------------------- */
/* Roadside assistance                                                         */
/* -------------------------------------------------------------------------- */

export type AssistanceKind = "Tow" | "Battery" | "Flat tyre" | "Lockout" | "Fuel";
export const ASSISTANCE_KINDS: AssistanceKind[] = [
  "Tow",
  "Battery",
  "Flat tyre",
  "Lockout",
  "Fuel",
];

export type AssistanceStatus = "requested" | "dispatched" | "completed";

export type AssistanceRequest = {
  id: string;
  kind: AssistanceKind;
  location: string;
  status: AssistanceStatus;
  requestedAt: string;
  /** Filled by the agent on dispatch. */
  provider: string | null;
  etaMinutes: number | null;
};

export const ASSISTANCE_PROVIDERS = [
  "Northlane Recovery",
  "Cedar Road Rescue",
] as const;

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

export type InvoiceStatus = "unpaid" | "paid" | "refunded";

export type Invoice = {
  id: string;
  description: string;
  amount: number;
  dueOn: string;
  status: InvoiceStatus;
  /** "Visa ending 1111", or null while unpaid. */
  paidWith: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
};

export type PaymentMethod = {
  id: string;
  label: string;
  last4: string;
  expiry: string;
  nameOnCard: string;
  addedAt: string;
};

export const MAX_PAYMENT_METHODS = 3;

export type CardInput = {
  cardNumber: string;
  expiry: string;
  cvv: string;
  nameOnCard: string;
};

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
  vehicles: Vehicle[];
  drivers: Driver[];
  /** A price on the table. Null once accepted or discarded. */
  quote: Quote | null;
  /** Newest first. At most one may be open at a time. */
  claims: Claim[];
  assistance: AssistanceRequest[];
  /** Newest first. */
  invoices: Invoice[];
  paymentMethods: PaymentMethod[];
  messages: DemoMessage[];
  lastRead: MessageReadState;
};

export type DemoStateAction =
  // policy and pricing
  | "request-quote"
  | "accept-quote"
  | "discard-quote"
  | "renew-policy"
  | "cancel-policy"
  // declared risk
  | "add-vehicle"
  | "update-vehicle"
  | "remove-vehicle"
  | "add-driver"
  | "update-driver"
  | "remove-driver"
  // claims, customer side
  | "file-claim"
  | "upload-claim-document"
  | "respond-to-claim-review"
  // assistance
  | "request-assistance"
  // billing
  | "pay-invoice"
  | "save-payment-method"
  | "remove-payment-method"
  | "change-instalment-plan"
  // shared
  | "send-message"
  | "mark-messages-read"
  // claims, agent side
  | "start-claim-review"
  | "assign-repair-shop"
  | "schedule-inspection"
  | "record-inspection"
  | "request-claim-information"
  | "approve-claim"
  | "reject-claim"
  | "settle-claim"
  // agent, other
  | "dispatch-assistance"
  | "complete-assistance"
  | "refund-invoice"
  | "lapse-policy";

export type DemoActionInput = {
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

export type DemoTransitionResult =
  | { ok: true; state: DemoState }
  | { ok: false; status: 400 | 403 | 409; error: string };

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

export type PricedQuote = {
  annualPremium: number;
  monthlyPremium: number;
  breakdown: PriceLine[];
};

/**
 * Prices a cover against the vehicles and drivers on the policy.
 *
 * Deliberately arithmetic a demo audience can follow in one reading: each
 * vehicle earns its own rated line, the least-experienced driver adds one
 * surcharge for the policy, add-ons are flat, the deductible moves the price up
 * or down, and the no-claims bonus comes off the subtotal. It is not risk
 * scoring and is not meant to resemble any.
 */
export function priceQuote(input: {
  coverage: CoverageTier;
  addOns: AddOnId[];
  deductible: DeductibleChoice;
  vehicles: Vehicle[];
  drivers: Driver[];
  noClaimsYears: number;
}): PricedQuote {
  const { coverage, addOns, deductible, vehicles, drivers, noClaimsYears } = input;
  const breakdown: PriceLine[] = [];

  for (const vehicle of vehicles) {
    let amount = COVERAGE_BASE_PREMIUM[coverage];
    const year = Number.parseInt(vehicle.year, 10);
    if (Number.isFinite(year) && year <= OLDER_VEHICLE_CUTOFF_YEAR) {
      amount += OLDER_VEHICLE_SURCHARGE;
    }
    if (vehicle.primaryUse === "Business") amount += BUSINESS_USE_SURCHARGE;
    breakdown.push({
      label: `${vehicle.year} ${vehicle.make} ${vehicle.model} · ${coverage}`,
      amount,
    });
  }

  // One surcharge for the policy, earned by whoever has driven the least.
  const leastExperienced = drivers
    .map(driver => Number.parseInt(driver.yearsLicensed, 10))
    .filter(Number.isFinite)
    .reduce((lowest, years) => Math.min(lowest, years), Number.POSITIVE_INFINITY);
  if (Number.isFinite(leastExperienced) && leastExperienced < NEW_DRIVER_YEARS) {
    breakdown.push({
      label: `Driver licensed under ${NEW_DRIVER_YEARS} years`,
      amount: NEW_DRIVER_SURCHARGE,
    });
  }

  for (const id of addOns) {
    const addOn = addOnFor(id);
    breakdown.push({ label: addOn.label, amount: addOn.annualPremium });
  }

  const deductibleAdjustment = DEDUCTIBLE_ADJUSTMENT[deductible];
  if (deductibleAdjustment !== 0) {
    breakdown.push({
      label: `${formatMoney(deductible)} deductible`,
      amount: deductibleAdjustment,
    });
  }

  const subtotal = breakdown.reduce((total, line) => total + line.amount, 0);
  const discountPercent = noClaimsDiscountPercent(noClaimsYears);
  if (discountPercent > 0) {
    breakdown.push({
      label: `No-claims bonus · ${discountPercent}%`,
      amount: -Math.round((subtotal * discountPercent) / 100),
    });
  }

  const annualPremium = Math.max(
    0,
    breakdown.reduce((total, line) => total + line.amount, 0),
  );
  return {
    annualPremium,
    monthlyPremium: Math.round(annualPremium / 12),
    breakdown,
  };
}

/** What a claim pays out: the estimate less the deductible, never below zero. */
export function settlementFor(estimate: number, deductible: number): number {
  return Math.max(0, estimate - deductible);
}

/** What one instalment costs under the plan in force. */
export function instalmentAmount(
  annualPremium: number,
  plan: InstalmentPlan,
): number {
  return plan === "annual" ? annualPremium : Math.round(annualPremium / 12);
}

/* -------------------------------------------------------------------------- */
/* Seed data                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_VEHICLES: Vehicle[] = [
  {
    id: "vehicle-1",
    year: "2019",
    make: "Honda",
    model: "Civic LX",
    vin: "1HGBH41JXMN109186",
    plate: "8KTR429",
    primaryUse: "Commute",
    updatedAt: "Initial demo record",
  },
];

export const DEFAULT_DRIVERS: Driver[] = [
  {
    id: "driver-1",
    fullName: "Alex Carter",
    licenseNumber: "C0482-9915-3320",
    licenseState: "California",
    yearsLicensed: "11",
    isPrimary: true,
    updatedAt: "Initial demo record",
  },
];

export const DEFAULT_POLICY: Policy = {
  number: "NL-2026-004821",
  status: "active",
  coverage: "Standard",
  addOns: [],
  deductible: 750,
  annualPremium: 980,
  instalmentPlan: "monthly",
  effectiveFrom: "February 1, 2026",
  renewsOn: "February 1, 2027",
  noClaimsYears: 4,
  updatedAt: "Initial demo record",
  endedOn: null,
  endedReason: null,
};

/** One closed claim so the history list is not empty on first sight. */
export const DEFAULT_CLAIMS: Claim[] = [
  {
    reference: "CLM-2025-5512",
    type: "Glass",
    incidentDate: "2025-11-03",
    description: "Stone chip in the windscreen on the motorway.",
    estimatedAmount: 480,
    status: "settled",
    filedAt: "November 3, 2025 at 4:12 PM",
    autoApproved: true,
    reviewNote:
      "Approved automatically: estimates of $2,000 or less do not need an agent review.",
    documents: [],
    thirdParty: null,
    repairShop: null,
    inspection: null,
    settlementAmount: 0,
    settledDeductible: 750,
  },
];

export const DEFAULT_INVOICES: Invoice[] = [
  {
    id: "invoice-jul",
    description: "Monthly premium · July 2026",
    amount: 82,
    dueOn: "August 5, 2026",
    status: "unpaid",
    paidWith: null,
    paidAt: null,
    refundedAt: null,
    refundReason: null,
  },
  {
    id: "invoice-jun",
    description: "Monthly premium · June 2026",
    amount: 82,
    dueOn: "July 5, 2026",
    status: "paid",
    paidWith: "Visa ending 1111",
    paidAt: "July 2, 2026 at 9:41 AM",
    refundedAt: null,
    refundReason: null,
  },
];

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
  vehicles: DEFAULT_VEHICLES,
  drivers: DEFAULT_DRIVERS,
  quote: null,
  claims: DEFAULT_CLAIMS,
  assistance: [],
  invoices: DEFAULT_INVOICES,
  paymentMethods: [],
  messages: DEFAULT_MESSAGES,
  lastRead: DEFAULT_LAST_READ,
};

export const DEMO_STATE_ACTIONS: DemoStateAction[] = [
  "request-quote",
  "accept-quote",
  "discard-quote",
  "renew-policy",
  "cancel-policy",
  "add-vehicle",
  "update-vehicle",
  "remove-vehicle",
  "add-driver",
  "update-driver",
  "remove-driver",
  "file-claim",
  "upload-claim-document",
  "respond-to-claim-review",
  "request-assistance",
  "pay-invoice",
  "save-payment-method",
  "remove-payment-method",
  "change-instalment-plan",
  "send-message",
  "mark-messages-read",
  "start-claim-review",
  "assign-repair-shop",
  "schedule-inspection",
  "record-inspection",
  "request-claim-information",
  "approve-claim",
  "reject-claim",
  "settle-claim",
  "dispatch-assistance",
  "complete-assistance",
  "refund-invoice",
  "lapse-policy",
];

const CUSTOMER_ACTIONS: DemoStateAction[] = [
  "request-quote",
  "accept-quote",
  "discard-quote",
  "renew-policy",
  "cancel-policy",
  "add-vehicle",
  "update-vehicle",
  "remove-vehicle",
  "add-driver",
  "update-driver",
  "remove-driver",
  "file-claim",
  "upload-claim-document",
  "respond-to-claim-review",
  "request-assistance",
  "pay-invoice",
  "save-payment-method",
  "remove-payment-method",
  "change-instalment-plan",
  "send-message",
  "mark-messages-read",
];

const AGENT_ACTIONS: DemoStateAction[] = [
  "start-claim-review",
  "assign-repair-shop",
  "schedule-inspection",
  "record-inspection",
  "request-claim-information",
  "approve-claim",
  "reject-claim",
  "settle-claim",
  "dispatch-assistance",
  "complete-assistance",
  "refund-invoice",
  "lapse-policy",
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

export function isAssistanceKind(value: unknown): value is AssistanceKind {
  return ASSISTANCE_KINDS.includes(String(value) as AssistanceKind);
}

export function isInstalmentPlan(value: unknown): value is InstalmentPlan {
  return INSTALMENT_PLANS.includes(String(value) as InstalmentPlan);
}

function isRequiredText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveAmount(value: unknown): value is number {
  return isAmount(value) && value >= 0;
}

export function isVehicle(value: unknown): value is Vehicle {
  if (!value || typeof value !== "object") return false;
  const vehicle = value as Partial<Vehicle>;
  return (
    isRequiredText(vehicle.id, 60) &&
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
    isRequiredText(driver.id, 60) &&
    isRequiredText(driver.fullName, 80) &&
    isRequiredText(driver.licenseNumber, 30) &&
    isRequiredText(driver.licenseState, 40) &&
    isRequiredText(driver.yearsLicensed, 2) &&
    typeof driver.isPrimary === "boolean" &&
    typeof driver.updatedAt === "string"
  );
}

function isPriceLine(value: unknown): value is PriceLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Partial<PriceLine>;
  return isRequiredText(line.label, 80) && isAmount(line.amount);
}

export function isQuote(value: unknown): value is Quote {
  if (!value || typeof value !== "object") return false;
  const quote = value as Partial<Quote>;
  return (
    isRequiredText(quote.reference, 40) &&
    ["new-business", "endorsement"].includes(String(quote.kind)) &&
    isCoverageTier(quote.coverage) &&
    Array.isArray(quote.addOns) &&
    quote.addOns.every(isAddOnId) &&
    isDeductibleChoice(quote.deductible) &&
    isPositiveAmount(quote.annualPremium) &&
    isPositiveAmount(quote.monthlyPremium) &&
    Array.isArray(quote.breakdown) &&
    quote.breakdown.every(isPriceLine) &&
    typeof quote.quotedAt === "string"
  );
}

export function isPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<Policy>;
  return (
    isRequiredText(policy.number, 40) &&
    ["active", "lapsed", "cancelled"].includes(String(policy.status)) &&
    isCoverageTier(policy.coverage) &&
    Array.isArray(policy.addOns) &&
    policy.addOns.every(isAddOnId) &&
    isDeductibleChoice(policy.deductible) &&
    isPositiveAmount(policy.annualPremium) &&
    isInstalmentPlan(policy.instalmentPlan) &&
    typeof policy.effectiveFrom === "string" &&
    typeof policy.renewsOn === "string" &&
    typeof policy.noClaimsYears === "number" &&
    policy.noClaimsYears >= 0 &&
    typeof policy.updatedAt === "string" &&
    (policy.endedOn === null || typeof policy.endedOn === "string") &&
    (policy.endedReason === null || typeof policy.endedReason === "string")
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

function isThirdParty(value: unknown): value is ThirdParty {
  if (!value || typeof value !== "object") return false;
  const party = value as Partial<ThirdParty>;
  return (
    isRequiredText(party.name, 80) &&
    isRequiredText(party.plate, 12) &&
    isRequiredText(party.insurer, 80)
  );
}

function isInspection(value: unknown): value is Inspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Partial<Inspection>;
  return (
    isRequiredText(inspection.shop, 80) &&
    typeof inspection.scheduledFor === "string" &&
    (inspection.outcome === null ||
      ["damage-confirmed", "damage-disputed"].includes(
        String(inspection.outcome),
      )) &&
    (inspection.notes === null || typeof inspection.notes === "string")
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
      "inspection-scheduled",
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
    (claim.thirdParty === null || isThirdParty(claim.thirdParty)) &&
    (claim.repairShop === null || isRepairShop(claim.repairShop)) &&
    (claim.inspection === null || isInspection(claim.inspection)) &&
    (claim.settlementAmount === null || isPositiveAmount(claim.settlementAmount)) &&
    (claim.settledDeductible === null || isPositiveAmount(claim.settledDeductible))
  );
}

export function isAssistanceRequest(value: unknown): value is AssistanceRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AssistanceRequest>;
  return (
    isRequiredText(request.id, 60) &&
    isAssistanceKind(request.kind) &&
    isRequiredText(request.location, 160) &&
    ["requested", "dispatched", "completed"].includes(String(request.status)) &&
    typeof request.requestedAt === "string" &&
    (request.provider === null || typeof request.provider === "string") &&
    (request.etaMinutes === null || typeof request.etaMinutes === "number")
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
    ["unpaid", "paid", "refunded"].includes(String(invoice.status)) &&
    (invoice.paidWith === null || typeof invoice.paidWith === "string") &&
    (invoice.paidAt === null || typeof invoice.paidAt === "string") &&
    (invoice.refundedAt === null || typeof invoice.refundedAt === "string") &&
    (invoice.refundReason === null || typeof invoice.refundReason === "string")
  );
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  if (!value || typeof value !== "object") return false;
  const method = value as Partial<PaymentMethod>;
  return (
    isRequiredText(method.id, 60) &&
    isRequiredText(method.label, 80) &&
    isRequiredText(method.last4, 4) &&
    isRequiredText(method.expiry, 5) &&
    isRequiredText(method.nameOnCard, 80) &&
    typeof method.addedAt === "string"
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

/* -------------------------------------------------------------------------- */
/* Derived reads                                                               */
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

/** The claim that is still moving, if any. At most one exists at a time. */
export function openClaim(state: DemoState): Claim | null {
  return state.claims.find(claim => OPEN_CLAIM_STATUSES.includes(claim.status)) ?? null;
}

export function hasOpenClaim(state: DemoState): boolean {
  return openClaim(state) !== null;
}

/** Claims sitting on an agent's desk right now. */
export function countClaimsAwaitingAgent(state: DemoState): number {
  const claim = openClaim(state);
  if (!claim) return 0;
  return ["submitted", "in-review", "inspection-scheduled", "approved"].includes(
    claim.status,
  )
    ? 1
    : 0;
}

export function unpaidInvoices(state: DemoState): Invoice[] {
  return state.invoices.filter(invoice => invoice.status === "unpaid");
}

export function openAssistance(state: DemoState): AssistanceRequest[] {
  return state.assistance.filter(request => request.status !== "completed");
}

/** Things the customer has to do before anything else can move. */
export function countCustomerTodos(state: DemoState): number {
  let total = unpaidInvoices(state).length;
  if (state.quote !== null) total += 1;
  if (openClaim(state)?.status === "more-info-needed") total += 1;
  if (state.policy.status === "lapsed") total += 1;
  return total;
}

export function claimStatusLabel(status: ClaimStatus): string {
  return {
    submitted: "Pending review",
    "in-review": "In review",
    "inspection-scheduled": "Inspection scheduled",
    "more-info-needed": "Needs more information",
    approved: "Approved",
    rejected: "Rejected",
    settled: "Settled",
  }[status];
}

export function policyStatusLabel(status: PolicyStatus): string {
  return { active: "Active", lapsed: "Lapsed", cancelled: "Cancelled" }[status];
}

export function assistanceStatusLabel(status: AssistanceStatus): string {
  return { requested: "Requested", dispatched: "On the way", completed: "Completed" }[
    status
  ];
}

/** Whole dollars as "$1,420", negatives as "−$210". Money is never bare. */
export function formatMoney(amount: number): string {
  const magnitude = `$${Math.abs(amount).toLocaleString("en-US")}`;
  return amount < 0 ? `−${magnitude}` : magnitude;
}

/** A policy can only be changed or claimed against while it is in force. */
export function isInForce(state: DemoState): boolean {
  return state.policy.status === "active";
}

/* -------------------------------------------------------------------------- */
/* Input parsing                                                               */
/* -------------------------------------------------------------------------- */

type VehicleInput = Omit<Vehicle, "id" | "updatedAt">;
type DriverInput = Omit<Driver, "id" | "isPrimary" | "updatedAt">;

function parseVehicle(value: unknown): VehicleInput | null {
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

function parseDriver(value: unknown): DriverInput | null {
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
  thirdParty: ThirdParty | null;
};

function parseClaim(value: unknown): ClaimInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as {
    type?: unknown;
    incidentDate?: unknown;
    description?: unknown;
    estimatedAmount?: unknown;
    thirdParty?: unknown;
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
  // A third party is optional, but a partial one is a mistake worth catching:
  // half an other-driver's details helps nobody.
  let thirdParty: ThirdParty | null = null;
  if (input.thirdParty !== undefined && input.thirdParty !== null) {
    if (!isThirdParty(input.thirdParty)) return null;
    thirdParty = {
      name: input.thirdParty.name.trim(),
      plate: input.thirdParty.plate.trim().toUpperCase(),
      insurer: input.thirdParty.insurer.trim(),
    };
  }
  return {
    type: input.type,
    incidentDate: input.incidentDate.trim(),
    description: input.description.trim(),
    estimatedAmount: estimate,
    thirdParty,
  };
}

function parseDocument(
  value: unknown,
): { fileName: string; sizeLabel: string } | null {
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

function parseAddOns(value: unknown): AddOnId[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every(isAddOnId)) return null;
  // Deduplicated and put in a stable order so the price lines never depend on
  // the order somebody happened to tick the boxes.
  return ADD_ONS.map(addOn => addOn.id).filter(id => value.includes(id));
}

function parseAssistance(
  value: unknown,
): { kind: AssistanceKind; location: string } | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { kind?: unknown; location?: unknown };
  if (!isAssistanceKind(input.kind) || !isRequiredText(input.location, 160)) {
    return null;
  }
  return { kind: input.kind, location: input.location.trim() };
}

/**
 * Card outcomes are deterministic: the documented demo card is accepted and
 * every other well-formed card is declined. Malformed input is a 400 because
 * the form is wrong, not the card.
 */
export type CardVerdict =
  | { ok: true; label: string; last4: string; expiry: string; nameOnCard: string }
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

  if (
    digits !== DEMO_CARD_NUMBER ||
    expiry !== DEMO_CARD_EXPIRY ||
    cvv !== DEMO_CARD_CVV
  ) {
    return { ok: false, status: 409, error: CARD_DECLINED_MESSAGE };
  }

  const last4 = digits.slice(-4);
  return {
    ok: true,
    label: `Visa ending ${last4}`,
    last4,
    expiry,
    nameOnCard,
  };
}

/* -------------------------------------------------------------------------- */
/* Transition helpers                                                          */
/* -------------------------------------------------------------------------- */

function refuse(
  status: 400 | 403 | 409,
  error: string,
): { ok: false; status: 400 | 403 | 409; error: string } {
  return { ok: false, status, error };
}

function accept(state: DemoState): { ok: true; state: DemoState } {
  return { ok: true, state };
}

/** Replaces the open claim, leaving closed history untouched. */
function withOpenClaim(state: DemoState, next: Claim): DemoState {
  return {
    ...state,
    claims: state.claims.map(claim =>
      claim.reference === next.reference ? next : claim,
    ),
  };
}

function nextId(prefix: string, existing: { id: string }[]): string {
  let index = existing.length + 1;
  const taken = new Set(existing.map(item => item.id));
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

/**
 * Reissues the open invoice at the current price.
 *
 * Called wherever the premium moves — a coverage change, a renewal, an
 * instalment-plan switch. A paid invoice describing a price that no longer
 * exists would be a lie, so it is replaced and reopened rather than left alone.
 */
function reissueOpenInvoice(
  invoices: Invoice[],
  description: string,
  amount: number,
  dueOn: string,
): Invoice[] {
  const history = invoices.filter(invoice => invoice.status !== "unpaid");
  const reissued: Invoice = {
    id: `invoice-${history.length + 1}-revised`,
    description,
    amount,
    dueOn,
    status: "unpaid",
    paidWith: null,
    paidAt: null,
    refundedAt: null,
    refundReason: null,
  };
  return [reissued, ...history];
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
    return refuse(403, "Only a claims agent can perform this action.");
  }
  if (role === "agent" && !AGENT_ACTIONS.includes(action)) {
    return refuse(403, "Only the policyholder can perform this action.");
  }

  switch (action) {
    /* ---------------- pricing and the policy lifecycle ------------------- */

    case "request-quote": {
      if (!isCoverageTier(input.coverage)) {
        return refuse(400, "Choose a coverage level.");
      }
      const addOns = parseAddOns(input.addOns);
      if (!addOns) return refuse(400, "Choose from the listed optional covers.");
      if (!isDeductibleChoice(input.deductible)) {
        return refuse(400, "Choose one of the available deductibles.");
      }
      const deductible = Number(input.deductible) as DeductibleChoice;

      // A policy that is not in force cannot be endorsed, so quoting one is a
      // new-business quote instead. That is the whole cancel-then-rejoin funnel.
      const kind: QuoteKind = isInForce(state) ? "endorsement" : "new-business";

      if (kind === "endorsement") {
        const unchanged =
          input.coverage === state.policy.coverage &&
          deductible === state.policy.deductible &&
          addOns.length === state.policy.addOns.length &&
          addOns.every(id => state.policy.addOns.includes(id));
        if (unchanged) {
          return refuse(
            409,
            "That is the cover you already have. Change the level, the deductible, or an optional cover to see a new price.",
          );
        }
      }

      // A new-business quote starts a fresh bonus record; an endorsement keeps
      // the one the policy has earned.
      const noClaimsYears = kind === "new-business" ? 0 : state.policy.noClaimsYears;
      const priced = priceQuote({
        coverage: input.coverage,
        addOns,
        deductible,
        vehicles: state.vehicles,
        drivers: state.drivers,
        noClaimsYears,
      });
      return accept({
        ...state,
        quote: {
          reference: kind === "new-business" ? "QT-2026-4102" : "QT-2026-3390",
          kind,
          coverage: input.coverage,
          addOns,
          deductible,
          annualPremium: priced.annualPremium,
          monthlyPremium: priced.monthlyPremium,
          breakdown: priced.breakdown,
          quotedAt: DEMO_NOW,
        },
      });
    }

    case "accept-quote": {
      const { quote } = state;
      if (!quote) {
        return refuse(409, "Request a quote before changing your cover.");
      }
      const newBusiness = quote.kind === "new-business";
      const policy: Policy = {
        ...state.policy,
        number: newBusiness ? "NL-2026-005390" : state.policy.number,
        status: "active",
        coverage: quote.coverage,
        addOns: quote.addOns,
        deductible: quote.deductible,
        annualPremium: quote.annualPremium,
        effectiveFrom: newBusiness ? DEMO_TODAY : state.policy.effectiveFrom,
        renewsOn: newBusiness ? DEMO_NEXT_TERM_END : state.policy.renewsOn,
        noClaimsYears: newBusiness ? 0 : state.policy.noClaimsYears,
        updatedAt: DEMO_NOW,
        endedOn: null,
        endedReason: null,
      };
      return accept({
        ...state,
        quote: null,
        policy,
        invoices: reissueOpenInvoice(
          state.invoices,
          `${policy.instalmentPlan === "annual" ? "Annual" : "Monthly"} premium · ${quote.coverage} cover`,
          instalmentAmount(quote.annualPremium, policy.instalmentPlan),
          "August 5, 2026",
        ),
      });
    }

    case "discard-quote":
      if (!state.quote) return refuse(409, "There is no quote to discard.");
      return accept({ ...state, quote: null });

    case "renew-policy": {
      if (state.policy.status === "cancelled") {
        return refuse(409, "A cancelled policy cannot be renewed. Get a new quote instead.");
      }
      if (state.policy.status === "lapsed") {
        return refuse(409, "Settle the overdue premium to reinstate this policy before renewing it.");
      }
      // Renewal is where the bonus is actually felt: another claim-free year is
      // added first, then the whole cover is repriced with it.
      const noClaimsYears = state.policy.noClaimsYears + 1;
      const priced = priceQuote({
        coverage: state.policy.coverage,
        addOns: state.policy.addOns,
        deductible: state.policy.deductible,
        vehicles: state.vehicles,
        drivers: state.drivers,
        noClaimsYears,
      });
      const policy: Policy = {
        ...state.policy,
        annualPremium: priced.annualPremium,
        noClaimsYears,
        effectiveFrom: DEMO_NEXT_TERM_START,
        renewsOn: DEMO_NEXT_TERM_END,
        updatedAt: DEMO_NOW,
      };
      return accept({
        ...state,
        policy,
        quote: null,
        invoices: reissueOpenInvoice(
          state.invoices,
          `${policy.instalmentPlan === "annual" ? "Annual" : "Monthly"} premium · renewal from ${DEMO_NEXT_TERM_START}`,
          instalmentAmount(priced.annualPremium, policy.instalmentPlan),
          "February 5, 2027",
        ),
      });
    }

    case "cancel-policy": {
      if (!isRequiredText(input.reason, 200)) {
        return refuse(400, "Tell us why you are cancelling, in up to 200 characters.");
      }
      if (state.policy.status === "cancelled") {
        return refuse(409, "This policy is already cancelled.");
      }
      if (hasOpenClaim(state)) {
        return refuse(
          409,
          "A claim is still open on this policy. It has to be closed before the policy can be cancelled.",
        );
      }
      return accept({
        ...state,
        quote: null,
        policy: {
          ...state.policy,
          status: "cancelled",
          endedOn: DEMO_TODAY,
          endedReason: input.reason.trim(),
          updatedAt: DEMO_NOW,
        },
      });
    }

    case "lapse-policy": {
      if (state.policy.status !== "active") {
        return refuse(409, "Only a policy in force can be lapsed.");
      }
      if (unpaidInvoices(state).length === 0) {
        return refuse(
          409,
          "Nothing is overdue on this policy, so it cannot be lapsed for non-payment.",
        );
      }
      return accept({
        ...state,
        policy: {
          ...state.policy,
          status: "lapsed",
          endedOn: DEMO_TODAY,
          endedReason: "Premium not paid by the due date.",
          updatedAt: DEMO_NOW,
        },
      });
    }

    /* ---------------- declared risk --------------------------------------- */

    case "add-vehicle": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its vehicles cannot be changed.");
      }
      if (state.vehicles.length >= MAX_VEHICLES) {
        return refuse(409, `A demo policy carries at most ${MAX_VEHICLES} vehicles.`);
      }
      const vehicle = parseVehicle(input.vehicle);
      if (!vehicle) {
        return refuse(
          400,
          "Complete every vehicle field. The year must be four digits and the use must be one of the listed options.",
        );
      }
      if (state.vehicles.some(existing => existing.vin === vehicle.vin)) {
        return refuse(409, "That VIN is already on this policy.");
      }
      return accept({
        ...state,
        quote: null,
        vehicles: [
          ...state.vehicles,
          { ...vehicle, id: nextId("vehicle", state.vehicles), updatedAt: DEMO_NOW },
        ],
      });
    }

    case "update-vehicle": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its vehicles cannot be changed.");
      }
      const index = state.vehicles.findIndex(item => item.id === input.vehicleId);
      if (index === -1) return refuse(400, "Choose one of the vehicles on this policy.");
      const vehicle = parseVehicle(input.vehicle);
      if (!vehicle) {
        return refuse(
          400,
          "Complete every vehicle field. The year must be four digits and the use must be one of the listed options.",
        );
      }
      if (
        state.vehicles.some(
          (existing, position) => position !== index && existing.vin === vehicle.vin,
        )
      ) {
        return refuse(409, "That VIN is already on this policy.");
      }
      // A repriced vehicle invalidates an outstanding quote: the price on the
      // table was calculated against the car that is no longer on file.
      return accept({
        ...state,
        quote: null,
        vehicles: state.vehicles.map((existing, position) =>
          position === index
            ? { ...vehicle, id: existing.id, updatedAt: DEMO_NOW }
            : existing,
        ),
      });
    }

    case "remove-vehicle": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its vehicles cannot be changed.");
      }
      if (!state.vehicles.some(item => item.id === input.vehicleId)) {
        return refuse(400, "Choose one of the vehicles on this policy.");
      }
      if (state.vehicles.length <= MIN_VEHICLES) {
        return refuse(409, "A policy has to cover at least one vehicle.");
      }
      return accept({
        ...state,
        quote: null,
        vehicles: state.vehicles.filter(item => item.id !== input.vehicleId),
      });
    }

    case "add-driver": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its drivers cannot be changed.");
      }
      if (state.drivers.length >= MAX_DRIVERS) {
        return refuse(409, `A demo policy names at most ${MAX_DRIVERS} drivers.`);
      }
      const driver = parseDriver(input.driver);
      if (!driver) {
        return refuse(400, "Complete every driver field. Years licensed must be a whole number.");
      }
      if (
        state.drivers.some(
          existing => existing.licenseNumber === driver.licenseNumber,
        )
      ) {
        return refuse(409, "That licence number is already named on this policy.");
      }
      return accept({
        ...state,
        quote: null,
        drivers: [
          ...state.drivers,
          {
            ...driver,
            id: nextId("driver", state.drivers),
            isPrimary: false,
            updatedAt: DEMO_NOW,
          },
        ],
      });
    }

    case "update-driver": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its drivers cannot be changed.");
      }
      const index = state.drivers.findIndex(item => item.id === input.driverId);
      if (index === -1) return refuse(400, "Choose one of the drivers on this policy.");
      const driver = parseDriver(input.driver);
      if (!driver) {
        return refuse(400, "Complete every driver field. Years licensed must be a whole number.");
      }
      return accept({
        ...state,
        quote: null,
        drivers: state.drivers.map((existing, position) =>
          position === index
            ? {
                ...driver,
                id: existing.id,
                isPrimary: existing.isPrimary,
                updatedAt: DEMO_NOW,
              }
            : existing,
        ),
      });
    }

    case "remove-driver": {
      if (!isInForce(state)) {
        return refuse(409, "This policy is not in force, so its drivers cannot be changed.");
      }
      const driver = state.drivers.find(item => item.id === input.driverId);
      if (!driver) return refuse(400, "Choose one of the drivers on this policy.");
      // The policyholder is not a named driver you can take off. Removing them
      // would leave a policy belonging to nobody.
      if (driver.isPrimary) {
        return refuse(409, "The policyholder cannot be removed from their own policy.");
      }
      if (state.drivers.length <= MIN_DRIVERS) {
        return refuse(409, "A policy has to name at least one driver.");
      }
      return accept({
        ...state,
        quote: null,
        drivers: state.drivers.filter(item => item.id !== driver.id),
      });
    }

    /* ---------------- claims, customer side ------------------------------- */

    case "file-claim": {
      const claim = parseClaim(input.claim);
      if (!claim) {
        return refuse(
          400,
          `Complete every claim field. The estimate must be a whole number of dollars up to ${formatMoney(MAX_CLAIM_ESTIMATE)}, and any third party needs a name, a plate and an insurer.`,
        );
      }
      if (!isInForce(state)) {
        return refuse(409, "A claim can only be filed against a policy in force.");
      }
      if (hasOpenClaim(state)) {
        return refuse(
          409,
          "Your existing claim has to be closed before you file another one.",
        );
      }
      // The fast-track rule. At or below the limit the claim is approved on
      // arrival; above it, an agent has to look at it.
      const fastTracked = claim.estimatedAmount <= FAST_TRACK_CLAIM_LIMIT;
      const filed: Claim = {
        reference: `CLM-2026-${7714 + state.claims.length}`,
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
        thirdParty: claim.thirdParty,
        repairShop: null,
        inspection: null,
        settlementAmount: null,
        settledDeductible: null,
      };
      return accept({ ...state, claims: [filed, ...state.claims] });
    }

    case "upload-claim-document": {
      const claim = openClaim(state);
      if (!claim) {
        return refuse(409, "File a claim before attaching documents to it.");
      }
      const document = parseDocument(input.document);
      if (!document) return refuse(400, "Choose a file to attach.");
      return accept(
        withOpenClaim(state, {
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
        }),
      );
    }

    case "respond-to-claim-review": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "more-info-needed") {
        return refuse(409, "This claim is not waiting on information from you.");
      }
      if (claim.documents.length === 0) {
        return refuse(
          409,
          "Attach at least one document before sending the claim back for review.",
        );
      }
      return accept(withOpenClaim(state, { ...claim, status: "in-review" }));
    }

    /* ---------------- roadside assistance --------------------------------- */

    case "request-assistance": {
      if (!isInForce(state)) {
        return refuse(409, "Assistance is only available on a policy in force.");
      }
      if (!state.policy.addOns.includes("roadside")) {
        return refuse(
          409,
          "Roadside assistance is not on this policy. Add it to your cover to request help.",
        );
      }
      if (openAssistance(state).length > 0) {
        return refuse(409, "An assistance request is already open.");
      }
      const request = parseAssistance(input.assistance);
      if (!request) {
        return refuse(400, "Choose the kind of help you need and say where you are.");
      }
      return accept({
        ...state,
        assistance: [
          {
            id: nextId("assistance", state.assistance),
            kind: request.kind,
            location: request.location,
            status: "requested",
            requestedAt: DEMO_NOW,
            provider: null,
            etaMinutes: null,
          },
          ...state.assistance,
        ],
      });
    }

    /* ---------------- billing --------------------------------------------- */

    case "pay-invoice": {
      // Everything malformed is rejected before anything stateful is judged, so
      // a 400 never depends on what the policy happens to look like. That is
      // what makes "409 means the request was fine" a true statement.
      let invoice: Invoice | undefined;
      if (input.invoiceId !== undefined) {
        invoice = state.invoices.find(item => item.id === input.invoiceId);
        if (!invoice) return refuse(400, "Choose one of the invoices on this policy.");
      }

      let method: PaymentMethod | undefined;
      let verdict: CardVerdict | undefined;
      if (input.paymentMethodId !== undefined) {
        method = state.paymentMethods.find(item => item.id === input.paymentMethodId);
        if (!method) return refuse(400, "Choose one of your saved payment methods.");
      } else {
        verdict = verifyCard(input.card);
        if (!verdict.ok && verdict.status === 400) {
          return refuse(400, verdict.error);
        }
      }

      if (!invoice) {
        invoice = unpaidInvoices(state)[0];
        if (!invoice) return refuse(409, "Nothing is outstanding on this policy.");
      }
      if (invoice.status !== "unpaid") {
        return refuse(409, "This invoice has already been settled.");
      }
      // The decline lands last: a card is only judged once there is something
      // for it to pay.
      if (verdict && !verdict.ok) return refuse(verdict.status, verdict.error);

      const label = method ? method.label : (verdict as { ok: true; label: string }).label;
      const invoices = state.invoices.map(item =>
        item.id === invoice.id
          ? { ...item, status: "paid" as const, paidWith: label, paidAt: DEMO_NOW }
          : item,
      );
      // Paying what was overdue brings a lapsed policy back into force. Nothing
      // else does; that is what makes the lapse worth demonstrating.
      const reinstated =
        state.policy.status === "lapsed" &&
        invoices.every(item => item.status !== "unpaid");
      return accept({
        ...state,
        invoices,
        policy: reinstated
          ? {
              ...state.policy,
              status: "active",
              endedOn: null,
              endedReason: null,
              updatedAt: DEMO_NOW,
            }
          : state.policy,
      });
    }

    case "save-payment-method": {
      if (state.paymentMethods.length >= MAX_PAYMENT_METHODS) {
        return refuse(409, `A demo account keeps at most ${MAX_PAYMENT_METHODS} cards.`);
      }
      const verdict = verifyCard(input.card);
      if (!verdict.ok) return refuse(verdict.status, verdict.error);
      if (
        state.paymentMethods.some(
          method => method.last4 === verdict.last4 && method.expiry === verdict.expiry,
        )
      ) {
        return refuse(409, "That card is already saved.");
      }
      return accept({
        ...state,
        paymentMethods: [
          ...state.paymentMethods,
          {
            id: nextId("card", state.paymentMethods),
            label: verdict.label,
            last4: verdict.last4,
            expiry: verdict.expiry,
            nameOnCard: verdict.nameOnCard,
            addedAt: DEMO_NOW,
          },
        ],
      });
    }

    case "remove-payment-method": {
      if (!state.paymentMethods.some(method => method.id === input.paymentMethodId)) {
        return refuse(400, "Choose one of your saved payment methods.");
      }
      return accept({
        ...state,
        paymentMethods: state.paymentMethods.filter(
          method => method.id !== input.paymentMethodId,
        ),
      });
    }

    case "change-instalment-plan": {
      if (!isInstalmentPlan(input.instalmentPlan)) {
        return refuse(400, "Choose either the annual or the monthly plan.");
      }
      if (input.instalmentPlan === state.policy.instalmentPlan) {
        return refuse(409, "That is the plan you are already on.");
      }
      const plan = input.instalmentPlan;
      const policy: Policy = { ...state.policy, instalmentPlan: plan, updatedAt: DEMO_NOW };
      return accept({
        ...state,
        policy,
        invoices: reissueOpenInvoice(
          state.invoices,
          `${plan === "annual" ? "Annual" : "Monthly"} premium · ${policy.coverage} cover`,
          instalmentAmount(policy.annualPremium, plan),
          "August 5, 2026",
        ),
      });
    }

    /* ---------------- shared ---------------------------------------------- */

    case "mark-messages-read": {
      const lastMessage = state.messages[state.messages.length - 1];
      if (!lastMessage || state.lastRead[role] === lastMessage.id) {
        return accept(state);
      }
      return accept({
        ...state,
        lastRead: { ...state.lastRead, [role]: lastMessage.id },
      });
    }

    case "send-message": {
      if (!isRequiredText(input.messageBody, 500)) {
        return refuse(400, "Enter a message with no more than 500 characters.");
      }
      return accept({
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
      });
    }

    /* ---------------- claims, agent side ---------------------------------- */

    case "start-claim-review": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "submitted") {
        return refuse(409, "Only a claim pending review can be opened for review.");
      }
      return accept(withOpenClaim(state, { ...claim, status: "in-review" }));
    }

    case "assign-repair-shop": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "in-review") {
        return refuse(409, "Only a claim in review can be sent to a repair shop.");
      }
      if (!isRepairShop(input.repairShop)) {
        return refuse(400, "Choose one of the approved repair shops.");
      }
      return accept(withOpenClaim(state, { ...claim, repairShop: input.repairShop }));
    }

    case "schedule-inspection": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "in-review") {
        return refuse(409, "Only a claim in review can have an inspection scheduled.");
      }
      if (!claim.repairShop) {
        return refuse(
          409,
          "Assign a repair shop before scheduling the inspection: that is where it happens.",
        );
      }
      return accept(
        withOpenClaim(state, {
          ...claim,
          status: "inspection-scheduled",
          inspection: {
            shop: claim.repairShop,
            scheduledFor: "July 28, 2026 at 11:00 AM",
            outcome: null,
            notes: null,
          },
        }),
      );
    }

    case "record-inspection": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "inspection-scheduled" || !claim.inspection) {
        return refuse(409, "No inspection is scheduled on this claim.");
      }
      const outcome = String(
        (input.inspection as { outcome?: unknown } | undefined)?.outcome ?? "",
      );
      if (!["damage-confirmed", "damage-disputed"].includes(outcome)) {
        return refuse(400, "Record the inspection as either confirmed or disputed.");
      }
      const notes = (input.inspection as { notes?: unknown } | undefined)?.notes;
      if (!isRequiredText(notes, 400)) {
        return refuse(400, "Write what the inspection found, in up to 400 characters.");
      }
      // The claim comes back to the agent's desk either way; the outcome is
      // evidence for the decision, not the decision itself.
      return accept(
        withOpenClaim(state, {
          ...claim,
          status: "in-review",
          inspection: {
            ...claim.inspection,
            outcome: outcome as InspectionOutcome,
            notes: notes.trim(),
          },
        }),
      );
    }

    case "request-claim-information":
    case "approve-claim":
    case "reject-claim": {
      // Every decision is written down. A rejection or an information request
      // with no reason is the one thing a policyholder cannot act on.
      if (!isRequiredText(input.reviewNote, 400)) {
        return refuse(400, "Write a note of up to 400 characters explaining this decision.");
      }
      const claim = openClaim(state);
      if (!claim || claim.status !== "in-review") {
        return refuse(409, "Only a claim in review can be decided.");
      }
      const reviewNote = input.reviewNote.trim();
      const status: ClaimStatus =
        action === "approve-claim"
          ? "approved"
          : action === "reject-claim"
            ? "rejected"
            : "more-info-needed";
      return accept(withOpenClaim(state, { ...claim, status, reviewNote }));
    }

    case "settle-claim": {
      const claim = openClaim(state);
      if (!claim || claim.status !== "approved") {
        return refuse(409, "Only an approved claim can be settled.");
      }
      // Glass cover pays the glass claim with no deductible at all. It is the
      // one place an add-on changes what a claim is worth, which is what makes
      // buying it worth demonstrating.
      const glassCovered =
        claim.type === "Glass" && state.policy.addOns.includes("glass");
      const deductible = glassCovered ? 0 : state.policy.deductible;
      return accept({
        ...withOpenClaim(state, {
          ...claim,
          status: "settled",
          settlementAmount: settlementFor(claim.estimatedAmount, deductible),
          settledDeductible: deductible,
        }),
        // Settling a claim is what costs the bonus, and it costs all of it.
        policy: {
          ...state.policy,
          noClaimsYears: 0,
          updatedAt: DEMO_NOW,
        },
      });
    }

    /* ---------------- agent, other ---------------------------------------- */

    case "dispatch-assistance": {
      const request = openAssistance(state).find(item => item.status === "requested");
      if (!request) return refuse(409, "No assistance request is waiting to be dispatched.");
      return accept({
        ...state,
        assistance: state.assistance.map(item =>
          item.id === request.id
            ? {
                ...item,
                status: "dispatched" as const,
                provider: ASSISTANCE_PROVIDERS[0],
                etaMinutes: 35,
              }
            : item,
        ),
      });
    }

    case "complete-assistance": {
      const request = state.assistance.find(item => item.status === "dispatched");
      if (!request) return refuse(409, "No assistance request is out for completion.");
      return accept({
        ...state,
        assistance: state.assistance.map(item =>
          item.id === request.id ? { ...item, status: "completed" as const } : item,
        ),
      });
    }

    case "refund-invoice": {
      const invoice = state.invoices.find(item => item.id === input.invoiceId);
      if (!invoice) return refuse(400, "Choose one of the invoices on this policy.");
      if (invoice.status !== "paid") {
        return refuse(409, "Only a paid invoice can be refunded.");
      }
      if (!isRequiredText(input.reason, 200)) {
        return refuse(400, "Write why this is being refunded, in up to 200 characters.");
      }
      return accept({
        ...state,
        invoices: state.invoices.map(item =>
          item.id === invoice.id
            ? {
                ...item,
                status: "refunded" as const,
                refundedAt: DEMO_NOW,
                refundReason: (input.reason as string).trim(),
              }
            : item,
        ),
      });
    }
  }
}
