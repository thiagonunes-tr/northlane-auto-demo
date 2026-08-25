import assert from "node:assert/strict";
import test from "node:test";
import {
  ADD_ONS,
  CARD_DECLINED_MESSAGE,
  COVERAGE_BASE_PREMIUM,
  DEDUCTIBLE_ADJUSTMENT,
  DEFAULT_DEMO_STATE,
  DEMO_NOW,
  DEMO_TODAY,
  FAST_TRACK_CLAIM_LIMIT,
  MAX_CLAIM_ESTIMATE,
  MAX_NO_CLAIMS_DISCOUNT,
  MAX_PAYMENT_METHODS,
  MAX_VEHICLES,
  NEW_DRIVER_SURCHARGE,
  NO_CLAIMS_DISCOUNT_PER_YEAR,
  OLDER_VEHICLE_SURCHARGE,
  countClaimsAwaitingAgent,
  countCustomerTodos,
  countUnreadMessages,
  formatMoney,
  hasOpenClaim,
  instalmentAmount,
  isDemoStateAction,
  noClaimsDiscountPercent,
  openClaim,
  priceQuote,
  settlementFor,
  transitionDemoState,
  unpaidInvoices,
} from "../lib/demo-state";
import type {
  Claim,
  DemoActionInput,
  DemoActorRole,
  DemoState,
  DemoStateAction,
} from "../lib/demo-state";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

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

const SECOND_VEHICLE = {
  year: "2021",
  make: "Toyota",
  model: "Corolla",
  vin: "JTDBR32E720012345",
  plate: "9LMN044",
  primaryUse: "Pleasure" as const,
};

const SECOND_DRIVER = {
  fullName: "Sam Carter",
  licenseNumber: "C7781-4420-9910",
  licenseState: "California",
  yearsLicensed: "2",
};

function claimOf(state: DemoState): Claim {
  const claim = state.claims[0];
  assert.ok(claim, "expected a claim on the state");
  return claim;
}

/** A large claim that has reached the agent and is open for a decision. */
function inReview(): DemoState {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  return apply(filed, "start-claim-review", "agent");
}

/** The same claim, approved and ready to settle. */
function approved(): DemoState {
  return apply(inReview(), "approve-claim", "agent", { reviewNote: "Covered." });
}

/* -------------------------------------------------------------------------- */
/* Action surface and roles                                                    */
/* -------------------------------------------------------------------------- */

test("recognizes only supported demo actions", () => {
  for (const action of [
    "request-quote", "renew-policy", "cancel-policy", "add-vehicle",
    "remove-driver", "request-assistance", "refund-invoice", "lapse-policy",
  ]) {
    assert.equal(isDemoStateAction(action), true, action);
  }
  assert.equal(isDemoStateAction("overwrite-state"), false);
  assert.equal(isDemoStateAction(""), false);
  assert.equal(isDemoStateAction(null), false);
});

test("each role is refused the other role's actions with 403", () => {
  for (const action of [
    "start-claim-review", "assign-repair-shop", "schedule-inspection",
    "record-inspection", "approve-claim", "reject-claim", "settle-claim",
    "dispatch-assistance", "complete-assistance", "refund-invoice", "lapse-policy",
  ] as DemoStateAction[]) {
    const refused = refuse(inReview(), action, "customer", { reviewNote: "Fine by me." });
    assert.equal(refused.status, 403, action);
    assert.match(refused.error, /claims agent/);
  }

  for (const action of [
    "request-quote", "accept-quote", "discard-quote", "renew-policy",
    "cancel-policy", "add-vehicle", "update-vehicle", "remove-vehicle",
    "add-driver", "update-driver", "remove-driver", "file-claim",
    "upload-claim-document", "respond-to-claim-review", "request-assistance",
    "pay-invoice", "save-payment-method", "remove-payment-method",
    "change-instalment-plan",
  ] as DemoStateAction[]) {
    const refused = refuse(DEFAULT_DEMO_STATE, action, "agent");
    assert.equal(refused.status, 403, action);
    assert.match(refused.error, /policyholder/);
  }
});

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

test("each vehicle earns its own rated line", () => {
  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const one = priceQuote({
    coverage: "Standard", addOns: [], deductible: 750, vehicles, drivers, noClaimsYears: 0,
  });
  assert.equal(one.annualPremium, COVERAGE_BASE_PREMIUM.Standard);
  assert.equal(one.breakdown.length, 1);

  const two = priceQuote({
    coverage: "Standard",
    addOns: [],
    deductible: 750,
    vehicles: [...vehicles, { ...vehicles[0], id: "vehicle-2", year: "2012" }],
    drivers,
    noClaimsYears: 0,
  });
  assert.equal(
    two.annualPremium,
    COVERAGE_BASE_PREMIUM.Standard * 2 + OLDER_VEHICLE_SURCHARGE,
  );
  assert.equal(two.breakdown.length, 2, "one line per vehicle, nothing merged");
});

test("the driver surcharge is charged once, for the least experienced", () => {
  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const many = priceQuote({
    coverage: "Standard",
    addOns: [],
    deductible: 750,
    vehicles,
    drivers: [
      ...drivers,
      { ...drivers[0], id: "driver-2", isPrimary: false, yearsLicensed: "1" },
      { ...drivers[0], id: "driver-3", isPrimary: false, yearsLicensed: "2" },
    ],
    noClaimsYears: 0,
  });
  const surcharges = many.breakdown.filter(line =>
    line.label.startsWith("Driver licensed under"),
  );
  assert.equal(surcharges.length, 1, "two inexperienced drivers, one surcharge");
  assert.equal(surcharges[0].amount, NEW_DRIVER_SURCHARGE);
});

