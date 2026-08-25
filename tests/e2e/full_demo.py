"""The deploy gate for the Northlane Auto demo.

It drives one deterministic story end to end across both roles — quote, buy,
pay, claim, review, settle — and audits every surface it lands on for the
accessibility rules this project owns. It asserts on visible text and on CSS
classes, so any UI change has to be reflected here in the same commit.

Run it with `npm run test:e2e`. It starts and stops its own dev server.
"""

import json
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
AGENT_EMAIL = "agent.demo@testrigor-mail.com"
AGENT_PASSWORD = "AgentDemo!2026"

DEMO_CARD = "4111 1111 1111 1111"
DECLINED_CARD = "5555 5555 5555 4444"

# Refusals this scenario drives on purpose. Chrome logs a console error for
# every non-2xx fetch, so without this list the demo behaving correctly would
# fail the run. Filtered by status rather than by silencing the console check,
# which would also hide a real failure, and kept to exactly the statuses the
# scenario provokes so an unexpected one still surfaces. Uncaught JavaScript
# always fails, through `pageerror`.
#
#   409  a declined payment card
#   429  the fifth code request in an hour; this gate spends one per run
#   502  a code requested where no mail provider is configured
EXPECTED_HTTP_NOISE = re.compile(
  r"Failed to load resource: the server responded with a status of (409|429|502)\b"
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
  assert state["quote"] is None
  assert state["policy"]["status"] == "active"
  assert state["policy"]["coverage"] == "Standard"
  assert state["policy"]["noClaimsYears"] > 0, "the seed needs a bonus for the claim to cost"
  assert len(state["vehicles"]) == 1 and len(state["drivers"]) == 1
  assert not any(c["status"] not in ("settled", "rejected") for c in state["claims"]), (
    "the seed must open with no live claim"
  )
  assert len([i for i in state["invoices"] if i["status"] == "unpaid"]) == 1


def read_state(page: Page) -> dict:
  response = page.request.get(f"{BASE_URL}/api/demo-state")
  assert response.ok, f"state read failed: {response.status}"
  return response.json()["state"]


# --------------------------------------------------------------------------- #
# Focused verifications                                                        #
# --------------------------------------------------------------------------- #





# --------------------------------------------------------------------------- #
# Focused verifications                                                        #
# --------------------------------------------------------------------------- #


def verify_quote_and_purchase(page: Page) -> None:
  """A quote is priced line by line and only changes the policy on accept.

  This is where the pricing model is visible, so it asserts the arithmetic and
  not just that a number appeared: every line in the breakdown has to sum to the
  total, or the screen is telling a story the price does not support.
  """
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  audit_surface(page, "policy")

  page.get_by_role("button", name="Get a quote").click()
  page.get_by_role("heading", name="Price a different cover").wait_for()
  page.get_by_role("radio", name=re.compile("^Comprehensive")).check(force=True)
  page.get_by_role("checkbox", name=re.compile("^Glass cover")).check(force=True)
  page.locator('select[name="deductible"]').select_option("500")
  audit_surface(page, "quote dialog")
  page.get_by_role("button", name="Get this quote").click()

  breakdown = page.locator(".quote-breakdown")
  breakdown.wait_for()
  expect(breakdown).to_contain_text("Comprehensive")
  expect(breakdown).to_contain_text("Glass cover")
  expect(breakdown).to_contain_text("No-claims bonus")
  # The policy has not moved yet.
  expect(page.locator(".document-card").first).to_contain_text("Standard")
  audit_surface(page, "policy with an open quote")

  quote = read_state(page)["quote"]
  assert quote["kind"] == "endorsement", quote
  assert quote["addOns"] == ["glass"], quote
  assert quote["deductible"] == 500, quote
  assert sum(line["amount"] for line in quote["breakdown"]) == quote["annualPremium"], (
    f"the priced lines do not add up to the total: {quote}"
  )
  assert read_state(page)["policy"]["coverage"] == "Standard", "a quote must not change the policy"

  page.get_by_role("button", name="Switch to Comprehensive cover").click()
  expect(page.locator(".toast")).to_contain_text("Cover updated")
  state = read_state(page)
  assert state["policy"]["coverage"] == "Comprehensive"
  assert state["policy"]["deductible"] == 500
  assert state["policy"]["addOns"] == ["glass"]
  assert state["quote"] is None
  assert state["policy"]["noClaimsYears"] == 4, "an endorsement keeps the bonus"
  print("  quote: priced, decomposed, applied on accept")


def verify_vehicles_and_drivers(page: Page) -> None:
  """Adding risk is felt in the next price, and the policy always keeps one of each."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()

  page.get_by_role("button", name="Add a vehicle").click()
  page.get_by_role("heading", name="Add a vehicle").wait_for()
  page.get_by_label("Year").fill("2012")
  page.get_by_label("Make").fill("Ford")
  page.get_by_label("Model").fill("Focus")
  page.get_by_label("VIN").fill("1FAHP3F20CL111222")
  page.get_by_label("Licence plate").fill("7ghd881")
  page.locator('select[name="primaryUse"]').select_option("Business")
  audit_surface(page, "add vehicle dialog")
  page.get_by_role("button", name="Add vehicle").click()
  expect(page.locator(".toast")).to_contain_text("Vehicle added")

  state = read_state(page)
  assert len(state["vehicles"]) == 2, state["vehicles"]
  assert state["vehicles"][1]["plate"] == "7GHD881", "normalised"

  page.get_by_role("button", name="Add a driver").click()
  page.get_by_role("heading", name="Add a driver").wait_for()
  page.get_by_label("Full name").fill("Sam Carter")
  page.get_by_label("Licence number").fill("C7781-4420-9910")
  page.get_by_label("Issuing state").fill("California")
  page.get_by_label("Years licensed").fill("1")
  page.get_by_role("button", name="Add driver").click()
  expect(page.locator(".toast")).to_contain_text("Driver added")
  assert len(read_state(page)["drivers"]) == 2

  # The policyholder is not removable, and neither is the last vehicle.
  expect(page.get_by_role("button", name="Remove Alex Carter")).to_be_disabled()
  audit_surface(page, "policy with two vehicles and two drivers")

  # Both additions show up as their own lines in the next price.
  page.get_by_role("button", name="Get a quote").click()
  page.get_by_role("radio", name=re.compile("^Standard")).check(force=True)
  page.get_by_role("button", name="Get this quote").click()
  breakdown = page.locator(".quote-breakdown")
  breakdown.wait_for()
  expect(breakdown).to_contain_text("Ford Focus")
  expect(breakdown).to_contain_text("Driver licensed under 3 years")
  quote = read_state(page)["quote"]
  assert len([l for l in quote["breakdown"] if "Standard" in l["label"]]) == 2, "one line per vehicle"

  page.get_by_role("button", name="Discard this quote").click()
  expect(page.locator(".toast")).to_contain_text("Quote discarded")

  # Removing the extra risk takes it back out of the policy.
  page.get_by_role("button", name="Remove Sam Carter").click()
  expect(page.locator(".toast")).to_contain_text("Driver removed")
  page.get_by_role("button", name="Remove 2012 Ford Focus").click()
  expect(page.locator(".toast")).to_contain_text("Vehicle removed")
  state = read_state(page)
  assert len(state["vehicles"]) == 1 and len(state["drivers"]) == 1
  print("  risk: vehicles and drivers added, priced, and removed")


def verify_billing(page: Page) -> None:
  """Both card outcomes, a saved card, an instalment switch, and the history."""
  sidebar(page, "Billing")
  page.get_by_role("heading", name="Billing").wait_for()
  # The seed carries a paid invoice, so history is visible from the start.
  # Scoped to the invoice list: the saved-cards list uses the same row class.
  expect(page.locator('[aria-label="Invoices"] .record-row')).to_have_count(2)
  audit_surface(page, "billing")

  page.get_by_role("button", name="Save a card").click()
  page.get_by_role("heading", name="Save a card").wait_for()
  fill_card(page)
  audit_surface(page, "save card dialog")
  page.get_by_role("button", name="Save this card").click()
  expect(page.locator(".toast")).to_contain_text("Card saved")
  saved = read_state(page)["paymentMethods"]
  assert len(saved) == 1 and saved[0]["last4"] == "1111", saved
  assert "4111111111111111" not in json.dumps(saved), "the card number must never be stored"

  # A declined card and an accepted one, on the invoice that is actually due.
  page.locator('[aria-label="Invoices"] .record-row').filter(has_text="Unpaid").get_by_role("button", name="Pay").click()
  page.get_by_role("heading", name=re.compile("^Pay ")).wait_for()
  page.get_by_role("radio", name=re.compile("Use a different card")).check(force=True)
  fill_card(page, number=DECLINED_CARD)
  audit_surface(page, "payment dialog")
  page.get_by_role("button", name=re.compile("^Pay ")).last.click()
  expect(page.locator(".toast.error")).to_contain_text("That card was declined")
  page.locator(".toast button[aria-label='Close']").click()

  page.get_by_role("radio", name=re.compile("Visa ending 1111")).check(force=True)
  page.get_by_role("button", name=re.compile("^Pay ")).last.click()
  expect(page.locator(".toast")).to_contain_text("Payment accepted")
  assert unpaid_count(page) == 0, "nothing should be outstanding after paying"

  # Switching the plan reissues the open invoice, which reopens the balance.
  page.get_by_role("button", name=re.compile("plan$")).click()
  page.get_by_role("heading", name="How you pay").wait_for()
  page.get_by_role("radio", name=re.compile("^Annual")).check(force=True)
  audit_surface(page, "instalment dialog")
  page.get_by_role("button", name="Switch plan").click()
  expect(page.locator(".toast")).to_contain_text("Billing plan changed")
  state = read_state(page)
  assert state["policy"]["instalmentPlan"] == "annual"
  due = [i for i in state["invoices"] if i["status"] == "unpaid"]
  assert len(due) == 1 and due[0]["amount"] == state["policy"]["annualPremium"], due
  print("  billing: card declined then accepted, saved card used, plan switched")


def fill_card(page: Page, number: str = DEMO_CARD) -> None:
  page.get_by_label("Name on card").fill("Alex Carter")
  page.get_by_label("Card number").fill(number)
  page.get_by_label("Expiry").fill("12/30")
  page.get_by_label("CVV").fill("123")


def unpaid_count(page: Page) -> int:
  return len([i for i in read_state(page)["invoices"] if i["status"] == "unpaid"])


def verify_file_claim(page: Page) -> None:
  """The $2,000 fast-track boundary, and a third party recorded with the claim."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims").wait_for()
  # The seed carries one settled claim, so history is visible before filing.
  expect(page.locator('[aria-label="Closed claims"] .record-row')).to_have_count(1)
  audit_surface(page, "claims, history only")

  page.locator(".welcome-row").get_by_role("button", name="File a claim").click()
  page.get_by_role("heading", name="File a claim").wait_for()
  page.get_by_label("What happened").fill("Rear-ended at a junction; bumper and boot lid damaged.")
  page.get_by_label("Estimated repair cost (USD)").fill("900")
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text("approved automatically")
  page.get_by_label("Estimated repair cost (USD)").fill("4200")
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text("pending review")

  page.get_by_role("checkbox", name=re.compile("Another driver was involved")).check()
  page.get_by_label("Their name").fill("Jordan Miller")
  page.get_by_label("Their plate").fill("7bkd221")
  page.get_by_label("Their insurer").fill("Cedar Mutual")
  audit_surface(page, "file claim dialog")
  page.get_by_role("button", name="File this claim").click()

  expect(page.locator(".toast")).to_contain_text("Claim filed")
  state = read_state(page)
  claim = state["claims"][0]
  assert claim["status"] == "submitted", claim
  assert claim["autoApproved"] is False
  assert claim["thirdParty"]["plate"] == "7BKD221", "normalised"
  assert len(state["claims"]) == 2, "the settled claim stays as history"
  expect(page.locator(".welcome-row").get_by_role("button", name="File a claim")).to_be_disabled()
  audit_surface(page, "claims, one open")
  print("  claim: $4,200 filed above the fast-track limit, with a third party")


