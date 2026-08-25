"""The deploy gate for the Northlane Auto demo.

It drives one deterministic story end to end across both roles — quote, buy,
pay, claim, review, settle — and audits every surface it lands on for the
accessibility rules this project owns. It asserts on visible text and on CSS
classes, so any UI change has to be reflected here in the same commit.

Run it with `npm run test:e2e`. It starts and stops its own dev server.
"""

import os
import re
import signal
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from axe_playwright_python.sync_playwright import Axe
from playwright.sync_api import Page, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "test-results" / "e2e"
DEV_VARS = ROOT / ".dev.vars"
BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:4173")
PARSED_BASE_URL = urlparse(BASE_URL)
HOST = PARSED_BASE_URL.hostname or "127.0.0.1"
PORT = PARSED_BASE_URL.port or 4173

CUSTOMER_EMAIL = "customer.demo@testrigor-mail.com"
CUSTOMER_PASSWORD = "CustomerDemo!2026"
CUSTOMER_CODE = "111111"
AGENT_EMAIL = "agent.demo@testrigor-mail.com"
AGENT_PASSWORD = "AgentDemo!2026"

DEMO_CARD = "4111 1111 1111 1111"
DECLINED_CARD = "5555 5555 5555 4444"

# The scenario deliberately drives two refusals — a declined card (409) and a
# wrong verification code (401) — and Chrome logs a console error for every
# non-2xx fetch. Those two are the demo working, so they are filtered out by
# status rather than by silencing the console check, which would also hide a
# real failure. Uncaught JavaScript still fails the run through `pageerror`.
EXPECTED_HTTP_NOISE = re.compile(
  r"Failed to load resource: the server responded with a status of (401|409)\b"
)


AXE = Axe()
# Rules this project owns. Failing any of these is a regression, not a new
# discovery. The list is inherited from the sibling demo's design audit.
AXE_RULES = [
  "aria-allowed-attr",
  "aria-required-attr",
  "aria-roles",
  "aria-valid-attr-value",
  "button-name",
  "color-contrast",
  "duplicate-id-aria",
  "empty-table-header",
  "form-field-multiple-labels",
  "html-has-lang",
  "label",
  "landmark-one-main",
  "landmark-unique",
  "region",
  "bypass",
  "page-has-heading-one",
  "skip-link",
  "link-name",
  "list",
  "select-name",
  "th-has-data-cells",
]


def settle_animations(page: Page) -> None:
  """Wait for anything mid-animation before measuring colour.

  The toast fades in from `opacity: 0`. Sampling during those 300ms reads the
  title composited against whatever is behind it and reports a contrast failure
  for a state that lasts a third of a second and is not what anyone reads. This
  is a measurement problem, not a design one, so it belongs here rather than in
  a rule exclusion that would also hide a real failure.
  """
  try:
    page.wait_for_function(
      "() => document.getAnimations().every(a => a.playState === 'finished')",
      timeout=3000,
    )
  except Exception:
    # Never let a stuck animation turn into a false failure of the audit
    # itself; a fixed settle is enough for every animation this app has.
    page.wait_for_timeout(500)


