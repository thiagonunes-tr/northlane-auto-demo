import assert from "node:assert/strict";
import test from "node:test";
import { describeUnreadableResponse, readJson } from "../lib/http";

test("a JSON body is returned as-is", async () => {
  const response = new Response(JSON.stringify({ user: { name: "Alex Carter" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const data = await readJson<{ user: { name: string } }>(response);
  assert.equal(data.user.name, "Alex Carter");
});

test("an error payload is still JSON and still parses", async () => {
  const response = new Response(JSON.stringify({ error: "Sign in to continue." }), {
    status: 401,
  });
  const data = await readJson<{ error: string }>(response);
  assert.equal(data.error, "Sign in to continue.");
});

// The regression this module exists for. A proxy pointing at a Worker hostname
// that does not resolve answers with its own plain-text 502, and the parser
// error from that body used to be shown to the reader as if it were advice.
test("a gateway's non-JSON failure becomes a sentence about the service", async () => {
  const response = new Response(
    "An error occurred with this application.\n\nDNS_HOSTNAME_NOT_FOUND\n",
    { status: 502 },
  );
  await assert.rejects(
    readJson(response),
    (error: Error) => {
      assert.match(error.message, /service is unavailable/i);
      assert.match(error.message, /502/);
      // The parser's own wording must never reach the reader.
      assert.doesNotMatch(error.message, /Unexpected token|JSON/i);
      return true;
    },
  );
});

test("HTML from a CDN is handled the same way", async () => {
  const response = new Response("<!doctype html><html><body>504</body></html>", {
    status: 504,
  });
  await assert.rejects(readJson(response), /service is unavailable.*504/i);
});

test("a 200 carrying junk is reported as a different problem", async () => {
  const response = new Response("not json at all", { status: 200 });
  await assert.rejects(readJson(response), (error: Error) => {
    assert.match(error.message, /could not read/i);
    assert.doesNotMatch(error.message, /unavailable/i);
    return true;
  });
});

test("an empty body is not silently treated as success", async () => {
  await assert.rejects(readJson(new Response("", { status: 200 })), /could not read/i);
  await assert.rejects(readJson(new Response("", { status: 502 })), /unavailable/i);
});

test("the two cases are worded distinguishably and never leak parser detail", () => {
  const reachable = describeUnreadableResponse(true, 200);
  const unreachable = describeUnreadableResponse(false, 502);
  assert.notEqual(reachable, unreachable);
  for (const message of [reachable, unreachable]) {
    assert.doesNotMatch(message, /Unexpected token|SyntaxError|JSON\.parse/);
    assert.ok(message.endsWith("."), "a message shown to a reader is a sentence");
  }
});