def verify_agent_review(page: Page) -> None:
  """Repair shop, inspection, and the note every decision needs."""
  sidebar(page, "Today")
  page.get_by_role("heading", name="Good morning, Jordan.").wait_for()
  expect(page.locator(".queue-row.highlighted")).to_contain_text("Pending review")
  audit_surface(page, "agent dashboard")

  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims", exact=True).wait_for()
  expect(page.locator(".request-card.highlighted")).to_contain_text("$4,200")
  expect(page.locator(".request-card.highlighted")).to_contain_text("Cedar Mutual")
  audit_surface(page, "agent claims")

  page.get_by_role("button", name="Start review").click()
  expect(page.locator(".toast")).to_contain_text("Review started")

  # An inspection cannot be scheduled with nowhere to hold it.
  expect(page.get_by_role("button", name="Schedule inspection")).to_be_disabled()
  page.get_by_role("button", name="Assign repair shop").click()
  page.get_by_role("heading", name="Assign a repair shop").wait_for()
  audit_surface(page, "repair shop dialog")
  page.get_by_role("button", name="Assign this shop").click()
  expect(page.locator(".toast")).to_contain_text("Repair shop assigned")

  page.get_by_role("button", name="Schedule inspection").click()
  expect(page.locator(".toast")).to_contain_text("Inspection scheduled")
  assert read_state(page)["claims"][0]["status"] == "inspection-scheduled"
  audit_surface(page, "claim out for inspection")

  page.get_by_role("button", name="Record the inspection").click()
  page.get_by_role("heading", name="Record what the inspection found").wait_for()
  # The finding has to be written down.
  page.get_by_role("button", name="Record the inspection").last.click()
  expect(page.locator(".field-error")).to_contain_text("This field is required")
  page.get_by_label("Inspection notes").fill("Rear panel and boot lid, as described.")
  audit_surface(page, "inspection dialog")
  page.get_by_role("button", name="Record the inspection").last.click()
  expect(page.locator(".toast")).to_contain_text("Inspection recorded")
  claim = read_state(page)["claims"][0]
  assert claim["status"] == "in-review", "back on the agent's desk"
  assert claim["inspection"]["outcome"] == "damage-confirmed"

  page.get_by_role("button", name="Request information").click()
  page.get_by_role("heading", name=re.compile("^Ask for more on")).wait_for()
  page.get_by_role("button", name="Send this request").click()
  expect(page.locator(".field-error")).to_contain_text("This field is required")
  page.get_by_label("Note to the policyholder").fill("Please attach a photo of the rear bumper.")
  audit_surface(page, "claim decision dialog")
  page.get_by_role("button", name="Send this request").click()
  expect(page.locator(".toast")).to_contain_text("More information requested")
  assert read_state(page)["claims"][0]["status"] == "more-info-needed"
  print("  agent: shop assigned, inspection recorded, information requested")


