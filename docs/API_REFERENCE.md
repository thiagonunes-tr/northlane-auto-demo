# API Reference

Every endpoint of the Northlane Auto demo, with the payloads it accepts, the
status codes it returns, and a runnable `curl` for each.

The interactive version of this contract is at `/api-docs`; its source is
[`public/openapi.json`](../public/openapi.json). Two unit tests compare that
document against the TypeScript source, so anything documented here that has
drifted will fail `npm test`.

Set a base URL first:

```bash
BASE=http://localhost:3000     # or the deployed origin
```

## Status codes carry meaning

The demo uses three refusal codes deliberately, and the tests assert on them:

| Code | Means | Example |
| --- | --- | --- |
| `400` | The request is malformed | An estimate that is not a whole number |
| `403` | The signed-in role may never do this | A policyholder approving their own claim |
| `409` | The request is fine; the state is not ready | Settling a claim that is not approved |

A `409` is the interesting one for automation: it is the only code that depends
on the order of operations rather than on the request itself.

---

## Authentication

### `POST /api/auth/login`

Signs in directly, or opens a two-step verification challenge.

| Field | Type | Notes |
| --- | --- | --- |
| `email` | string | Required |
| `password` | string | Required; at least 8 characters when registering |
| `role` | `"customer"` \| `"agent"` | Optional; must match an existing account |
| `skipMfa` | boolean | Fixed demo accounts only; anything else gets `403` |

An email matching no account is treated as a registration. The account is only
persisted once the verification code is accepted.

**Single-call sign-in** (the fastest path for automation):

```bash
curl -s -c cookies.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer.demo@testrigor-mail.com","password":"CustomerDemo!2026","role":"customer","skipMfa":true}'
```

```json
{ "user": { "email": "customer.demo@testrigor-mail.com", "name": "Alex Carter", "role": "customer" } }
```

**Opening a challenge instead:**

```bash
curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer.demo@testrigor-mail.com","password":"CustomerDemo!2026","role":"customer"}'
```

```json
{
  "challengeId": "3f6c9a1e-0d2b-4b6f-9f3c-2a1b7d8e5c40",
  "destination": "cus••••••••••@testrigor-mail.com",
  "expiresInSeconds": 600,
  "codeDelivery": "fixed"
}
```

`codeDelivery` tells a client which second step to render:

| Value | Meaning | Code to use |
| --- | --- | --- |
| `fixed` | No email was sent | `111111` (policyholder), `222222` (agent), `123456` (any other account when no mail provider is configured) |
| `email` | A real message was delivered | Read it from the mailbox |

Rate limiting (60-second cooldown, 5 per hour) applies **only** when
`codeDelivery` is `email`. A fixed code sends no mail, so throttling it would
only slow a test suite down.

| Status | Cause |
| --- | --- |
| `400` | Malformed body, or a new account with a password under 8 characters |
| `401` | Wrong password, or a role that does not match the account |
| `403` | `skipMfa` on an account that is not a fixed demo account |
| `429` | Cooldown or hourly limit, email delivery only |
| `502` | The challenge could not be created or the email could not be sent |

### `POST /api/auth/verify`

Exchanges a code for a session. A code is single-use, expires after 10 minutes,
and locks the challenge after 5 wrong attempts.

```bash
curl -s -c cookies.txt -X POST "$BASE/api/auth/verify" \
  -H 'Content-Type: application/json' \
  -d '{"challengeId":"<id>","code":"111111"}'
```

| Status | Cause |
| --- | --- |
| `400` | Missing `challengeId`, or a code that is not six digits |
| `401` | Wrong code. The message names how many attempts remain |
| `409` | The code was already used |
| `410` | The challenge expired, was consumed, or does not exist |
| `429` | Five wrong attempts; request a new code |

### `GET /api/auth/session`

```bash
curl -s -b cookies.txt "$BASE/api/auth/session"
```

Answers `{"user": null}` rather than `401` when there is no session, so a client
can render the sign-in screen without treating it as an error.

