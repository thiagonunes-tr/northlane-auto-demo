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

Then open the URL the dev server prints and sign in with a demo account below,
using **Sign in without two-step verification** — a local checkout has no mail
provider, so the emailed-code path cannot complete there and says so. `.dev.vars`
supplies the local signing secret; nothing else is needed.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Policyholder | `customer.demo@testrigor-mail.com` | `CustomerDemo!2026` |
| Claims agent | `agent.demo@testrigor-mail.com` | `AgentDemo!2026` |

Two ways in, and the choice is the button you press:

| You want | Press | You get |
| --- | --- | --- |
| The path for automation | **Sign in without two-step verification** | A session in one request, no mailbox |
| The verification step | **Continue as …** | A real six-digit code by email |

There is no printed code. A code that can be read off the screen is not a second
factor, and the bypass already covers every case where waiting for mail is the
wrong trade — which is most automated ones.

Requesting a code is rate limited to one a minute and five an hour per address.

Payment uses one accepted card. Every other well-formed card is declined, so both
outcomes are reachable without guessing:

| Field | Accepted value |
| --- | --- |
| Card number | `4111 1111 1111 1111` |
| Expiry | `12/30` |
| CVV | `123` |

## The demo story

Alex Carter already holds an active policy on a 2019 Honda Civic, with four
claim-free years behind it. From there:

**Cover and price**
1. **Get a quote** for a different coverage level, optional extras, or a
   different deductible. The price is itemised line by line and does not touch
   the policy until accepted.
2. **Add or remove vehicles and drivers.** Each vehicle is rated separately; the
   least experienced driver adds one surcharge for the whole policy. Any change
   clears an open quote, because the price was for the old details.
3. **Renew early** to bank another claim-free year — the no-claims bonus is 5% a
   year up to 25%, and the renewal reprices with it.
4. **Cancel**, and the next quote becomes *new business*: a new policy number,
   and the bonus starts again from zero.

**Claims**
5. **File a claim**, optionally naming the other driver. The rule the demo turns
   on: an estimate of **$2,000 or less is approved automatically**; anything
   higher goes to a claims agent.
6. The **agent** assigns a repair shop, schedules an inspection, records what it
   found, and then approves, rejects, or asks for more information — every
   decision in writing.
7. **Settle** an approved claim. The payout is the estimate less the deductible,
   and it **costs the whole no-claims bonus** — visible at the next renewal.

**Money and service**
8. **Pay a premium** with the demo card, save a card for next time, or switch
   between monthly and annual billing. Invoices keep their history; an agent can
   refund a paid one.
9. **Miss a payment** and the agent can lapse the policy. Paying the arrears is
   the only thing that reinstates it.
10. **Call for roadside assistance** — if the add-on is on the cover. The agent
    dispatches a provider and closes the job.
11. **Download** a certificate of insurance as a PDF, or a claim summary as CSV,
    both generated in the browser.
12. **Message** the claims team either way, with per-role unread counts.

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
- ~~Real verification emails.~~ **Live.** Every code is a real message sent
  through Brevo. A local checkout has no key, so the code path refuses in words
  there; automation uses the bypass, which needs no mail at all.
- **A sender on the testRigor domain.** The sender is currently borrowed from the
  sibling demo, because `testrigor-mail.com` is not authenticated in Brevo — it
  publishes no SPF, no DMARC and no Brevo DKIM selector, so mail sent as that
  domain is accepted by Brevo and dropped on delivery. Authenticate the domain at
  <https://app.brevo.com/senders/domain/list> and the sender can move on-brand.
- **A staging environment.** Create a second D1 database and set
  `D1_DATABASE_NAME` and `D1_DATABASE_ID` together at build time. Never point
  staging at the production database: the workflow state is a single global row,
  so a preview would mutate production.
