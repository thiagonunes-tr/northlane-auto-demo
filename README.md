# Northlane Auto Insurance Demo

Northlane Auto is an English-language car insurance portal demo with policyholder
and claims agent experiences, password plus two-step verification, persistent demo
users, and automatically resetting demo state.

It implements **Project 2: Car Insurance Demo Apps** from `Demo App Projects.pdf`,
and is a sibling of the [Luma Health demo](https://github.com/thiagonunes-tr/luma-health-demo):
same stack, same design system, same QA-automation purpose, different domain.

> Everything here is fictional. Northlane sells no policies, pays no claims, and
> handles no money. Do not enter real licence, vehicle, or card details.

## Live environment

| Target | URL |
| --- | --- |
| Frontend (Vercel) | <https://northlane-auto-demo.vercel.app> |
| API + app (Cloudflare Worker) | <https://northlane-auto-demo.thiago-nunes-5e0.workers.dev> |
| Swagger console | <https://northlane-auto-demo.vercel.app/api-docs> |

The Vercel frontend proxies `/api/*` to the Worker. The Worker is the source of
truth for authentication, sessions, users and workflow state, and also serves the
whole application on its own origin — useful when you want a single-origin
environment for automation.

## Quick start

```bash
npm install
npm run dev
```

Then open the URL the dev server prints and sign in with a demo account below.
No cloud account, no secrets, and no email provider are required: `.dev.vars`
supplies a local signing secret and the app falls back to fixed verification
codes when no mail provider is configured.

## Demo accounts

| Role | Email | Password | Verification code |
| --- | --- | --- | --- |
| Policyholder | `customer.demo@testrigor-mail.com` | `CustomerDemo!2026` | `111111` |
| Claims agent | `agent.demo@testrigor-mail.com` | `AgentDemo!2026` | `222222` |

Both accounts can also skip verification entirely with **Sign in without two-step
verification**, which returns a session in a single request.

Three ways in, so the same account serves automation and a live demo:

| You want | Do this | You get |
| --- | --- | --- |
| The fastest path for a test suite | **Sign in without two-step verification** | A session in one request |
| The verification step, deterministically | **Continue as …** | The printed code above |
| To demonstrate real email verification | Tick **Send the code by email instead** | A real message to that address |

The shared accounts default to their printed code on purpose: credentials used by
every automated suite should not stop working because a mailbox does. Accounts
you register yourself always verify by email when a provider is configured, and
fall back to `123456` when one is not.

Payment uses one accepted card. Every other well-formed card is declined, so both
outcomes are reachable without guessing:

| Field | Accepted value |
| --- | --- |
| Card number | `4111 1111 1111 1111` |
| Expiry | `12/30` |
| CVV | `123` |

## The demo story

A policyholder already has an active policy on a 2019 Honda Civic. From there:

1. **Get a quote** for a different coverage level. The price is a base rate plus
   named surcharges, itemised on screen, and it does not touch the policy until
   accepted. Accepting it reprices the policy and reissues the open invoice.
2. **Update the vehicle or the driver.** Either change clears an open quote,
   because that price was calculated against details no longer on file.
3. **Pay the premium** with the demo card, or watch any other card be declined.
4. **File a claim.** The single rule the whole demo turns on: an estimate of
   **$2,000 or less is approved automatically**; anything higher starts as
   *Pending review* and lands on a claims agent's desk.
5. The **claims agent** starts the review and either approves it, rejects it, or
   asks for more information — every decision requires a written note.
6. If information was requested, the policyholder **attaches a document** and
   sends the claim back. The file itself is never uploaded or stored; only its
   name and size are recorded.
7. The agent **settles** an approved claim. The payout is the estimate less the
   policy deductible, floored at zero.
8. Either side can **message** the other, and **generate a claim summary** as a
   downloadable CSV.

Both roles share one environment, so a change made by one is visible to the other.

## Architecture

- **Frontend:** Vite/React, deployable to Vercel from `vercel-frontend/`
- **API:** Next-compatible routes running on a Cloudflare Worker via `vinext`
- **Database:** Cloudflare D1, holding one shared workflow row
- **Transactional email:** Brevo, optional — the app works fully without it
- **Business rules:** `lib/demo-state.ts`, a pure state machine with no I/O

`shared/NorthlaneApp.tsx` compiles into **two** deployment targets (the Worker and
the Vercel bundle), so it cannot take framework-specific dependencies.

## Verification

Four gates, all of which must pass before a change lands:

```bash
npm run lint                            # ESLint, including jsx-a11y recommended
npm test                                # business rules + OpenAPI contract drift
npm run build                           # Cloudflare Worker target
npm --prefix vercel-frontend run build  # Vercel target
```

Plus the deploy gate, which starts its own server and drives the whole story in a
real browser across both roles, both themes, and a phone viewport:

```bash
python3 -m venv .venv-e2e
.venv-e2e/bin/pip install -r requirements-e2e.txt
.venv-e2e/bin/playwright install chromium
npm run test:e2e
```

It audits every surface it lands on with axe, measures contrast directly on the
gradient surfaces axe declines to judge, and asserts that nothing overlaps.

## Documentation

- [API Reference](docs/API_REFERENCE.md) — endpoints, payloads, status codes, curl recipes
- [QA Automation Guide](docs/QA_AUTOMATION.md) — deterministic setup, scenarios, expected failures
- [Developer Handoff](docs/DEVELOPER_HANDOFF.md) — architecture, data model, invariants, limitations
- [Requirements Traceability](docs/REQUIREMENTS_TRACEABILITY.md) — requirement-by-requirement comparison with the original brief

Interactive Swagger documentation is at `/api-docs`, and its OpenAPI 3.1 source at
[`public/openapi.json`](public/openapi.json). Two unit tests compare that document
against the TypeScript source, so the contract cannot drift silently.

## Provisioning

Already done, and recorded here so the next environment can be rebuilt from
nothing:

| Resource | Value |
| --- | --- |
| D1 database | `northlane-auto-demo-db` · `97e10f3c-01ef-40cf-bc27-64cdb8700dbe` |
| Worker | `northlane-auto-demo`, binding `DB` |
| Worker secrets | `MFA_SESSION_SECRET`, `BREVO_API_KEY` — set, never committed |
| Mail sender | `lumahealth.testrigordemo@gmail.com`, shown as “Northlane Auto (demo)” |
| Vercel project | Git integration on this repository |

The database id lives in [`vite.config.ts`](vite.config.ts) and the Worker origin
in [`vercel.json`](vercel.json) and
[`vercel-frontend/vercel.json`](vercel-frontend/vercel.json).

### Still optional

- **Automatic Worker deploys.** CI validates every push, but the deploy job is
  gated behind the repository variable `CLOUDFLARE_PROVISIONED`. Set it to
  `true`, and add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
  to have `main` publish the Worker. Until then, deploy with `npx wrangler
  deploy` after `npm run build`.
- ~~Real verification emails.~~ **Live.** Codes go through Brevo. Registered
  accounts verify by email automatically; the shared accounts do it on request.
  A local checkout has no key, so it still falls back to the printed code and
  says so — which is what keeps the test suite runnable with no secrets.
- **A sender on the testRigor domain.** The sender is currently borrowed from the
  sibling demo, because `testrigor-mail.com` is not authenticated in Brevo — it
  publishes no SPF, no DMARC and no Brevo DKIM selector, so mail sent as that
  domain is accepted by Brevo and dropped on delivery. Authenticate the domain at
  <https://app.brevo.com/senders/domain/list> and the sender can move on-brand.
- **A staging environment.** Create a second D1 database and set
  `D1_DATABASE_NAME` and `D1_DATABASE_ID` together at build time. Never point
  staging at the production database: the workflow state is a single global row,
  so a preview would mutate production.
