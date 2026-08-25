/**
 * Reading an API response without trusting that it is one.
 *
 * The app only ever talks to its own Worker, but it rarely talks to it
 * directly: a CDN, a proxy rewrite, or a hosting gateway sits in between, and
 * those answer failures with their own HTML or plain text rather than this
 * API's JSON. `response.json()` throws a SyntaxError on that body, and the raw
 * `Unexpected token 'A', "An error o"... is not valid JSON` then reached the
 * sign-in form and was displayed to the reader as if it were advice.
 *
 * That happened in production the first time the frontend was deployed against
 * a Worker hostname that did not exist yet: every request came back as a 502
 * from the proxy, and the app reported a parser error instead of "the service
 * is unavailable".
 */
export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(describeUnreadableResponse(response.ok, response.status));
  }
}

/**
 * The sentence a reader gets when the body was not JSON.
 *
 * Split out from `readJson` so the wording is assertable without fabricating a
 * `Response`, and so the two cases stay distinguishable: a 200 carrying junk is
 * a different problem from a gateway refusing to reach the API at all.
 */
export function describeUnreadableResponse(ok: boolean, status: number): string {
  if (ok) {
    return "The server sent a response this app could not read. Please reload and try again.";
  }
  return `The service is unavailable right now (HTTP ${status}). Please try again shortly.`;
}
