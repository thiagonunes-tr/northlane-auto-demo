# QA Automation Guide

How to drive this application deterministically: the shortest path to a known
state, the scenarios worth automating, the failures that are supposed to happen,
and the parts that will bite you if you assume they behave like a real insurer.

## The one thing to know first

**The workflow state is a single row shared by every session in the
environment.** Two browsers signed in as different roles see the same policy,
the same claim, and the same invoices — that is the point, because it is what
makes a cross-role demo possible. It also means tests are not isolated from each
other by default.

Reset before every scenario:

```bash
curl -s -b cookies.txt -X DELETE "$BASE/api/demo-state"
```

The environment also resets itself every 24 hours. Do not rely on that.

## Deterministic setup

```bash
BASE=http://localhost:3000

curl -s -c customer.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer.demo@testrigor-mail.com","password":"CustomerDemo!2026","role":"customer","skipMfa":true}'

curl -s -c agent.txt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"agent.demo@testrigor-mail.com","password":"AgentDemo!2026","role":"agent","skipMfa":true}'

curl -s -b customer.txt -X DELETE "$BASE/api/demo-state"
```

Two cookie jars, one shared state. That is the whole harness.

### The seed state

It deliberately opens with history, so the list screens are not empty on first
sight:

| | |
| --- | --- |
| Policy | `NL-2026-004821`, active, Standard, `$750` deductible, no add-ons, monthly |
| No-claims bonus | 4 years → 20% |
| Vehicles | one, a 2019 Honda Civic LX |
| Drivers | one, Alex Carter, the policyholder |
| Claims | one **settled** glass claim from 2025. Nothing open. |
| Invoices | one unpaid (`$82`), one paid |
| Saved cards, assistance | none |

### Fixed values you can hardcode

Nothing depends on the wall clock or on a random number.

| Thing | Value |
| --- | --- |
| Accepted card | `4111 1111 1111 1111`, `12/30`, `123` |
| Seed policy number | `NL-2026-004821` |
| Policy number after new business | `NL-2026-005390` |
| Endorsement quote reference | `QT-2026-3390` |
| New-business quote reference | `QT-2026-4102` |
| First new claim reference | `CLM-2026-7715` |
| Any "just now" timestamp | `July 24, 2026 at 10:05 AM` |
| Any new message timestamp | `Jul 24 · Now` |
| Inspection slot | `July 28, 2026 at 11:00 AM` |

Claim references are derived from how many claims exist, so the *n*th claim you
file is `CLM-2026-{7714 + n}` counting the seed claim as one. Assert on
`claims[0]` rather than on the reference if you would rather not track that.

### Sign-in

`skipMfa: true` on either shared account. One request, no mailbox. The other
path emails a real code, is rate limited to five an hour per address, and cannot
complete without reading the mailbox — so leave it alone in a suite.

## Cross-role scenarios

### 1. The fast-track boundary

The single highest-value assertion in the app. One dollar changes the outcome.

| Estimate | Status | `autoApproved` | Agent involved |
| --- | --- | --- | --- |
| `2000` | `approved` | `true` | No |
| `2001` | `submitted` | `false` | Yes |

### 2. The full claim cycle, both roles

```
customer  file-claim (4200, with a third party) -> submitted
agent     start-claim-review                     -> in-review
agent     schedule-inspection                    -> 409, no repair shop yet
agent     assign-repair-shop                     -> shop recorded
agent     schedule-inspection                    -> inspection-scheduled
agent     approve-claim                          -> 409, it is out for inspection
agent     record-inspection (outcome + notes)    -> in-review
agent     request-claim-information (note)       -> more-info-needed
customer  respond-to-claim-review                -> 409, nothing attached
customer  upload-claim-document                  -> 1 document
customer  respond-to-claim-review                -> in-review
agent     approve-claim (note)                   -> approved
agent     settle-claim                           -> settled, and the bonus is gone
```

Settlement is `estimate − deductible`, floored at zero, using the deductible in
force **at settlement time**. `claim.settledDeductible` records which one was
applied, so history stays true after a later change.

### 3. The bonus, which is the most interesting cross-flow

```
renew-policy on the seed          -> noClaimsYears 5, premium DOWN
settle a claim, then renew        -> noClaimsYears 1, premium UP vs the above
```

Assert the *comparison*, not a fixed number: it is the relationship that is the
business rule.

### 4. Pricing that decomposes

```
request-quote Comprehensive + [roadside, glass] + 500 deductible
```

`sum(quote.breakdown[].amount) === quote.annualPremium`, always. Add a second
vehicle and a second line appears; add a driver with under 3 years and exactly
one surcharge line appears however many such drivers there are.

### 5. A quote invalidated by a details change

Any of `add-vehicle`, `update-vehicle`, `remove-vehicle`, `add-driver`,
`update-driver`, `remove-driver` clears an open quote. The price was calculated
against details no longer on file.

### 6. Lapse and reinstatement

```
agent     lapse-policy            -> 409 if nothing is overdue
agent     lapse-policy            -> lapsed
customer  add-vehicle / file-claim -> 409, the policy is not in force
customer  pay-invoice (all arrears) -> active again
```

### 7. The new-business funnel

```
customer  cancel-policy (reason)   -> cancelled
customer  request-quote            -> kind: "new-business", no bonus line
customer  accept-quote             -> a NEW policy number, noClaimsYears 0
```

