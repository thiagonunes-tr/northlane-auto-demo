# API Reference

Every endpoint of the Northlane Auto demo, with the payloads it accepts, the
status codes it returns, and a runnable `curl` for each.

The interactive version of this contract is at `/api-docs`; its source is
[`public/openapi.json`](../public/openapi.json). Three unit tests compare that
document against the TypeScript source, so anything documented here that has
drifted will fail `npm test`.

```bash
BASE=https://northlane-auto-demo.thiago-nunes-5e0.workers.dev   # the Worker, single origin
# BASE=https://northlane-auto-demo.vercel.app                    # the Vercel frontend, proxies /api
# BASE=http://localhost:3000                                     # local dev
```

## Status codes carry meaning

| Code | Means | Example |
| --- | --- | --- |
| `400` | The request is malformed | An estimate that is not a whole number |
| `403` | The signed-in role may never do this | A policyholder approving their own claim |
| `409` | The request is fine; the state is not ready | Settling a claim that is not approved |

**Everything malformed is rejected before anything stateful is judged.** A `400`
never depends on what the policy happens to look like, which is what makes "409
means the request was fine" a true statement rather than a hopeful one.

---

## Authentication

### `POST /api/auth/login`

| Field | Type | Notes |
| --- | --- | --- |
| `email` | string | Required |
| `password` | string | Required; at least 8 characters when registering |
| `role` | `"customer"` \| `"agent"` | Optional; must match an existing account |
| `skipMfa` | boolean | Shared demo accounts only; anything else gets `403` |

**Single-call sign-in** — the path automation should take:

```bash
curl -s -c cookies.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer.demo@testrigor-mail.com","password":"CustomerDemo!2026","role":"customer","skipMfa":true}'
```

Without `skipMfa`, a real six-digit code is emailed and the response is a
challenge (`challengeId`, masked `destination`, `expiresInSeconds`). There is no
printed or fixed code. Rate limited: one a minute, five an hour, per address.

| Status | Cause |
| --- | --- |
| `400` | Malformed body, or a new account with a password under 8 characters |
| `401` | Wrong password, or a role that does not match the account |
| `403` | `skipMfa` on an account that is not a shared demo account |
| `429` | Cooldown or hourly limit |
| `502` | No mail provider configured, or the message could not be sent |

### `POST /api/auth/verify`

Single-use, 10-minute lifetime, locks after 5 wrong attempts.

```bash
curl -s -c cookies.txt -X POST "$BASE/api/auth/verify" \
  -H 'Content-Type: application/json' \
  -d '{"challengeId":"<id>","code":"<the six digits from the email>"}'
```

`400` malformed · `401` wrong code · `409` already used · `410` expired or
unknown · `429` locked.

### `GET /api/auth/session` · `POST /api/auth/logout` · `DELETE /api/auth/account`

The session read answers `{"user": null}` rather than `401` when there is none.
Logout always succeeds. Account deletion needs
`{"password", "confirmation": "DELETE"}` and is refused for the two shared
accounts.

---

## Demo state

One row, shared by every session. It resets itself every 24 hours, and `DELETE`
resets it on demand.

### `GET /api/demo-state`

```bash
curl -s -b cookies.txt "$BASE/api/demo-state"
```

Ten top-level fields:

| Field | Shape | Notes |
| --- | --- | --- |
| `policy` | object | Always present. `status` is `active`, `lapsed` or `cancelled`. |
| `vehicles` | array, 1–4 | Each is rated separately. |
| `drivers` | array, 1–4 | Exactly one has `isPrimary: true` and cannot be removed. |
| `quote` | object \| null | A price on the table. `kind` is `endorsement` or `new-business`. |
| `claims` | array | Newest first. At most one is open at a time. |
| `assistance` | array | Roadside requests, newest first. |
| `invoices` | array, ≥1 | Newest first. `status` is `unpaid`, `paid` or `refunded`. |
| `paymentMethods` | array, 0–3 | Saved cards. The number itself is never stored. |
| `messages` | array | The shared thread. |
| `lastRead` | object | Per-role read markers. |