def verify_document_round_trip(page: Page, upload: Path) -> None:
  """The claim cannot come back to the agent with nothing new attached."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims").wait_for()
  expect(page.locator(".next-step")).to_contain_text("rear bumper")
  expect(page.get_by_role("button", name="Send back for review")).to_be_disabled()

  page.locator(".next-step").get_by_role("button", name="Attach a document").click()
  page.get_by_role("heading", name="Attach accident photos or documents").wait_for()
  page.locator('input[type="file"]').set_input_files(str(upload))
  expect(page.locator(".form-hint[aria-live='polite']")).to_contain_text(upload.name)
  audit_surface(page, "upload dialog")
  page.get_by_role("button", name="Attach to my claim").click()
  expect(page.locator(".toast")).to_contain_text("Document attached")

  page.get_by_role("button", name="Send back for review").click()
  expect(page.locator(".toast")).to_contain_text("Sent back for review")
  claim = read_state(page)["claims"][0]
  assert claim["status"] == "in-review"
  # The file itself is never stored; only its name and size are recorded.
  assert set(claim["documents"][0]) == {"id", "fileName", "sizeLabel", "uploadedAt"}
  audit_surface(page, "claims with a document")
  print("  documents: attached by name only, claim returned for review")


def verify_settlement_and_bonus(page: Page) -> None:
  """Settling pays out and costs the bonus, which the next renewal makes visible."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims", exact=True).wait_for()
  before = read_state(page)["policy"]["noClaimsYears"]
  assert before > 0, "the seed policy should carry a bonus to lose"

  page.get_by_role("button", name="Approve", exact=True).click()
  page.get_by_role("heading", name=re.compile("^Approve CLM-")).wait_for()
  page.get_by_label("Note to the policyholder").fill("Damage is consistent with the inspection.")
  page.get_by_role("button", name="Approve this claim").click()
  expect(page.locator(".toast")).to_contain_text("Claim approved")

  # Comprehensive cover took the deductible to $500, so $4,200 settles at $3,700.
  page.get_by_role("button", name="Settle for $3,700").click()
  expect(page.locator(".toast")).to_contain_text("Claim settled")
  state = read_state(page)
  claim = state["claims"][0]
  assert claim["status"] == "settled"
  assert claim["settlementAmount"] == 3700, claim
  assert claim["settledDeductible"] == 500, claim
  assert state["policy"]["noClaimsYears"] == 0, "settling a claim costs the whole bonus"
  audit_surface(page, "settled claim")
  print("  settlement: $3,700 paid, no-claims bonus reset to zero")