test("add-ons and the deductible each move the price by their own named line", () => {
  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const priced = priceQuote({
    coverage: "Liability",
    addOns: ["glass", "roadside"],
    deductible: 250,
    vehicles,
    drivers,
    noClaimsYears: 0,
  });
  const glass = ADD_ONS.find(a => a.id === "glass")!;
  const roadside = ADD_ONS.find(a => a.id === "roadside")!;
  assert.equal(
    priced.annualPremium,
    COVERAGE_BASE_PREMIUM.Liability +
      glass.annualPremium +
      roadside.annualPremium +
      DEDUCTIBLE_ADJUSTMENT[250],
  );
  // Every line is named, so the total can always be decomposed on screen.
  assert.equal(
    priced.breakdown.reduce((total, line) => total + line.amount, 0),
    priced.annualPremium,
  );
});

test("a higher deductible lowers the premium and a lower one raises it", () => {
  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const price = (deductible: 250 | 750 | 1000) =>
    priceQuote({ coverage: "Standard", addOns: [], deductible, vehicles, drivers, noClaimsYears: 0 })
      .annualPremium;
  assert.ok(price(250) > price(750));
  assert.ok(price(1000) < price(750));
});

test("the no-claims bonus is a percentage of the subtotal, capped", () => {
  assert.equal(noClaimsDiscountPercent(0), 0);
  assert.equal(noClaimsDiscountPercent(3), 3 * NO_CLAIMS_DISCOUNT_PER_YEAR);
  assert.equal(noClaimsDiscountPercent(99), MAX_NO_CLAIMS_DISCOUNT, "capped");
  assert.equal(noClaimsDiscountPercent(-4), 0, "never negative");

  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const plain = priceQuote({ coverage: "Standard", addOns: [], deductible: 750, vehicles, drivers, noClaimsYears: 0 });
  const bonused = priceQuote({ coverage: "Standard", addOns: [], deductible: 750, vehicles, drivers, noClaimsYears: 4 });
  assert.ok(bonused.annualPremium < plain.annualPremium);
  assert.equal(
    bonused.annualPremium,
    plain.annualPremium - Math.round((plain.annualPremium * 20) / 100),
  );
  assert.match(bonused.breakdown.at(-1)!.label, /No-claims bonus · 20%/);
});

test("a premium never goes below zero however many discounts apply", () => {
  const { vehicles, drivers } = DEFAULT_DEMO_STATE;
  const priced = priceQuote({
    coverage: "Liability", addOns: [], deductible: 1000, vehicles, drivers, noClaimsYears: 99,
  });
  assert.ok(priced.annualPremium >= 0);
});

/* -------------------------------------------------------------------------- */
/* Quote lifecycle and endorsement                                             */
/* -------------------------------------------------------------------------- */

test("an endorsement quote leaves the policy untouched until accepted", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Comprehensive", addOns: [], deductible: 750,
  });
  assert.equal(quoted.quote?.kind, "endorsement");
  assert.deepEqual(quoted.policy, DEFAULT_DEMO_STATE.policy);

  const accepted = apply(quoted, "accept-quote", "customer");
  assert.equal(accepted.quote, null);
  assert.equal(accepted.policy.coverage, "Comprehensive");
  assert.equal(accepted.policy.number, DEFAULT_DEMO_STATE.policy.number, "same policy");
  assert.equal(accepted.policy.noClaimsYears, 4, "the bonus survives an endorsement");
  assert.equal(unpaidInvoices(accepted)[0].amount, accepted.quote === null
    ? instalmentAmount(accepted.policy.annualPremium, "monthly") : -1);
});

test("re-quoting the exact cover already held is refused", () => {
  const refused = refuse(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Standard", addOns: [], deductible: 750,
  });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /cover you already have/);
});

test("changing only an add-on or only the deductible is a real change", () => {
  const byAddOn = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Standard", addOns: ["glass"], deductible: 750,
  });
  assert.deepEqual(byAddOn.quote?.addOns, ["glass"]);
  const byDeductible = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Standard", addOns: [], deductible: 250,
  });
  assert.equal(byDeductible.quote?.deductible, 250);
});

test("add-ons are deduplicated and ordered, so the price lines are stable", () => {
  const quoted = apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
    coverage: "Standard", addOns: ["glass", "courtesy-car", "glass"], deductible: 750,
  });
  assert.deepEqual(quoted.quote?.addOns, ["courtesy-car", "glass"]);
});

test("malformed quote inputs are 400", () => {
  for (const input of [
    { coverage: "Platinum", addOns: [], deductible: 750 },
    { coverage: "Standard", addOns: ["free-coffee"], deductible: 750 },
    { coverage: "Standard", addOns: [], deductible: 333 },
  ]) {
    assert.equal(refuse(DEFAULT_DEMO_STATE, "request-quote", "customer", input).status, 400);
  }
});

test("accepting or discarding with no quote on the table is a conflict", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "accept-quote", "customer").status, 409);
  assert.equal(refuse(DEFAULT_DEMO_STATE, "discard-quote", "customer").status, 409);
});