def audit_surface(page: Page, surface: str) -> None:
  """Fail the deploy on any violation of the rules this project owns.

  Semantics and geometry both, because a surface can be perfectly accessible
  and still render wrong: axe reads the DOM and the colours, never where an
  element actually landed.
  """
  settle_animations(page)
  results = AXE.run(
    page,
    # The Swagger console is vendor DOM (swagger-ui-react); its violations are
    # not ours to fix and must not gate this deploy.
    context={"exclude": [[".api-docs-console"]]},
    options={
      "runOnly": {"type": "rule", "values": AXE_RULES},
      # "incomplete" matters as much as "violations": axe declines to judge
      # contrast when it cannot resolve the background, which is exactly what a
      # gradient does. Anything axe cannot judge is measured directly below.
      "resultTypes": ["violations", "incomplete"],
    },
  )
  violations = results.response.get("violations", [])
  undetermined = [
    node["target"]
    for entry in results.response.get("incomplete", [])
    if entry["id"] == "color-contrast"
    for node in entry["nodes"]
  ]
  if violations:
    lines = []
    for violation in violations:
      lines.append(f"  {violation['id']} ({violation['impact']}): {violation['help']}")
      for node in violation["nodes"][:4]:
        lines.append(f"    at {node['target']}")
    raise AssertionError(f"axe violations on {surface}:\n" + "\n".join(lines))
  for target in undetermined:
    measure_contrast(page, target[0] if isinstance(target, list) else target, surface)
  assert_no_overlap(page, surface)
  suffix = f" ({len(undetermined)} gradient nodes measured directly)" if undetermined else ""
  print(f"  audited: {surface}{suffix}")


def assert_no_overlap(page: Page, surface: str) -> None:
  """Nothing that reserves a grid column may overhang what sits beside it.

  Several grids reserve a fixed column for an avatar, and the `min-width:
  1000px` block grows the avatar. Any grid whose column is not grown with it
  ends up with the avatar sitting on top of the name. Nothing else in this gate
  can see that: the DOM is valid, the names are right, the contrast passes.

  The hero is checked the same way for the same reason — its metric column used
  to be absolutely positioned and ran through the vehicle row on narrow
  viewports as soon as the heading wrapped to two lines.
  """
  overlaps = page.evaluate(
    """() => {
      const out = [];
      for (const avatar of document.querySelectorAll('.person-avatar, .avatar')) {
        const next = avatar.nextElementSibling;
        if (!next) continue;
        const own = avatar.getBoundingClientRect();
        const beside = next.getBoundingClientRect();
        if (own.width === 0 || beside.width === 0) continue;
        if (own.right > beside.left + 0.5) {
          out.push({
            what: avatar.className,
            container: avatar.parentElement.closest('[class]').className,
            overlapPx: Math.round(own.right - beside.left),
          });
        }
      }
      const person = document.querySelector('.hero-person');
      const metric = document.querySelector('.hero-metric');
      if (person && metric) {
        const a = person.getBoundingClientRect();
        const b = metric.getBoundingClientRect();
        // Side by side on desktop, stacked on phones. Only the stacked case can
        // collide vertically, and only then is the check meaningful.
        if (b.left < a.right && a.bottom > b.top + 0.5) {
          out.push({ what: 'hero-metric', container: 'hero-card',
                     overlapPx: Math.round(a.bottom - b.top) });
        }
      }
      return out;
    }"""
  )
  assert overlaps == [], f"overlapping elements on {surface}: {overlaps}"


MIN_CONTRAST = 4.5


def _relative_luminance(rgb) -> float:
  channels = []
  for raw in rgb:
    c = raw / 255
    channels.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def measure_contrast(page: Page, selector: str, surface: str) -> None:
  """Assert contrast for a node axe could not judge.

  Samples every gradient stop behind the text. Translucent stops are composited
  over each opaque stop rather than treated as solid, because a radial highlight
  at low alpha is not its own colour — reading it as opaque produces a false
  failure on the auth gradient.
  """
  sample = page.evaluate(
    r"""(selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const parse = (value) => {
        const parts = value.match(/[\d.]+/g).map(Number);
        return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
      };
      let el = node, stops = null;
      while (el && !stops) {
        const style = getComputedStyle(el);
        if (style.backgroundImage !== "none") {
          const found = (style.backgroundImage.match(/rgba?\([^)]*\)/g) || [])
            .map(parse)
            .filter(s => s.alpha > 0);
          if (found.length) stops = found;
        } else if (style.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(style.backgroundColor)) {
          stops = [parse(style.backgroundColor)];
        }
        el = el.parentElement;
      }
      return stops ? { color: parse(getComputedStyle(node).color).rgb, stops } : null;
    }""",
    selector,
  )
  if sample is None:
    return

  opaque = [s["rgb"] for s in sample["stops"] if s["alpha"] >= 1]
  translucent = [s for s in sample["stops"] if s["alpha"] < 1]
  if not opaque:
    return

  candidates = list(opaque)
  for stop in translucent:
    for base in opaque:
      candidates.append(
        [stop["alpha"] * stop["rgb"][i] + (1 - stop["alpha"]) * base[i] for i in range(3)]
      )

  foreground = _relative_luminance(sample["color"])
  for background_rgb in candidates:
    background = _relative_luminance(background_rgb)
    lighter, darker = max(foreground, background), min(foreground, background)
    ratio = (lighter + 0.05) / (darker + 0.05)
    assert ratio >= MIN_CONTRAST, (
      f"contrast {ratio:.2f}:1 on {surface} at {selector} (text "
      f"{sample['color']} on background {[round(c) for c in background_rgb]}); "
      f"needs {MIN_CONTRAST}:1"
    )