def verify_renewal(page: Page) -> None:
  """Renewal banks a claim-free year and reprices with it."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  before = read_state(page)["policy"]
  page.get_by_role("button", name="Renew early").click()
  expect(page.locator(".toast")).to_contain_text("Policy renewed")
  after = read_state(page)["policy"]
  assert after["noClaimsYears"] == before["noClaimsYears"] + 1, (before, after)
  assert after["renewsOn"] != before["renewsOn"], "the term should move on"
  assert unpaid_count(page) == 1, "renewal issues an invoice"
  print("  renewal: a claim-free year banked and the term moved on")


def verify_assistance(page: Page) -> None:
  """Roadside is gated on the add-on, and runs requested → dispatched → completed."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  # Glass is on the policy from the earlier quote, roadside is not.
  expect(page.get_by_role("button", name="Request assistance")).to_be_disabled()

  page.get_by_role("button", name="Get a quote").click()
  page.get_by_role("checkbox", name=re.compile("^Roadside assistance")).check(force=True)
  page.get_by_role("button", name="Get this quote").click()
  page.get_by_role("button", name=re.compile("^Switch to ")).click()
  expect(page.locator(".toast")).to_contain_text("Cover updated")
  assert "roadside" in read_state(page)["policy"]["addOns"]

  page.get_by_role("button", name="Request assistance").click()
  page.get_by_role("heading", name="Request help").wait_for()
  page.locator('select[name="kind"]').select_option("Tow")
  page.get_by_label("Where are you?").fill("I-80 westbound, mile 42")
  audit_surface(page, "assistance dialog")
  page.get_by_role("button", name="Request assistance").last.click()
  expect(page.locator(".toast")).to_contain_text("Help is on the way")
  assert read_state(page)["assistance"][0]["status"] == "requested"
  print("  assistance: gated on the add-on, then requested")