### `POST /api/auth/logout`

Clears the cookie. Always `200`, session or not.

```bash
curl -s -b cookies.txt -X POST "$BASE/api/auth/logout"
```

### `DELETE /api/auth/account`

Deletes the signed-in account, its pending registrations, and its challenges.
The shared workflow state is never touched.

```bash
curl -s -b cookies.txt -X DELETE "$BASE/api/auth/account" \
  -H 'Content-Type: application/json' \
  -d '{"password":"MyDemoPassword1","confirmation":"DELETE"}'
```

| Status | Cause |
| --- | --- |
| `400` | `confirmation` is not the literal string `DELETE` |
| `401` | No session, or the password is wrong |
| `403` | A fixed demo account. They are protected so shared credentials keep working |
| `404` | No stored user to delete |

---

## Demo state

One row, shared by every session in the environment. It resets itself every 24
hours, and `DELETE` resets it on demand.

### `GET /api/demo-state`

```bash
curl -s -b cookies.txt "$BASE/api/demo-state"
```

```json
{
  "state": {
    "policy":  { "number": "NL-2026-004821", "coverage": "Standard", "annualPremium": 980,
                 "deductible": 750, "effectiveFrom": "February 1, 2026",
                 "renewsOn": "February 1, 2027", "updatedAt": "Initial demo record" },
    "vehicle": { "year": "2019", "make": "Honda", "model": "Civic LX",
                 "vin": "1HGBH41JXMN109186", "plate": "8KTR429",
                 "primaryUse": "Commute", "updatedAt": "Initial demo record" },
    "driver":  { "fullName": "Alex Carter", "licenseNumber": "C0482-9915-3320",
                 "licenseState": "California", "yearsLicensed": "11",
                 "updatedAt": "Initial demo record" },
    "quote": null,
    "claim": null,
    "invoice": { "id": "invoice-jul", "description": "Monthly premium · July 2026",
                 "amount": 82, "dueOn": "August 5, 2026", "status": "unpaid",
                 "paidWith": null, "paidAt": null },
    "messages": [ { "id": "message-1", "sender": "agent", "body": "…", "sentAt": "Jul 24 · 9:10 AM" } ],
    "lastRead": { "customer": null, "agent": null }
  }
}
```

Money is always a whole number of US dollars. Timestamps are fixed literals, not
a real clock, so a test can assert on the exact string it will get.

### `PATCH /api/demo-state`

The single write endpoint. Body is `{ "action": … }` plus whatever that action
needs. Fields irrelevant to the action are ignored.

#### Policyholder actions

| Action | Extra fields | Refuses when |
| --- | --- | --- |
| `request-quote` | `coverage` | `400` unknown tier · `409` already on that tier |
| `accept-quote` | — | `409` no quote on the table |
| `discard-quote` | — | `409` no quote on the table |
| `update-vehicle` | `vehicle` | `400` any field missing or malformed |
| `update-driver` | `driver` | `400` any field missing or malformed |
| `file-claim` | `claim` | `400` malformed · `409` a claim is still open |
| `upload-claim-document` | `document` | `400` no file name · `409` no claim, or it is closed |
| `respond-to-claim-review` | — | `409` not awaiting information, or nothing attached |
| `pay-invoice` | `card` | `400` malformed card · `409` declined, or already paid |
| `send-message` | `messageBody` | `400` empty or over 500 characters |
| `mark-messages-read` | — | never |

#### Claims agent actions

| Action | Extra fields | Refuses when |
| --- | --- | --- |
| `start-claim-review` | — | `409` the claim is not pending review |
| `request-claim-information` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `approve-claim` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `reject-claim` | `reviewNote` | `400` no note · `409` the claim is not in review |
| `settle-claim` | — | `409` the claim is not approved |
| `send-message` | `messageBody` | `400` empty or over 500 characters |
| `mark-messages-read` | — | never |

Any action outside the signed-in role's list is `403`, regardless of state.