def wait_for_server(process: subprocess.Popen, timeout_seconds: int = 90) -> None:
  deadline = time.monotonic() + timeout_seconds
  while time.monotonic() < deadline:
    if process.poll() is not None:
      raise RuntimeError(
        f"Development server exited early with code {process.returncode}."
      )
    try:
      with socket.create_connection((HOST, PORT), timeout=1):
        return
    except OSError:
      time.sleep(0.25)
  raise TimeoutError(f"Development server did not open port {PORT}.")


# --------------------------------------------------------------------------- #
# Navigation helpers                                                           #
# --------------------------------------------------------------------------- #


def sidebar(page: Page, item: str) -> None:
  page.locator(".nav-item", has_text=item).first.click()
  page.wait_for_timeout(200)


def sign_in(page: Page, role: str) -> None:
  """Signs in through the documented bypass. The code path is exercised separately."""
  page.goto(BASE_URL)
  page.wait_for_load_state("networkidle")
  page.get_by_role("button", name="QA API documentation").wait_for()
  if role == "agent":
    page.get_by_role("button", name="Agent", exact=True).click()
  page.get_by_label("Email address").fill(
    AGENT_EMAIL if role == "agent" else CUSTOMER_EMAIL
  )
  page.get_by_label("Password").fill(
    AGENT_PASSWORD if role == "agent" else CUSTOMER_PASSWORD
  )
  page.get_by_role("button", name="Sign in without two-step verification").click()
  heading = "Good morning, Jordan." if role == "agent" else "Hello, Alex."
  page.get_by_role("heading", name=heading).wait_for()


def sign_out(page: Page) -> None:
  page.get_by_role("button", name="Account settings").click()
  page.get_by_role("button", name="Sign out").click()
  page.get_by_role("button", name="QA API documentation").wait_for()


def reset_environment(page: Page) -> None:
  """Restore the seed state so the scenario below starts from a known point."""
  response = page.request.delete(f"{BASE_URL}/api/demo-state")
  assert response.ok, f"reset failed: {response.status} {response.text()}"
  state = response.json()["state"]
  assert state["claim"] is None
  assert state["quote"] is None
  assert state["policy"]["coverage"] == "Standard"
  assert state["invoice"]["status"] == "unpaid"


def read_state(page: Page) -> dict:
  response = page.request.get(f"{BASE_URL}/api/demo-state")
  assert response.ok, f"state read failed: {response.status}"
  return response.json()["state"]


# --------------------------------------------------------------------------- #
# Focused verifications                                                        #
# --------------------------------------------------------------------------- #