### 8. Roadside, gated on the add-on

```
customer  request-assistance       -> 409 without the roadside add-on
(buy roadside via a quote)
customer  request-assistance       -> requested
agent     dispatch-assistance      -> dispatched, provider and ETA set
agent     complete-assistance      -> completed, a new one is allowed again
```

### 9. Billing history and refunds

Paying never removes an invoice — the list keeps everything. `accept-quote`,
`renew-policy` and `change-instalment-plan` each **reissue** the open invoice,
which reopens the balance even if you had just paid it. An agent can refund a
paid invoice with a reason.

### 10. Unread message counts

Read markers are per role and never count your own messages. Opening the
Messages screen marks the thread read as a side effect, so a UI test that
navigates there will clear the badge it may have been about to assert on.

## Expected failures

These are the app working. A suite that treats them as defects will be wrong; a
suite that never exercises them is not testing much.

| Provoke it with | Status |
| --- | --- |
| Card `5555 5555 5555 4444` | `409` declined |
| Card `4111` | `400` malformed |
| Re-quoting the exact cover already held | `409` |
| Second claim while one is open | `409` |
| `respond-to-claim-review` with no document | `409` |
| `schedule-inspection` with no repair shop | `409` |
| Any agent decision with no note | `400` |
| Deciding a claim that is out for inspection | `409` |
| `settle-claim` before approval | `409` |
| Removing the last vehicle, or the policyholder | `409` |
| A duplicate VIN or licence number | `409` |
| Any risk change on a cancelled or lapsed policy | `409` |
| Cancelling with an open claim | `409` |
| `lapse-policy` with nothing overdue | `409` |
| `request-assistance` without the add-on | `409` |
| A second open assistance request | `409` |
| `refund-invoice` on an unpaid invoice | `409` |
| Estimate `0`, `-100`, `1200.5`, `100001` | `400` |
| A third party with only some fields filled | `400` |
| Policyholder calling `approve-claim` | `403` |
| Agent calling `pay-invoice` | `403` |
| `skipMfa` on a self-created account | `403` |
| `DELETE /api/demo-state` as a self-created account | `403` |
| Requesting a code with no mail provider | `502` |
| The sixth code request in an hour | `429` |

**A browser logs a console error for every one of these.** A blanket "no console
errors" assertion will fail on the demo working correctly — filter by status, and
keep a separate `pageerror` listener so genuine JavaScript exceptions still fail.
[`tests/e2e/full_demo.py`](../tests/e2e/full_demo.py) does exactly that.

## Test isolation

There is none by default. In order of preference: reset between scenarios; run
scenarios serially; or create per-test accounts — which isolates *authentication*
only, since a self-created account still reads and writes the same shared row.

## Stable selectors

Hand-written CSS, no component library, so class names are stable and
meaningful. The E2E suite asserts on visible text and on these.

| What | Selector |
| --- | --- |
| Signed-in shell | `.app-shell` |
| Sidebar destination | `.nav-item` (contains the label text) |
| Unread badge | `.nav-badge` |
| Toast | `.toast`, `.toast.error` |
| Status chip | `.review-status`, `.review-status.pending`, `.review-status.declined` |
| Field-level error | `.field-error` |
| A row in any list | `.record-row` |
| Quote price lines | `.quote-breakdown`, `.quote-breakdown li.total` |
| Claim queue row | `.queue-row`, `.queue-row.highlighted` |
| Agent claim card | `.request-card`, `.request-card.highlighted` |
| Directory result rows | `.directory-results > button` |
| Any dialog | `[role="dialog"]` |

Four traps worth knowing, all of which cost a debugging cycle here:

- **`.record-row` is used by several lists on one screen.** Scope to the region:
  `[aria-label="Invoices"] .record-row`, `[aria-label="Closed claims"]
  .record-row`, and so on.
- **Playwright's `has_text` is a case-insensitive substring.** Filtering invoice
  rows on `"Paid"` also matches a row reading "Not yet paid". Match the status
  chip exactly instead.
- **Several buttons share a label with the dialog they open** — "Record the
  inspection", "Cancel this policy", "Request assistance". Use `.last` inside the
  dialog, or scope to the form.
- **An add-on's description can collide with a field label.** "Glass cover ·
  Windscreen and window repair with no deductible" makes `get_by_label
  ("Deductible")` ambiguous. Address the control: `select[name="deductible"]`.

Prefer roles and labels over classes where both work: every control has an
accessible name, and the accessibility audit in the deploy gate guarantees it.

## Timing

- **Toasts animate in over 300ms.** If you measure rendered colour or geometry,
  wait for `document.getAnimations()` to settle first.
- **Dialogs trap focus and close on Escape.** One holding unsaved input asks
  `window.confirm` before discarding, so a harness that auto-dismisses dialogs
  will silently fail to close it.
- **Every mutation is a single `PATCH` returning the whole new state.** No
  polling, no eventual consistency.

## Accessibility as a gate

`npm run test:e2e` fails the build on any violation of the rule set in
`AXE_RULES`, on any element that overlaps its neighbour, and on any contrast
below 4.5:1 — including on the gradient surfaces axe declines to judge, which
are measured directly by compositing every gradient stop. The Swagger console is
excluded: it is vendor DOM and its violations are not ours to fix.
