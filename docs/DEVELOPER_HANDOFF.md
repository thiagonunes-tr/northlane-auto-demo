# Developer Handoff

Read this before changing authentication, persistence, the state machine, the
stylesheet, or the deploy configuration. It records the architecture, the
invariants that are not obvious from any single file, the known limitations, and
what is deliberately not built.

## 1. What this is

A fictional car insurance portal built to demonstrate test automation. It
implements **Project 2** of `Demo App Projects.pdf` and is a sibling of the Luma
Health demo: the same stack, the same design system, the same shape of state
machine, a different domain.

The governing rule from the brief, and the one to apply to every proposed
change: *build the smallest believable version of the system that lets a test
tool demonstrate the workflow.* Realistic from the outside, simple on the inside.

## 2. Layout

| Path | Holds |
| --- | --- |
| `lib/demo-state.ts` | The entire business domain as a pure state machine. No I/O. |
| `lib/mfa-db.ts` | D1 persistence, state hydration, the 24-hour reset. |
| `lib/auth.ts` | Accounts, password hashing, session signing, verification planning, Brevo. |
| `lib/mfa-policy.ts` | Code lifetime, attempt limits, resend cooldown. Pure. |
| `app/api/**` | Next-compatible route handlers. Thin: parse, delegate, map to a status. |
| `shared/NorthlaneApp.tsx` | The whole UI for both roles. |
| `shared/{Modal,Tooltip,Icon,ApiDocs}.tsx` | Shared primitives. |
| `app/globals.css` | Every style in the app, tokens first. |
| `public/openapi.json` | The published contract. Verified against the source by tests. |
| `tests/*.test.ts` | Business rules and contract drift. |
| `tests/e2e/full_demo.py` | The deploy gate: full story, both roles, accessibility. |
| `vercel-frontend/` | The second build target. Compiles the same `shared/` code. |

## 3. The state machine

`transitionDemoState(state, action, role, input)` is the only way the workflow
changes. It is pure: no network, no database, no React, no clock. Everything
else — routes, persistence, UI — is plumbing around it. That is what lets the
unit tests cover every rule without a running server.

Three properties hold and are asserted:

- **A transition never mutates its input.** Callers rely on this.
- **A refused transition returns no state.** The result type has no `state`
  field on the failure branch, so a caller cannot accidentally persist it.
- **Status codes are semantic.** `403` role, `400` malformed, `409` out of
  sequence. Tests assert on the code, not just on failure.

### The state

```ts
type DemoState = {
  policy: Policy;          // always present; the seed policy is already active
  vehicle: Vehicle;
  driver: Driver;
  quote: Quote | null;     // a price on the table, not yet accepted
  claim: Claim | null;     // null until filed; kept after closing, as history
  invoice: Invoice;
  messages: DemoMessage[];
  lastRead: MessageReadState;
};
```

There is no redundant status field. Whether a quote is outstanding is
`quote !== null`; whether a claim is open is `OPEN_CLAIM_STATUSES.includes(...)`.
Storing a derivable status alongside the thing it describes is how the two drift
apart, which is a defect the sibling project had to migrate its way out of.

### Claim lifecycle

```
                        ┌──────────── estimate ≤ $2,000 ────────────┐
                        │                                            ▼
  (none) ── file-claim ─┤                                        approved ── settle-claim ──▶ settled
                        │                                            ▲
                        └── estimate > $2,000 ──▶ submitted          │
                                                      │              │
                                          start-claim-review         │
                                                      ▼              │
                                                  in-review ─── approve-claim
                                                   │     │
                                request-claim-information reject-claim
                                                   ▼            ▼
                                          more-info-needed   rejected
                                                   │
                     upload-claim-document, then respond-to-claim-review
                                                   │
                                                   └──▶ in-review
```

`settled` and `rejected` are terminal, and both free the policyholder to file
again. `autoApproved` distinguishes the two ways `approved` is reached, because
a demo audience seeing "Approved" with no agent action needs to be told why.

### Rules worth knowing before you change them

- **Settlement uses the deductible in force at settlement time**, not at filing
  time. Change coverage mid-claim and the payout changes. This is tested.
- **Accepting a quote reissues the invoice**, clearing a previous payment. The
  amount changed, so a paid invoice describing the old price would be a lie.
- **Changing the vehicle or the driver clears an open quote.** The price was
  calculated against details no longer on file.
- **`respond-to-claim-review` requires at least one document.** A round trip
  that tells the agent nothing new is not a round trip.
- **Every agent decision requires a note.** A rejection with no reason is the
  one thing a policyholder cannot act on.

## 4. Authentication

Real password hashing, real signed sessions, and real single-use codes
delivered by email. There is no fixed or printed code anywhere.

There used to be one, selectable per sign-in through a checkbox. It was removed
as redundant: **Sign in without two-step verification** already covers every
case where waiting on mail is the wrong trade, and a code printed on the screen
beside the password it protects is not a second factor. Dropping it took with it
a delivery-preference flag on the API, a column on `mfa_challenges`, a branch in
the verification screen, and three tests — all of which existed only to describe
which kind of code you were getting.

So there are two paths, and which one you get is the button you press:

| Button | Behaviour |
| --- | --- |
| Sign in without two-step verification | A session in one request. Shared demo accounts only; anything else gets `403`. |
| Continue as … | A six-digit code by email, rate limited to one a minute and five an hour per address. |

Consequences worth keeping in mind:

- **A checkout with no mail provider cannot complete the code path.** It answers
  `502` and the screen says so. That is why the deploy gate signs in with the
  bypass, exactly as the sibling project's does.