def verify_two_step_verification(page: Page) -> None:
  """The fixed-code path, which is the one a demo audience actually watches.

  The code is printed on the screen rather than emailed, so this asserts both
  that it is shown and that a wrong code is rejected before the right one is
  accepted.
  """
  page.goto(BASE_URL)
  page.wait_for_load_state("networkidle")
  page.get_by_label("Email address").fill(CUSTOMER_EMAIL)
  page.get_by_label("Password").fill(CUSTOMER_PASSWORD)
  page.get_by_role("button", name="Continue as Policyholder").click()

  code_note = page.locator(".fixed-code-note")
  code_note.wait_for()
  expect(code_note.locator("code")).to_have_text(CUSTOMER_CODE)
  audit_surface(page, "verification step")

  page.get_by_label("Verification code").fill("999999")
  page.get_by_role("button", name="Verify and sign in").click()
  expect(page.get_by_role("alert")).to_contain_text("That code is incorrect")

  page.get_by_label("Verification code").fill(CUSTOMER_CODE)
  page.get_by_role("button", name="Verify and sign in").click()
  page.get_by_role("heading", name="Hello, Alex.").wait_for()
  print("  two-step verification: fixed code shown, wrong code rejected")


def verify_quote_and_purchase(page: Page) -> None:
  """A quote is priced, explained line by line, and only changes the policy on accept."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  audit_surface(page, "policy")

  page.get_by_role("button", name="Get a quote").click()
  page.get_by_role("heading", name="Price a different coverage level").wait_for()
  # The tier already held cannot be re-quoted, so its radio is disabled.
  expect(page.locator('.coverage-options input[value="Standard"]')).to_be_disabled()
  page.locator('.coverage-options input[value="Comprehensive"]').check(force=True)
  audit_surface(page, "quote dialog")
  page.get_by_role("button", name="Get this quote").click()

  breakdown = page.locator(".quote-breakdown")
  breakdown.wait_for()
  expect(breakdown).to_contain_text("Comprehensive base rate")
  expect(breakdown.locator("li.total")).to_contain_text("$1,420")
  # The policy has not moved yet.
  expect(page.locator(".document-card").first).to_contain_text("Standard")
  audit_surface(page, "policy with an open quote")

  state = read_state(page)
  assert state["quote"]["annualPremium"] == 1420, state["quote"]
  assert state["policy"]["coverage"] == "Standard", "a quote must not change the policy"

  page.get_by_role("button", name="Switch to Comprehensive coverage").click()
  expect(page.locator(".toast")).to_contain_text("Coverage changed")
  state = read_state(page)
  assert state["policy"]["coverage"] == "Comprehensive"
  assert state["policy"]["deductible"] == 500
  assert state["quote"] is None
  # The open invoice is reissued at the new price rather than left stale.
  assert state["invoice"]["amount"] == 118, state["invoice"]
  assert state["invoice"]["status"] == "unpaid"
  print("  quote: priced, explained, applied on accept, invoice reissued")


def verify_payment(page: Page) -> None:
  """Both card outcomes are reachable, and they use different status codes."""
  sidebar(page, "Billing")
  page.get_by_role("heading", name="Billing").wait_for()
  audit_surface(page, "billing")

  page.get_by_role("button", name="Pay this invoice").click()
  page.get_by_role("heading", name="Pay $118").wait_for()
  audit_surface(page, "payment dialog")

  def fill_card(number: str) -> None:
    page.get_by_label("Name on card").fill("Alex Carter")
    page.get_by_label("Card number").fill(number)
    page.get_by_label("Expiry").fill("12/30")
    page.get_by_label("CVV").fill("123")

  fill_card(DECLINED_CARD)
  page.get_by_role("button", name="Pay $118").click()
  expect(page.locator(".toast.error")).to_contain_text("That card was declined")
  page.locator(".toast button[aria-label='Close']").click()

  fill_card(DEMO_CARD)
  page.get_by_role("button", name="Pay $118").click()
  expect(page.locator(".toast")).to_contain_text("Payment accepted")

  state = read_state(page)
  assert state["invoice"]["status"] == "paid"
  assert state["invoice"]["paidWith"] == "Visa ending 1111"
  expect(page.locator(".document-card").first).to_contain_text("Paid with Visa ending 1111")
  print("  payment: demo card accepted, any other card declined")


def verify_file_claim(page: Page) -> None:
  """The $2,000 fast-track boundary is the single rule the whole demo turns on."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims").wait_for()
  audit_surface(page, "claims, none on file")

  page.locator(".welcome-row").get_by_role("button", name="File a claim").click()
  page.get_by_role("heading", name="File a claim").wait_for()
  page.get_by_label("What happened").fill(
    "Rear-ended at a junction; bumper and boot lid damaged."
  )
  # Under the limit first, to prove the form says which path it is taking.
  page.get_by_label("Estimated repair cost (USD)").fill("900")
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text(
    "approved automatically"
  )
  page.get_by_label("Estimated repair cost (USD)").fill("4200")
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text(
    "pending review"
  )
  audit_surface(page, "file claim dialog")
  page.get_by_role("button", name="File this claim").click()

  expect(page.locator(".toast")).to_contain_text("Claim filed")
  expect(page.locator(".review-status").first).to_have_text("Pending review")
  state = read_state(page)
  assert state["claim"]["status"] == "submitted", state["claim"]
  assert state["claim"]["autoApproved"] is False
  # Filing a second claim is blocked while this one is open.
  expect(page.locator(".welcome-row").get_by_role("button", name="File a claim")).to_be_disabled()
  audit_surface(page, "claims, one pending")
  print("  claim: $4,200 filed above the fast-track limit, second claim blocked")