#### Request the fast-track path

An estimate at or under `$2,000` is approved on arrival:

```bash
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" \
  -H 'Content-Type: application/json' \
  -d '{"action":"file-claim","claim":{"type":"Glass","incidentDate":"2026-07-18","description":"Stone chip in the windscreen.","estimatedAmount":640}}'
```

The resulting claim has `"status": "approved"` and `"autoApproved": true`.

#### Request the review path

One dollar more sends it to an agent:

```bash
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" \
  -H 'Content-Type: application/json' \
  -d '{"action":"file-claim","claim":{"type":"Collision","incidentDate":"2026-07-18","description":"Rear-ended at a junction.","estimatedAmount":2001}}'
```

`"status": "submitted"`, `"autoApproved": false`, `"reviewNote": null`.

#### Payment, both outcomes

```bash
# accepted
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" \
  -H 'Content-Type: application/json' \
  -d '{"action":"pay-invoice","card":{"nameOnCard":"Alex Carter","cardNumber":"4111111111111111","expiry":"12/30","cvv":"123"}}'

# declined — 409
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" \
  -H 'Content-Type: application/json' \
  -d '{"action":"pay-invoice","card":{"nameOnCard":"Alex Carter","cardNumber":"5555555555554444","expiry":"01/29","cvv":"999"}}'
```

Spaces and hyphens in `cardNumber` are tolerated. A card that is not 16 digits,
an expiry that is not `MM/YY`, or a CVV that is not 3 digits is `400` — the form
is wrong, not the card.

#### Attaching a document

```bash
curl -s -b cookies.txt -X PATCH "$BASE/api/demo-state" \
  -H 'Content-Type: application/json' \
  -d '{"action":"upload-claim-document","document":{"fileName":"accident-photo.jpg","sizeLabel":"1.4 MB"}}'
```

No file is transmitted. `sizeLabel` is optional and defaults to
`"unknown size"`. This is deliberate: the workflow only has to prove it accepted
a file and reacted.

### `DELETE /api/demo-state`

Restores the seed state. Fixed demo accounts only.

```bash
curl -s -b cookies.txt -X DELETE "$BASE/api/demo-state"
```

| Status | Cause |
| --- | --- |
| `401` | No session |
| `403` | A self-created account. Only fixed demo accounts may reset the shared environment |

---

## Business rules in one table

| Rule | Value | Where |
| --- | --- | --- |
| Fast-track claim limit | `$2,000`, inclusive | `FAST_TRACK_CLAIM_LIMIT` |
| Maximum claim estimate | `$100,000` | `MAX_CLAIM_ESTIMATE` |
| Base premium | Liability `$640`, Standard `$980`, Comprehensive `$1,420` | `COVERAGE_BASE_PREMIUM` |
| Deductible | Liability `$1,000`, Standard `$750`, Comprehensive `$500` | `COVERAGE_DEDUCTIBLE` |
| Older-vehicle surcharge | `+$120` for model year 2016 or earlier | `OLDER_VEHICLE_SURCHARGE` |
| New-driver surcharge | `+$260` for fewer than 3 years licensed | `NEW_DRIVER_SURCHARGE` |
| Business-use surcharge | `+$180` | `BUSINESS_USE_SURCHARGE` |
| Monthly premium | `round(annual / 12)` | `priceQuote` |
| Settlement | `max(0, estimate − deductible)` | `settlementFor` |
| Accepted card | `4111111111111111`, `12/30`, `123` | `verifyCard` |
| Session lifetime | 8 hours | `SESSION_TTL_SECONDS` |
| Verification code lifetime | 10 minutes, 5 attempts | `MFA_TTL_MS`, `MAX_MFA_ATTEMPTS` |
| Environment reset | Every 24 hours | `RESET_INTERVAL_MS` |

All of these live in [`lib/demo-state.ts`](../lib/demo-state.ts) except the
session and code policies, which are in `lib/auth.ts` and `lib/mfa-policy.ts`.