- **Registration still works without mail**, up to the point of verification —
  the account waits in `pending_users` and is only written to `users` once a
  code is accepted.

Two details that outlast the simplification:

- **`readSession` re-reads the account on every request** and rejects the token
  if the name or role no longer match. Renaming a demo account therefore
  invalidates every session signed under the old name. That is intentional, and
  it is also why a rename looks like a mass logout.
- **Rate limiting protects the mail provider**, and now that every challenge
  sends a message, every challenge is counted. An earlier version counted
  fixed-code challenges too, which let automation exhaust a budget it never
  used; that whole class of bug disappeared with the fixed codes.

### Brevo accepting a message does not mean it was delivered

`northlane-auto@testrigor-mail.com` was tried first: on-brand, and on the domain
the brief's *Email Rules* actually ask for. Brevo answered 2xx, the app showed
"check your email", and nothing arrived.

The domain publishes no SPF, no DMARC and no Brevo DKIM selector:

```bash
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=testrigor-mail.com&type=TXT'
```

So the receiving server saw mail from Brevo's infrastructure claiming to be that
domain with nothing authorising it, and dropped it. The API call succeeding
proved only that Brevo took the message, not that anyone got it.

**The proper fix, if the sender should live on the testRigor domain:**
authenticate `testrigor-mail.com` at <https://app.brevo.com/senders/domain/list>
and publish the DKIM and SPF records Brevo hands back. That needs DNS access to
the domain. Until then, borrowing a verified address is the working option.

Whatever the sender, confirm delivery in Brevo's transactional log
(<https://app.brevo.com/transactional/statistics/events>) rather than from the
app: the log distinguishes *sent*, *delivered*, *soft bounce*, *hard bounce* and
*blocked*, and the app can only ever report the first.

### Editing wrangler.jsonc requires a rebuild

`wrangler deploy` does **not** read `wrangler.jsonc` directly. The build emits a
redirected configuration and wrangler uses that:

```
Using redirected Wrangler configuration.
 - Configuration being used: "dist/server/wrangler.json"
 - Original user's configuration: "wrangler.jsonc"
```

So `npx wrangler deploy` after editing `wrangler.jsonc` silently redeploys the
*previous* values. This cost a debugging cycle: the sender looked configured,
the deploy succeeded, and the Worker went on behaving as though no sender was
set, because the one it had bound was still the empty string. Always
`npm run build` first, and confirm what actually shipped:

```bash
grep -o '"BREVO_SENDER_EMAIL":"[^"]*"' dist/server/wrangler.json
```

The deploy output also prints every binding it is about to attach. Read it.

### A deployed frontend needs a deployed Worker

The frontend was published before the Worker existed, and the result is worth
recording: the site loaded, rendered the sign-in screen correctly, and failed
every request with a proxy 502, because the rewrite pointed at a hostname that
did not resolve. Nothing about the page suggested the backend was the problem.

Two consequences, both now handled. The rewrite target in `vercel.json` and
`vercel-frontend/vercel.json` must be a Worker that actually exists — a
`workers.dev` URL is `<name>.<account-subdomain>.workers.dev`, not
`<name>.workers.dev`. And `lib/http.ts` exists because the app used to show the
JSON parser's own error message to the reader when a gateway answered in
anything other than JSON.

Two operational rules inherited from the sibling project, both learned the hard
way:

- **A staging deploy must not share production's D1 database.** The workflow
  state is a single global row, so one shared database means a preview mutates
  production. Set `D1_DATABASE_NAME` and `D1_DATABASE_ID` together.
- **A Worker deployed without `MFA_SESSION_SECRET` answers 500 on every
  authenticated route**, which reads as a broken application rather than a
  missing secret. The deploy job checks for it and refuses to proceed.

## 11. Deliberately not built

From the brief's build rules, and worth defending against scope creep:

- **No real payment processing.** A fake form, one accepted card, and a success
  or failure message.
- **No document storage.** The file name and size are recorded; the file is
  never read, uploaded, or kept.
- **No risk scoring.** A base rate plus at most three named surcharges,
  arithmetic a demo audience can follow in one reading.
- **No search engine.** Five policyholders filtered by substring.
- **No workflow engine.** A status field and a note.
- **No permission system.** Two hardcoded roles and one allow-list each.
- **No native mobile application.** Responsive web covers desktop and mobile
  web; the agent experience lives in the same web app rather than a Windows
  desktop application. Both are documented adaptations — see
  [Requirements Traceability](REQUIREMENTS_TRACEABILITY.md).

If a proposed change does not help demonstrate test automation, the brief's
answer is not to build it.

## 12. Known limitations

- **No test isolation.** One shared workflow row. Reset between scenarios and
  run them serially. See [QA Automation](QA_AUTOMATION.md).
- **The claim reference is constant.** Every claim is `CLM-2026-7714`, including
  one filed after a previous claim closed. Deterministic on purpose, but it
  cannot distinguish two claims. Use `filedAt` or `status`.
- **Timestamps are fixed literals**, not a clock. `filedAt` is always
  `July 24, 2026 at 10:05 AM`. Do not build anything that needs elapsed time.
- **Only one claim exists at a time.** The model holds `claim: Claim | null`.
  A claim history list would need a different shape.
- **The queue fixtures are inert.** The three other claims on the agent's
  dashboard are static rows for texture; only the live claim can be acted on.
- **Sessions break on a rename.** Changing a demo account's `name` invalidates
  every session signed under the old one. See §4.