def verify_agent_review(page: Page) -> None:
  """The agent's half of the workflow, including the note every decision needs."""
  sidebar(page, "Today")
  page.get_by_role("heading", name="Good morning, Jordan.").wait_for()
  expect(page.locator(".queue-row.highlighted")).to_contain_text("Pending review")
  audit_surface(page, "agent dashboard")

  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims", exact=True).wait_for()
  expect(page.locator(".request-card.highlighted")).to_contain_text("$4,200")
  expect(page.locator(".request-card.highlighted")).to_contain_text(
    "above the $2,000 fast-track limit"
  )
  audit_surface(page, "agent claims")

  page.get_by_role("button", name="Start review").click()
  expect(page.locator(".toast")).to_contain_text("Review started")
  page.get_by_role("button", name="Request information").wait_for()

  # A decision with no note is refused by the form before it reaches the API.
  page.get_by_role("button", name="Request information").click()
  page.get_by_role("heading", name="Ask for more on").wait_for()
  page.get_by_role("button", name="Send this request").click()
  expect(page.locator(".field-error")).to_contain_text("This field is required")
  page.get_by_label("Note to the policyholder").fill(
    "Please attach a photo of the rear bumper and the repair quote."
  )
  audit_surface(page, "claim decision dialog")
  page.get_by_role("button", name="Send this request").click()
  expect(page.locator(".toast")).to_contain_text("More information requested")

  state = read_state(page)
  assert state["claim"]["status"] == "more-info-needed", state["claim"]
  assert "rear bumper" in state["claim"]["reviewNote"]
  print("  agent: review started, information requested with a note")