def verify_agent_assistance(page: Page) -> None:
  sidebar(page, "Today")
  page.get_by_role("heading", name="Good morning, Jordan.").wait_for()
  page.get_by_role("button", name="Dispatch a provider").click()
  expect(page.locator(".toast")).to_contain_text("Provider dispatched")
  request = read_state(page)["assistance"][0]
  assert request["status"] == "dispatched" and request["provider"], request
  audit_surface(page, "agent dashboard with a dispatch")
  page.get_by_role("button", name="Mark completed").click()
  expect(page.locator(".toast")).to_contain_text("Assistance completed")
  assert read_state(page)["assistance"][0]["status"] == "completed"
  print("  assistance: dispatched and completed by the agent")


def verify_agent_policy_and_refund(page: Page) -> None:
  """The agent's levers: refund a paid invoice, and lapse for non-payment."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  audit_surface(page, "agent policy")

  # `has_text` is a case-insensitive substring, and an unpaid row reads "Not yet
  # paid", so match the status chip exactly instead.
  paid = page.locator('[aria-label="Policy invoices"] .record-row').filter(
    has=page.locator(".review-status", has_text=re.compile(r"^Paid$"))
  ).first
  paid.get_by_role("button", name="Refund").click()
  page.get_by_role("heading", name=re.compile("^Refund ")).wait_for()
  page.get_by_label("Why is this being refunded?").fill("Duplicate charge after the cover change.")
  audit_surface(page, "refund dialog")
  page.get_by_role("button", name="Refund this invoice").click()
  expect(page.locator(".toast")).to_contain_text("Invoice refunded")
  assert any(i["status"] == "refunded" for i in read_state(page)["invoices"])

  page.get_by_role("button", name=re.compile("Lapse this policy")).click()
  expect(page.locator(".toast")).to_contain_text("Policy lapsed")
  assert read_state(page)["policy"]["status"] == "lapsed"
  audit_surface(page, "lapsed policy, agent view")
  print("  agent: invoice refunded and the policy lapsed for non-payment")


def verify_reinstatement(page: Page) -> None:
  """Paying what is overdue is the only thing that brings a lapsed policy back."""
  sidebar(page, "Home")
  page.get_by_role("heading", name="Hello, Alex.").wait_for()
  expect(page.locator(".shared-record-notice")).to_contain_text("lapsed")
  audit_surface(page, "lapsed policy, policyholder view")
  # Nothing about the risk can be changed while cover has stopped.
  sidebar(page, "Policy")
  expect(page.get_by_role("button", name="Add a vehicle")).to_be_disabled()

  sidebar(page, "Billing")
  page.locator('[aria-label="Invoices"] .record-row').filter(has_text="Unpaid").first.get_by_role("button", name="Pay").click()
  page.get_by_role("heading", name=re.compile("^Pay ")).wait_for()
  page.get_by_role("radio", name=re.compile("Visa ending 1111")).check(force=True)
  page.get_by_role("button", name=re.compile("^Pay ")).last.click()
  expect(page.locator(".toast")).to_contain_text("Payment accepted")
  assert read_state(page)["policy"]["status"] == "active", "paying the arrears reinstates cover"
  print("  reinstatement: the overdue premium paid, cover back in force")


def verify_cancel_and_new_business(page: Page) -> None:
  """Cancelling turns the next quote into new business, with the bonus reset."""
  sidebar(page, "Policy")
  page.get_by_role("heading", name="Policy", exact=True).wait_for()
  page.get_by_role("button", name="Cancel this policy").click()
  page.get_by_role("heading", name="Cancel your cover").wait_for()
  page.get_by_label("Why are you cancelling?").fill("Sold the car.")
  audit_surface(page, "cancel dialog")
  page.get_by_role("button", name="Cancel this policy").last.click()
  expect(page.locator(".toast")).to_contain_text("Policy cancelled")

  old = read_state(page)["policy"]
  assert old["status"] == "cancelled" and old["endedReason"] == "Sold the car."
  audit_surface(page, "cancelled policy")

  page.get_by_role("button", name="Get a quote").click()
  page.get_by_role("heading", name="Price a new policy").wait_for()
  page.get_by_role("radio", name=re.compile("^Liability")).check(force=True)
  page.get_by_role("button", name="Get this quote").click()
  quote = read_state(page)["quote"]
  assert quote["kind"] == "new-business", quote
  assert not any("No-claims bonus" in l["label"] for l in quote["breakdown"]), (
    "new business starts the bonus from zero"
  )

  page.get_by_role("button", name="Buy this policy").click()
  expect(page.locator(".toast")).to_contain_text("Cover updated")
  fresh = read_state(page)["policy"]
  assert fresh["status"] == "active"
  assert fresh["number"] != old["number"], "a new policy gets a new number"
  assert fresh["noClaimsYears"] == 0
  audit_surface(page, "new policy in force")
  print("  funnel: cancelled, re-quoted as new business, and bought")


def verify_certificate(page: Page) -> None:
  sidebar(page, "Policy")
  page.get_by_role("button", name="Open certificate").click()
  page.get_by_role("heading", name=re.compile("^NL-")).wait_for()
  audit_surface(page, "certificate dialog")
  with page.expect_download() as download:
    page.get_by_role("button", name="Download PDF").click()
  saved = ARTIFACTS / "certificate.pdf"
  download.value.save_as(saved)
  head = saved.read_bytes()
  assert head.startswith(b"%PDF-"), "the certificate must be a real PDF"
  assert b"%%EOF" in head, "the PDF must be terminated, or a reader will refuse it"
  assert b"Northlane Auto Insurance" in head
  page.get_by_role("dialog").locator("button.secondary-button", has_text="Close").click()
  print(f"  certificate: {len(head)} byte PDF generated in the browser")


def verify_claim_summary(page: Page) -> None:
  """Runs as the agent, whose claim cards carry the summary action."""
  sidebar(page, "Claims")
  page.get_by_role("heading", name="Claims", exact=True).wait_for()
  page.get_by_role("button", name="Generate claim summary").first.click()
  page.get_by_role("heading", name=re.compile("^CLM-")).wait_for()
  audit_surface(page, "claim summary dialog")
  with page.expect_download() as download:
    page.get_by_role("button", name="Download CSV").click()
  saved = ARTIFACTS / "claim-summary.csv"
  download.value.save_as(saved)
  content = saved.read_text()
  assert "Settlement" in content and "Fictional demo data" in content, content
  page.get_by_role("dialog").locator("button.secondary-button", has_text="Close").click()
  print("  claim summary: rendered and downloadable as CSV")


def verify_messages(page: Page, role: str) -> None:
  sidebar(page, "Messages")
  page.get_by_role("heading", name="Messages").wait_for()
  body = f"A demo message from the {role}."
  page.get_by_label("Reply to").fill(body)
  page.get_by_role("button", name="Send message").click()
  expect(page.locator(".message-bubble").last).to_contain_text(body)
  expect(page.locator(".nav-item", has_text="Messages").locator(".nav-badge")).to_have_count(0)
  audit_surface(page, f"messages ({role})")
  print(f"  messages: sent and marked read as the {role}")


def verify_directory(page: Page) -> None:
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
  expect(page.locator(".review-details")).to_contain_text("No-claims bonus")
  audit_surface(page, "policyholder profile")
  page.get_by_role("dialog").get_by_label("Close").click()
  print("  directory: five policyholders, searchable, live state on the profile")


def verify_role_boundary(page: Page) -> None:
  """The API refuses a cross-role action even when the UI never offers it."""
  refused = page.request.patch(
    f"{BASE_URL}/api/demo-state",
    data={"action": "approve-claim", "reviewNote": "Not mine to approve."},
  )
  assert refused.status == 403, f"expected 403, got {refused.status}"
  assert "claims agent" in refused.json()["error"]

  # And a malformed request is a 400 whatever the state happens to be.
  malformed = page.request.patch(
    f"{BASE_URL}/api/demo-state",
    data={"action": "request-quote", "coverage": "Platinum"},
  )
  assert malformed.status == 400, f"expected 400, got {malformed.status}"
  print("  role boundary: 403 across roles, 400 for a malformed request")



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


def verify_verification_step(page: Page) -> None:
  """The code path, as far as this gate can honestly take it.

  Every code is a real email now — there is no printed fallback, which is what
  keeps a working code off the screen. That also means this gate cannot complete
  the flow: reading a mailbox is out of scope, and CI has no mail provider at
  all. So it asserts the two things it can see, and both matter.

  Where mail is configured the challenge opens and names the masked address.
  Where it is not, the attempt has to fail *legibly* — a demo whose sign-in dies
  with a stack trace or a silent spinner is worse than one that says it cannot
  send right now.

  The refusal is deliberately not pinned to one cause. Requesting a code is rate
  limited at five an hour per address, and this gate spends one of them every
  time it runs, so on the third run in an hour the honest answer is "too many
  codes" rather than "no provider". Both are the app refusing in words, which is
  the property worth gating on; pinning the cause would make the gate fail on
  its own second run.
  """
  page.goto(BASE_URL)
  page.wait_for_load_state("networkidle")
  page.get_by_label("Email address").fill(CUSTOMER_EMAIL)
  page.get_by_label("Password").fill(CUSTOMER_PASSWORD)

  # No code may be printed on the sign-in screen. Checked as a shape rather than
  # against the constants that used to be here, so reintroducing a *different*
  # printed code is caught too — the point is that nothing readable beside the
  # password can serve as the second factor.
  card = page.locator(".auth-card").inner_text()
  printed = re.findall(r"(?<!\d)\d{6}(?!\d)", card)
  assert printed == [], f"a six-digit code is printed on the sign-in screen: {printed}"

  with page.expect_response(lambda r: "/api/auth/login" in r.url) as caught:
    page.get_by_role("button", name="Continue as Policyholder").click()
  response = caught.value

  if response.ok:
    page.locator(".code-input").wait_for()
    expect(page.locator(".auth-subtitle")).to_contain_text("@")
    expect(page.get_by_role("button", name="Send a new code")).to_be_visible()
    audit_surface(page, "verification step")
    page.get_by_role("button", name="Back to sign in").click()
    page.get_by_role("button", name="QA API documentation").wait_for()
    print("  verification step: code sent, reader pointed at the mailbox")
  else:
    # No mail provider here. The refusal must reach the reader as a sentence.
    alert = page.get_by_role("alert")
    alert.wait_for()
    message = alert.inner_text().strip()
    assert message, "the refusal reached the reader as an empty box"
    # A sentence, not a leaked object, a status code, or a parser error.
    assert message.endswith("."), message
    for leak in ("undefined", "[object", "Error:", "Unexpected token", "502", "429"):
      assert leak not in message, f"internal detail leaked to the reader: {message}"
    # And it must not strand them: the form is still there to go back to.
    expect(page.get_by_role("button", name="Continue as Policyholder")).to_be_visible()
    audit_surface(page, "verification unavailable")
    print(f"  verification step: refused legibly ({response.status}) — {message}")


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
  verify_vehicles_and_drivers(page)
  verify_billing(page)
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
  sign_out(page)

  print("Policyholder responds")
  sign_in(page, "customer")
  verify_document_round_trip(page, upload)
  sign_out(page)

  print("Claims agent decides")
  sign_in(page, "agent")
  verify_settlement_and_bonus(page)
  verify_claim_summary(page)
  sign_out(page)

  print("Renewal, assistance and documents")
  sign_in(page, "customer")
  verify_renewal(page)
  verify_assistance(page)
  verify_certificate(page)
  sign_out(page)

  print("Agent levers")
  sign_in(page, "agent")
  verify_agent_assistance(page)
  verify_agent_policy_and_refund(page)
  sign_out(page)

  print("Reinstatement and the new-business funnel")
  sign_in(page, "customer")
  verify_reinstatement(page)
  verify_cancel_and_new_business(page)
  sign_out(page)

  print("Sign-in paths")
  verify_verification_step(page)
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
