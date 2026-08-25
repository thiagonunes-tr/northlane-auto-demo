import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_USE_SURCHARGE,
  CARD_DECLINED_MESSAGE,
  COVERAGE_BASE_PREMIUM,
  COVERAGE_DEDUCTIBLE,
  DEFAULT_DEMO_STATE,
  DEMO_NOW,
  FAST_TRACK_CLAIM_LIMIT,
  MAX_CLAIM_ESTIMATE,
  NEW_DRIVER_SURCHARGE,
  OLDER_VEHICLE_SURCHARGE,
  countClaimsAwaitingAgent,
  countCustomerTodos,
  countUnreadMessages,
  formatMoney,
  hasOpenClaim,
  isDemoStateAction,
  priceQuote,
  settlementFor,
  transitionDemoState,
} from "../lib/demo-state";
import type {
  Claim,
  ClaimStatus,
  DemoActionInput,
  DemoActorRole,
  DemoState,
  DemoStateAction,
} from "../lib/demo-state";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Applies an action and fails the test if it was refused. */
function apply(
  state: DemoState,
  action: DemoStateAction,
  role: DemoActorRole,
  input: DemoActionInput = {},
): DemoState {
  const result = transitionDemoState(state, action, role, input);
  assert.equal(
    result.ok,
    true,
    `expected ${action} to succeed, got ${result.ok ? "" : result.error}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.state;
}

/** Applies an action expecting refusal, and returns the status and message. */
function refuse(
  state: DemoState,
  action: DemoStateAction,
  role: DemoActorRole,
  input: DemoActionInput = {},
): { status: number; error: string } {
  const result = transitionDemoState(state, action, role, input);
  assert.equal(result.ok, false, `expected ${action} to be refused`);
  if (result.ok) throw new Error("unreachable");
  return { status: result.status, error: result.error };
}

const VALID_CARD = {
  nameOnCard: "Alex Carter",
  cardNumber: "4111111111111111",
  expiry: "12/30",
  cvv: "123",
};

const SMALL_CLAIM = {
  type: "Glass" as const,
  incidentDate: "2026-07-18",
  description: "Stone chip in the windscreen on the motorway.",
  estimatedAmount: 640,
};

const LARGE_CLAIM = {
  type: "Collision" as const,
  incidentDate: "2026-07-18",
  description: "Rear-ended at a junction; bumper and boot lid damaged.",
  estimatedAmount: 4200,
};

/** A large claim that has reached the agent and is open for a decision. */
function inReview(): DemoState {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  return apply(filed, "start-claim-review", "agent");
}

function claimOf(state: DemoState): Claim {
  assert.ok(state.claim, "expected a claim on the state");
  return state.claim;
}

/* -------------------------------------------------------------------------- */
/* Action surface                                                              */
/* -------------------------------------------------------------------------- */

test("recognizes only supported demo actions", () => {
  assert.equal(isDemoStateAction("request-quote"), true);
  assert.equal(isDemoStateAction("file-claim"), true);
  assert.equal(isDemoStateAction("settle-claim"), true);
  assert.equal(isDemoStateAction("pay-invoice"), true);
  assert.equal(isDemoStateAction("overwrite-state"), false);
  assert.equal(isDemoStateAction(""), false);
  assert.equal(isDemoStateAction(null), false);
  assert.equal(isDemoStateAction(42), false);
});

test("each role is refused the other role's actions with 403", () => {
  // The policyholder cannot decide their own claim.
  for (const action of [
    "start-claim-review",
    "approve-claim",
    "reject-claim",
    "request-claim-information",
    "settle-claim",
  ] as DemoStateAction[]) {
    const refused = refuse(inReview(), action, "customer", { reviewNote: "Looks fine to me." });
    assert.equal(refused.status, 403);
    assert.match(refused.error, /claims agent/);
  }

  // The agent cannot quote, buy, pay, or file on the policyholder's behalf.
  for (const action of [
    "request-quote",
    "accept-quote",
    "discard-quote",
    "update-vehicle",
    "update-driver",
    "file-claim",
    "upload-claim-document",
    "respond-to-claim-review",
    "pay-invoice",
  ] as DemoStateAction[]) {
    const refused = refuse(DEFAULT_DEMO_STATE, action, "agent");
    assert.equal(refused.status, 403);
    assert.match(refused.error, /policyholder/);
  }
});

test("both roles may use the shared message actions", () => {
  const fromCustomer = apply(DEFAULT_DEMO_STATE, "send-message", "customer", {
    messageBody: "Any update on my claim?",
  });
  const fromAgent = apply(fromCustomer, "send-message", "agent", {
    messageBody: "Looking at it now.",
  });
  assert.equal(fromAgent.messages.length, 4);
  assert.equal(fromAgent.messages[2].sender, "customer");
  assert.equal(fromAgent.messages[3].sender, "agent");
});

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

test("a quote is the base rate plus only the surcharges that apply", () => {
  const { vehicle, driver } = DEFAULT_DEMO_STATE;

  // 2019 vehicle, 11 years licensed, commute use: no surcharge earns its place.
  const clean = priceQuote("Comprehensive", vehicle, driver);
  assert.equal(clean.annualPremium, COVERAGE_BASE_PREMIUM.Comprehensive);
  assert.equal(clean.deductible, COVERAGE_DEDUCTIBLE.Comprehensive);
  assert.equal(clean.monthlyPremium, Math.round(COVERAGE_BASE_PREMIUM.Comprehensive / 12));
  assert.equal(clean.breakdown.length, 1);

  const loaded = priceQuote(
    "Liability",
    { ...vehicle, year: "2015", primaryUse: "Business" },
    { ...driver, yearsLicensed: "1" },
  );
  assert.equal(
    loaded.annualPremium,
    COVERAGE_BASE_PREMIUM.Liability +
      OLDER_VEHICLE_SURCHARGE +
      NEW_DRIVER_SURCHARGE +
      BUSINESS_USE_SURCHARGE,
  );
  // Every line is named, so the total can always be decomposed on screen.
  assert.deepEqual(
    loaded.breakdown.map(line => line.amount),
    [
      COVERAGE_BASE_PREMIUM.Liability,
      OLDER_VEHICLE_SURCHARGE,
      NEW_DRIVER_SURCHARGE,
      BUSINESS_USE_SURCHARGE,
    ],
  );
  assert.equal(
    loaded.breakdown.reduce((total, line) => total + line.amount, 0),
    loaded.annualPremium,
  );
});

test("the 2016 vehicle surcharge is inclusive at the cutoff year", () => {
  const { vehicle, driver } = DEFAULT_DEMO_STATE;
  const atCutoff = priceQuote("Standard", { ...vehicle, year: "2016" }, driver);
  const justAfter = priceQuote("Standard", { ...vehicle, year: "2017" }, driver);
  assert.equal(
    atCutoff.annualPremium,
    COVERAGE_BASE_PREMIUM.Standard + OLDER_VEHICLE_SURCHARGE,
  );
  assert.equal(justAfter.annualPremium, COVERAGE_BASE_PREMIUM.Standard);
});

test("the new-driver surcharge is exclusive at three years", () => {
  const { vehicle, driver } = DEFAULT_DEMO_STATE;
  const two = priceQuote("Standard", vehicle, { ...driver, yearsLicensed: "2" });
  const three = priceQuote("Standard", vehicle, { ...driver, yearsLicensed: "3" });
  assert.equal(
    two.annualPremium,
    COVERAGE_BASE_PREMIUM.Standard + NEW_DRIVER_SURCHARGE,
  );
  assert.equal(three.annualPremium, COVERAGE_BASE_PREMIUM.Standard);
});

/* -------------------------------------------------------------------------- */
/* Quote lifecycle                                                             */
/* -------------------------------------------------------------------------- */

test("requesting a quote leaves the policy untouched", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Comprehensive",
  });
  assert.ok(quoted.quote);
  assert.equal(quoted.quote.coverage, "Comprehensive");
  assert.equal(quoted.quote.quotedAt, DEMO_NOW);
  assert.deepEqual(quoted.policy, DEFAULT_DEMO_STATE.policy);
  assert.deepEqual(quoted.invoice, DEFAULT_DEMO_STATE.invoice);
});

test("re-quoting the coverage already held is refused", () => {
  const refused = refuse(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: DEFAULT_DEMO_STATE.policy.coverage,
  });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /already on Standard/);
});

test("an unknown coverage level is a malformed request, not a conflict", () => {
  const refused = refuse(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Platinum",
  });
  assert.equal(refused.status, 400);
});

test("accepting a quote repricies the policy and reissues the invoice", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Comprehensive",
  });
  const accepted = apply(quoted, "accept-quote", "customer");

  assert.equal(accepted.quote, null);
  assert.equal(accepted.policy.coverage, "Comprehensive");
  assert.equal(accepted.policy.annualPremium, COVERAGE_BASE_PREMIUM.Comprehensive);
  assert.equal(accepted.policy.deductible, COVERAGE_DEDUCTIBLE.Comprehensive);
  assert.equal(accepted.policy.updatedAt, DEMO_NOW);
  // The number never changes: this is an endorsement, not a new policy.
  assert.equal(accepted.policy.number, DEFAULT_DEMO_STATE.policy.number);

  // A stale invoice describing the old cover would be the drift this prevents.
  assert.equal(accepted.invoice.status, "unpaid");
  assert.equal(accepted.invoice.amount, quoted.quote?.monthlyPremium);
  assert.match(accepted.invoice.description, /Comprehensive/);
});

test("accepting or discarding with no quote on the table is a conflict", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "accept-quote", "customer").status, 409);
  assert.equal(refuse(DEFAULT_DEMO_STATE, "discard-quote", "customer").status, 409);
});

test("discarding a quote changes nothing else", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Liability",
  });
  const discarded = apply(quoted, "discard-quote", "customer");
  assert.deepEqual(discarded, { ...DEFAULT_DEMO_STATE, quote: null });
});

/* -------------------------------------------------------------------------- */
/* Vehicle and driver                                                          */
/* -------------------------------------------------------------------------- */

test("changing the vehicle clears a quote priced against the old one", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Liability",
  });
  const updated = apply(quoted, "update-vehicle", "customer", {
    vehicle: {
      year: "2013",
      make: "Ford",
      model: "Focus",
      vin: "abc12345678901234",
      plate: "7xyz123",
      primaryUse: "Business",
    },
  });
  assert.equal(updated.quote, null);
  // VIN and plate are normalised, so a search never depends on how it was typed.
  assert.equal(updated.vehicle.vin, "ABC12345678901234");
  assert.equal(updated.vehicle.plate, "7XYZ123");
  assert.equal(updated.vehicle.updatedAt, DEMO_NOW);

  // And the new vehicle is what the next quote is priced against.
  const requoted = apply(updated, "request-quote", "customer", { coverage: "Liability" });
  assert.equal(
    requoted.quote?.annualPremium,
    COVERAGE_BASE_PREMIUM.Liability + OLDER_VEHICLE_SURCHARGE + BUSINESS_USE_SURCHARGE,
  );
});

test("changing the driver clears a quote priced against the old one", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Liability",
  });
  const updated = apply(quoted, "update-driver", "customer", {
    driver: {
      fullName: "Alex Carter",
      licenseNumber: "C0482-9915-3320",
      licenseState: "California",
      yearsLicensed: "1",
    },
  });
  assert.equal(updated.quote, null);
  const requoted = apply(updated, "request-quote", "customer", { coverage: "Liability" });
  assert.equal(
    requoted.quote?.annualPremium,
    COVERAGE_BASE_PREMIUM.Liability + NEW_DRIVER_SURCHARGE,
  );
});

test("vehicle and driver updates reject malformed fields with 400", () => {
  const base = { ...DEFAULT_DEMO_STATE.vehicle };
  for (const bad of [
    { ...base, year: "19" },
    { ...base, year: "3026" },
    { ...base, make: "" },
    { ...base, primaryUse: "Racing" },
  ]) {
    assert.equal(
      refuse(DEFAULT_DEMO_STATE, "update-vehicle", "customer", { vehicle: bad }).status,
      400,
    );
  }

  const driver = { ...DEFAULT_DEMO_STATE.driver };
  for (const bad of [
    { ...driver, yearsLicensed: "many" },
    { ...driver, yearsLicensed: "" },
    { ...driver, fullName: "   " },
  ]) {
    assert.equal(
      refuse(DEFAULT_DEMO_STATE, "update-driver", "customer", { driver: bad }).status,
      400,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Filing a claim and the fast-track rule                                      */
/* -------------------------------------------------------------------------- */

test("a claim at or under the fast-track limit is approved on arrival", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: FAST_TRACK_CLAIM_LIMIT },
  });
  const claim = claimOf(filed);
  assert.equal(claim.status, "approved");
  assert.equal(claim.autoApproved, true);
  assert.match(claim.reviewNote ?? "", /Approved automatically/);
  assert.equal(claim.settlementAmount, null);
  assert.deepEqual(claim.documents, []);
});

test("a claim one dollar over the limit waits for an agent", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: FAST_TRACK_CLAIM_LIMIT + 1 },
  });
  const claim = claimOf(filed);
  assert.equal(claim.status, "submitted");
  assert.equal(claim.autoApproved, false);
  assert.equal(claim.reviewNote, null);
});

test("filing rejects malformed claims with 400", () => {
  for (const bad of [
    { ...LARGE_CLAIM, type: "Vandalism" },
    { ...LARGE_CLAIM, incidentDate: "18/07/2026" },
    { ...LARGE_CLAIM, description: "" },
    { ...LARGE_CLAIM, estimatedAmount: 0 },
    { ...LARGE_CLAIM, estimatedAmount: -100 },
    { ...LARGE_CLAIM, estimatedAmount: 1200.5 },
    { ...LARGE_CLAIM, estimatedAmount: MAX_CLAIM_ESTIMATE + 1 },
  ]) {
    assert.equal(
      refuse(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: bad }).status,
      400,
    );
  }
});

test("a second claim is refused while the first one is still open", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(hasOpenClaim(filed), true);
  const refused = refuse(filed, "file-claim", "customer", { claim: SMALL_CLAIM });
  assert.equal(refused.status, 409);
});

test("a settled or rejected claim frees the policyholder to file again", () => {
  const settled = (() => {
    const approved = apply(inReview(), "approve-claim", "agent", { reviewNote: "Covered." });
    return apply(approved, "settle-claim", "agent");
  })();
  assert.equal(hasOpenClaim(settled), false);
  const refiled = apply(settled, "file-claim", "customer", { claim: SMALL_CLAIM });
  assert.equal(claimOf(refiled).type, "Glass");

  const rejected = apply(inReview(), "reject-claim", "agent", { reviewNote: "Out of period." });
  assert.equal(hasOpenClaim(rejected), false);
  assert.equal(claimOf(apply(rejected, "file-claim", "customer", { claim: SMALL_CLAIM })).status, "approved");
});

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

test("attaching a document records its name and nothing else", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  const attached = apply(filed, "upload-claim-document", "customer", {
    document: { fileName: "accident-photo.jpg", sizeLabel: "1.4 MB" },
  });
  const [document] = claimOf(attached).documents;
  assert.equal(document.fileName, "accident-photo.jpg");
  assert.equal(document.sizeLabel, "1.4 MB");
  assert.equal(document.uploadedAt, DEMO_NOW);
  assert.equal(document.id, "document-1");
});

test("a missing size still attaches; a missing name does not", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  const attached = apply(filed, "upload-claim-document", "customer", {
    document: { fileName: "quote.pdf" },
  });
  assert.equal(claimOf(attached).documents[0].sizeLabel, "unknown size");
  assert.equal(
    refuse(filed, "upload-claim-document", "customer", { document: { fileName: "" } }).status,
    400,
  );
});

test("documents cannot be attached before a claim exists or after it closes", () => {
  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "upload-claim-document", "customer", {
      document: { fileName: "photo.jpg" },
    }).status,
    409,
  );

  const rejected = apply(inReview(), "reject-claim", "agent", { reviewNote: "Out of period." });
  const refused = refuse(rejected, "upload-claim-document", "customer", {
    document: { fileName: "photo.jpg" },
  });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /closed/);
});

/* -------------------------------------------------------------------------- */
/* The agent review cycle                                                      */
/* -------------------------------------------------------------------------- */

test("only a pending claim can be opened for review", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  const reviewing = apply(filed, "start-claim-review", "agent");
  assert.equal(claimOf(reviewing).status, "in-review");
  // A second start is out of sequence, not malformed.
  assert.equal(refuse(reviewing, "start-claim-review", "agent").status, 409);

  // A fast-tracked claim never passes through "submitted", so it cannot start.
  const fastTracked = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: SMALL_CLAIM });
  assert.equal(refuse(fastTracked, "start-claim-review", "agent").status, 409);
});

test("every agent decision requires a written note", () => {
  for (const action of [
    "approve-claim",
    "reject-claim",
    "request-claim-information",
  ] as DemoStateAction[]) {
    assert.equal(refuse(inReview(), action, "agent").status, 400);
    assert.equal(refuse(inReview(), action, "agent", { reviewNote: "   " }).status, 400);
    assert.equal(
      refuse(inReview(), action, "agent", { reviewNote: "x".repeat(401) }).status,
      400,
    );
  }
});

test("decisions move the claim and keep the note", () => {
  const expected: Record<string, ClaimStatus> = {
    "approve-claim": "approved",
    "reject-claim": "rejected",
    "request-claim-information": "more-info-needed",
  };
  for (const [action, status] of Object.entries(expected)) {
    const decided = apply(inReview(), action as DemoStateAction, "agent", {
      reviewNote: "  A decision worth reading.  ",
    });
    assert.equal(claimOf(decided).status, status);
    assert.equal(claimOf(decided).reviewNote, "A decision worth reading.");
    // Only the agent's own decision flips autoApproved off, never on.
    assert.equal(claimOf(decided).autoApproved, false);
  }
});

test("a decision on a claim that is not in review is a conflict", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(
    refuse(filed, "approve-claim", "agent", { reviewNote: "Too early." }).status,
    409,
  );
  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "approve-claim", "agent", { reviewNote: "No claim." }).status,
    409,
  );
});

test("more information sends the claim back only once a document is attached", () => {
  const asked = apply(inReview(), "request-claim-information", "agent", {
    reviewNote: "Please attach a photo of the rear bumper.",
  });

  // Nothing attached yet: the round trip would tell the agent nothing new.
  const refused = refuse(asked, "respond-to-claim-review", "customer");
  assert.equal(refused.status, 409);
  assert.match(refused.error, /at least one document/);

  const attached = apply(asked, "upload-claim-document", "customer", {
    document: { fileName: "rear-bumper.jpg", sizeLabel: "820 KB" },
  });
  const returned = apply(attached, "respond-to-claim-review", "customer");
  assert.equal(claimOf(returned).status, "in-review");
  // The agent's note survives the round trip, so the reason stays on record.
  assert.match(claimOf(returned).reviewNote ?? "", /rear bumper/);
});

test("responding is refused when the claim is not waiting on the policyholder", () => {
  assert.equal(refuse(inReview(), "respond-to-claim-review", "customer").status, 409);
  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "respond-to-claim-review", "customer").status,
    409,
  );
});

/* -------------------------------------------------------------------------- */
/* Settlement                                                                  */
/* -------------------------------------------------------------------------- */

test("settling pays the estimate less the deductible", () => {
  const approved = apply(inReview(), "approve-claim", "agent", { reviewNote: "Covered." });
  const settled = apply(approved, "settle-claim", "agent");
  assert.equal(claimOf(settled).status, "settled");
  assert.equal(
    claimOf(settled).settlementAmount,
    LARGE_CLAIM.estimatedAmount - DEFAULT_DEMO_STATE.policy.deductible,
  );
});

test("a settlement never goes negative", () => {
  assert.equal(settlementFor(400, 750), 0);
  assert.equal(settlementFor(750, 750), 0);
  assert.equal(settlementFor(1000, 750), 250);

  // A fast-tracked claim under the deductible settles at zero rather than
  // producing a payout the insurer would be owed.
  const tiny = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: 400 },
  });
  assert.equal(claimOf(apply(tiny, "settle-claim", "agent")).settlementAmount, 0);
});

test("settling uses the deductible in force at settlement time", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Comprehensive",
  });
  const upgraded = apply(quoted, "accept-quote", "customer");
  const filed = apply(upgraded, "file-claim", "customer", { claim: LARGE_CLAIM });
  const reviewing = apply(filed, "start-claim-review", "agent");
  const approved = apply(reviewing, "approve-claim", "agent", { reviewNote: "Covered." });
  const settled = apply(approved, "settle-claim", "agent");
  assert.equal(
    claimOf(settled).settlementAmount,
    LARGE_CLAIM.estimatedAmount - COVERAGE_DEDUCTIBLE.Comprehensive,
  );
});

test("only an approved claim can be settled", () => {
  assert.equal(refuse(inReview(), "settle-claim", "agent").status, 409);
  assert.equal(refuse(DEFAULT_DEMO_STATE, "settle-claim", "agent").status, 409);

  const approved = apply(inReview(), "approve-claim", "agent", { reviewNote: "Covered." });
  const settled = apply(approved, "settle-claim", "agent");
  assert.equal(refuse(settled, "settle-claim", "agent").status, 409);
});

/* -------------------------------------------------------------------------- */
/* Payment                                                                     */
/* -------------------------------------------------------------------------- */

test("the documented demo card is accepted", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(paid.invoice.status, "paid");
  assert.equal(paid.invoice.paidWith, "Visa ending 1111");
  assert.equal(paid.invoice.paidAt, DEMO_NOW);
});

test("spaces and hyphens in the card number are tolerated", () => {
  const spaced = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", {
    card: { ...VALID_CARD, cardNumber: "4111 1111-1111 1111" },
  });
  assert.equal(spaced.invoice.status, "paid");
});

test("any other well-formed card is declined with 409, not 400", () => {
  for (const card of [
    { ...VALID_CARD, cardNumber: "5555555555554444" },
    { ...VALID_CARD, expiry: "01/29" },
    { ...VALID_CARD, cvv: "999" },
  ]) {
    const refused = refuse(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card });
    assert.equal(refused.status, 409);
    assert.equal(refused.error, CARD_DECLINED_MESSAGE);
  }
});

test("a malformed card is the form's fault, so it is a 400", () => {
  for (const card of [
    { ...VALID_CARD, cardNumber: "4111" },
    { ...VALID_CARD, cardNumber: "411111111111111a" },
    { ...VALID_CARD, expiry: "13/30" },
    { ...VALID_CARD, expiry: "2030-12" },
    { ...VALID_CARD, cvv: "12" },
    { ...VALID_CARD, nameOnCard: "" },
  ]) {
    assert.equal(
      refuse(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card }).status,
      400,
      `expected 400 for ${JSON.stringify(card)}`,
    );
  }
  assert.equal(refuse(DEFAULT_DEMO_STATE, "pay-invoice", "customer").status, 400);
});

test("an invoice cannot be paid twice", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  const refused = refuse(paid, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(refused.status, 409);
});

test("accepting a quote reopens the invoice a previous payment had closed", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  const quoted = apply(paid, "request-quote", "customer", { coverage: "Comprehensive" });
  const accepted = apply(quoted, "accept-quote", "customer");
  assert.equal(accepted.invoice.status, "unpaid");
  assert.equal(accepted.invoice.paidWith, null);
  assert.equal(accepted.invoice.paidAt, null);
});

/* -------------------------------------------------------------------------- */
/* Messages and derived counts                                                 */
/* -------------------------------------------------------------------------- */

test("a message must be present and within 500 characters", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "send-message", "customer").status, 400);
  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "send-message", "customer", { messageBody: "   " }).status,
    400,
  );
  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "send-message", "customer", {
      messageBody: "x".repeat(501),
    }).status,
    400,
  );
});

test("the unread count never counts the reader's own messages", () => {
  // The seed thread ends with the customer's own reply.
  assert.equal(countUnreadMessages(DEFAULT_DEMO_STATE, "customer"), 1);
  assert.equal(countUnreadMessages(DEFAULT_DEMO_STATE, "agent"), 1);

  // Reading is per role: one side catching up leaves the other side untouched.
  const read = apply(DEFAULT_DEMO_STATE, "mark-messages-read", "customer");
  assert.equal(countUnreadMessages(read, "customer"), 0);
  assert.equal(countUnreadMessages(read, "agent"), 1);

  const bothRead = apply(read, "mark-messages-read", "agent");
  assert.equal(countUnreadMessages(bothRead, "agent"), 0);

  // The agent's own reply is unread for the customer and never for the agent.
  const replied = apply(bothRead, "send-message", "agent", { messageBody: "On it." });
  assert.equal(countUnreadMessages(replied, "customer"), 1);
  assert.equal(countUnreadMessages(replied, "agent"), 0);
});

test("marking an already-read thread is a no-op rather than an error", () => {
  const read = apply(DEFAULT_DEMO_STATE, "mark-messages-read", "customer");
  const again = apply(read, "mark-messages-read", "customer");
  assert.deepEqual(again, read);
});

test("the agent queue counts only claims sitting on the agent's desk", () => {
  assert.equal(countClaimsAwaitingAgent(DEFAULT_DEMO_STATE), 0);

  const submitted = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(countClaimsAwaitingAgent(submitted), 1);

  const asked = apply(inReview(), "request-claim-information", "agent", {
    reviewNote: "Photo please.",
  });
  // Waiting on the policyholder is not waiting on the agent.
  assert.equal(countClaimsAwaitingAgent(asked), 0);

  const approved = apply(inReview(), "approve-claim", "agent", { reviewNote: "Covered." });
  assert.equal(countClaimsAwaitingAgent(approved), 1, "an approved claim still needs settling");
  assert.equal(countClaimsAwaitingAgent(apply(approved, "settle-claim", "agent")), 0);
});

test("the policyholder's to-do count reflects what is actually outstanding", () => {
  // Seed state: one unpaid invoice.
  assert.equal(countCustomerTodos(DEFAULT_DEMO_STATE), 1);

  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(countCustomerTodos(paid), 0);

  const quoted = apply(paid, "request-quote", "customer", { coverage: "Comprehensive" });
  assert.equal(countCustomerTodos(quoted), 1);

  const asked = apply(inReview(), "request-claim-information", "agent", {
    reviewNote: "Photo please.",
  });
  assert.equal(countCustomerTodos(asked), 2, "an unpaid invoice plus a claim needing information");
});

test("money is always formatted with a currency symbol and thousands separator", () => {
  assert.equal(formatMoney(0), "$0");
  assert.equal(formatMoney(640), "$640");
  assert.equal(formatMoney(1420), "$1,420");
  assert.equal(formatMoney(100000), "$100,000");
});

/* -------------------------------------------------------------------------- */
/* Immutability                                                                */
/* -------------------------------------------------------------------------- */

test("a transition never mutates the state it was given", () => {
  const before = structuredClone(DEFAULT_DEMO_STATE);
  apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  apply(DEFAULT_DEMO_STATE, "request-quote", "customer", { coverage: "Liability" });
  apply(DEFAULT_DEMO_STATE, "send-message", "customer", { messageBody: "Hello." });
  apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.deepEqual(DEFAULT_DEMO_STATE, before);
});

test("a refused transition returns no state to accidentally save", () => {
  const result = transitionDemoState(DEFAULT_DEMO_STATE, "settle-claim", "agent");
  assert.equal(result.ok, false);
  assert.equal("state" in result, false);
});