Money is always a whole number of US dollars. Timestamps are fixed literals, not
a clock, so a test can assert on the exact string it will get.

### `PATCH /api/demo-state`

The single write endpoint. Body is `{ "action": … }` plus whatever that action
needs. Fields irrelevant to the action are ignored.

#### Policyholder actions

| Action | Extra fields | Refuses when |
| --- | --- | --- |
| `request-quote` | `coverage`, `addOns`, `deductible` | `400` unknown tier / add-on / deductible · `409` the cover is unchanged |
| `accept-quote` | — | `409` no quote on the table |
| `discard-quote` | — | `409` no quote on the table |
| `renew-policy` | — | `409` cancelled, or lapsed with arrears |
| `cancel-policy` | `reason` | `400` no reason · `409` already cancelled, or a claim is open |
| `add-vehicle` | `vehicle` | `400` malformed · `409` not in force, at the cap, or duplicate VIN |
| `update-vehicle` | `vehicleId`, `vehicle` | `400` unknown id or malformed · `409` not in force, duplicate VIN |
| `remove-vehicle` | `vehicleId` | `400` unknown id · `409` not in force, or the last one |
| `add-driver` | `driver` | `400` malformed · `409` not in force, at the cap, duplicate licence |
| `update-driver` | `driverId`, `driver` | `400` unknown id or malformed · `409` not in force |
| `remove-driver` | `driverId` | `400` unknown id · `409` the policyholder, or the last one |
| `file-claim` | `claim` | `400` malformed · `409` not in force, or a claim is open |
| `upload-claim-document` | `document` | `400` no file name · `409` no open claim |
| `respond-to-claim-review` | — | `409` not awaiting information, or nothing attached |
| `request-assistance` | `assistance` | `400` malformed · `409` no roadside add-on, or one already open |
| `pay-invoice` | `invoiceId?`, and `card` **or** `paymentMethodId` | `400` unknown id or malformed card · `409` nothing due, already settled, or declined |
| `save-payment-method` | `card` | `400` malformed · `409` declined, duplicate, or at the cap |
| `remove-payment-method` | `paymentMethodId` | `400` unknown id |
| `change-instalment-plan` | `instalmentPlan` | `400` unknown plan · `409` already on it |
| `send-message` | `messageBody` | `400` empty or over 500 characters |
| `mark-messages-read` | — | never |

#### Claims agent actions

| Action | Extra fields | Refuses when |
| --- | --- | --- |
| `start-claim-review` | — | `409` the claim is not pending review |
| `assign-repair-shop` | `repairShop` | `400` unknown shop · `409` the claim is not in review |
| `schedule-inspection` | — | `409` not in review, or no repair shop assigned |
| `record-inspection` | `inspection` (`outcome`, `notes`) | `400` malformed · `409` no inspection scheduled |
| `request-claim-information` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `approve-claim` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `reject-claim` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `settle-claim` | — | `409` the claim is not approved |
| `dispatch-assistance` | — | `409` nothing waiting to be dispatched |
| `complete-assistance` | — | `409` nothing out for completion |
| `refund-invoice` | `invoiceId`, `reason` | `400` unknown id or no reason · `409` the invoice is not paid |
| `lapse-policy` | — | `409` not in force, or nothing overdue |
| `send-message`, `mark-messages-read` | — | as above |

Any action outside the signed-in role's list is `403`, regardless of state.

#### The rules worth exercising

**The fast-track boundary.** An estimate at or under `$2,000` is approved on
arrival; one dollar more goes to an agent.

```bash
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" -H 'Content-Type: application/json' \
  -d '{"action":"file-claim","claim":{"type":"Collision","incidentDate":"2026-07-18","description":"Rear-ended at a junction.","estimatedAmount":2001}}'
```

**Pricing.** Each vehicle earns its own line; one driver surcharge for the whole
policy; add-ons are flat; the deductible moves the price up or down; the
no-claims bonus comes off the subtotal. `quote.breakdown` always sums exactly to
`quote.annualPremium` — worth asserting, because a total nobody can decompose is
a total nobody should trust.