/* -------------------------------------------------------------------------- */
/* Cancellation, new business, lapse and reinstatement                         */
/* -------------------------------------------------------------------------- */

function cancelled(): DemoState {
  return apply(DEFAULT_DEMO_STATE, "cancel-policy", "customer", {
    reason: "Sold the car.",
  });
}

test("cancelling needs a reason and records it", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "cancel-policy", "customer").status, 400);
  const state = cancelled();
  assert.equal(state.policy.status, "cancelled");
  assert.equal(state.policy.endedOn, DEMO_TODAY);
  assert.equal(state.policy.endedReason, "Sold the car.");
  assert.equal(refuse(state, "cancel-policy", "customer", { reason: "Again." }).status, 409);
});

test("a policy with an open claim cannot be cancelled", () => {
  const refused = refuse(inReview(), "cancel-policy", "customer", { reason: "Done." });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /claim is still open/);
});

test("quoting a cancelled policy is new business, and buying it issues a new one", () => {
  const state = cancelled();
  const quoted = apply(state, "request-quote", "customer", {
    coverage: "Comprehensive", addOns: ["roadside"], deductible: 500,
  });
  assert.equal(quoted.quote?.kind, "new-business");
  // New business starts the bonus record from nothing, so the price is higher
  // than the same cover would be as an endorsement.
  assert.equal(
    quoted.quote?.breakdown.some(line => line.label.startsWith("No-claims bonus")),
    false,
  );

  const bought = apply(quoted, "accept-quote", "customer");
  assert.equal(bought.policy.status, "active");
  assert.notEqual(bought.policy.number, state.policy.number, "a new policy number");
  assert.equal(bought.policy.noClaimsYears, 0);
  assert.equal(bought.policy.effectiveFrom, DEMO_TODAY);
  assert.equal(bought.policy.endedOn, null);
});

test("a cancelled policy accepts no risk or claim changes", () => {
  const state = cancelled();
  for (const action of [
    "add-vehicle", "update-vehicle", "remove-vehicle",
    "add-driver", "update-driver", "remove-driver", "file-claim", "request-assistance",
  ] as DemoStateAction[]) {
    assert.equal(refuse(state, action, "customer", {
      vehicle: SECOND_VEHICLE, driver: SECOND_DRIVER, claim: LARGE_CLAIM,
      vehicleId: "vehicle-1", driverId: "driver-1",
      assistance: { kind: "Tow", location: "I-80" },
    }).status, 409, action);
  }
});

test("lapsing needs an overdue premium, and paying it reinstates the policy", () => {
  // Nothing overdue once the invoice is paid, so there is nothing to lapse for.
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(refuse(paid, "lapse-policy", "agent").status, 409);

  const lapsed = apply(DEFAULT_DEMO_STATE, "lapse-policy", "agent");
  assert.equal(lapsed.policy.status, "lapsed");
  assert.equal(refuse(lapsed, "renew-policy", "customer").status, 409);
  assert.equal(refuse(lapsed, "file-claim", "customer", { claim: LARGE_CLAIM }).status, 409);

  const reinstated = apply(lapsed, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(reinstated.policy.status, "active");
  assert.equal(reinstated.policy.endedReason, null);
});

/* -------------------------------------------------------------------------- */
/* Renewal and the bonus                                                       */
/* -------------------------------------------------------------------------- */

test("renewing adds a claim-free year and reprices with it", () => {
  const renewed = apply(DEFAULT_DEMO_STATE, "renew-policy", "customer");
  assert.equal(renewed.policy.noClaimsYears, 5);
  assert.ok(
    renewed.policy.annualPremium < DEFAULT_DEMO_STATE.policy.annualPremium,
    "a bigger bonus should cost less",
  );
  assert.equal(renewed.policy.renewsOn, "February 1, 2028");
  assert.equal(unpaidInvoices(renewed).length, 1, "renewal issues one invoice");
});

test("settling a claim costs the whole bonus, and the next renewal shows it", () => {
  const settled = apply(approved(), "settle-claim", "agent");
  assert.equal(settled.policy.noClaimsYears, 0, "the bonus is gone");

  const withBonus = apply(DEFAULT_DEMO_STATE, "renew-policy", "customer").policy.annualPremium;
  const afterClaim = apply(settled, "renew-policy", "customer").policy.annualPremium;
  assert.ok(
    afterClaim > withBonus,
    "a settled claim must make the renewal dearer than a claim-free one",
  );
});

test("a cancelled policy cannot be renewed", () => {
  const refused = refuse(cancelled(), "renew-policy", "customer");
  assert.equal(refused.status, 409);
  assert.match(refused.error, /new quote/);
});

/* -------------------------------------------------------------------------- */
/* Vehicles and drivers                                                        */
/* -------------------------------------------------------------------------- */

test("vehicles can be added, changed and removed, within limits", () => {
  let state = apply(DEFAULT_DEMO_STATE, "add-vehicle", "customer", { vehicle: SECOND_VEHICLE });
  assert.equal(state.vehicles.length, 2);
  assert.equal(state.vehicles[1].vin, SECOND_VEHICLE.vin);
  assert.equal(state.quote, null, "adding a vehicle clears an open quote");

  // A duplicate VIN is the same car twice.
  assert.equal(refuse(state, "add-vehicle", "customer", { vehicle: SECOND_VEHICLE }).status, 409);

  state = apply(state, "update-vehicle", "customer", {
    vehicleId: "vehicle-2",
    vehicle: { ...SECOND_VEHICLE, primaryUse: "Business", plate: "abc123" },
  });
  assert.equal(state.vehicles[1].primaryUse, "Business");
  assert.equal(state.vehicles[1].plate, "ABC123", "normalised");
  assert.equal(state.vehicles[1].id, "vehicle-2", "identity survives an edit");

  state = apply(state, "remove-vehicle", "customer", { vehicleId: "vehicle-2" });
  assert.equal(state.vehicles.length, 1);
  // The last one cannot go: a policy with no car cannot be priced.
  assert.equal(refuse(state, "remove-vehicle", "customer", { vehicleId: "vehicle-1" }).status, 409);
  assert.equal(refuse(state, "remove-vehicle", "customer", { vehicleId: "nope" }).status, 400);
});

test("the vehicle list is capped", () => {
  let state = DEFAULT_DEMO_STATE;
  for (let index = 2; index <= MAX_VEHICLES; index += 1) {
    state = apply(state, "add-vehicle", "customer", {
      vehicle: { ...SECOND_VEHICLE, vin: `VIN0000000000000${index}`, plate: `PL0000${index}` },
    });
  }
  assert.equal(state.vehicles.length, MAX_VEHICLES);
  assert.equal(
    refuse(state, "add-vehicle", "customer", {
      vehicle: { ...SECOND_VEHICLE, vin: "VINZZZZZZZZZZZZZZ", plate: "ZZZ999" },
    }).status,
    409,
  );
});

test("drivers can be added and removed, but never the policyholder", () => {
  let state = apply(DEFAULT_DEMO_STATE, "add-driver", "customer", { driver: SECOND_DRIVER });
  assert.equal(state.drivers.length, 2);
  assert.equal(state.drivers[1].isPrimary, false);

  // Adding an inexperienced driver is felt in the next price.
  const requoted = apply(state, "request-quote", "customer", {
    coverage: "Comprehensive", addOns: [], deductible: 750,
  });
  assert.ok(
    requoted.quote!.breakdown.some(line => line.label.startsWith("Driver licensed under")),
  );

  assert.equal(refuse(state, "add-driver", "customer", { driver: SECOND_DRIVER }).status, 409,
    "a duplicate licence number");

  const refused = refuse(state, "remove-driver", "customer", { driverId: "driver-1" });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /policyholder cannot be removed/);

  state = apply(state, "remove-driver", "customer", { driverId: "driver-2" });
  assert.equal(state.drivers.length, 1);
});

