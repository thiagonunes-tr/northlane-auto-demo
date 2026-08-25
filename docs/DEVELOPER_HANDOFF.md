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

Real password hashing, real signed sessions, real single-use codes — and
deliberately fake code *delivery* for the two shared accounts.

`chooseDelivery` in `lib/mfa-policy.ts` owns the decision and is pure, so both
branches are provable without a mail provider, a database, or a network.
`planVerification` only supplies the environment and picks the matching code.

| Account | Mail provider | Asked for email | Delivery | Code |
| --- | --- | --- | --- | --- |
| Shared demo | no | either | `fixed` | `111111` / `222222` |
| Shared demo | yes | no | `fixed` | `111111` / `222222` |
| Shared demo | yes | yes | `email` | Random, via Brevo |
| Registered | no | — | `fixed` | `123456` |
| Registered | yes | — | `email` | Random, via Brevo |

Three rules, in order:

1. **No mail provider means no email.** A local checkout and CI have no Brevo
   key and the sign-in flow still has to complete there. Without this the demo
   would need a cloud account just to run.
2. **A shared demo account uses its printed code unless asked otherwise.** Those
   credentials are on the screen and in every automated suite; tying them to a
   mailbox means one mail outage breaks every test and every live demo at once.
   The checkbox opts one sign-in into the mailbox flow.
3. **A registered account uses email.** Its address is real and was chosen by
   whoever owns it, which is what verification is actually for.

Two consequences worth keeping:

- **The preference does not persist.** It resets with the account tab, because a
  preference that survived would make the next automated run depend on what the
  last human clicked.
- **The fallback announces itself.** Requesting email in an environment with no
  provider shows the printed code *and* says why. A silent fallback would look
  identical to the default and would hide a misconfigured deployment.

Rate limiting applies only when `delivery` is `email`, and — the part that is
easy to get wrong — it counts only challenges that were themselves delivered by
email. `mfa_challenges.delivery` exists for that filter alone.

The first version counted every challenge for the address. Fixed-code sign-ins
send no mail but still wrote rows, so a test run silently exhausted the hourly
budget and the next person trying to demonstrate the email flow was told "Too
many codes were requested". The limit was throttling a provider it had never
used. `tests/rate-limit-scope.test.ts` pins the corrected query, because the
rule lives in SQL against a Cloudflare-only binding and cannot be reached from a
unit test.

Databases created before the column exists are migrated on first use by
`addDeliveryColumnIfMissing`. Existing rows default to `fixed`: a challenge
recorded before the distinction existed cannot be shown to have sent mail.

Two details worth knowing:

- **`readSession` re-reads the account on every request** and rejects the token
  if the name or role no longer match. Renaming a demo account therefore
  invalidates every session signed under the old name. That is intentional, and
  it is also why a rename looks like a mass logout.
- **Registration is deferred.** A new account lives in `pending_users` keyed by
  the challenge, and is only written to `users` once the code is accepted.

## 5. Persistence

One D1 database, five tables, and `CREATE TABLE IF NOT EXISTS` on first use — so
a fresh environment needs no migration step to work. The Drizzle migration in
`drizzle/` exists for tooling and for a controlled production rollout; runtime
does not depend on it.

`getDemoState()` validates every field on the way out and falls back to the seed
value for anything that fails its guard. It falls back to a **whole** field, not
a repaired one: a half-valid record leaves the UI reasoning about entries the
guards already rejected.

`resetDemoState()` and the no-row path both return a **deep copy** of the seed.
Handing out the module-level constants would let one request's mutation leak
into the next reader's "fresh" environment.

The 24-hour reset runs opportunistically inside `getDemoState` and
`saveDemoState`. Registered users survive it; workflow state does not.

## 6. The stylesheet

`app/globals.css` is the whole design system, and it holds one invariant:

> **No colour or font-size literal exists outside the `:root` block.**

The dark theme redeclares **only colour tokens**. The type, spacing and radius
scales are theme-independent, so a dark-mode regression can only ever be a
colour problem. Check it with:

```bash
grep -nE '#[0-9a-fA-F]{3,8}' app/globals.css | grep -v -E '^\s*[0-9]+:\s*--|:root'
```

Three deliberate exceptions, all commented in place:

- `rgba()` overlays on surfaces that are dark in **both** themes (the hero and
  auth gradients, the toast). They are theme-independent by construction.
- `--on-accent`, `--accent-from`, `--accent-to`: text and gradient stops for
  those always-dark surfaces. Do not collapse `--on-accent` into `--surface`;
  they coincide in the light theme only, and `--surface` goes dark.