def verify_document_round_trip(page: Page, upload: Path) -> None:
  """The claim cannot come back to the agent with nothing new attached."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims").wait_for()
  expect(page.locator(".next-step")).to_contain_text("rear bumper")

  # Nothing attached yet, so the return button is not offered.
  expect(page.get_by_role("button", name="Send back for review")).to_be_disabled()

  page.locator(".next-step").get_by_role("button", name="Attach a document").click()
  page.get_by_role("heading", name="Attach accident photos or documents").wait_for()
  page.locator('input[type="file"]').set_input_files(str(upload))
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text(upload.name)
  audit_surface(page, "upload dialog")
  page.get_by_role("button", name="Attach to my claim").click()
  expect(page.locator(".toast")).to_contain_text("Document attached")

  expect(page.locator(".record-row")).to_contain_text(upload.name)
  page.get_by_role("button", name="Send back for review").click()
  expect(page.locator(".toast")).to_contain_text("Sent back for review")

  state = read_state(page)
  assert state["claim"]["status"] == "in-review"
  assert state["claim"]["documents"][0]["fileName"] == upload.name
  # The file itself is never stored; only its name and size are recorded.
  assert set(state["claim"]["documents"][0]) == {
    "id", "fileName", "sizeLabel", "uploadedAt",
  }
  audit_surface(page, "claims with a document")
  print("  documents: attached by name only, claim returned for review")


def verify_settlement(page: Page) -> None:
  """Approval and settlement are two steps, and the payout is arithmetic."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims", exact=True).wait_for()

  page.get_by_role("button", name="Approve", exact=True).click()
  page.get_by_role("heading", name="Approve CLM-").wait_for()
  page.get_by_label("Note to the policyholder").fill(
    "Damage is consistent with the photo and covered under the policy."
  )
  page.get_by_role("button", name="Approve this claim").click()
  expect(page.locator(".toast")).to_contain_text("Claim approved")

  # Comprehensive cover took the deductible to $500, so $4,200 settles at $3,700.
  settle = page.get_by_role("button", name="Settle for $3,700")
  settle.wait_for()
  settle.click()
  expect(page.locator(".toast")).to_contain_text("Claim settled")

  state = read_state(page)
  assert state["claim"]["status"] == "settled"
  assert state["claim"]["settlementAmount"] == 3700, state["claim"]
  audit_surface(page, "settled claim")
  print("  settlement: $4,200 estimate less the $500 deductible = $3,700")


def verify_claim_summary(page: Page) -> None:
  page.get_by_role("button", name="Generate claim summary").click()
  page.get_by_role("heading", name="CLM-").wait_for()
  expect(page.locator(".data-table")).to_contain_text("$3,700")
  audit_surface(page, "claim summary dialog")

  with page.expect_download() as download:
    page.get_by_role("button", name="Download CSV").click()
  saved = ARTIFACTS / "claim-summary.csv"
  download.value.save_as(saved)
  content = saved.read_text()
  assert "Settlement" in content and "$3,700" in content, content
  assert "Fictional demo data" in content, content
  # The dialog carries both an icon-only close and a labelled one.
  page.get_by_role("dialog").locator("button.secondary-button", has_text="Close").click()
  print("  claim summary: rendered and downloadable as CSV")


def verify_messages(page: Page, role: str) -> None:
  sidebar(page, "Messages")
  page.get_by_role("heading", name="Messages").wait_for()
  body = f"A demo message from the {role}."
  page.get_by_label("Reply to").fill(body)
  page.get_by_role("button", name="Send message").click()
  expect(page.locator(".message-bubble").last).to_contain_text(body)
  # Opening the thread clears this role's unread badge.
  expect(page.locator(".nav-item", has_text="Messages").locator(".nav-badge")).to_have_count(0)
  audit_surface(page, f"messages ({role})")
  print(f"  messages: sent and marked read as the {role}")


def verify_directory(page: Page) -> None:
  # The directory is opened from the dashboard, not from the claims list.
  sidebar(page, "Today")
  page.get_by_role("heading", name="Good morning, Jordan.").wait_for()
  page.get_by_role("button", name="Search policyholders").click()
  page.get_by_role("heading", name="Search policyholders").wait_for()
  results = page.locator(".directory-results > button")
  expect(results).to_have_count(5)
  page.get_by_placeholder("Search by name").fill("alex")
  expect(results).to_have_count(1)
  audit_surface(page, "policyholder directory")
  results.first.click()
  page.get_by_role("heading", name="Alex Carter").wait_for()
  # The live workflow state is reflected in the profile, not a fixture copy.
  expect(page.locator(".review-details")).to_contain_text("Comprehensive")
  audit_surface(page, "policyholder profile")
  # Scoped to the dialog: a toast may also carry a "Close" button.
  page.get_by_role("dialog").get_by_label("Close").click()
  print("  directory: five policyholders, searchable, live state on the profile")


