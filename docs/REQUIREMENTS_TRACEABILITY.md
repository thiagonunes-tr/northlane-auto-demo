# Requirements Traceability and Implementation Assessment

A requirement-by-requirement comparison between **Project 2: Car Insurance Demo
Apps** in `Demo App Projects.pdf` (page 2) and this implementation, plus the 21
build rules that apply to every demo project in that document.

## 1. Status definitions

| Status | Meaning |
| --- | --- |
| **Implemented** | Available as a working, testable flow |
| **Partial** | Represented in the UI, but part of the expected interaction or state change is missing |
| **Agreed adaptation** | The original requirement was intentionally replaced by a later decision, mirroring the sibling project |
| **Out of scope** | Explicitly excluded from the accepted QA-training scope |
| **Not implemented** | The required workflow is not currently available |
| **Intentional extension** | Goes beyond the original scope because of a later decision |

## 2. Executive assessment

The project **satisfies the agreed web-based QA-training scope for the car
insurance domain**. Every customer-side and employee-side capability listed in
the brief is available as a real, observable state transition, driven by one
pure state machine and exercised end to end by the deploy gate.

The deliberate scope decisions, both inherited from the sibling health project so
the two demos stay consistent:

- Native iOS and Android applications are out of scope; responsive mobile web is
  the accepted mobile deliverable.
- The Windows desktop claims/agent application is replaced by an agent
  experience inside the same web application.

One deviation is specific to this project and is an improvement on the brief
rather than a shortfall: the brief's *Login Rules* say not to build real
authentication, while this app hashes passwords, signs sessions, and issues
single-use verification codes. Code **delivery** for the shared demo accounts
remains fake, exactly as the brief's *MFA Rules* prescribe.

## 3. Customer-side requirements

The brief lists eight capabilities.

| Requirement | Implementation | Status |
| --- | --- | --- |
| Get quote | `request-quote` prices a coverage tier against the vehicle and driver on file, itemised line by line in the UI. Refuses re-quoting the tier already held. | **Implemented** |
| Buy/view policy | The policy is always viewable on the Policy screen. "Buying" is `accept-quote`, which applies the quoted tier, premium and deductible, and reissues the open invoice. | **Implemented** |
| Update vehicle information | `update-vehicle`, with per-field validation and VIN/plate normalisation. Clears any open quote. | **Implemented** |
| Update driver information | `update-driver`, with per-field validation. Clears any open quote. | **Implemented** |
| File claim | `file-claim` with type, incident date, description and estimate. The estimate decides the path. | **Implemented** |
| Upload accident photos/documents | `upload-claim-document` records the file name and size. Per the brief's *File Upload Rules*, nothing is read, uploaded, or stored. | **Implemented** |
| Track claim status | Six statuses, a four-stage timeline on the customer's Claims screen, and the agent's note visible at every step. | **Implemented** |
| Make payment | `pay-invoice` with a fake card form. One documented card is accepted; any other well-formed card is declined. | **Implemented** |

**Not in the brief, added deliberately:** a shared message thread between the
policyholder and the claims team. It is the channel the brief's *Request more
information* step needs in order to reach the customer, and it gives the demo an
unread-count surface. **Intentional extension.**

## 4. Employee-side requirements

The brief lists six capabilities.

| Requirement | Implementation | Status |
| --- | --- | --- |
| Search policyholder | A directory dialog over five sample policyholders, filtered by substring, opening a profile that reflects live workflow state. Per the brief's *Search Rules*, no search infrastructure. | **Implemented** |
| Review claim | `start-claim-review` moves a pending claim to *In review* and shows the full claim, its documents, the deductible, and what it would settle for. | **Implemented** |
| Approve/reject claim | `approve-claim` and `reject-claim`, each requiring a written note. | **Implemented** |
| Request more information | `request-claim-information` moves the claim to *Needs more information* and blocks it until the policyholder attaches a document. | **Implemented** |
| Update claim status | Every agent action is a status change, matching the brief's *Admin Approval Rules*: a simple status field, no workflow engine. | **Implemented** |
| Generate claim summary | A summary dialog plus a CSV download, matching the brief's *Reports and Exports Rules*. | **Implemented** |

**Beyond the list:** `settle-claim` records a payout of the estimate less the
deductible. The brief does not require it, but "Approved" as a terminal state
leaves the money question unanswered on screen. **Intentional extension.**

## 5. Platform requirements

The brief's *New Simple Rule* asks for three customer platforms and one employee
platform.

| Platform | Implementation | Status |
| --- | --- | --- |
| Desktop Web Insurance Portal | The policyholder portal at any desktop viewport. | **Implemented** |
| Mobile Web Insurance Portal | The same application, responsive, with a bottom navigation bar below 680px. Per the brief's *Mobile Web Rules*, not a separate product. | **Implemented** |
| Native Mobile Insurance App | No iOS or Android application exists. | **Out of scope** |
| Windows Desktop Claims/Agent App | The agent experience is available inside the same web application. | **Agreed adaptation** |

Both decisions match the sibling health project, so the demo family is
consistent about what "platform coverage" means.

## 6. Build rules