- `:where(.has-tooltip) { position: relative }` has zero specificity on purpose.
  It only supplies a containing block to triggers that lack one. A plain
  `.has-tooltip` rule outranks `.modal-close`, which is already absolutely
  positioned, and drops the close button into the dialog's text.

### Two layout traps

- **Any grid that reserves a column for an avatar** must grow that column inside
  the `min-width: 1000px` block, where the avatar grows. Miss one and the avatar
  overhangs the name beside it. The deploy gate checks this geometrically,
  because nothing else can see it: the DOM is valid and the contrast passes.
- **Do not position hero content absolutely.** The mobile hero originally pinned
  its metric to the bottom, which assumed the copy above never grew. A two-line
  heading ran straight through the vehicle row. It stacks in normal flow now,
  and the gate asserts they do not overlap.

## 7. The UI

`shared/NorthlaneApp.tsx` compiles into **two** targets, so it cannot take
framework-specific dependencies. No `next/*` imports, no server components.

**Every dialog is owned by the root component**, in one discriminated union:

```ts
type PortalModal = null | { kind: "account" } | { kind: "quote" } | …
```

This makes "at most one dialog is mounted" structural rather than a rule someone
has to remember. Two mounted dialogs mean two focus traps and two Escape
listeners fighting each other, which is a defect the sibling project shipped and
had to fix.

`Modal` traps focus, restores it to the opener on close, closes on Escape, and
**does not dismiss on backdrop click by default**. A stray click outside a form
dialog used to destroy typed input, including a password. Read-only dialogs opt
in with `dismissOnBackdrop`. Dialogs holding input pass `confirmDiscard`, which
asks before throwing work away.

`useTooltip` describes; it never renames. It uses `aria-describedby`, because an
`aria-label` on a wrapper would replace the control's own accessible name. It
opens on keyboard focus as well as hover and dismisses on Escape (WCAG 2.1
1.4.13). Callers must add `has-tooltip` to the trigger's class list.

## 8. The contract

`public/openapi.json` is published and rendered at `/api-docs`. Three tests keep
it honest, and they are the only thing standing between a renamed action and a
lying contract:

1. The `action` enum equals the TypeScript `DemoStateAction` union.
2. `DemoState.required` and `.properties` equal the keys of `DEFAULT_DEMO_STATE`.
3. `DemoStateActionRequest.properties` equals the fields the route actually
   destructures — read out of `app/api/demo-state/route.ts` by regex, not from a
   hardcoded list, because a hardcoded list passes while the route grows an
   undocumented input.

Add an action or a state field and `npm test` fails until the document catches
up. That is the design.

## 9. Verification

| Command | Covers |
| --- | --- |
| `npm run lint` | ESLint with `jsx-a11y` recommended rules |
| `npm test` | Business rules, contract drift, verification policy |
| `npm run build` | The Worker target |
| `npm --prefix vercel-frontend run build` | The Vercel target |
| `npm run test:e2e` | The full story, both roles, both themes, mobile, accessibility |

`npx tsc --noEmit` reports errors for `cloudflare:workers` and `D1Database`.
Those types are injected by the Cloudflare Vite plugin at build time and are
**not** available to a bare typecheck. The sibling project reports the identical
set. `npm run build` is the type gate; a bare `tsc` is not.

The E2E suite starts and stops its own dev server, writes artefacts to
`test-results/e2e/`, and on failure saves a screenshot and a Playwright trace.

## 10. Deployment

Both targets are live:

| Target | URL |
| --- | --- |
| Vercel frontend | <https://northlane-auto-demo.vercel.app> |
| Cloudflare Worker | <https://northlane-auto-demo.thiago-nunes-5e0.workers.dev> |

The Worker serves the whole application *and* the API on one origin; Vercel
serves the frontend and rewrites `/api/*` to the Worker. Either origin is a
valid automation target, and the single-origin Worker one avoids the proxy hop.

The Worker is currently deployed by hand — `npm run build && npx wrangler
deploy`. The CI deploy job exists but is gated behind the repository variable
`CLOUDFLARE_PROVISIONED`; validation runs on every push regardless. Setting that
variable and adding `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` turns on
automatic deploys from `main`.

Email verification is live. `BREVO_API_KEY` is a Worker secret and
`BREVO_SENDER_EMAIL` is `northlane-auto@testrigor-mail.com` — an address on the
testRigor mail domain rather than a personal mailbox, which is what the brief's
*Email Rules* ask for and an improvement on the sibling project's Gmail sender.

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
the deploy succeeded, and the app kept answering `codeDelivery: "fixed"` because
the Worker still had an empty sender bound. Always `npm run build` first, and
confirm what actually shipped:

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