def verify_tooltips(page: Page) -> None:
  """A tooltip describes, is reachable by keyboard, and dismisses with Escape.

  Hover-only would be unreachable by keyboard and undismissable (WCAG 2.1
  1.4.13), and an `aria-label` on a wrapper would replace the control's own
  accessible name rather than add to it.
  """
  switch = page.get_by_role("switch", name="Dark mode")
  switch.hover()
  tooltip = page.locator(".tooltip")
  tooltip.wait_for()
  expect(tooltip).to_contain_text("Switch to the")
  described_by = switch.get_attribute("aria-describedby")
  assert described_by, "the tooltip must describe the control, not rename it"
  assert switch.get_attribute("aria-label") == "Dark mode"

  switch.focus()
  page.keyboard.press("Escape")
  expect(tooltip).to_have_count(0)
  # Escape dismissed only the tooltip; the page behind it is untouched.
  expect(page.locator(".app-shell")).to_be_visible()
  print("  tooltips: describe, keyboard reachable, Escape dismisses")


def verify_logo_goes_home(page: Page, home: str) -> None:
  sidebar(page, "Messages")
  page.get_by_role("heading", name="Messages").wait_for()
  page.locator("button.brand").click()
  page.get_by_role("heading", name=home).wait_for()
  print("  logo: returns to the role's home destination")


def verify_theme(page: Page) -> None:
  """Both themes are audited, because only colour tokens change between them."""
  page.get_by_role("switch", name="Dark mode").click()
  page.wait_for_timeout(300)
  assert page.evaluate("document.documentElement.dataset.theme") == "dark"
  audit_surface(page, "dark theme")
  page.get_by_role("switch", name="Dark mode").click()
  page.wait_for_timeout(300)
  assert page.evaluate("document.documentElement.dataset.theme") == "light"
  print("  theme: dark and light both audited")


def verify_mobile(page: Page) -> None:
  """The phone layout stacks the hero instead of overlapping it."""
  page.set_viewport_size({"width": 390, "height": 844})
  page.wait_for_timeout(400)
  expect(page.locator(".mobile-nav")).to_be_visible()
  expect(page.locator(".sidebar")).to_be_hidden()
  audit_surface(page, "mobile home")
  page.set_viewport_size({"width": 1440, "height": 1050})
  page.wait_for_timeout(300)
  print("  mobile: bottom navigation, no overlap in the hero")


def verify_api_docs(page: Page) -> None:
  page.goto(f"{BASE_URL}/api-docs")
  page.wait_for_load_state("networkidle")
  page.get_by_role("heading", name="Interactive API documentation").wait_for()
  audit_surface(page, "api docs")

  contract = page.request.get(f"{BASE_URL}/openapi.json")
  assert contract.ok, f"openapi.json is not served: {contract.status}"
  document = contract.json()
  assert document["info"]["title"] == "Northlane Auto Demo API"
  assert "/api/demo-state" in document["paths"]
  print("  api docs: console renders and the contract is served")


def verify_role_boundary(page: Page) -> None:
  """The API refuses a cross-role action even when the UI never offers it."""
  response = page.request.patch(
    f"{BASE_URL}/api/demo-state",
    data={"action": "approve-claim", "reviewNote": "Not mine to approve."},
  )
  assert response.status == 403, f"expected 403, got {response.status}"
  assert "claims agent" in response.json()["error"]
  print("  role boundary: the API refuses a cross-role action with 403")


# --------------------------------------------------------------------------- #
# The scenario                                                                 #
# --------------------------------------------------------------------------- #