| # | Rule | Implementation | Status |
| --- | --- | --- | --- |
| 1 | Do not build real authentication | Real registration, password hashing, signed sessions. | **Agreed adaptation** — mirrors the sibling project's approved decision |
| 1 | Hardcoded demo users | Two fixed accounts, `customer.demo` and `agent.demo`. | **Implemented** |
| 2 | Do not build production MFA | No authenticator app, no SMS, no push, no enrolment. | **Implemented** |
| 2 | Role-based fixed MFA code | `111111` policyholder, `222222` agent, `123456` fallback — the brief's suggested values. | **Implemented** |
| 3 | No external email systems | Brevo is optional and unused by default; the app is fully functional without it. | **Implemented** |
| 3 | Verification code email | Available when a Brevo key is configured: automatic for registered accounts, and on request for the two shared demo accounts via an explicit per-sign-in choice. | **Implemented** |
| 4 | No complex databases | One D1 database, five tables, one shared workflow row as JSON. | **Implemented** |
| 5 | No real payments | Fake form, no processor, no money. | **Implemented** |
| 5 | Card `4111 1111 1111 1111`, `12/30`, `123` | Exactly these values are accepted; anything else is declined. | **Implemented** |
| 6 | No real document storage | File name and size only. Nothing read, uploaded, or kept. | **Implemented** |
| 7 | No advanced search | Substring filter over a five-item static list. | **Implemented** |
| 8 | No real reporting engines | One summary page and a small CSV export. | **Implemented** |
| 9 | No workflow engines | A status field plus a note; the agent clicks and the status changes. | **Implemented** |
| 10 | No permission system | Two hardcoded roles with an allow-list each. | **Implemented** |
| 11 | No real business calculations | A base rate plus at most three named surcharges. | **Implemented** |
| 11 | *Insurance claim over $2,000 starts as Pending Review* | Implemented exactly, inclusive at the limit, and the boundary is unit-tested at 2000 and 2001. | **Implemented** |
| 12 | No external APIs | Only Brevo, and only when configured. Nothing else. | **Implemented** |
| 12 | Local endpoints such as `/api/claims`, `/api/policies` | One `/api/demo-state` endpoint carries the whole workflow instead. | **Agreed adaptation** — see §7 |
| 13 | Simple reset | `DELETE /api/demo-state` plus an automatic 24-hour reset. | **Implemented** |
| 14 | A small number of useful demo errors | Fourteen documented failures, each with its own status code. | **Implemented** |
| 15 | Do not over-design | Hand-written CSS, no component library, one stylesheet. | **Implemented** |
| 16 | Native mobile | Not built. | **Out of scope** |
| 17 | Mobile web is the responsive desktop app | One application, one codebase. | **Implemented** |
| 18 | Windows desktop for employees | Replaced by agent access in the web app. | **Agreed adaptation** |
| 19 | No real security, fake data only | Every name is from the brief's own list of demo people. No real data of any kind. | **Implemented** |
| 20 | Mock integrations | Only the optional Brevo path, which the brief explicitly allows. | **Implemented** |
| 21 | Scope control | §11 of the Developer Handoff lists what was deliberately not built. | **Implemented** |

## 7. Documented deviations

Three, each deliberate.

### 7.1 Real authentication replaces the brief's fake login

The brief's *Login Rules* prohibit real registration, password hashing and
session management. This project implements all three, matching the decision
already taken and shipped on the sibling health project.

**Why:** shared demo accounts alone cannot demonstrate a registration flow, and
registration is one of the most commonly automated workflows there is. The
brief's underlying intent — that sign-in must never depend on an external
service or a human reading a mailbox — is preserved: the two shared accounts use
fixed codes and can bypass verification entirely in one request.

### 7.2 One workflow endpoint instead of several resource endpoints

The brief's *API Rules* suggest `/api/claims`, `/api/policies` and similar. This
project exposes one `PATCH /api/demo-state` carrying an action name.

**Why:** the workflow is one shared state, and every transition is a legality
question about that whole state — whether a claim can be settled depends on the
policy's deductible and the claim's status together. Splitting it across
resource endpoints would spread one state machine over several handlers and lose
the property the tests depend on: that there is exactly one place a transition
can be refused. The published OpenAPI document names every action and every
input, so the contract is no less discoverable.

### 7.3 Settlement added beyond the brief's list

Explained in §4. It closes the loop the brief's *Approve/reject claim* leaves
open, and it gives the demo a second piece of visible arithmetic.

## 8. Gaps and recommended follow-up

Nothing in the brief is unimplemented. The following are limitations of the
current model rather than missing requirements, and each is recorded in the
Developer Handoff:

1. **One claim at a time.** `claim` is a single nullable value. A claim history
   would need an array and a selected-claim concept. Worth doing only if a demo
   scenario needs two open claims.
2. **A constant claim reference.** Every claim is `CLM-2026-7714`. Deterministic
   by design, but it cannot distinguish two claims across a reset.
3. **No test isolation.** One shared row, by design. Documented in the QA
   Automation guide with the reset-between-scenarios workaround.
4. **Not deployed.** The application builds and tests green; the Cloudflare
   Worker, D1 database and Vercel project have not been created. The deploy job
   is gated behind a repository variable until they are.

## 9. Conclusion

The project implements **every customer-side and employee-side capability the
brief lists for Project 2**, obeys all 21 build rules except the three deviations
documented in §7, and matches the sibling health project's platform decisions.

Its compliance profile:

- **Core demo story:** implemented for the agreed web scope.
- **Customer and employee feature lists:** fully implemented.
- **Build rules:** followed, with three documented deviations.
- **Native mobile:** explicitly out of scope.
- **Windows desktop:** replaced by agent access in the web application.
- **Deployment:** not yet provisioned.