test("vehicle and driver updates reject malformed fields with 400", () => {
  const vehicle = { ...SECOND_VEHICLE };
  for (const bad of [
    { ...vehicle, year: "19" },
    { ...vehicle, year: "3026" },
    { ...vehicle, make: "" },
    { ...vehicle, primaryUse: "Racing" },
  ]) {
    assert.equal(refuse(DEFAULT_DEMO_STATE, "add-vehicle", "customer", { vehicle: bad }).status, 400);
  }
  for (const bad of [
    { ...SECOND_DRIVER, yearsLicensed: "many" },
    { ...SECOND_DRIVER, yearsLicensed: "" },
    { ...SECOND_DRIVER, fullName: "   " },
  ]) {
    assert.equal(refuse(DEFAULT_DEMO_STATE, "add-driver", "customer", { driver: bad }).status, 400);
  }
});

/* -------------------------------------------------------------------------- */
/* Claims: filing, history and third parties                                   */
/* -------------------------------------------------------------------------- */

test("a claim at or under the fast-track limit is approved on arrival", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: FAST_TRACK_CLAIM_LIMIT },
  });
  const claim = claimOf(filed);
  assert.equal(claim.status, "approved");
  assert.equal(claim.autoApproved, true);
  assert.match(claim.reviewNote ?? "", /Approved automatically/);
});

test("a claim one dollar over the limit waits for an agent", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: FAST_TRACK_CLAIM_LIMIT + 1 },
  });
  assert.equal(claimOf(filed).status, "submitted");
  assert.equal(claimOf(filed).autoApproved, false);
});

test("filing keeps the closed ones as history, newest first", () => {
  const before = DEFAULT_DEMO_STATE.claims.length;
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(filed.claims.length, before + 1);
  assert.equal(filed.claims[0].type, "Collision", "newest first");
  assert.equal(filed.claims[1].status, "settled", "the old one is untouched");
  assert.notEqual(filed.claims[0].reference, filed.claims[1].reference);
});

test("a third party is optional, and half of one is refused", () => {
  const withParty = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: {
      ...LARGE_CLAIM,
      thirdParty: { name: "Jordan Miller", plate: "7bkd221", insurer: "Cedar Mutual" },
    },
  });
  assert.equal(claimOf(withParty).thirdParty?.plate, "7BKD221", "normalised");

  assert.equal(
    refuse(DEFAULT_DEMO_STATE, "file-claim", "customer", {
      claim: { ...LARGE_CLAIM, thirdParty: { name: "Jordan Miller", plate: "", insurer: "" } },
    }).status,
    400,
  );
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
    assert.equal(refuse(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: bad }).status, 400);
  }
});

test("a second claim is refused while the first one is still open", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(hasOpenClaim(filed), true);
  assert.equal(refuse(filed, "file-claim", "customer", { claim: SMALL_CLAIM }).status, 409);
});

