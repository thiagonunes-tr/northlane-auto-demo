# QA Automation Guide

How to drive this application deterministically: the shortest path to a known
state, the scenarios worth automating, the failures that are supposed to happen,
and the parts that will bite you if you assume they behave like a real insurer.

## The one thing to know first

**The workflow state is a single row shared by every session in the
environment.** Two browsers signed in as different roles see the same policy,
the same claim, and the same invoice — that is the point, because it is what
makes a cross-role demo possible. It also means tests are not isolated from each
other by default.

Reset to a known state before every scenario:

```bash
curl -s -b cookies.txt -X DELETE "$BASE/api/demo-state"
```

The environment also resets itself every 24 hours. Do not rely on that.

## Deterministic setup

```bash
BASE=http://localhost:3000

# One request, one session. No mailbox, no waiting.
curl -s -c customer.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer.demo@testrigor-mail.com","password":"CustomerDemo!2026","role":"customer","skipMfa":true}'

curl -s -c agent.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"agent.demo@testrigor-mail.com","password":"AgentDemo!2026","role":"agent","skipMfa":true}'

curl -s -b customer.txt -X DELETE "$BASE/api/demo-state"
```

Two cookie jars, one shared state. That is the whole harness.

### Fixed values you can hardcode

Nothing in this app depends on the wall clock or on a random number that a test
cannot predict.

| Thing | Value |
| --- | --- |
| Verification code, policyholder | `111111` |
| Verification code, agent | `222222` |
| Verification code, self-created account (no mail provider) | `123456` |
| Accepted card | `4111 1111 1111 1111`, `12/30`, `123` |
| Policy number | `NL-2026-004821` |
| Claim reference | `CLM-2026-7714` |
| Quote reference | `QT-2026-3390` |
| Any "just now" timestamp | `July 24, 2026 at 10:05 AM` |
| Any new message timestamp | `Jul 24 · Now` |

The claim reference is the same for every claim, including one filed after a
previous claim closed. This is deliberate — a reference a test can hardcode is
worth more here than a unique one — but it means you cannot use the reference to
tell two claims apart. Use `filedAt`, `estimatedAmount`, or `status`.

### Choosing how the code arrives

`POST /api/auth/login` accepts `deliverByEmail: true`, and the response's
`codeDelivery` field says what actually happened. Assert on that field rather
than on the screen: it is the only thing that distinguishes "email was never
requested" from "email was requested and no provider is configured".

| Account | `deliverByEmail` | Mail provider | `codeDelivery` |
| --- | --- | --- | --- |
| Shared demo | omitted | either | `fixed` |
| Shared demo | `true` | none | `fixed` |
| Shared demo | `true` | configured | `email` |
| Registered | either | none | `fixed` |
| Registered | either | configured | `email` |

A suite should leave `deliverByEmail` alone. The shared accounts then always
answer `fixed`, in every environment, which is what keeps the suite runnable
without a mailbox.

**Environments differ, so do not hardcode the outcome.** A local checkout and CI
have no mail provider and always answer `fixed`. The deployed environment has
one, so the same request there answers `email`. A test that asserts one of them
passes wherever it was written and fails everywhere else. Branch on the
`codeDelivery` field instead — `verify_email_delivery_choice` in
[`tests/e2e/full_demo.py`](../tests/e2e/full_demo.py) does, and asserts the pair
that holds everywhere: whatever the API reports, the screen matches it.

**The email branch is rate limited and the limit is easy to hit.** Sixty seconds
between codes and five per hour, per address, counting every challenge for that
address regardless of how it was delivered. Exercising the email path a handful
of times in a row will produce a `429`, which is the demo working. Reach for the
bypass or the printed code for anything repetitive.

## Cross-role scenarios

### 1. The fast-track boundary

The single highest-value assertion in the app. One dollar changes the outcome.

| Estimate | Resulting status | `autoApproved` | Agent involved |
| --- | --- | --- | --- |
| `2000` | `approved` | `true` | No |
| `2001` | `submitted` | `false` | Yes |

```bash
curl -s -b customer.txt -X PATCH "$BASE/api/demo-state" -H 'Content-Type: application/json' \
  -d '{"action":"file-claim","claim":{"type":"Glass","incidentDate":"2026-07-18","description":"Windscreen chip.","estimatedAmount":2000}}'
```

### 2. Full review cycle, both roles

```
customer  file-claim (4200)          -> submitted
agent     start-claim-review          -> in-review
agent     request-claim-information   -> more-info-needed   (note required)
customer  respond-to-claim-review     -> 409, nothing attached
customer  upload-claim-document       -> 1 document
customer  respond-to-claim-review     -> in-review
agent     approve-claim               -> approved           (note required)
agent     settle-claim                -> settled, 3450
```

`3450` assumes the seed Standard policy, whose deductible is `$750`. If the
scenario changed coverage first, the deductible changed with it — settlement uses
the deductible in force **at settlement time**, not at filing time.

### 3. Quote, accept, and the invoice it reissues

```
customer  request-quote Comprehensive -> quote 1420/yr, policy unchanged
customer  accept-quote                -> policy Comprehensive, deductible 500
                                         invoice reissued at 118, unpaid
```