```bash
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" -H 'Content-Type: application/json' \
  -d '{"action":"request-quote","coverage":"Comprehensive","addOns":["roadside","glass"],"deductible":500}'
```

**The bonus is real money.** `settle-claim` sets `policy.noClaimsYears` to zero;
`renew-policy` adds one and reprices with it. Settle a claim and then renew, and
the premium is visibly higher than a claim-free renewal — the clearest cross-flow
in the demo.

**Glass cover waives the deductible** on a glass claim, and only on a glass
claim. It is the one place an add-on changes what a claim is worth.

**Payment, three outcomes.**

```bash
# accepted
-d '{"action":"pay-invoice","card":{"nameOnCard":"Alex Carter","cardNumber":"4111111111111111","expiry":"12/30","cvv":"123"}}'
# declined — 409
-d '{"action":"pay-invoice","card":{"nameOnCard":"Alex Carter","cardNumber":"5555555555554444","expiry":"01/29","cvv":"999"}}'
# a saved card, no re-entry
-d '{"action":"pay-invoice","paymentMethodId":"card-1"}'
```

**Lapse and reinstatement.** An agent can `lapse-policy` while a premium is
overdue. Paying every outstanding invoice puts cover straight back in force, and
nothing else does.

**The new-business funnel.** Cancel, then quote: the quote comes back with
`kind: "new-business"`, no bonus line, and accepting it issues a new policy
number with `noClaimsYears: 0`.

### `DELETE /api/demo-state`

Restores the seed state. Shared demo accounts only (`403` otherwise).

---

## Business rules in one table

| Rule | Value | Where |
| --- | --- | --- |
| Fast-track claim limit | `$2,000`, inclusive | `FAST_TRACK_CLAIM_LIMIT` |
| Maximum claim estimate | `$100,000` | `MAX_CLAIM_ESTIMATE` |
| Base premium, per vehicle | Liability `$640`, Standard `$980`, Comprehensive `$1,420` | `COVERAGE_BASE_PREMIUM` |
| Add-ons | Courtesy car `$120`, Roadside `$90`, Glass `$60`, Third-party plus `$150` | `ADD_ONS` |
| Deductible choices | `$250` (+180), `$500` (+80), `$750` (0), `$1,000` (−90) | `DEDUCTIBLE_ADJUSTMENT` |
| Older-vehicle surcharge | `+$120` per vehicle, model year 2016 or earlier | `OLDER_VEHICLE_SURCHARGE` |
| New-driver surcharge | `+$260` once, for fewer than 3 years licensed | `NEW_DRIVER_SURCHARGE` |
| Business-use surcharge | `+$180` per vehicle | `BUSINESS_USE_SURCHARGE` |
| No-claims bonus | 5% a year, capped at 25% | `NO_CLAIMS_DISCOUNT_PER_YEAR` |
| Settlement | `max(0, estimate − deductible)`; the deductible is 0 for a glass claim with glass cover | `settlementFor` |
| Vehicles / drivers / saved cards | 1–4 / 1–4 / 0–3 | `MAX_VEHICLES`, `MAX_DRIVERS`, `MAX_PAYMENT_METHODS` |
| Accepted card | `4111111111111111`, `12/30`, `123` | `verifyCard` |
| Session lifetime | 8 hours | `SESSION_TTL_SECONDS` |
| Code lifetime | 10 minutes, 5 attempts | `MFA_TTL_MS`, `MAX_MFA_ATTEMPTS` |
| Code requests | 1 per minute, 5 per hour, per address | `RESEND_COOLDOWN_MS`, `HOURLY_EMAIL_LIMIT` |
| Environment reset | Every 24 hours | `RESET_INTERVAL_MS` |

All of these live in [`lib/demo-state.ts`](../lib/demo-state.ts) except the
session and code policies, which are in `lib/auth.ts` and `lib/mfa-policy.ts`.