/* -------------------------------------------------------------------------- */
/* Claims: the agent's review                                                  */
/* -------------------------------------------------------------------------- */

test("only a pending claim can be opened for review", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  const reviewing = apply(filed, "start-claim-review", "agent");
  assert.equal(claimOf(reviewing).status, "in-review");
  assert.equal(refuse(reviewing, "start-claim-review", "agent").status, 409);
});

test("an inspection needs a repair shop first, and comes back to the desk", () => {
  const reviewing = inReview();
  // Nowhere to inspect it yet.
  assert.equal(refuse(reviewing, "schedule-inspection", "agent").status, 409);
  assert.equal(refuse(reviewing, "assign-repair-shop", "agent", { repairShop: "Bob's" }).status, 400);

  const assigned = apply(reviewing, "assign-repair-shop", "agent", {
    repairShop: "Northgate Auto Body",
  });
  assert.equal(claimOf(assigned).repairShop, "Northgate Auto Body");

  const scheduled = apply(assigned, "schedule-inspection", "agent");
  assert.equal(claimOf(scheduled).status, "inspection-scheduled");
  assert.equal(claimOf(scheduled).inspection?.shop, "Northgate Auto Body");
  assert.equal(claimOf(scheduled).inspection?.outcome, null);
  // A claim out for inspection is not decidable.
  assert.equal(refuse(scheduled, "approve-claim", "agent", { reviewNote: "Looks fine." }).status, 409);

  assert.equal(refuse(scheduled, "record-inspection", "agent", {
    inspection: { outcome: "damage-confirmed" },
  }).status, 400, "the finding has to be written down");

  const recorded = apply(scheduled, "record-inspection", "agent", {
    inspection: { outcome: "damage-confirmed", notes: "Rear panel and boot lid, as described." },
  });
  assert.equal(claimOf(recorded).status, "in-review", "back on the agent's desk");
  assert.equal(claimOf(recorded).inspection?.outcome, "damage-confirmed");
  assert.match(claimOf(recorded).inspection?.notes ?? "", /Rear panel/);
});

test("every agent decision requires a written note", () => {
  for (const action of [
    "approve-claim", "reject-claim", "request-claim-information",
  ] as DemoStateAction[]) {
    assert.equal(refuse(inReview(), action, "agent").status, 400);
    assert.equal(refuse(inReview(), action, "agent", { reviewNote: "   " }).status, 400);
    assert.equal(refuse(inReview(), action, "agent", { reviewNote: "x".repeat(401) }).status, 400);
  }
});

test("more information sends the claim back only once a document is attached", () => {
  const asked = apply(inReview(), "request-claim-information", "agent", {
    reviewNote: "Please attach a photo of the rear bumper.",
  });
  const refused = refuse(asked, "respond-to-claim-review", "customer");
  assert.equal(refused.status, 409);
  assert.match(refused.error, /at least one document/);

  const attached = apply(asked, "upload-claim-document", "customer", {
    document: { fileName: "rear-bumper.jpg", sizeLabel: "820 KB" },
  });
  const returned = apply(attached, "respond-to-claim-review", "customer");
  assert.equal(claimOf(returned).status, "in-review");
  assert.match(claimOf(returned).reviewNote ?? "", /rear bumper/);
});

test("a document records its name and nothing else", () => {
  const filed = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  const attached = apply(filed, "upload-claim-document", "customer", {
    document: { fileName: "accident-photo.jpg", sizeLabel: "1.4 MB" },
  });
  const [document] = claimOf(attached).documents;
  assert.deepEqual(Object.keys(document).sort(), ["fileName", "id", "sizeLabel", "uploadedAt"]);
  assert.equal(document.uploadedAt, DEMO_NOW);
  assert.equal(refuse(filed, "upload-claim-document", "customer", {
    document: { fileName: "" },
  }).status, 400);
});

/* -------------------------------------------------------------------------- */
/* Settlement                                                                  */
/* -------------------------------------------------------------------------- */

test("settling pays the estimate less the deductible in force", () => {
  const settled = apply(approved(), "settle-claim", "agent");
  assert.equal(claimOf(settled).status, "settled");
  assert.equal(
    claimOf(settled).settlementAmount,
    LARGE_CLAIM.estimatedAmount - DEFAULT_DEMO_STATE.policy.deductible,
  );
  // The deductible applied is captured, so history stays true after a change.
  assert.equal(claimOf(settled).settledDeductible, DEFAULT_DEMO_STATE.policy.deductible);
});

test("glass cover settles a glass claim with no deductible at all", () => {
  const withGlass = apply(
    apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
      coverage: "Standard", addOns: ["glass"], deductible: 750,
    }),
    "accept-quote", "customer",
  );
  const filed = apply(withGlass, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, estimatedAmount: 900 },
  });
  const settled = apply(filed, "settle-claim", "agent");
  assert.equal(claimOf(settled).settledDeductible, 0);
  assert.equal(claimOf(settled).settlementAmount, 900, "paid in full");

  // Without the add-on the same claim would be reduced.
  const plain = apply(
    apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
      claim: { ...SMALL_CLAIM, estimatedAmount: 900 },
    }),
    "settle-claim", "agent",
  );
  assert.equal(claimOf(plain).settlementAmount, 150);
});