def run_scenario(page: Page, upload: Path) -> None:
  print("Policyholder")
  sign_in(page, "customer")
  reset_environment(page)
  page.reload()
  page.get_by_role("heading", name="Hello, Alex.").wait_for()
  audit_surface(page, "policyholder home")
  verify_tooltips(page)
  verify_theme(page)
  verify_mobile(page)
  verify_quote_and_purchase(page)
  verify_payment(page)
  verify_file_claim(page)
  verify_role_boundary(page)
  verify_messages(page, "policyholder")
  verify_logo_goes_home(page, "Hello, Alex.")
  sign_out(page)

  print("Claims agent")
  sign_in(page, "agent")
  verify_agent_review(page)
  verify_directory(page)
  verify_messages(page, "agent")
  verify_logo_goes_home(page, "Good morning, Jordan.")
  sign_out(page)

  print("Policyholder responds")
  sign_in(page, "customer")
  verify_document_round_trip(page, upload)
  sign_out(page)

  print("Claims agent decides")
  sign_in(page, "agent")
  verify_settlement(page)
  verify_claim_summary(page)
  sign_out(page)

  print("Sign-in paths")
  verify_two_step_verification(page)
  sign_out(page)
  verify_api_docs(page)


def main() -> None:
  ARTIFACTS.mkdir(parents=True, exist_ok=True)
  secret_created = False
  if not DEV_VARS.exists():
    secret = os.environ.get("E2E_MFA_SESSION_SECRET")
    if not secret:
      raise RuntimeError(
        "Create .dev.vars or set E2E_MFA_SESSION_SECRET before running E2E."
      )
    DEV_VARS.write_text(f"MFA_SESSION_SECRET={secret}\n")
    secret_created = True

  upload = ARTIFACTS / "accident-photo.jpg"
  # A real file on disk, because the dialog reads its name and size. Its bytes
  # are never sent anywhere.
  upload.write_bytes(b"\xff\xd8\xff\xe0" + b"northlane demo upload" * 64)

  server_log = (ARTIFACTS / "server.log").open("w")
  process = subprocess.Popen(
    ["npm", "run", "dev", "--", "--host", HOST, "--port", str(PORT), "--strictPort"],
    cwd=ROOT,
    stdout=server_log,
    stderr=subprocess.STDOUT,
    text=True,
    start_new_session=True,
  )

  try:
    wait_for_server(process)
    with sync_playwright() as playwright:
      browser = playwright.chromium.launch(headless=True)
      context = browser.new_context(
        viewport={"width": 1440, "height": 1050},
        accept_downloads=True,
      )
      context.tracing.start(screenshots=True, snapshots=True, sources=True)
      page = context.new_page()
      # The dirty-form guard uses window.confirm. Accepting it keeps a dialog
      # that the scenario deliberately abandons from wedging the run.
      page.on("dialog", lambda dialog: dialog.accept())
      console_errors = []
      page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error" and not EXPECTED_HTTP_NOISE.search(message.text)
        else None,
      )
      page.on("pageerror", lambda error: console_errors.append(f"pageerror: {error}"))
      try:
        run_scenario(page, upload)
        assert console_errors == [], console_errors
        page.screenshot(path=ARTIFACTS / "completed.png", full_page=True)
        context.tracing.stop()
      except Exception:
        page.screenshot(path=ARTIFACTS / "failure.png", full_page=True)
        context.tracing.stop(path=ARTIFACTS / "trace.zip")
        raise
      finally:
        browser.close()
  finally:
    # npm spawns vinext as a child; terminating only the wrapper leaves the
    # server holding the port, which breaks the next run. Signal the group.
    try:
      os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
      process.terminate()
    try:
      process.wait(timeout=10)
    except subprocess.TimeoutExpired:
      try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
      except (ProcessLookupError, PermissionError):
        process.kill()
      process.wait(timeout=5)
    server_log.close()
    if secret_created:
      DEV_VARS.unlink(missing_ok=True)

  print("Full deterministic demo E2E passed")


if __name__ == "__main__":
  main()
