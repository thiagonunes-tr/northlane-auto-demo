import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The hourly limit exists to protect a mail provider, so it must count only
 * challenges that actually used one.
 *
 * This was a real defect: the query counted every challenge for an address,
 * which let a suite signing in with fixed codes silently exhaust a budget it
 * never touched. The one sign-in that then wanted to demonstrate email was
 * refused with "Too many codes were requested", and nothing on the way there
 * suggested why.
 *
 * The rule lives in SQL against a Cloudflare-only binding, so it cannot be
 * exercised in a unit test. It is pinned by reading the route instead — the
 * same approach `openapi.test.ts` uses to stop the published contract drifting
 * from the code.
 */
const route = readFileSync(
  new URL("../app/api/auth/login/route.ts", import.meta.url),
  "utf8",
);

function statementContaining(marker: string): string {
  const start = route.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker} in the login route`);
  const end = route.indexOf("`", route.indexOf("`", start) + 1);
  return route.slice(start, end);
}

test("the hourly limit counts only challenges delivered by email", () => {
  const query = statementContaining("SELECT created_at FROM mfa_challenges");
  assert.match(
    query,
    /delivery\s*=\s*'email'/,
    "the rate-limit query must exclude fixed-code challenges, or automation " +
      "signing in with printed codes will exhaust the email budget",
  );
  assert.match(query, /WHERE\s+email\s*=\s*\?/, "still scoped to one address");
  assert.match(query, /created_at\s*>\s*\?/, "still scoped to a time window");
});

test("the rate-limit check only runs for an email delivery", () => {
  // A fixed code sends no mail, so throttling it would slow a suite down for
  // nothing. The guard around the query is what makes that true.
  const guarded = route.indexOf('if (plan.delivery === "email") {');
  const query = route.indexOf("SELECT created_at FROM mfa_challenges");
  assert.notEqual(guarded, -1, "the rate-limit branch is no longer guarded");
  assert.ok(
    guarded < query,
    "the rate-limit query must sit inside the email-delivery branch",
  );
});

test("every challenge records how it was delivered", () => {
  const insert = statementContaining("INSERT INTO mfa_challenges");
  assert.match(
    insert,
    /consumed_at,\s*delivery\)/,
    "the insert must persist the delivery, or the limit has nothing to filter on",
  );
  const bindings = route.slice(route.indexOf(insert), route.indexOf("];", route.indexOf(insert)));
  assert.match(
    bindings,
    /plan\.delivery/,
    "the delivery bound must be the one the plan chose, not a literal",
  );
});