Worth asserting: `accept-quote` **reopens a paid invoice**. Pay first, then
accept a quote, and `invoice.status` returns to `unpaid` with `paidWith` and
`paidAt` cleared. That is correct — the amount changed — and it surprises people.

### 4. A quote invalidated by a details change

```
customer  request-quote Liability     -> quote exists
customer  update-vehicle              -> quote is null
```

Same for `update-driver`. The price was calculated against details no longer on
file, so it is cleared rather than left stale.

### 5. Unread message counts

Read markers are per role and never count your own messages.

```
seed state                      customer unread 1, agent unread 1
customer mark-messages-read     customer unread 0, agent unread 1
agent    send-message           customer unread 1, agent unread 0
```

The badge in the sidebar renders this number. Opening the Messages screen marks
the thread read as a side effect, so a UI test that navigates to Messages will
clear the badge it may have been about to assert on.

## Expected failures

These are the app working. A test suite that treats them as defects will be
wrong; a suite that never exercises them is not testing much.

| Provoke it with | Status | Message contains |
| --- | --- | --- |
| Card `5555 5555 5555 4444` | `409` | `That card was declined` |
| Card `4111` | `400` | `Enter a 16-digit card number` |
| Verification code `999999` | `401` | `That code is incorrect. 4 attempts remaining.` |
| Five wrong codes | `429` | `Too many incorrect attempts` |
| Re-quoting the current tier | `409` | `already on Standard coverage` |
| Second claim while one is open | `409` | `has to be closed before you file another` |
| `respond-to-claim-review` with no document | `409` | `at least one document` |
| Agent decision with no note | `400` | `Write a note of up to 400 characters` |
| `settle-claim` before approval | `409` | `Only an approved claim can be settled` |
| Policyholder calling `approve-claim` | `403` | `Only a claims agent` |
| Agent calling `pay-invoice` | `403` | `Only the policyholder` |
| Estimate `0`, `-100`, `1200.5`, `100001` | `400` | `whole number of dollars` |
| `skipMfa` on a self-created account | `403` | `only be skipped for the fixed demo accounts` |
| `DELETE /api/demo-state` as a self-created account | `403` | `Only fixed demo accounts` |

**A browser will log a console error for every one of these.** Chrome reports
`Failed to load resource: the server responded with a status of 409` for any
non-2xx fetch. A blanket "no console errors" assertion will fail on the demo
working correctly — filter by status, and keep a separate `pageerror` listener
so genuine JavaScript exceptions still fail. The suite in
[`tests/e2e/full_demo.py`](../tests/e2e/full_demo.py) does exactly this.

## Test isolation

There is none by default. Options, in order of preference:

1. **Reset between scenarios.** `DELETE /api/demo-state`. Cheap and total.
2. **Run scenarios serially.** Two parallel workers sharing one claim will
   interleave and produce `409`s that look like defects.
3. **Create per-test accounts.** This isolates *authentication*, not workflow
   state — a self-created account still reads and writes the same shared row,
   and it cannot reset the environment. Its value is testing registration.

Registration itself is safe to parallelise: each account is independent, and
deleting one leaves the shared workflow untouched.

## Stable selectors

The UI is hand-written CSS with no component library, so class names are stable
and meaningful. The E2E suite asserts on visible text and on these classes, and
any UI change has to update it in the same commit.

| What | Selector |
| --- | --- |
| Signed-in shell | `.app-shell` |
| Sidebar destination | `.nav-item` (contains the label text) |
| Unread badge | `.nav-badge` |
| Toast | `.toast`, `.toast.error` |
| Status chip | `.review-status`, `.review-status.pending`, `.review-status.declined` |
| Field-level error | `.field-error` |
| Claim queue row | `.queue-row`, `.queue-row.highlighted` |
| Claim card for the agent | `.request-card`, `.request-card.highlighted` |
| Quote price lines | `.quote-breakdown`, `.quote-breakdown li.total` |
| Fixed verification code | `.fixed-code-note code` |
| Directory result rows | `.directory-results > button` |
| Any dialog | `[role="dialog"]` |

Prefer roles and labels over classes where both work: every control has an
accessible name, and the accessibility audit in the deploy gate guarantees it.

Two dialogs carry a close control with the accessible name **Close** — the
icon-only one in the corner and, on read-only dialogs, a labelled button at the
bottom. Scope to one, or you will hit a strict-mode violation. The toast also
has one.

## Timing

- **Waiting on a toast?** It animates in over 300ms. If you are measuring
  rendered colour or geometry, wait for `document.getAnimations()` to settle
  first, or you will sample a state nobody sees.
- **Waiting on a dialog?** They trap focus and close on Escape. A dialog holding
  unsaved input asks `window.confirm` before discarding — an automation harness
  that auto-dismisses dialogs will silently fail to close it.
- **Waiting on the API?** Every mutation is a single `PATCH` that returns the
  whole new state. There is no polling and no eventual consistency.

## Accessibility as a gate

`npm run test:e2e` fails the build on any violation of the rule set in
[`tests/e2e/full_demo.py`](../tests/e2e/full_demo.py) (`AXE_RULES`), on any
element that overlaps its neighbour, and on any contrast below 4.5:1 — including
on the gradient surfaces axe declines to judge, which are measured directly by
compositing every gradient stop.

The Swagger console is excluded: it is vendor DOM and its violations are not
ours to fix.