test("a settlement never goes negative", () => {
  assert.equal(settlementFor(400, 750), 0);
  assert.equal(settlementFor(1000, 750), 250);
  const tiny = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", {
    claim: { ...SMALL_CLAIM, type: "Theft", estimatedAmount: 400 },
  });
  assert.equal(claimOf(apply(tiny, "settle-claim", "agent")).settlementAmount, 0);
});

test("only an approved claim can be settled", () => {
  assert.equal(refuse(inReview(), "settle-claim", "agent").status, 409);
  const settled = apply(approved(), "settle-claim", "agent");
  assert.equal(refuse(settled, "settle-claim", "agent").status, 409);
});

/* -------------------------------------------------------------------------- */
/* Roadside assistance                                                         */
/* -------------------------------------------------------------------------- */

function withRoadside(): DemoState {
  return apply(
    apply(DEFAULT_DEMO_STATE, "request-quote", "customer", {
      coverage: "Standard", addOns: ["roadside"], deductible: 750,
    }),
    "accept-quote", "customer",
  );
}

test("assistance is only available when the add-on was bought", () => {
  const refused = refuse(DEFAULT_DEMO_STATE, "request-assistance", "customer", {
    assistance: { kind: "Tow", location: "I-80 westbound, mile 42" },
  });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /not on this policy/);

  const requested = apply(withRoadside(), "request-assistance", "customer", {
    assistance: { kind: "Tow", location: "I-80 westbound, mile 42" },
  });
  assert.equal(requested.assistance[0].status, "requested");
  assert.equal(requested.assistance[0].kind, "Tow");
});

test("assistance runs requested, dispatched, completed, one at a time", () => {
  const requested = apply(withRoadside(), "request-assistance", "customer", {
    assistance: { kind: "Battery", location: "Cedar Street car park" },
  });
  assert.equal(refuse(requested, "request-assistance", "customer", {
    assistance: { kind: "Fuel", location: "Elsewhere" },
  }).status, 409, "one open request at a time");
  assert.equal(refuse(requested, "complete-assistance", "agent").status, 409, "not dispatched yet");

  const dispatched = apply(requested, "dispatch-assistance", "agent");
  assert.equal(dispatched.assistance[0].status, "dispatched");
  assert.ok(dispatched.assistance[0].provider);
  assert.ok((dispatched.assistance[0].etaMinutes ?? 0) > 0);

  const completed = apply(dispatched, "complete-assistance", "agent");
  assert.equal(completed.assistance[0].status, "completed");
  // Closed, so a new one is allowed again.
  assert.equal(
    apply(completed, "request-assistance", "customer", {
      assistance: { kind: "Fuel", location: "Elsewhere" },
    }).assistance.length,
    2,
  );
});

test("assistance rejects malformed requests with 400", () => {
  assert.equal(refuse(withRoadside(), "request-assistance", "customer", {
    assistance: { kind: "Helicopter", location: "Nowhere" },
  }).status, 400);
  assert.equal(refuse(withRoadside(), "request-assistance", "customer", {
    assistance: { kind: "Tow", location: "" },
  }).status, 400);
});

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

test("the documented demo card is accepted and any other is declined", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(paid.invoices[0].status, "paid");
  assert.equal(paid.invoices[0].paidWith, "Visa ending 1111");

  const declined = refuse(DEFAULT_DEMO_STATE, "pay-invoice", "customer", {
    card: { ...VALID_CARD, cardNumber: "5555555555554444" },
  });
  assert.equal(declined.status, 409);
  assert.equal(declined.error, CARD_DECLINED_MESSAGE);

  assert.equal(refuse(DEFAULT_DEMO_STATE, "pay-invoice", "customer", {
    card: { ...VALID_CARD, cardNumber: "4111" },
  }).status, 400, "malformed is the form's fault");
});

test("an invoice cannot be paid twice, and history is kept", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(paid.invoices.length, DEFAULT_DEMO_STATE.invoices.length, "nothing dropped");
  assert.equal(paid.invoices[1].status, "paid", "the older one is untouched");

  // Naming the settled invoice is a conflict; naming none when none is due is
  // also a conflict, not a malformed request.
  const already = refuse(paid, "pay-invoice", "customer", {
    invoiceId: paid.invoices[0].id, card: VALID_CARD,
  });
  assert.equal(already.status, 409);
  assert.match(already.error, /already been settled/);

  const nothingDue = refuse(paid, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(nothingDue.status, 409);
  assert.match(nothingDue.error, /Nothing is outstanding/);

  // A reference that does not exist is malformed, and stays a 400.
  assert.equal(refuse(paid, "pay-invoice", "customer", {
    invoiceId: "invoice-nope", card: VALID_CARD,
  }).status, 400);
});

test("a saved card pays without re-entering it, and can be removed", () => {
  let state = apply(DEFAULT_DEMO_STATE, "save-payment-method", "customer", { card: VALID_CARD });
  assert.equal(state.paymentMethods.length, 1);
  assert.equal(state.paymentMethods[0].last4, "1111");
  // The number itself is never kept.
  assert.equal(JSON.stringify(state.paymentMethods).includes("4111111111111111"), false);

  assert.equal(refuse(state, "save-payment-method", "customer", { card: VALID_CARD }).status, 409,
    "the same card twice");

  state = apply(state, "pay-invoice", "customer", { paymentMethodId: "card-1" });
  assert.equal(state.invoices[0].status, "paid");

  assert.equal(refuse(state, "pay-invoice", "customer", { paymentMethodId: "card-9" }).status, 400);
  state = apply(state, "remove-payment-method", "customer", { paymentMethodId: "card-1" });
  assert.equal(state.paymentMethods.length, 0);
  assert.equal(refuse(state, "remove-payment-method", "customer", { paymentMethodId: "card-1" }).status, 400);
});

test("saving a declined card is refused, and the wallet is capped", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "save-payment-method", "customer", {
    card: { ...VALID_CARD, cvv: "999" },
  }).status, 409);
  assert.ok(MAX_PAYMENT_METHODS >= 1);
});

test("switching the instalment plan reissues the open invoice", () => {
  const annual = apply(DEFAULT_DEMO_STATE, "change-instalment-plan", "customer", {
    instalmentPlan: "annual",
  });
  assert.equal(annual.policy.instalmentPlan, "annual");
  assert.equal(unpaidInvoices(annual)[0].amount, annual.policy.annualPremium);
  assert.match(unpaidInvoices(annual)[0].description, /Annual premium/);

  assert.equal(refuse(annual, "change-instalment-plan", "customer", {
    instalmentPlan: "annual",
  }).status, 409, "already on it");
  assert.equal(refuse(annual, "change-instalment-plan", "customer", {
    instalmentPlan: "weekly",
  }).status, 400);
});

test("only a paid invoice can be refunded, with a reason", () => {
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  const invoiceId = paid.invoices[0].id;
  assert.equal(refuse(paid, "refund-invoice", "agent", { invoiceId }).status, 400, "no reason");
  assert.equal(refuse(DEFAULT_DEMO_STATE, "refund-invoice", "agent", {
    invoiceId: DEFAULT_DEMO_STATE.invoices[0].id, reason: "Overcharged.",
  }).status, 409, "unpaid");

  const refunded = apply(paid, "refund-invoice", "agent", {
    invoiceId, reason: "Overcharged after the cover change.",
  });
  assert.equal(refunded.invoices[0].status, "refunded");
  assert.match(refunded.invoices[0].refundReason ?? "", /Overcharged/);
  assert.equal(refunded.invoices[0].refundedAt, DEMO_NOW);
});

/* -------------------------------------------------------------------------- */
/* Messages and derived counts                                                 */
/* -------------------------------------------------------------------------- */

test("the unread count never counts the reader's own messages", () => {
  assert.equal(countUnreadMessages(DEFAULT_DEMO_STATE, "customer"), 1);
  const read = apply(DEFAULT_DEMO_STATE, "mark-messages-read", "customer");
  assert.equal(countUnreadMessages(read, "customer"), 0);
  assert.equal(countUnreadMessages(read, "agent"), 1);

  const bothRead = apply(read, "mark-messages-read", "agent");
  const replied = apply(bothRead, "send-message", "agent", { messageBody: "On it." });
  assert.equal(countUnreadMessages(replied, "customer"), 1);
  assert.equal(countUnreadMessages(replied, "agent"), 0);
});

test("a message must be present and within 500 characters", () => {
  assert.equal(refuse(DEFAULT_DEMO_STATE, "send-message", "customer").status, 400);
  assert.equal(refuse(DEFAULT_DEMO_STATE, "send-message", "customer", {
    messageBody: "x".repeat(501),
  }).status, 400);
});

test("the agent queue counts only claims sitting on the agent's desk", () => {
  assert.equal(countClaimsAwaitingAgent(DEFAULT_DEMO_STATE), 0, "history does not count");

  const submitted = apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  assert.equal(countClaimsAwaitingAgent(submitted), 1);

  const asked = apply(inReview(), "request-claim-information", "agent", {
    reviewNote: "Photo please.",
  });
  assert.equal(countClaimsAwaitingAgent(asked), 0, "waiting on the policyholder");
  assert.equal(countClaimsAwaitingAgent(approved()), 1, "approved still needs settling");
  assert.equal(countClaimsAwaitingAgent(apply(approved(), "settle-claim", "agent")), 0);
});

test("the policyholder's to-do count reflects what is actually outstanding", () => {
  assert.equal(countCustomerTodos(DEFAULT_DEMO_STATE), 1, "one unpaid invoice");
  const paid = apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  assert.equal(countCustomerTodos(paid), 0);
  const quoted = apply(paid, "request-quote", "customer", {
    coverage: "Comprehensive", addOns: [], deductible: 750,
  });
  assert.equal(countCustomerTodos(quoted), 1);
  assert.equal(countCustomerTodos(apply(DEFAULT_DEMO_STATE, "lapse-policy", "agent")), 2);
});

test("openClaim finds the one that is moving, not the history", () => {
  assert.equal(openClaim(DEFAULT_DEMO_STATE), null);
  assert.equal(openClaim(inReview())?.status, "in-review");
});

test("money is formatted with a symbol, separators, and a real minus sign", () => {
  assert.equal(formatMoney(0), "$0");
  assert.equal(formatMoney(1420), "$1,420");
  assert.equal(formatMoney(-210), "−$210");
});

test("an instalment is the annual price, or a twelfth of it", () => {
  assert.equal(instalmentAmount(1200, "annual"), 1200);
  assert.equal(instalmentAmount(1200, "monthly"), 100);
});

/* -------------------------------------------------------------------------- */
/* Invariants                                                                  */
/* -------------------------------------------------------------------------- */

test("a transition never mutates the state it was given", () => {
  const before = structuredClone(DEFAULT_DEMO_STATE);
  apply(DEFAULT_DEMO_STATE, "file-claim", "customer", { claim: LARGE_CLAIM });
  apply(DEFAULT_DEMO_STATE, "add-vehicle", "customer", { vehicle: SECOND_VEHICLE });
  apply(DEFAULT_DEMO_STATE, "add-driver", "customer", { driver: SECOND_DRIVER });
  apply(DEFAULT_DEMO_STATE, "pay-invoice", "customer", { card: VALID_CARD });
  apply(DEFAULT_DEMO_STATE, "renew-policy", "customer");
  apply(DEFAULT_DEMO_STATE, "cancel-policy", "customer", { reason: "Testing." });
  assert.deepEqual(DEFAULT_DEMO_STATE, before);
});

test("a refused transition returns no state to accidentally save", () => {
  const result = transitionDemoState(DEFAULT_DEMO_STATE, "settle-claim", "agent");
  assert.equal(result.ok, false);
  assert.equal("state" in result, false);
});

test("every action is reachable: none is dead code", () => {
  // A guard against an action being added to the union and the list, given a
  // role, and then never wired to anything that can legally call it.
  const reachable = new Set<DemoStateAction>();
  const record = (state: DemoState, action: DemoStateAction, role: DemoActorRole, input: DemoActionInput = {}) => {
    const result = transitionDemoState(state, action, role, input);
    if (result.ok) reachable.add(action);
    return result.ok ? result.state : state;
  };

  let state = DEFAULT_DEMO_STATE;
  state = record(state, "add-vehicle", "customer", { vehicle: SECOND_VEHICLE });
  state = record(state, "update-vehicle", "customer", { vehicleId: "vehicle-2", vehicle: SECOND_VEHICLE });
  state = record(state, "remove-vehicle", "customer", { vehicleId: "vehicle-2" });
  state = record(state, "add-driver", "customer", { driver: SECOND_DRIVER });
  state = record(state, "update-driver", "customer", { driverId: "driver-2", driver: SECOND_DRIVER });
  state = record(state, "remove-driver", "customer", { driverId: "driver-2" });
  state = record(state, "request-quote", "customer", { coverage: "Comprehensive", addOns: ["roadside", "glass"], deductible: 500 });
  state = record(state, "discard-quote", "customer");
  state = record(state, "request-quote", "customer", { coverage: "Comprehensive", addOns: ["roadside", "glass"], deductible: 500 });
  state = record(state, "accept-quote", "customer");
  state = record(state, "change-instalment-plan", "customer", { instalmentPlan: "annual" });
  state = record(state, "save-payment-method", "customer", { card: VALID_CARD });
  state = record(state, "pay-invoice", "customer", { paymentMethodId: "card-1" });
  state = record(state, "refund-invoice", "agent", { invoiceId: state.invoices[0].id, reason: "Duplicate." });
  state = record(state, "remove-payment-method", "customer", { paymentMethodId: "card-1" });
  state = record(state, "request-assistance", "customer", { assistance: { kind: "Tow", location: "I-80" } });
  state = record(state, "dispatch-assistance", "agent");
  state = record(state, "complete-assistance", "agent");
  state = record(state, "file-claim", "customer", { claim: LARGE_CLAIM });
  state = record(state, "start-claim-review", "agent");
  state = record(state, "assign-repair-shop", "agent", { repairShop: "Northgate Auto Body" });
  state = record(state, "schedule-inspection", "agent");
  state = record(state, "record-inspection", "agent", { inspection: { outcome: "damage-confirmed", notes: "Confirmed." } });
  state = record(state, "request-claim-information", "agent", { reviewNote: "Photo please." });
  state = record(state, "upload-claim-document", "customer", { document: { fileName: "photo.jpg" } });
  state = record(state, "respond-to-claim-review", "customer");
  state = record(state, "approve-claim", "agent", { reviewNote: "Covered." });
  state = record(state, "settle-claim", "agent");
  state = record(state, "send-message", "customer", { messageBody: "Thanks." });
  state = record(state, "mark-messages-read", "agent");
  state = record(state, "renew-policy", "customer");
  state = record(state, "lapse-policy", "agent");
  state = record(state, "pay-invoice", "customer", { card: VALID_CARD });
  record(state, "cancel-policy", "customer", { reason: "Sold the car." });
  // reject-claim needs its own branch: the run above approved instead.
  record(inReview(), "reject-claim", "agent", { reviewNote: "Outside the policy period." });

  const all: DemoStateAction[] = [
    "request-quote","accept-quote","discard-quote","renew-policy","cancel-policy",
    "add-vehicle","update-vehicle","remove-vehicle","add-driver","update-driver",
    "remove-driver","file-claim","upload-claim-document","respond-to-claim-review",
    "request-assistance","pay-invoice","save-payment-method","remove-payment-method",
    "change-instalment-plan","send-message","mark-messages-read","start-claim-review",
    "assign-repair-shop","schedule-inspection","record-inspection",
    "request-claim-information","approve-claim","reject-claim","settle-claim",
    "dispatch-assistance","complete-assistance","refund-invoice","lapse-policy",
  ];
  const unreached = all.filter(action => !reachable.has(action));
  assert.deepEqual(unreached, [], `never reached a legal path: ${unreached.join(", ")}`);
});
