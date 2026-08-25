"use client";

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ADD_ONS,
  ASSISTANCE_KINDS,
  CLAIM_TYPES,
  COVERAGE_BASE_PREMIUM,
  COVERAGE_TIERS,
  DEDUCTIBLE_CHOICES,
  DEFAULT_DEMO_STATE,
  DEMO_CARD_CVV,
  DEMO_CARD_EXPIRY,
  DEMO_CARD_NUMBER,
  FAST_TRACK_CLAIM_LIMIT,
  MAX_CLAIM_ESTIMATE,
  MAX_DRIVERS,
  MAX_PAYMENT_METHODS,
  MAX_VEHICLES,
  NEW_DRIVER_YEARS,
  OLDER_VEHICLE_CUTOFF_YEAR,
  REPAIR_SHOPS,
  VEHICLE_USES,
  addOnFor,
  assistanceStatusLabel,
  claimStatusLabel,
  countClaimsAwaitingAgent,
  countCustomerTodos,
  countUnreadMessages,
  formatMoney,
  hasOpenClaim,
  instalmentAmount,
  isInForce,
  noClaimsDiscountPercent,
  openAssistance,
  openClaim,
  policyStatusLabel,
  unpaidInvoices,
} from "../lib/demo-state";
import type {
  AddOnId,
  AssistanceKind,
  CardInput,
  Claim,
  ClaimStatus,
  ClaimType,
  CoverageTier,
  DeductibleChoice,
  DemoMessage,
  DemoState,
  DemoStateAction,
  Driver,
  InstalmentPlan,
  Invoice,
  PaymentMethod,
  Policy,
  RepairShop,
  Vehicle,
} from "../lib/demo-state";
import { readJson } from "../lib/http";
import { Icon, type IconName } from "./Icon";
import { Modal } from "./Modal";
import { buildCsv, buildPdf, downloadBlob } from "./pdf";
import { useTooltip } from "./Tooltip";

type Role = "customer" | "agent";
type Toast = { title: string; message: string; tone: "success" | "error" } | null;
type ThemePreference = "light" | "dark" | null;
const THEME_STORAGE_KEY = "northlane-theme";

type ClaimDecisionAction =
  | "approve-claim"
  | "reject-claim"
  | "request-claim-information";

/**
 * One atom for "which dialog is open", including whatever that dialog needs to
 * know. Every dialog in the app lives here rather than in the screen that opens
 * it, which makes "at most one dialog is mounted" structural instead of a rule
 * someone has to remember: two mounted dialogs mean two focus traps and two
 * Escape listeners fighting each other.
 */
type PortalModal =
  | null
  | { kind: "account" }
  | { kind: "quote" }
  | { kind: "vehicle"; vehicle: Vehicle | null }
  | { kind: "driver"; driver: Driver | null }
  | { kind: "cancel-policy" }
  | { kind: "file-claim" }
  | { kind: "upload-document" }
  | { kind: "assistance" }
  | { kind: "payment"; invoice: Invoice }
  | { kind: "save-card" }
  | { kind: "instalment" }
  | { kind: "certificate" }
  | { kind: "claim-summary"; claim: Claim }
  | { kind: "directory"; person: PolicyholderProfile | null }
  | { kind: "decision"; decision: ClaimDecisionAction }
  | { kind: "repair-shop" }
  | { kind: "inspection" }
  | { kind: "refund"; invoice: Invoice };

type AuthUser = { email: string; name: string; role: Role };
type Challenge = {
  id: string;
  destination: string;
  email: string;
  password: string;
  requestedRole?: Role;
};

type PolicyholderProfile = {
  name: string;
  initials: string;
  policyNumber: string;
  email: string;
  vehicle: string;
  memberSince: string;
};

const DEMO_CUSTOMER_EMAIL = "customer.demo@testrigor-mail.com";

const policyholders: PolicyholderProfile[] = [
  { name: "Alex Carter", initials: "AC", policyNumber: "NL-2026-004821", email: DEMO_CUSTOMER_EMAIL, vehicle: "2019 Honda Civic LX", memberSince: "February 2026" },
  { name: "Maria Lopez", initials: "ML", policyNumber: "NL-2026-004822", email: "maria.lopez@example.test", vehicle: "2021 Toyota Corolla", memberSince: "March 2025" },
  { name: "Emma Johnson", initials: "EJ", policyNumber: "NL-2025-003914", email: "emma.johnson@example.test", vehicle: "2015 Ford Focus", memberSince: "August 2024" },
  { name: "Chris Brown", initials: "CB", policyNumber: "NL-2025-003770", email: "chris.brown@example.test", vehicle: "2020 Mazda CX-5", memberSince: "January 2025" },
  { name: "Priya Shah", initials: "PS", policyNumber: "NL-2026-004615", email: "priya.shah@example.test", vehicle: "2018 Subaru Impreza", memberSince: "November 2025" },
];

/**
 * Claims belonging to the other policyholders. They give the agent's queue the
 * texture of a real book of business, and they are deliberately inert: only the
 * live claim in the shared state can be acted on.
 */
type QueueFixture = {
  reference: string;
  holder: string;
  summary: string;
  status: string;
  waiting: boolean;
};

const queueFixtures: QueueFixture[] = [
  { reference: "CLM-2026-7708", holder: "Emma Johnson", summary: "Collision · Rear-end at a junction", status: "In review", waiting: true },
  { reference: "CLM-2026-7702", holder: "Maria Lopez", summary: "Glass · Windscreen chip", status: "Settled", waiting: false },
  { reference: "CLM-2026-7695", holder: "Priya Shah", summary: "Weather · Hail damage to bonnet", status: "Settled", waiting: false },
];

type CustomerNavId = "home" | "policy" | "claims" | "billing" | "messages";
type AgentNavId = "today" | "claims" | "book" | "messages";
type NavId = CustomerNavId | AgentNavId;
type NavEntry = { id: NavId; label: string; icon: IconName };

const CUSTOMER_NAV: NavEntry[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "policy", label: "Policy", icon: "shield-check" },
  { id: "claims", label: "Claims", icon: "clipboard" },
  { id: "billing", label: "Billing", icon: "credit-card" },
  { id: "messages", label: "Messages", icon: "message" },
];

const AGENT_NAV: NavEntry[] = [
  { id: "today", label: "Today", icon: "home" },
  { id: "claims", label: "Claims", icon: "clipboard" },
  { id: "book", label: "Policy", icon: "shield-check" },
  { id: "messages", label: "Messages", icon: "message" },
];

/** The stages a claim passes through, and which statuses have reached each. */
const CLAIM_TIMELINE: { label: string; reachedWhen: ClaimStatus[] }[] = [
  { label: "Filed", reachedWhen: ["submitted", "in-review", "inspection-scheduled", "more-info-needed", "approved", "rejected", "settled"] },
  { label: "In review", reachedWhen: ["in-review", "inspection-scheduled", "more-info-needed", "approved", "rejected", "settled"] },
  { label: "Inspected", reachedWhen: ["inspection-scheduled", "approved", "rejected", "settled"] },
  { label: "Decision", reachedWhen: ["approved", "rejected", "settled"] },
  { label: "Settled", reachedWhen: ["settled"] },
];

const CLAIM_TYPE_HINTS: Record<ClaimType, string> = {
  Collision: "Contact with another vehicle or object",
  Theft: "The vehicle or its parts were stolen",
  Glass: "Windscreen or window damage only",
  Weather: "Hail, flood, or storm damage",
};

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

function policyholderFor(name: string): PolicyholderProfile | null {
  return policyholders.find(person => person.name === name) ?? null;
}

function initialsOf(name: string): string {
  return (
    name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(part => part[0]?.toUpperCase()).join("") || "NA"
  );
}

/**
 * The initials a reviewer keeps clicking. They open the same profile card the
 * directory shows, so there is one description of a policyholder in the app
 * rather than two. Never used inside `.directory-results`, where the whole row
 * is already a button: a button inside a button is invalid HTML and
 * unreachable by keyboard.
 */
function PersonAvatarButton({ person, onOpen }: {
  person: PolicyholderProfile;
  onOpen: (person: PolicyholderProfile) => void;
}) {
  const tooltip = useTooltip(`Quick profile · ${person.name}`);
  return <button
    type="button"
    className="person-avatar has-tooltip"
    onClick={() => onOpen(person)}
    aria-label={`Quick profile for ${person.name}`}
    {...tooltip.triggerProps}
  >{person.initials}{tooltip.tip}</button>;
}

function HolderAvatar({ name, onOpen }: {
  name: string;
  onOpen: (person: PolicyholderProfile) => void;
}) {
  const person = policyholderFor(name);
  if (!person) return <span className="person-avatar">{initialsOf(name)}</span>;
  return <PersonAvatarButton person={person} onOpen={onOpen} />;
}

function homeNavFor(role: Role): NavId {
  return role === "customer" ? "home" : "today";
}

function homeLabelFor(role: Role): string {
  const nav = role === "customer" ? CUSTOMER_NAV : AGENT_NAV;
  return nav.find(entry => entry.id === homeNavFor(role))?.label ?? "the start";
}

/**
 * The Northlane mark. It is a button in both places it appears, because a logo
 * that does nothing is the one thing every reviewer tries to click.
 */
function BrandButton({ className, role, onGoHome, children }: {
  className: string;
  role: Role;
  onGoHome: () => void;
  children: ReactNode;
}) {
  const label = homeLabelFor(role);
  const tooltip = useTooltip(`Back to ${label}`);
  return <button
    type="button"
    className={`${className} has-tooltip`}
    onClick={onGoHome}
    aria-label={`Northlane Auto — back to ${label}`}
    {...tooltip.triggerProps}
  >{children}{tooltip.tip}</button>;
}

/** "2026-07-18" -> "July 18, 2026". The stored value stays ISO. */
function formatIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const monthName = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][Number(month) - 1];
  return `${monthName} ${Number(day)}, ${year}`;
}

function describeVehicle(vehicle: Vehicle): string {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

function describeAddOns(ids: AddOnId[]): string {
  if (ids.length === 0) return "No optional cover";
  return ids.map(id => addOnFor(id).label).join(", ");
}

/**
 * Mirrors the server's per-field rules (lib/demo-state.ts) so a message names
 * the field instead of the form. Returns a message per invalid field, keyed by
 * input name.
 */
function validateText(
  values: Record<string, string>,
  limits: Record<string, number>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, max] of Object.entries(limits)) {
    const value = (values[name] ?? "").trim();
    if (value.length === 0) errors[name] = "This field is required.";
    else if (value.length > max) errors[name] = `Use ${max} characters or fewer.`;
  }
  return errors;
}

function fieldProps(name: string, errors: Record<string, string>) {
  return errors[name]
    ? { "aria-invalid": true as const, "aria-describedby": `${name}-error` }
    : {};
}

function focusFirstInvalid(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLElement) field.focus();
}

function FieldError({ name, errors }: { name: string; errors: Record<string, string> }) {
  if (!errors[name]) return null;
  return <p className="field-error" id={`${name}-error`} role="alert">{errors[name]}</p>;
}

/**
 * Resolves a theme preference onto the document. The dark palette is selected
 * by `[data-theme="dark"]` rather than a media query, so a reader can override
 * the system preference; "system" keeps following it, including live changes.
 */
function useTheme(): [boolean, (next: "light" | "dark") => void] {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  });
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const isDark = preference === null ? systemDark : preference === "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }, [isDark]);

  function choose(next: "light" | "dark") {
    setPreference(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  return [isDark, choose];
}

function ThemeSwitch({ isDark, onChange }: {
  isDark: boolean;
  onChange: (next: "light" | "dark") => void;
}) {
  const tooltip = useTooltip(
    isDark ? "Switch to the light theme" : "Switch to the dark theme",
  );
  return <button
    type="button"
    className="theme-switch has-tooltip"
    role="switch"
    aria-checked={isDark}
    aria-label="Dark mode"
    onClick={() => onChange(isDark ? "light" : "dark")}
    {...tooltip.triggerProps}
  >
    <span className="theme-switch-icon" aria-hidden="true"><Icon name="sun" size={15} /></span>
    <span className="theme-switch-track" aria-hidden="true"><i /></span>
    <span className="theme-switch-icon" aria-hidden="true"><Icon name="moon" size={15} /></span>
    {tooltip.tip}
  </button>;
}

function claimChipTone(status: ClaimStatus): string {
  if (status === "rejected") return "declined";
  if (status === "approved" || status === "settled") return "";
  return "pending";
}

function policyChipTone(status: Policy["status"]): string {
  if (status === "active") return "";
  if (status === "cancelled") return "declined";
  return "pending";
}

function invoiceChipTone(status: Invoice["status"]): string {
  if (status === "unpaid") return "pending";
  if (status === "refunded") return "neutral";
  return "";
}

function invoiceLabel(status: Invoice["status"]): string {
  return { unpaid: "Unpaid", paid: "Paid", refunded: "Refunded" }[status];
}

/* -------------------------------------------------------------------------- */
/* Root                                                                        */
/* -------------------------------------------------------------------------- */

export default function Home() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [activeNav, setActiveNav] = useState<NavId>("home");
  const [isDarkTheme, chooseTheme] = useTheme();
  const [activeModal, setActiveModal] = useState<PortalModal>(null);
  const closeModal = () => setActiveModal(null);
  const [demo, setDemo] = useState<DemoState>(DEFAULT_DEMO_STATE);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState<DemoStateAction | null>(null);
  /** Which row an in-flight action belongs to, so only that row reads as busy. */
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const dateLabel = useMemo(
    () => new Intl.DateTimeFormat("en-US", {
      weekday: "long", day: "numeric", month: "long",
    }).format(new Date(2026, 6, 24)),
    [],
  );

  const role: Role = user?.role ?? "customer";
  const navEntries = role === "customer" ? CUSTOMER_NAV : AGENT_NAV;
  const sharedRecord = role === "customer" && user?.email !== DEMO_CUSTOMER_EMAIL;
  const unreadMessages = countUnreadMessages(demo, role);
  const displayName = user?.name ?? (role === "customer" ? "Alex Carter" : "Jordan Miller");
  const initials = initialsOf(displayName);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) return null;
        return (await readJson<{ user: AuthUser }>(response)).user;
      })
      .then(sessionUser => {
        if (!active) return;
        setUser(sessionUser);
        if (sessionUser) setActiveNav(homeNavFor(sessionUser.role));
      })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    fetch("/api/demo-state", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("The demo environment could not be loaded.");
        return readJson<{ state: DemoState }>(response);
      })
      .then(data => { if (active) setDemo(data.state); })
      .catch(error => {
        if (active) {
          notify("Environment unavailable",
            error instanceof Error ? error.message : "Please reload and try again.", "error");
        }
      })
      .finally(() => { if (active) setLoadedFor(user.email); });
    return () => { active = false; };
  }, [user]);

  async function startLogin(
    email: string, password: string, requestedRole?: Role, skipMfa = false,
  ) {
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, role: requestedRole, skipMfa }),
      });
      const data = await readJson<{
        challengeId?: string; destination?: string; user?: AuthUser; error?: string;
      }>(response);
      if (response.ok && data.user) {
        setUser(data.user);
        setChallenge(null);
        setActiveNav(homeNavFor(data.user.role));
        return;
      }
      if (!response.ok || !data.challengeId || !data.destination) {
        throw new Error(data.error ?? "Sign-in could not be completed.");
      }
      setChallenge({
        id: data.challengeId, destination: data.destination, email, password, requestedRole,
      });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign-in could not be completed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function verifyCode(code: string) {
    if (!challenge) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.id, code }),
      });
      const data = await readJson<{ user?: AuthUser; error?: string }>(response);
      if (!response.ok || !data.user) throw new Error(data.error ?? "The code could not be verified.");
      setUser(data.user);
      setChallenge(null);
      setActiveNav(homeNavFor(data.user.role));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "The code could not be verified.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setToast(null);
    setUser(null);
    setChallenge(null);
    setAuthError("");
    setActiveModal(null);
  }

  function notify(title: string, message: string, tone: "success" | "error" = "success") {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ title, message, tone });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 4200);
  }

  function friendlyActionError(status: number, apiError?: string): string {
    if (status === 403) return "That action is not available for your account.";
    if (status === 401) return "Your session ended. Sign in again to continue.";
    return apiError ?? "The change could not be saved.";
  }

  /**
   * A null `successTitle` runs the action silently: no success toast and no
   * error toast. Clearing a read marker is housekeeping the user did not ask
   * for, and announcing it would be chrome reporting on itself.
   */
  async function run(
    action: DemoStateAction,
    successTitle: string | null,
    successMessage: string,
    input: Record<string, unknown> = {},
    target: string | null = null,
  ): Promise<boolean> {
    if (demoBusy) return false;
    setDemoBusy(action);
    setBusyTarget(target);
    try {
      const response = await fetch("/api/demo-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...input }),
      });
      const data = await readJson<{ state?: DemoState; error?: string }>(response);
      if (!response.ok || !data.state) {
        throw new Error(friendlyActionError(response.status, data.error));
      }
      setDemo(data.state);
      if (successTitle !== null) notify(successTitle, successMessage);
      return true;
    } catch (error) {
      if (successTitle !== null) {
        notify("Action not saved",
          error instanceof Error ? error.message : "Please try again.", "error");
      }
      return false;
    } finally {
      setDemoBusy(null);
      setBusyTarget(null);
    }
  }

  const closeOn = (ok: boolean) => { if (ok) closeModal(); };

  const requestQuote = async (
    coverage: CoverageTier, addOns: AddOnId[], deductible: DeductibleChoice,
  ) => closeOn(await run("request-quote", "Quote ready",
    `Your ${coverage} quote is on the Policy screen, priced line by line.`,
    { coverage, addOns, deductible }));

  const acceptQuote = () => run("accept-quote", "Cover updated",
    "Your policy and your next invoice were reissued at the new price.");

  const discardQuote = () => run("discard-quote", "Quote discarded", "Your cover is unchanged.");

  const renewPolicy = () => run("renew-policy", "Policy renewed",
    "Another claim-free year was added to your bonus and the premium was recalculated with it.");

  const cancelPolicy = async (reason: string) => closeOn(
    await run("cancel-policy", "Policy cancelled",
      "Your cover has ended. You can get a new quote whenever you want to come back.", { reason }));

  const saveVehicle = async (vehicle: Omit<Vehicle, "id" | "updatedAt">, id: string | null) =>
    closeOn(await run(id ? "update-vehicle" : "add-vehicle",
      id ? "Vehicle updated" : "Vehicle added",
      "Any open quote was cleared, because the price was calculated for the old details.",
      id ? { vehicleId: id, vehicle } : { vehicle }));

  const removeVehicle = (vehicleId: string) => run("remove-vehicle", "Vehicle removed",
    "It is off the policy and out of the next price.", { vehicleId }, vehicleId);

  const saveDriver = async (driver: Omit<Driver, "id" | "isPrimary" | "updatedAt">, id: string | null) =>
    closeOn(await run(id ? "update-driver" : "add-driver",
      id ? "Driver updated" : "Driver added",
      "Any open quote was cleared, because the price was calculated for the old details.",
      id ? { driverId: id, driver } : { driver }));

  const removeDriver = (driverId: string) => run("remove-driver", "Driver removed",
    "They are no longer named on the policy.", { driverId }, driverId);

  const fileClaim = async (claim: Record<string, unknown>) => {
    const fastTracked = Number(claim.estimatedAmount) <= FAST_TRACK_CLAIM_LIMIT;
    const saved = await run("file-claim", "Claim filed",
      fastTracked
        ? `Estimates of ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} or less are approved automatically, so this claim is already approved.`
        : `Estimates above ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} go to an agent, so this claim is pending review.`,
      { claim });
    if (saved) { closeModal(); setActiveNav("claims"); }
  };

  const uploadDocument = async (document: { fileName: string; sizeLabel: string }) =>
    closeOn(await run("upload-claim-document", "Document attached",
      `${document.fileName} was attached. Nothing is stored: this demo records the file name only.`,
      { document }));

  const respondToReview = () => run("respond-to-claim-review", "Sent back for review",
    "Your agent can now continue reviewing the claim.");

  const requestAssistance = async (assistance: { kind: AssistanceKind; location: string }) =>
    closeOn(await run("request-assistance", "Help is on the way",
      "Your claims team can see the request and will dispatch a provider.", { assistance }));

  const payInvoice = async (invoiceId: string, payment: Record<string, unknown>) =>
    closeOn(await run("pay-invoice", "Payment accepted",
      "No money moved: this demo records the payment and nothing else.",
      { invoiceId, ...payment }));

  const saveCard = async (card: CardInput) => closeOn(
    await run("save-payment-method", "Card saved",
      "Only the last four digits are kept. The number itself is never stored.", { card }));

  const removeCard = (paymentMethodId: string) => run("remove-payment-method",
    "Card removed", "It is no longer available at checkout.", { paymentMethodId }, paymentMethodId);

  const changePlan = async (instalmentPlan: InstalmentPlan) => closeOn(
    await run("change-instalment-plan", "Billing plan changed",
      "Your open invoice was reissued at the new amount.", { instalmentPlan }));

  const startClaimReview = () => run("start-claim-review", "Review started",
    "The claim is assigned to you and the policyholder can see it.");

  const assignShop = async (repairShop: RepairShop) => closeOn(
    await run("assign-repair-shop", "Repair shop assigned",
      "The inspection can now be scheduled there.", { repairShop }));

  const scheduleInspection = () => run("schedule-inspection", "Inspection scheduled",
    "The claim is out for inspection and cannot be decided until it comes back.");

  const recordInspection = async (outcome: string, notes: string) => closeOn(
    await run("record-inspection", "Inspection recorded",
      "The claim is back on your desk with the finding attached.",
      { inspection: { outcome, notes } }));

  const decideClaim = async (action: ClaimDecisionAction, reviewNote: string) => {
    const copy = {
      "approve-claim": { title: "Claim approved", message: "Settle it to record the payout." },
      "reject-claim": { title: "Claim rejected", message: "Your note is visible to the policyholder." },
      "request-claim-information": { title: "More information requested", message: "The policyholder has to attach a document." },
    }[action];
    closeOn(await run(action, copy.title, copy.message, { reviewNote }));
  };

  const settleClaim = () => run("settle-claim", "Claim settled",
    "The payout is the estimate less the deductible, and the no-claims bonus is reset.");

  const dispatchAssistance = () => run("dispatch-assistance", "Provider dispatched",
    "The policyholder can see who is coming and when.");

  const completeAssistance = () => run("complete-assistance", "Assistance completed",
    "The request is closed and a new one can be raised.");

  const refundInvoice = async (invoiceId: string, reason: string) => closeOn(
    await run("refund-invoice", "Invoice refunded",
      "No money moved: this demo records the refund and nothing else.", { invoiceId, reason }));

  const lapsePolicy = () => run("lapse-policy", "Policy lapsed",
    "Cover has stopped. Paying what is overdue reinstates it.");

  const sendMessage = (messageBody: string) => run("send-message", "Message sent",
    role === "customer"
      ? "Your claims team can now read your message."
      : "The policyholder can now read your reply.",
    { messageBody });

  async function markMessagesRead() {
    if (demoBusy) return;
    try {
      const response = await fetch("/api/demo-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-messages-read" }),
      });
      const data = await readJson<{ state?: DemoState }>(response);
      if (response.ok && data.state) setDemo(data.state);
    } catch {
      // A failed read marker is not worth interrupting the user over.
    }
  }

  const openDirectory = (person: PolicyholderProfile | null = null) =>
    setActiveModal({ kind: "directory", person });

  const messageCenter = () => (
    <MessageCenter role={role} sharedRecord={sharedRecord} messages={demo.messages}
      busy={demoBusy !== null} unread={unreadMessages}
      onSend={sendMessage} onRead={markMessagesRead} />
  );

  const shared: ScreenProps = {
    demo, busyAction: demoBusy, busyTarget, setActiveModal, onGoTo: setActiveNav,
  };

  const customerDestinations: Record<CustomerNavId, () => ReactNode> = {
    home: () => <CustomerHome {...shared} sharedRecord={sharedRecord}
      firstName={displayName.split(/\s+/)[0] || "there"}
      onAcceptQuote={acceptQuote} onRenew={renewPolicy} />,
    policy: () => <PolicyView {...shared} sharedRecord={sharedRecord}
      onAcceptQuote={acceptQuote} onDiscardQuote={discardQuote} onRenew={renewPolicy}
      onRemoveVehicle={removeVehicle} onRemoveDriver={removeDriver} />,
    claims: () => <CustomerClaims {...shared} sharedRecord={sharedRecord} onRespond={respondToReview} />,
    billing: () => <BillingView {...shared} sharedRecord={sharedRecord} onRemoveCard={removeCard} />,
    messages: messageCenter,
  };

  const agentDestinations: Record<AgentNavId, () => ReactNode> = {
    today: () => <AgentToday {...shared} firstName={displayName.split(/\s+/)[0] || "there"}
      onOpenDirectory={openDirectory} onDispatch={dispatchAssistance} onComplete={completeAssistance} />,
    claims: () => <AgentClaims {...shared} onStartReview={startClaimReview}
      onScheduleInspection={scheduleInspection} onSettle={settleClaim} onOpenDirectory={openDirectory} />,
    book: () => <AgentPolicy {...shared} onLapse={lapsePolicy} onOpenDirectory={openDirectory} />,
    messages: messageCenter,
  };

  const destinations: Partial<Record<NavId, () => ReactNode>> =
    role === "customer" ? customerDestinations : agentDestinations;

  if (authLoading) return <AuthLoading />;
  if (!user) {
    return <AuthScreen challenge={challenge} busy={authBusy} error={authError}
      onLogin={startLogin} onVerify={verifyCode}
      onBack={() => { setChallenge(null); setAuthError(""); }}
      onResend={() => challenge && startLogin(challenge.email, challenge.password, challenge.requestedRole)} />;
  }

  const claim = openClaim(demo);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <nav className="mobile-nav" aria-label="Primary">
        {navEntries.map(entry => (
          <button key={entry.id} className={activeNav === entry.id ? "active" : ""}
            onClick={() => setActiveNav(entry.id)}>
            <span><Icon name={entry.icon} size={19} /></span>{entry.label}
          </button>
        ))}
      </nav>

      <aside className="sidebar">
        <BrandButton className="brand" role={role} onGoHome={() => setActiveNav(homeNavFor(role))}>
          <span className="brand-mark" aria-hidden="true"><i></i><b></b></span>
          <span>Northlane <strong>Auto</strong></span>
        </BrandButton>

        <div className="role-label">
          <span><Icon name="shield-check" size={13} /></span>
          {role === "customer" ? "Policyholder portal" : "Claims agent portal"}
        </div>

        <nav aria-label="Main navigation">
          <p className="nav-label">MENU</p>
          {navEntries.map(entry => (
            <button key={entry.id}
              className={activeNav === entry.id ? "nav-item active" : "nav-item"}
              onClick={() => setActiveNav(entry.id)}>
              <span className="nav-icon"><Icon name={entry.icon} size={18} /></span>
              {entry.label}
              {entry.id === "messages" && unreadMessages > 0 && (
                <span className="nav-badge">{unreadMessages}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-help">
          <span className="help-icon" aria-hidden="true"><Icon name="help-circle" size={18} /></span>
          <div><strong>Demo environment</strong><small>No support channel exists</small></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <BrandButton className="mobile-brand" role={role} onGoHome={() => setActiveNav(homeNavFor(role))}>
            <span className="brand-mark small" aria-hidden="true"><i></i><b></b></span>Northlane Auto
          </BrandButton>
          <div className="top-actions">
            <ThemeSwitch isDark={isDarkTheme} onChange={chooseTheme} />
            <button className="top-user" onClick={() => setActiveModal({ kind: "account" })}
              aria-label="Account settings">
              <span className="avatar">{initials}</span>
              <span>
                <strong>{displayName}</strong>
                <small>{role === "customer" ? "Policyholder · Account settings" : "Claims agent · Account settings"}</small>
              </span>
            </button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1}
          aria-busy={(user !== null && loadedFor !== user.email) || demoBusy !== null}>
          {(destinations[activeNav] ?? destinations[homeNavFor(role)])?.() ?? null}
        </main>

        <footer className="app-footer">
          <p>Northlane Auto Insurance is a fictional insurer for QA automation training. No policy exists, no claim is real, and no money moves.</p>
          <p>Demo data · {dateLabel}</p>
        </footer>
      </div>

      {activeModal?.kind === "quote" && <QuoteModal demo={demo} busy={demoBusy !== null} onClose={closeModal} onSubmit={requestQuote} />}
      {activeModal?.kind === "vehicle" && <VehicleModal vehicle={activeModal.vehicle} busy={demoBusy !== null} onClose={closeModal} onSubmit={saveVehicle} />}
      {activeModal?.kind === "driver" && <DriverModal driver={activeModal.driver} busy={demoBusy !== null} onClose={closeModal} onSubmit={saveDriver} />}
      {activeModal?.kind === "cancel-policy" && <CancelPolicyModal busy={demoBusy !== null} onClose={closeModal} onSubmit={cancelPolicy} />}
      {activeModal?.kind === "file-claim" && <FileClaimModal busy={demoBusy !== null} onClose={closeModal} onSubmit={fileClaim} />}
      {activeModal?.kind === "upload-document" && <UploadDocumentModal busy={demoBusy !== null} onClose={closeModal} onSubmit={uploadDocument} />}
      {activeModal?.kind === "assistance" && <AssistanceModal busy={demoBusy !== null} onClose={closeModal} onSubmit={requestAssistance} />}
      {activeModal?.kind === "payment" && <PaymentModal invoice={activeModal.invoice} methods={demo.paymentMethods} busy={demoBusy !== null} onClose={closeModal} onSubmit={payInvoice} />}
      {activeModal?.kind === "save-card" && <SaveCardModal busy={demoBusy !== null} onClose={closeModal} onSubmit={saveCard} />}
      {activeModal?.kind === "instalment" && <InstalmentModal policy={demo.policy} busy={demoBusy !== null} onClose={closeModal} onSubmit={changePlan} />}
      {activeModal?.kind === "certificate" && <CertificateModal demo={demo} onClose={closeModal} />}
      {activeModal?.kind === "claim-summary" && <ClaimSummaryModal claim={activeModal.claim} policyNumber={demo.policy.number} onClose={closeModal} />}
      {activeModal?.kind === "decision" && claim && <ClaimDecisionModal claim={claim} decision={activeModal.decision} busy={demoBusy !== null} onClose={closeModal} onSubmit={decideClaim} />}
      {activeModal?.kind === "repair-shop" && <RepairShopModal busy={demoBusy !== null} onClose={closeModal} onSubmit={assignShop} />}
      {activeModal?.kind === "inspection" && <InspectionModal busy={demoBusy !== null} onClose={closeModal} onSubmit={recordInspection} />}
      {activeModal?.kind === "refund" && <RefundModal invoice={activeModal.invoice} busy={demoBusy !== null} onClose={closeModal} onSubmit={refundInvoice} />}
      {activeModal?.kind === "directory" && <DirectoryModal demo={demo} initialPerson={activeModal.person} onClose={closeModal} />}
      {activeModal?.kind === "account" && <AccountModal user={user} onClose={closeModal}
        onDeleted={() => { closeModal(); setUser(null); setActiveNav(homeNavFor(role)); }} onSignOut={signOut} />}

      {toast && (
        <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          <span><Icon name={toast.tone === "error" ? "alert-circle" : "check"} size={16} /></span>
          <div><strong>{toast.title}</strong><p>{toast.message}</p></div>
          <button onClick={() => setToast(null)} aria-label="Close"><Icon name="close" size={17} /></button>
        </div>
      )}
    </div>
  );
}

/** What every screen needs from the root, and nothing more. */
type ScreenProps = {
  demo: DemoState;
  busyAction: DemoStateAction | null;
  busyTarget: string | null;
  setActiveModal: (modal: PortalModal) => void;
  onGoTo: (id: NavId) => void;
};

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

function AuthLoading() {
  return <main className="auth-shell">
    <div className="auth-loading" role="status">
      <span className="brand-mark" aria-hidden="true"><i></i><b></b></span>
      <p>Loading secure access…</p>
    </div>
  </main>;
}

function AuthScreen({ challenge, busy, error, onLogin, onVerify, onBack, onResend }: {
  challenge: Challenge | null;
  busy: boolean;
  error: string;
  onLogin: (email: string, password: string, requestedRole?: Role, skipMfa?: boolean) => Promise<void>;
  onVerify: (code: string) => Promise<void>;
  onBack: () => void;
  onResend: () => void;
}) {
  const [selectedAccess, setSelectedAccess] = useState<"customer" | "agent" | "create">("customer");
  const [newAccountRole, setNewAccountRole] = useState<Role>("customer");
  const [code, setCode] = useState("");
  const [copiedCredential, setCopiedCredential] = useState<"email" | "password" | null>(null);

  const credentials = selectedAccess === "customer"
    ? { email: DEMO_CUSTOMER_EMAIL, password: "CustomerDemo!2026", label: "Policyholder" }
    : selectedAccess === "agent"
      ? { email: "agent.demo@testrigor-mail.com", password: "AgentDemo!2026", label: "Claims agent" }
      : null;

  function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    void onLogin(
      String(form.get("demo-email") ?? ""),
      String(form.get("demo-password") ?? ""),
      selectedAccess === "create" ? newAccountRole : selectedAccess === "agent" ? "agent" : "customer",
      submitter?.value === "skip-mfa",
    );
  }

  async function copyCredential(type: "email" | "password", value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedCredential(type);
    window.setTimeout(() => setCopiedCredential(c => (c === type ? null : c)), 1600);
  }

  return <main className="auth-shell">
    <div className="auth-story">
      <div className="auth-brand">
        <span className="brand-mark" aria-hidden="true"><i></i><b></b></span>
        <span>Northlane <strong>Auto</strong></span>
      </div>
      <div className="auth-story-copy">
        <p className="eyebrow light">CAR INSURANCE, HANDLED</p>
        <h1>Quote, cover,<br />and claim in one place.</h1>
        <p>Policyholders and claims agents use the same secure sign-in, with a second verification step protecting every account.</p>
      </div>
      <div className="security-note">
        <span><Icon name="shield-check" size={18} /></span>
        <div>
          <strong>Two-step verification</strong>
          <small>Every account is protected by a password and a one-time code sent by email. The two shared demo accounts can skip the code entirely.</small>
        </div>
      </div>
    </div>

    <section className="auth-panel">
      <div className="auth-card">
        {!challenge ? <>
          <p className="eyebrow">WELCOME BACK</p>
          <h2>Sign in to Northlane Auto</h2>
          <p className="auth-subtitle">Use a demo account, or create a new policyholder or agent account.</p>

          <div className="account-tabs" role="group" aria-label="Choose an account type">
            <button type="button" className={selectedAccess === "customer" ? "active" : ""} onClick={() => { setSelectedAccess("customer"); setCopiedCredential(null); }}>Policyholder</button>
            <button type="button" className={selectedAccess === "agent" ? "active" : ""} onClick={() => { setSelectedAccess("agent"); setCopiedCredential(null); }}>Agent</button>
            <button type="button" className={selectedAccess === "create" ? "active" : ""} onClick={() => { setSelectedAccess("create"); setCopiedCredential(null); }}>Create account</button>
          </div>

          <form className="auth-form" key={selectedAccess} onSubmit={submitLogin} autoComplete="off">
            <label>Email address<input name="demo-email" type="email" autoComplete="off" placeholder="Enter your email address" required /></label>
            <label>Password<input name="demo-password" type="password" autoComplete="off" minLength={selectedAccess === "create" ? 8 : undefined} placeholder={selectedAccess === "create" ? "Create a password" : "Enter the demo password"} required /></label>
            {selectedAccess === "create" && <fieldset className="account-role-picker">
              <legend>Account type</legend>
              <div>
                <label className={newAccountRole === "customer" ? "selected" : ""}><input type="radio" name="new-account-role" value="customer" checked={newAccountRole === "customer"} onChange={() => setNewAccountRole("customer")} />Policyholder</label>
                <label className={newAccountRole === "agent" ? "selected" : ""}><input type="radio" name="new-account-role" value="agent" checked={newAccountRole === "agent"} onChange={() => setNewAccountRole("agent")} />Agent</label>
              </div>
            </fieldset>}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="primary-button auth-submit" type="submit" disabled={busy}>
              {busy ? "Starting verification…" : credentials ? `Continue as ${credentials.label}` : "Create account"}
            </button>
            {credentials && <button className="skip-mfa-button" type="submit" value="skip-mfa" disabled={busy}>
              {busy ? "Signing in…" : "Sign in without two-step verification"}
            </button>}
          </form>

          {credentials ? <div className="demo-credentials" aria-label={`${credentials.label} demo credentials`}>
            <div className="demo-credentials-heading"><strong>{credentials.label} demo credentials</strong><span>Copy and paste above</span></div>
            <div className="credential-row">
              <div><span>Email</span><code>{credentials.email}</code></div>
              <button type="button" onClick={() => void copyCredential("email", credentials.email)}>{copiedCredential === "email" ? "Copied" : "Copy"}</button>
            </div>
            <div className="credential-row">
              <div><span>Password</span><code>{credentials.password}</code></div>
              <button type="button" onClick={() => void copyCredential("password", credentials.password)}>{copiedCredential === "password" ? "Copied" : "Copy"}</button>
            </div>
            <p>Continue to receive a verification code by email, or use the button above to sign in without one.</p>
          </div> : <div className="demo-credentials" aria-label="New account instructions">
            <div className="demo-credentials-heading"><strong>Create a new account</strong><span>Password + verification code</span></div>
            <p>Choose whether you are a policyholder or an agent, then enter your email and create a password with at least 8 characters.</p>
            <p>Your account is saved once you enter the verification code on the next screen.</p>
          </div>}
        </> : <>
          <button className="auth-back" type="button" onClick={onBack}><Icon name="arrow-left" size={14} /> Back to sign in</button>
          <div className="mail-icon"><Icon name="mail" size={24} /></div>
          <p className="eyebrow">CHECK YOUR EMAIL</p>
          <h2>Enter your verification code</h2>
          <p className="auth-subtitle">We sent a six-digit code to <strong>{challenge.destination}</strong>. It expires in 10 minutes.</p>
          <form className="auth-form code-form" onSubmit={e => { e.preventDefault(); void onVerify(code); }}>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- this step exists only to
                type the code, and focus arrives here after a deliberate navigation,
                not on initial page load. */}
            <label>Verification code<input className="code-input" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" placeholder="000000" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="primary-button auth-submit" type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Verify and sign in"}</button>
          </form>
          <p className="resend-copy">Didn&apos;t receive it? <button type="button" onClick={onResend} disabled={busy}>Send a new code</button></p>
        </>}
      </div>
      <p className="privacy-copy">
        Protected access · Demo environment · No real policy data ·{" "}
        <button type="button" onClick={() => window.location.assign("/api-docs")}>QA API documentation</button>
      </p>
    </section>
  </main>;
}

function AccountModal({ user, onClose, onDeleted, onSignOut }: {
  user: AuthUser;
  onClose: () => void;
  onDeleted: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fixedDemoAccount = [DEMO_CUSTOMER_EMAIL, "agent.demo@testrigor-mail.com"].includes(user.email);

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmation }),
      });
      const data = await readJson<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || !data.ok) throw new Error(data.error ?? "The account could not be deleted.");
      onDeleted();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The account could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return <Modal confirmDiscard labelledBy="account-title" className="account-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">ACCOUNT</p>
    <h2 id="account-title">Account settings</h2>
    <p>Manage the signed-in account for this demonstration.</p>
    <dl className="review-details">
      <div><dt>Name</dt><dd>{user.name}</dd></div>
      <div><dt>Email</dt><dd>{user.email}</dd></div>
      <div><dt>Role</dt><dd>{user.role === "agent" ? "Claims agent" : "Policyholder"}</dd></div>
    </dl>
    {fixedDemoAccount ? <div className="protected-account">
      <span><Icon name="shield-check" size={18} /></span>
      <div><strong>Protected demo account</strong><p>Fixed accounts cannot be deleted, so shared QA credentials remain available.</p></div>
    </div> : <form className="danger-zone" onSubmit={deleteAccount}>
      <div><strong>Delete account permanently</strong><p>This removes the user, pending registrations, and verification challenges. The shared fictional policy data is not affected.</p></div>
      <label>Current password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <label>Type DELETE to confirm<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" required /></label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="danger-button full" type="submit" disabled={busy || !password || confirmation !== "DELETE"}>{busy ? "Deleting…" : "Delete my account"}</button>
    </form>}
    <button className="secondary-button full" onClick={() => void onSignOut()} disabled={busy}>Sign out</button>
  </Modal>;
}

/* -------------------------------------------------------------------------- */
/* Shared notices and cards                                                    */
/* -------------------------------------------------------------------------- */

function SharedRecordNotice() {
  return <section className="panel shared-record-notice" aria-label="Shared demo record">
    <span className="activity-icon coral"><Icon name="alert-circle" size={18} /></span>
    <div>
      <strong>You are looking at the shared demo record</strong>
      <p>The policy, vehicles, claims, and invoices below belong to <b>Alex Carter</b>, the fictional policyholder every demo account shares. Nothing here is yours, and nothing here is real.</p>
    </div>
  </section>;
}

/** Says plainly when cover has stopped, and what puts it back. */
function PolicyStatusBanner({ policy, onGoTo }: { policy: Policy; onGoTo: (id: NavId) => void }) {
  if (policy.status === "active") return null;
  const lapsed = policy.status === "lapsed";
  return <section className="panel shared-record-notice" aria-label="Policy status">
    <span className="activity-icon coral"><Icon name="alert-circle" size={18} /></span>
    <div>
      <strong>{lapsed ? "Your cover has lapsed" : "Your policy is cancelled"}</strong>
      <p>{policy.endedReason} {lapsed
        ? "Paying the overdue premium puts the cover straight back in force."
        : "You can get a new quote whenever you want to come back."}</p>
      <button className="primary-button" onClick={() => onGoTo(lapsed ? "billing" : "policy")}>
        {lapsed ? "Pay what is due" : "Get a new quote"}
      </button>
    </div>
  </section>;
}

function QuickCard({ color, icon, title, text, action, onClick, done = false, disabled = false }: {
  color: string; icon: IconName; title: string; text: string; action: string;
  onClick: () => void | Promise<unknown>; done?: boolean; disabled?: boolean;
}) {
  return <button className="quick-card" onClick={onClick} disabled={disabled}>
    <span className={`quick-icon ${color}`}><Icon name={done ? "check" : icon} size={20} /></span>
    <span><strong>{title}</strong><small>{text}</small><b>{action} <Icon name="arrow-right" size={13} /></b></span>
  </button>;
}

function Metric({ value, label, detail, tone }: {
  value: string; label: string; detail: string; tone: string;
}) {
  return <div className={`metric-card ${tone}`}><strong>{value}</strong><h2>{label}</h2><p>{detail}</p></div>;
}

/** The banner that names the single next thing the policyholder should do. */
function NextStep({ demo, busyAction, onAcceptQuote, onGoTo, setActiveModal }: {
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onAcceptQuote: () => void | Promise<unknown>;
  onGoTo: (id: NavId) => void;
  setActiveModal: (modal: PortalModal) => void;
}) {
  const claim = openClaim(demo);
  const due = unpaidInvoices(demo);

  if (demo.quote) {
    return <section className="next-step" aria-label="Next step">
      <div>
        <p className="eyebrow">NEXT STEP</p>
        <strong>A {demo.quote.coverage} quote is waiting</strong>
        <p>{formatMoney(demo.quote.annualPremium)} a year, {formatMoney(demo.quote.monthlyPremium)} a month. Accepting it {demo.quote.kind === "new-business" ? "issues a new policy" : "changes your cover and reissues your invoice"}.</p>
      </div>
      <button className="primary-button" disabled={busyAction !== null} onClick={() => void onAcceptQuote()}>
        <Icon name="check" size={17} /> {busyAction === "accept-quote" ? "Saving…" : "Accept this quote"}
      </button>
    </section>;
  }
  if (claim?.status === "more-info-needed") {
    return <section className="next-step" aria-label="Next step">
      <div><p className="eyebrow">NEXT STEP</p><strong>Your claim needs more information</strong><p>{claim.reviewNote}</p></div>
      <button className="primary-button" onClick={() => onGoTo("claims")}><Icon name="upload" size={17} /> Open the claim</button>
    </section>;
  }
  if (due.length > 0) {
    return <section className="next-step" aria-label="Next step">
      <div>
        <p className="eyebrow">NEXT STEP</p>
        <strong>{formatMoney(due[0].amount)} is due on {due[0].dueOn}</strong>
        <p>{due[0].description}. No money moves: this demo records the payment and nothing else.</p>
      </div>
      <button className="primary-button" onClick={() => setActiveModal({ kind: "payment", invoice: due[0] })}>
        <Icon name="credit-card" size={17} /> Pay now
      </button>
    </section>;
  }
  return <section className="next-step" aria-label="Next step">
    <div>
      <p className="eyebrow">NOTHING OUTSTANDING</p>
      <strong>Your policy is up to date</strong>
      <p>Change your cover to see a new price, renew early to bank another claim-free year, or file a claim.</p>
    </div>
    <button className="secondary-button" onClick={() => setActiveModal({ kind: "quote" })}>
      <Icon name="receipt" size={17} /> Get a new quote
    </button>
  </section>;
}

/* -------------------------------------------------------------------------- */
/* Policyholder screens                                                        */
/* -------------------------------------------------------------------------- */

function PolicyHero({ demo, onOpen }: { demo: DemoState; onOpen: () => void }) {
  const { policy, vehicles } = demo;
  const bonus = noClaimsDiscountPercent(policy.noClaimsYears);
  return <section className="hero-card" aria-label="Your policy">
    <div className="hero-copy">
      <span className="status-pill"><i></i> POLICY {policyStatusLabel(policy.status).toUpperCase()}</span>
      <p className="hero-date">Policy {policy.number} · renews {policy.renewsOn}</p>
      <h2>{policy.coverage} cover · {formatMoney(policy.deductible)} deductible</h2>
      <p className="hero-person">
        <span className="hero-person-avatar" aria-hidden="true"><Icon name="car" size={16} /></span>
        <span>
          <strong>{vehicles.length === 1 ? describeVehicle(vehicles[0]) : `${vehicles.length} vehicles covered`}</strong>
          <small>{bonus > 0 ? `${bonus}% no-claims bonus · ` : ""}{describeAddOns(policy.addOns)}</small>
        </span>
      </p>
    </div>
    <div className="hero-metric">
      <strong>{formatMoney(policy.annualPremium)}</strong>
      <span>per year</span>
      <button onClick={onOpen}>Open policy <Icon name="arrow-right" size={13} /></button>
    </div>
    <div className="hero-decoration" aria-hidden="true" />
  </section>;
}

function CustomerHome({ demo, busyAction, sharedRecord, firstName, onGoTo, setActiveModal, onAcceptQuote, onRenew }: ScreenProps & {
  sharedRecord: boolean;
  firstName: string;
  onAcceptQuote: () => void | Promise<unknown>;
  onRenew: () => void | Promise<unknown>;
}) {
  const { policy, quote } = demo;
  const todos = countCustomerTodos(demo);
  const claim = openClaim(demo);
  const due = unpaidInvoices(demo);
  const assistance = openAssistance(demo)[0];

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Hello, {firstName}.</h1>
        <p className="subtitle">{todos === 0 ? "Nothing needs your attention today." : todos === 1 ? "One thing needs your attention today." : `${todos} things need your attention today.`}</p>
      </div>
      <button className="primary-button" onClick={() => setActiveModal({ kind: "file-claim" })}
        disabled={hasOpenClaim(demo) || !isInForce(demo)}>
        <Icon name="plus" size={17} /> File a claim
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}
    <PolicyStatusBanner policy={policy} onGoTo={onGoTo} />
    <NextStep demo={demo} busyAction={busyAction} onAcceptQuote={onAcceptQuote} onGoTo={onGoTo} setActiveModal={setActiveModal} />
    <PolicyHero demo={demo} onOpen={() => onGoTo("policy")} />

    <div className="section-heading"><div><h2>Your cover</h2><p>Every card here reflects your current state.</p></div></div>
    <div className="quick-grid">
      {quote && <QuickCard color="sky" icon="receipt"
        title={`${quote.coverage} quote · ${formatMoney(quote.annualPremium)}/yr`}
        text={`Quoted ${quote.quotedAt}. ${quote.kind === "new-business" ? "Buying it issues a new policy." : "Accepting it changes your cover."}`}
        action="Open policy" onClick={() => onGoTo("policy")} />}

      {assistance && <QuickCard color="coral" icon="truck"
        title={`Roadside ${assistanceStatusLabel(assistance.status).toLowerCase()}`}
        text={`${assistance.kind} at ${assistance.location}${assistance.provider ? ` · ${assistance.provider}, ${assistance.etaMinutes} min` : ""}`}
        action="Open policy" onClick={() => onGoTo("policy")} />}

      {due.length > 0 ? <QuickCard color="violet" icon="credit-card"
        title={`${formatMoney(due[0].amount)} premium due`}
        text={`${due[0].description} · due ${due[0].dueOn}`}
        action="Open billing" onClick={() => onGoTo("billing")} />
        : <QuickCard color="green" icon="credit-card" title="Nothing outstanding"
          text="Every invoice on this policy has been settled." action="Open billing"
          onClick={() => onGoTo("billing")} done />}

      {claim ? <QuickCard
        color={claim.status === "rejected" ? "coral" : claim.status === "settled" ? "green" : "accent"}
        icon="clipboard" title={`Claim ${claim.reference} · ${claimStatusLabel(claim.status)}`}
        text={`${claim.type} on ${formatIsoDate(claim.incidentDate)} · estimate ${formatMoney(claim.estimatedAmount)}`}
        action="Open claims" onClick={() => onGoTo("claims")} />
        : <QuickCard color="coral" icon="clipboard" title="No open claim"
          text={`Estimates of ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} or less are approved automatically. Anything higher goes to an agent.`}
          action="Open claims" onClick={() => onGoTo("claims")} />}

      {policy.status === "active" && <QuickCard color="accent" icon="refresh"
        title={`Renew early · ${noClaimsDiscountPercent(policy.noClaimsYears + 1)}% bonus`}
        text={`You have ${policy.noClaimsYears} claim-free ${policy.noClaimsYears === 1 ? "year" : "years"}. Renewing banks another one and reprices the cover.`}
        action="Renew now" onClick={onRenew} disabled={busyAction !== null} />}
    </div>
  </div>;
}

function PolicyView({ demo, busyAction, busyTarget, sharedRecord, onGoTo, setActiveModal, onAcceptQuote, onDiscardQuote, onRenew, onRemoveVehicle, onRemoveDriver }: ScreenProps & {
  sharedRecord: boolean;
  onAcceptQuote: () => void | Promise<unknown>;
  onDiscardQuote: () => void | Promise<unknown>;
  onRenew: () => void | Promise<unknown>;
  onRemoveVehicle: (id: string) => void | Promise<unknown>;
  onRemoveDriver: (id: string) => void | Promise<unknown>;
}) {
  const { policy, vehicles, drivers, quote } = demo;
  const inForce = isInForce(demo);
  const bonus = noClaimsDiscountPercent(policy.noClaimsYears);
  const assistance = openAssistance(demo)[0];
  const hasRoadside = policy.addOns.includes("roadside");

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Policy</h1>
        <p className="subtitle">Your cover, the cars it protects, and the drivers it names.</p>
      </div>
      <button className="secondary-button" onClick={() => setActiveModal({ kind: "quote" })}>
        <Icon name="receipt" size={16} /> Get a quote
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}
    <PolicyStatusBanner policy={policy} onGoTo={onGoTo} />

    {quote && <section className="panel record-list" aria-label="Open quote">
      <div className="panel-heading">
        <div><h2>Quote {quote.reference}</h2><p>{quote.coverage} cover · {quote.kind === "new-business" ? "a new policy" : "a change to your current policy"} · quoted {quote.quotedAt}</p></div>
        <span className="review-status pending">Awaiting your decision</span>
      </div>
      <ul className="quote-breakdown">
        {quote.breakdown.map(line => (
          <li key={line.label}><span>{line.label}</span><span>{formatMoney(line.amount)}</span></li>
        ))}
        <li className="total"><span>Total each year</span><span>{formatMoney(quote.annualPremium)}</span></li>
      </ul>
      <dl className="review-details">
        <div><dt>Monthly</dt><dd>{formatMoney(quote.monthlyPremium)}</dd></div>
        <div><dt>Deductible</dt><dd>{formatMoney(quote.deductible)}</dd></div>
        <div><dt>Optional cover</dt><dd>{describeAddOns(quote.addOns)}</dd></div>
        <div><dt>Change from now</dt><dd>{quote.annualPremium === policy.annualPremium ? "No change" : `${quote.annualPremium > policy.annualPremium ? "+" : "−"}${formatMoney(Math.abs(quote.annualPremium - policy.annualPremium))} a year`}</dd></div>
      </dl>
      <button className="primary-button full" onClick={() => void onAcceptQuote()} disabled={busyAction !== null}>
        {busyAction === "accept-quote" ? "Saving…" : quote.kind === "new-business" ? "Buy this policy" : `Switch to ${quote.coverage} cover`}
      </button>
      <button className="secondary-button full" onClick={() => void onDiscardQuote()} disabled={busyAction !== null}>
        {busyAction === "discard-quote" ? "Discarding…" : "Discard this quote"}
      </button>
    </section>}

    <div className="document-grid">
      <article className="panel document-card">
        <span className="activity-icon accent"><Icon name="shield-check" size={18} /></span>
        <div>
          <p className="eyebrow">COVER</p>
          <h2>{policy.coverage}</h2>
          <p>{formatMoney(policy.annualPremium)} a year · {formatMoney(policy.deductible)} deductible · {describeAddOns(policy.addOns)}</p>
          <small>Policy {policy.number} · <span className={`review-status ${policyChipTone(policy.status)}`}>{policyStatusLabel(policy.status)}</span> · effective {policy.effectiveFrom}</small>
        </div>
        <button className="secondary-button" onClick={() => setActiveModal({ kind: "quote" })}>Change cover</button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon green"><Icon name="refresh" size={18} /></span>
        <div>
          <p className="eyebrow">RENEWAL AND BONUS</p>
          <h2>{bonus}% no-claims bonus</h2>
          <p>{policy.noClaimsYears} claim-free {policy.noClaimsYears === 1 ? "year" : "years"}. Renewing banks another one; settling a claim resets it to zero.</p>
          <small>Renews {policy.renewsOn}</small>
        </div>
        <button className="secondary-button" onClick={() => void onRenew()} disabled={!inForce || busyAction !== null}>
          {busyAction === "renew-policy" ? "Renewing…" : "Renew early"}
        </button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon sky"><Icon name="file-text" size={18} /></span>
        <div>
          <p className="eyebrow">DOCUMENT</p>
          <h2>Certificate of insurance</h2>
          <p>A one-page PDF naming the cover, the vehicles and the drivers, generated in your browser.</p>
          <small>Fictional. Not proof of anything.</small>
        </div>
        <button className="secondary-button" onClick={() => setActiveModal({ kind: "certificate" })}>Open certificate</button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon violet"><Icon name="truck" size={18} /></span>
        <div>
          <p className="eyebrow">ROADSIDE ASSISTANCE</p>
          <h2>{assistance ? assistanceStatusLabel(assistance.status) : hasRoadside ? "Ready when you need it" : "Not on your cover"}</h2>
          <p>{assistance
            ? `${assistance.kind} at ${assistance.location}.${assistance.provider ? ` ${assistance.provider} is on the way, about ${assistance.etaMinutes} minutes.` : " Your claims team will dispatch a provider."}`
            : hasRoadside
              ? "Towing, jump starts, flat tyres, lockouts and fuel delivery."
              : "Add roadside assistance to your cover to request help."}</p>
        </div>
        <button className="secondary-button" onClick={() => setActiveModal({ kind: "assistance" })}
          disabled={!hasRoadside || !inForce || Boolean(assistance)}>
          {assistance ? "Request open" : "Request assistance"}
        </button>
      </article>
    </div>

    <div className="section-heading">
      <div><h2>Vehicles</h2><p>Each one is rated separately and shows as its own line in a quote.</p></div>
    </div>
    <section className="panel record-list" aria-label="Vehicles on this policy">
      {vehicles.map(vehicle => (
        <article className="record-row" key={vehicle.id}>
          <span className="activity-icon sky"><Icon name="car" size={18} /></span>
          <div>
            <h2>{describeVehicle(vehicle)}</h2>
            <p>VIN {vehicle.vin} · plate {vehicle.plate} · {vehicle.primaryUse}</p>
            <small>{Number(vehicle.year) <= OLDER_VEHICLE_CUTOFF_YEAR ? "Older-vehicle surcharge applies · " : ""}last change: {vehicle.updatedAt}</small>
          </div>
          <button className="secondary-button" onClick={() => setActiveModal({ kind: "vehicle", vehicle })} disabled={!inForce}>Edit</button>
          <button className="danger-button" onClick={() => void onRemoveVehicle(vehicle.id)}
            disabled={!inForce || vehicles.length <= 1 || busyAction !== null}
            aria-label={`Remove ${describeVehicle(vehicle)}`}>
            {busyTarget === vehicle.id ? "Removing…" : <Icon name="trash" size={15} />}
          </button>
        </article>
      ))}
      <button className="secondary-button full" onClick={() => setActiveModal({ kind: "vehicle", vehicle: null })}
        disabled={!inForce || vehicles.length >= MAX_VEHICLES}>
        <Icon name="plus" size={16} /> Add a vehicle
      </button>
    </section>

    <div className="section-heading">
      <div><h2>Drivers</h2><p>The least experienced driver sets the policy surcharge, once.</p></div>
    </div>
    <section className="panel record-list" aria-label="Drivers on this policy">
      {drivers.map(driver => (
        <article className="record-row" key={driver.id}>
          <span className="activity-icon violet"><Icon name="id-card" size={18} /></span>
          <div>
            <h2>{driver.fullName}{driver.isPrimary ? " · policyholder" : ""}</h2>
            <p>Licence {driver.licenseNumber} · {driver.licenseState}</p>
            <small>{driver.yearsLicensed} years licensed{Number(driver.yearsLicensed) < NEW_DRIVER_YEARS ? " · new-driver surcharge applies" : ""}</small>
          </div>
          <button className="secondary-button" onClick={() => setActiveModal({ kind: "driver", driver })} disabled={!inForce}>Edit</button>
          <button className="danger-button" onClick={() => void onRemoveDriver(driver.id)}
            disabled={!inForce || driver.isPrimary || busyAction !== null}
            aria-label={`Remove ${driver.fullName}`}>
            {busyTarget === driver.id ? "Removing…" : <Icon name="trash" size={15} />}
          </button>
        </article>
      ))}
      <button className="secondary-button full" onClick={() => setActiveModal({ kind: "driver", driver: null })}
        disabled={!inForce || drivers.length >= MAX_DRIVERS}>
        <Icon name="plus" size={16} /> Add a driver
      </button>
    </section>

    {inForce && <section className="panel record-list" aria-label="End this policy">
      <div className="modal-danger-zone">
        <strong>No longer need this cover?</strong>
        <button className="danger-button full" onClick={() => setActiveModal({ kind: "cancel-policy" })}
          disabled={hasOpenClaim(demo)}>
          {hasOpenClaim(demo) ? "Close the open claim before cancelling" : "Cancel this policy"}
        </button>
      </div>
    </section>}
  </div>;
}

function ClaimDetail({ claim, policy }: { claim: Claim; policy: Policy }) {
  return <>
    <dl className="review-details">
      <div><dt>What happened</dt><dd>{claim.description}</dd></div>
      <div><dt>Your estimate</dt><dd>{formatMoney(claim.estimatedAmount)}</dd></div>
      <div><dt>Policy deductible</dt><dd>{formatMoney(policy.deductible)}</dd></div>
      {claim.thirdParty && <div><dt>Third party</dt><dd>{claim.thirdParty.name} · {claim.thirdParty.plate} · {claim.thirdParty.insurer}</dd></div>}
      {claim.repairShop && <div><dt>Repair shop</dt><dd>{claim.repairShop}</dd></div>}
      {claim.inspection && <div><dt>Inspection</dt><dd>{claim.inspection.scheduledFor}{claim.inspection.outcome ? ` · ${claim.inspection.outcome === "damage-confirmed" ? "damage confirmed" : "damage disputed"}` : " · not yet carried out"}{claim.inspection.notes ? ` — ${claim.inspection.notes}` : ""}</dd></div>}
      {claim.settlementAmount !== null && <div><dt>Settled for</dt><dd><b>{formatMoney(claim.settlementAmount)}</b> · estimate less {formatMoney(claim.settledDeductible ?? 0)} deductible</dd></div>}
      {claim.reviewNote && <div><dt>{claim.autoApproved ? "Why" : "Agent note"}</dt><dd>{claim.reviewNote}</dd></div>}
    </dl>
    <ol className="status-timeline" aria-label="Claim progress">
      {CLAIM_TIMELINE.map(step => (
        <li key={step.label} className={step.reachedWhen.includes(claim.status) ? "reached" : ""}>{step.label}</li>
      ))}
    </ol>
  </>;
}

function CustomerClaims({ demo, busyAction, sharedRecord, setActiveModal, onRespond }: ScreenProps & {
  sharedRecord: boolean;
  onRespond: () => void | Promise<unknown>;
}) {
  const { policy, claims } = demo;
  const claim = openClaim(demo);
  const history = claims.filter(item => item !== claim);
  const closed = claim ? claim.status === "settled" || claim.status === "rejected" : false;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Claims</h1>
        <p className="subtitle">{claim ? `Claim ${claim.reference} · ${claimStatusLabel(claim.status)}` : `${claims.length} closed ${claims.length === 1 ? "claim" : "claims"} on file, nothing open.`}</p>
      </div>
      <button className="primary-button" onClick={() => setActiveModal({ kind: "file-claim" })}
        disabled={hasOpenClaim(demo) || !isInForce(demo)}>
        <Icon name="plus" size={17} /> File a claim
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}

    {!claim && <section className="panel empty-panel" aria-label="No claim open">
      <p>{isInForce(demo)
        ? "Nothing is open on this policy. Filing a claim starts the review workflow the claims agent picks up."
        : "This policy is not in force, so no new claim can be filed against it."}</p>
      <button className="primary-button" onClick={() => setActiveModal({ kind: "file-claim" })} disabled={!isInForce(demo)}>
        <Icon name="plus" size={17} /> File a claim
      </button>
    </section>}

    {claim && <>
      {claim.status === "more-info-needed" && <section className="next-step" aria-label="Next step for your claim">
        <div><p className="eyebrow">NEXT STEP</p><strong>Your agent asked for more information</strong><p>{claim.reviewNote}</p></div>
        <button className="primary-button" onClick={() => setActiveModal({ kind: "upload-document" })}>
          <Icon name="upload" size={17} /> Attach a document
        </button>
      </section>}

      <section className="panel record-list" aria-label="Your claim">
        <div className="panel-heading">
          <div><h2>{claim.type} · {formatIsoDate(claim.incidentDate)}</h2><p>Filed {claim.filedAt} · reference {claim.reference}</p></div>
          <span className={`review-status ${claimChipTone(claim.status)}`}>{claimStatusLabel(claim.status)}</span>
        </div>
        <ClaimDetail claim={claim} policy={policy} />
      </section>

      <div className="section-heading"><div><h2>Documents</h2><p>Photos and paperwork attached to this claim.</p></div></div>
      <section className="panel record-list" aria-label="Claim documents">
        {claim.documents.length === 0
          ? <p className="empty-note">Nothing attached yet. A claim over {formatMoney(FAST_TRACK_CLAIM_LIMIT)} usually needs at least a photo.</p>
          : claim.documents.map(document => <article className="record-row" key={document.id}>
            <span className="activity-icon sky"><Icon name="paperclip" size={18} /></span>
            <div>
              <h2>{document.fileName}</h2>
              <p>{document.sizeLabel} · attached {document.uploadedAt}</p>
              <small>Recorded by name only. No file is stored or read.</small>
            </div>
            <span className="review-status">Attached</span>
            <span />
          </article>)}

        <button className="secondary-button full" onClick={() => setActiveModal({ kind: "upload-document" })} disabled={closed}>
          <Icon name="upload" size={16} /> Attach a document
        </button>
        {claim.status === "more-info-needed" && <button className="primary-button full"
          onClick={() => void onRespond()} disabled={busyAction !== null || claim.documents.length === 0}>
          {busyAction === "respond-to-claim-review" ? "Sending…" : "Send back for review"}
        </button>}
        <button className="secondary-button full" onClick={() => setActiveModal({ kind: "claim-summary", claim })}>
          <Icon name="download" size={16} /> Open claim summary
        </button>
      </section>
    </>}

    {history.length > 0 && <>
      <div className="section-heading"><div><h2>Claim history</h2><p>Closed claims stay on the record.</p></div></div>
      <section className="panel record-list" aria-label="Closed claims">
        {history.map(item => <article className="record-row" key={item.reference}>
          <span className={`activity-icon ${item.status === "rejected" ? "coral" : "green"}`}><Icon name="clipboard" size={18} /></span>
          <div>
            <h2>{item.type} · {formatIsoDate(item.incidentDate)}</h2>
            <p>{item.reference} · estimate {formatMoney(item.estimatedAmount)}{item.settlementAmount !== null ? ` · settled for ${formatMoney(item.settlementAmount)}` : ""}</p>
            <small>Filed {item.filedAt}</small>
          </div>
          <span className={`review-status ${claimChipTone(item.status)}`}>{claimStatusLabel(item.status)}</span>
          <button className="secondary-button" onClick={() => setActiveModal({ kind: "claim-summary", claim: item })}>Summary</button>
        </article>)}
      </section>
    </>}
  </div>;
}

function BillingView({ demo, busyAction, busyTarget, sharedRecord, setActiveModal, onRemoveCard }: ScreenProps & {
  sharedRecord: boolean;
  onRemoveCard: (id: string) => void | Promise<unknown>;
}) {
  const { policy, invoices, paymentMethods } = demo;
  const due = unpaidInvoices(demo);

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Billing</h1>
        <p className="subtitle">{due.length === 0 ? "Nothing is outstanding on this policy." : `${formatMoney(due[0].amount)} is due on ${due[0].dueOn}.`}</p>
      </div>
      <button className="secondary-button" onClick={() => setActiveModal({ kind: "instalment" })}>
        <Icon name="refresh" size={16} /> {policy.instalmentPlan === "annual" ? "Annual" : "Monthly"} plan
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}

    <div className="section-heading">
      <div><h2>Invoices</h2><p>{policy.instalmentPlan === "annual" ? "One payment a year" : "Twelve payments a year"} · {formatMoney(instalmentAmount(policy.annualPremium, policy.instalmentPlan))} each.</p></div>
    </div>
    <section className="panel record-list" aria-label="Invoices">
      {invoices.map(invoice => (
        <article className="record-row" key={invoice.id}>
          <span className={`activity-icon ${invoice.status === "paid" ? "green" : invoice.status === "refunded" ? "violet" : "coral"}`}>
            <Icon name="receipt" size={18} />
          </span>
          <div>
            <h2>{formatMoney(invoice.amount)}</h2>
            <p>{invoice.description} · due {invoice.dueOn}</p>
            <small>{invoice.status === "paid" ? `Paid with ${invoice.paidWith} on ${invoice.paidAt}`
              : invoice.status === "refunded" ? `Refunded ${invoice.refundedAt} — ${invoice.refundReason}`
              : "Not yet paid"}</small>
          </div>
          <span className={`review-status ${invoiceChipTone(invoice.status)}`}>{invoiceLabel(invoice.status)}</span>
          <button className="secondary-button" onClick={() => setActiveModal({ kind: "payment", invoice })}
            disabled={invoice.status !== "unpaid"}>
            {invoice.status === "unpaid" ? "Pay" : "Settled"}
          </button>
        </article>
      ))}
    </section>

    <div className="section-heading">
      <div><h2>Saved cards</h2><p>Only the last four digits are kept. The number itself is never stored.</p></div>
    </div>
    <section className="panel record-list" aria-label="Saved payment methods">
      {paymentMethods.length === 0
        ? <p className="empty-note">No cards saved. Saving one lets you pay without typing it again.</p>
        : paymentMethods.map(method => (
          <article className="record-row" key={method.id}>
            <span className="activity-icon accent"><Icon name="credit-card" size={18} /></span>
            <div>
              <h2>{method.label}</h2>
              <p>{method.nameOnCard} · expires {method.expiry}</p>
              <small>Saved {method.addedAt}</small>
            </div>
            <span className="review-status">Saved</span>
            <button className="danger-button" onClick={() => void onRemoveCard(method.id)}
              disabled={busyAction !== null} aria-label={`Remove ${method.label}`}>
              {busyTarget === method.id ? "Removing…" : <Icon name="trash" size={15} />}
            </button>
          </article>
        ))}
      <button className="secondary-button full" onClick={() => setActiveModal({ kind: "save-card" })}
        disabled={paymentMethods.length >= MAX_PAYMENT_METHODS}>
        <Icon name="plus" size={16} /> Save a card
      </button>
    </section>

    <p className="demo-disclaimer">Fake payment form · No card is charged and no money moves. Use {DEMO_CARD_NUMBER.replace(/(\d{4})(?=\d)/g, "$1 ")} with expiry {DEMO_CARD_EXPIRY} and CVV {DEMO_CARD_CVV}.</p>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Claims agent screens                                                        */
/* -------------------------------------------------------------------------- */

function AgentToday({ demo, busyAction, firstName, onGoTo, onOpenDirectory, onDispatch, onComplete }: ScreenProps & {
  firstName: string;
  onOpenDirectory: (person?: PolicyholderProfile | null) => void;
  onDispatch: () => void | Promise<unknown>;
  onComplete: () => void | Promise<unknown>;
}) {
  const claim = openClaim(demo);
  const awaitingYou = countClaimsAwaitingAgent(demo);
  const fixturesWaiting = queueFixtures.filter(item => item.waiting).length;
  const exposure = claim && !["rejected", "settled"].includes(claim.status) ? claim.estimatedAmount : 0;
  const assistance = openAssistance(demo)[0];

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">CLAIMS DASHBOARD</p>
        <h1>Good morning, {firstName}.</h1>
        <p className="subtitle">Claims and assistance from the policyholder portal, and the book they belong to.</p>
      </div>
      <button className="secondary-button" onClick={() => onOpenDirectory(null)}>
        <Icon name="search" size={16} /> Search policyholders
      </button>
    </div>

    <div className="metric-grid">
      <Metric value={String(awaitingYou + fixturesWaiting)} label="Claims awaiting you"
        detail={awaitingYou === 0 ? "None from the portal" : "One from the portal"} tone="sky" />
      <Metric value={formatMoney(exposure)} label="Open estimate"
        detail={exposure === 0 ? "Nothing open" : `Claim ${claim?.reference}`} tone="coral" />
      <Metric value={String(policyholders.length)} label="Policies in book" detail="Sample directory" tone="accent" />
    </div>

    <div className="agent-layout">
      <div className="panel queue-panel">
        <div className="panel-heading"><div><h2>Claim queue</h2><p>Friday, July 24</p></div></div>
        {claim && <div className="queue-row highlighted">
          <strong>{claim.reference}</strong>
          <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
          <div><b>Alex Carter</b><small>{claim.type} · {formatMoney(claim.estimatedAmount)} · policyholder portal</small></div>
          <span className={`queue-status${["submitted", "more-info-needed"].includes(claim.status) ? " waiting" : ""}`}>{claimStatusLabel(claim.status)}</span>
          <button aria-label={`Review claim ${claim.reference}`} onClick={() => onGoTo("claims")}>
            <Icon name="arrow-right" size={15} />
          </button>
        </div>}
        {queueFixtures.map(item => <div className="queue-row" key={item.reference}>
          <strong>{item.reference}</strong>
          <HolderAvatar name={item.holder} onOpen={onOpenDirectory} />
          <div><b>{item.holder}</b><small>{item.summary}</small></div>
          <span className={`queue-status${item.waiting ? " waiting" : ""}`}>{item.status}</span>
          <span />
        </div>)}
        {!claim && <p className="empty-note">Nothing new from the policyholder portal.</p>}
      </div>

      <div className="panel request-panel">
        <div className="panel-heading">
          <div><h2>Roadside</h2><p>Requests from the portal</p></div>
          {assistance && <span className="count-badge">1</span>}
        </div>
        {!assistance
          ? <p className="empty-note">No assistance request is open.</p>
          : <div className="request-card highlighted">
            <div className="request-top">
              <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
              <div><strong>Alex Carter</strong><small>{assistance.kind} · {assistance.location}</small></div>
              <span className={`review-status ${assistance.status === "requested" ? "pending" : ""}`}>{assistanceStatusLabel(assistance.status)}</span>
            </div>
            <p>Requested {assistance.requestedAt}.{assistance.provider ? ` ${assistance.provider}, about ${assistance.etaMinutes} minutes.` : ""}</p>
            <div className="request-actions">
              {assistance.status === "requested" && <button className="approve" onClick={() => void onDispatch()} disabled={busyAction !== null}>
                {busyAction === "dispatch-assistance" ? "Dispatching…" : "Dispatch a provider"}
              </button>}
              {assistance.status === "dispatched" && <button className="approve" onClick={() => void onComplete()} disabled={busyAction !== null}>
                {busyAction === "complete-assistance" ? "Closing…" : "Mark completed"}
              </button>}
            </div>
          </div>}
      </div>
    </div>
  </div>;
}

function AgentClaims({ demo, busyAction, setActiveModal, onStartReview, onScheduleInspection, onSettle, onOpenDirectory }: ScreenProps & {
  onStartReview: () => void | Promise<unknown>;
  onScheduleInspection: () => void | Promise<unknown>;
  onSettle: () => void | Promise<unknown>;
  onOpenDirectory: (person?: PolicyholderProfile | null) => void;
}) {
  const { policy, claims } = demo;
  const claim = openClaim(demo);
  const history = claims.filter(item => item !== claim);
  const glassWaived = claim ? claim.type === "Glass" && policy.addOns.includes("glass") : false;
  const payout = claim
    ? glassWaived ? claim.estimatedAmount : Math.max(0, claim.estimatedAmount - policy.deductible)
    : 0;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">CLAIMS DASHBOARD</p>
        <h1>Claims</h1>
        <p className="subtitle">Claims submitted from the policyholder portal that need a decision.</p>
      </div>
    </div>

    <section className="panel request-panel" aria-label="Claims from the policyholder portal">
      {!claim && <p className="empty-note">No claim is open. Anything the policyholder files appears here.</p>}

      {claim && <div className="request-card highlighted">
        <div className="request-top">
          <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
          <div><strong>Alex Carter</strong><small>{claim.reference} · {claim.type} · {formatIsoDate(claim.incidentDate)}</small></div>
          <span className={`review-status ${claimChipTone(claim.status)}`}>{claimStatusLabel(claim.status)}</span>
        </div>

        <dl className="review-details">
          <div><dt>Policy</dt><dd>{policy.number} · {policy.coverage} · {describeAddOns(policy.addOns)}</dd></div>
          <div><dt>What happened</dt><dd>{claim.description}</dd></div>
          <div><dt>Estimate</dt><dd>{formatMoney(claim.estimatedAmount)} · {claim.autoApproved ? "at or under" : "above"} the {formatMoney(FAST_TRACK_CLAIM_LIMIT)} fast-track limit</dd></div>
          <div><dt>Deductible</dt><dd>{formatMoney(policy.deductible)}{glassWaived ? " · waived by glass cover" : ""}</dd></div>
          <div><dt>Would settle for</dt><dd>{formatMoney(payout)}</dd></div>
          {claim.thirdParty && <div><dt>Third party</dt><dd>{claim.thirdParty.name} · {claim.thirdParty.plate} · {claim.thirdParty.insurer}</dd></div>}
          <div><dt>Repair shop</dt><dd>{claim.repairShop ?? "Not assigned"}</dd></div>
          {claim.inspection && <div><dt>Inspection</dt><dd>{claim.inspection.scheduledFor} at {claim.inspection.shop}{claim.inspection.outcome ? ` · ${claim.inspection.outcome === "damage-confirmed" ? "damage confirmed" : "damage disputed"} — ${claim.inspection.notes}` : " · not yet carried out"}</dd></div>}
          <div><dt>Documents</dt><dd>{claim.documents.length === 0 ? "None attached" : claim.documents.map(d => d.fileName).join(", ")}</dd></div>
          {claim.reviewNote && <div><dt>{claim.autoApproved ? "Why" : "Last note"}</dt><dd>{claim.reviewNote}</dd></div>}
        </dl>

        <div className="request-actions">
          {claim.status === "submitted" && <button className="approve" onClick={() => void onStartReview()} disabled={busyAction !== null}>
            {busyAction === "start-claim-review" ? "Opening…" : "Start review"}
          </button>}

          {claim.status === "in-review" && <>
            <button className="reject" onClick={() => setActiveModal({ kind: "repair-shop" })} disabled={busyAction !== null}>
              {claim.repairShop ? "Change repair shop" : "Assign repair shop"}
            </button>
            <button className="reject" onClick={() => void onScheduleInspection()} disabled={busyAction !== null || !claim.repairShop}>
              {busyAction === "schedule-inspection" ? "Scheduling…" : "Schedule inspection"}
            </button>
            <button className="reject" onClick={() => setActiveModal({ kind: "decision", decision: "request-claim-information" })} disabled={busyAction !== null}>Request information</button>
            <button className="reject" onClick={() => setActiveModal({ kind: "decision", decision: "reject-claim" })} disabled={busyAction !== null}>Reject</button>
            <button className="approve" onClick={() => setActiveModal({ kind: "decision", decision: "approve-claim" })} disabled={busyAction !== null}>Approve</button>
          </>}

          {claim.status === "inspection-scheduled" && <button className="approve" onClick={() => setActiveModal({ kind: "inspection" })} disabled={busyAction !== null}>
            Record the inspection
          </button>}

          {claim.status === "more-info-needed" && <button className="reject" disabled>Waiting on the policyholder</button>}

          {claim.status === "approved" && <button className="approve" onClick={() => void onSettle()} disabled={busyAction !== null}>
            {busyAction === "settle-claim" ? "Settling…" : `Settle for ${formatMoney(payout)}`}
          </button>}
        </div>

        <button className="text-action" onClick={() => setActiveModal({ kind: "claim-summary", claim })}>
          Generate claim summary <Icon name="arrow-right" size={13} />
        </button>
      </div>}

      {history.map(item => <div className="request-card" key={item.reference}>
        <div className="request-top">
          <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
          <div><strong>Alex Carter</strong><small>{item.reference} · {item.type} · {formatIsoDate(item.incidentDate)}</small></div>
          <span className={`review-status ${claimChipTone(item.status)}`}>{claimStatusLabel(item.status)}</span>
        </div>
        <p>{item.settlementAmount !== null ? `Settled for ${formatMoney(item.settlementAmount)}.` : "Closed without a payout."} {item.reviewNote}</p>
        <button className="text-action" onClick={() => setActiveModal({ kind: "claim-summary", claim: item })}>
          Generate claim summary <Icon name="arrow-right" size={13} />
        </button>
      </div>)}

      {queueFixtures.filter(item => !item.waiting).map(item => <div className="request-card" key={item.reference}>
        <div className="request-top">
          <HolderAvatar name={item.holder} onOpen={onOpenDirectory} />
          <div><strong>{item.holder}</strong><small>{item.reference} · {item.summary}</small></div>
          <span className="review-status">{item.status}</span>
        </div>
        <p>Closed in a previous cycle. Sample history, not an actionable claim.</p>
      </div>)}
    </section>
  </div>;
}

function AgentPolicy({ demo, busyAction, setActiveModal, onLapse, onOpenDirectory }: ScreenProps & {
  onLapse: () => void | Promise<unknown>;
  onOpenDirectory: (person?: PolicyholderProfile | null) => void;
}) {
  const { policy, vehicles, drivers, invoices } = demo;
  const due = unpaidInvoices(demo);

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">CLAIMS DASHBOARD</p>
        <h1>Policy</h1>
        <p className="subtitle">The policyholder&apos;s cover, billing, and the levers you hold over both.</p>
      </div>
      <button className="secondary-button" onClick={() => onOpenDirectory(null)}>
        <Icon name="search" size={16} /> Search policyholders
      </button>
    </div>

    <section className="panel record-list" aria-label="Policy summary">
      <div className="panel-heading">
        <div><h2>{policy.number}</h2><p>Alex Carter · effective {policy.effectiveFrom} · renews {policy.renewsOn}</p></div>
        <span className={`review-status ${policyChipTone(policy.status)}`}>{policyStatusLabel(policy.status)}</span>
      </div>
      <dl className="review-details">
        <div><dt>Cover</dt><dd>{policy.coverage} · {formatMoney(policy.annualPremium)} a year · {policy.instalmentPlan} billing</dd></div>
        <div><dt>Deductible</dt><dd>{formatMoney(policy.deductible)}</dd></div>
        <div><dt>Optional cover</dt><dd>{describeAddOns(policy.addOns)}</dd></div>
        <div><dt>No-claims bonus</dt><dd>{noClaimsDiscountPercent(policy.noClaimsYears)}% · {policy.noClaimsYears} claim-free {policy.noClaimsYears === 1 ? "year" : "years"}</dd></div>
        <div><dt>Vehicles</dt><dd>{vehicles.map(describeVehicle).join(", ")}</dd></div>
        <div><dt>Drivers</dt><dd>{drivers.map(d => `${d.fullName} (${d.yearsLicensed}y)`).join(", ")}</dd></div>
        {policy.endedReason && <div><dt>Ended</dt><dd>{policy.endedOn} — {policy.endedReason}</dd></div>}
      </dl>
      {policy.status === "active" && <div className="modal-danger-zone">
        <strong>Premium not paid by the due date?</strong>
        <button className="danger-button full" onClick={() => void onLapse()} disabled={busyAction !== null || due.length === 0}>
          {busyAction === "lapse-policy" ? "Lapsing…" : due.length === 0 ? "Nothing is overdue" : "Lapse this policy for non-payment"}
        </button>
      </div>}
    </section>

    <div className="section-heading"><div><h2>Invoices</h2><p>A paid invoice can be refunded, with a reason.</p></div></div>
    <section className="panel record-list" aria-label="Policy invoices">
      {invoices.map(invoice => (
        <article className="record-row" key={invoice.id}>
          <span className={`activity-icon ${invoice.status === "paid" ? "green" : invoice.status === "refunded" ? "violet" : "coral"}`}>
            <Icon name="receipt" size={18} />
          </span>
          <div>
            <h2>{formatMoney(invoice.amount)}</h2>
            <p>{invoice.description} · due {invoice.dueOn}</p>
            <small>{invoice.status === "paid" ? `Paid with ${invoice.paidWith}` : invoice.status === "refunded" ? `Refunded — ${invoice.refundReason}` : "Not yet paid"}</small>
          </div>
          <span className={`review-status ${invoiceChipTone(invoice.status)}`}>{invoiceLabel(invoice.status)}</span>
          <button className="secondary-button" onClick={() => setActiveModal({ kind: "refund", invoice })}
            disabled={invoice.status !== "paid"}>Refund</button>
        </article>
      ))}
    </section>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

function MessageCenter({ role, sharedRecord, messages, busy, unread, onSend, onRead }: {
  role: Role;
  sharedRecord: boolean;
  messages: DemoMessage[];
  busy: boolean;
  unread: number;
  onSend: (messageBody: string) => Promise<boolean>;
  onRead: () => void | Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");

  // Opening the thread is what marks it read, so the badge reflects reality.
  useEffect(() => {
    if (unread > 0) void onRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onSend(draft);
    if (saved) setDraft("");
  }

  return <div className="page-content message-page">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">{role === "customer" ? "POLICYHOLDER PORTAL" : "CLAIMS DASHBOARD"}</p>
        <h1>Messages</h1>
        <p className="subtitle">A shared demo conversation between Alex Carter and the claims team.</p>
      </div>
    </div>
    {sharedRecord && <SharedRecordNotice />}
    <section className="panel conversation-panel" aria-label="Claims team conversation">
      <header>
        <span className="person-avatar">{role === "customer" ? "CT" : "AC"}</span>
        <div>
          <strong>{role === "customer" ? "Claims team" : "Alex Carter"}</strong>
          <small>{role === "customer" ? "Northlane Auto" : "Policyholder portal"}</small>
        </div>
        <span className="conversation-status"><i></i> Sample conversation</span>
      </header>
      <div className="message-thread" aria-live="polite">
        {messages.length === 0 && <p className="message-empty">No messages yet. Anything you send appears here.</p>}
        {messages.map(message => <article key={message.id} className={message.sender === role ? "message-bubble own" : "message-bubble"}>
          <span>{message.sender === "customer" ? "Alex Carter" : "Claims team"}</span>
          <p>{message.body}</p>
          <time>{message.sentAt}</time>
        </article>)}
      </div>
      <form className="message-composer" onSubmit={submit}>
        <label htmlFor="message-body">Reply to {role === "customer" ? "your claims team" : "Alex Carter"}</label>
        <div>
          <textarea id="message-body" value={draft} onChange={e => setDraft(e.target.value)} maxLength={500} placeholder="Write a demo message…" required />
          <button className="primary-button" type="submit" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send message"}</button>
        </div>
        <small>{draft.length}/500 · No real policy information</small>
      </form>
    </section>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                     */
/* -------------------------------------------------------------------------- */

function QuoteModal({ demo, busy, onClose, onSubmit }: {
  demo: DemoState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (coverage: CoverageTier, addOns: AddOnId[], deductible: DeductibleChoice) => Promise<void>;
}) {
  const { policy } = demo;
  const newBusiness = !isInForce(demo);
  const [coverage, setCoverage] = useState<CoverageTier>(policy.coverage);
  const [addOns, setAddOns] = useState<AddOnId[]>(policy.addOns);
  const [deductible, setDeductible] = useState<DeductibleChoice>(policy.deductible);

  const unchanged = !newBusiness &&
    coverage === policy.coverage &&
    deductible === policy.deductible &&
    addOns.length === policy.addOns.length &&
    addOns.every(id => policy.addOns.includes(id));

  function toggle(id: AddOnId) {
    setAddOns(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  return <Modal labelledBy="quote-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">{newBusiness ? "NEW POLICY" : "CHANGE YOUR COVER"}</p>
    <h2 id="quote-title">{newBusiness ? "Price a new policy" : "Price a different cover"}</h2>
    <p>{newBusiness
      ? "Your previous policy has ended, so this is a fresh quote. A new policy starts its no-claims bonus from zero."
      : "The price is calculated against the vehicles and drivers on your policy. Your cover is unchanged until you accept."}</p>

    <form onSubmit={e => { e.preventDefault(); void onSubmit(coverage, addOns, deductible); }}>
      <fieldset>
        <legend>Coverage level</legend>
        <div className="coverage-options">
          {COVERAGE_TIERS.map(tier => (
            <label key={tier} className={coverage === tier ? "selected" : ""}>
              <input type="radio" name="coverage" value={tier} checked={coverage === tier} onChange={() => setCoverage(tier)} />
              <span>
                <b>{tier}{!newBusiness && tier === policy.coverage ? " · your current level" : ""}</b>
                <small>Base rate {formatMoney(COVERAGE_BASE_PREMIUM[tier])} a year, per vehicle</small>
              </span>
              <em>{formatMoney(COVERAGE_BASE_PREMIUM[tier])}</em>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Optional cover</legend>
        <div className="coverage-options">
          {ADD_ONS.map(addOn => (
            <label key={addOn.id} className={addOns.includes(addOn.id) ? "selected" : ""}>
              <input type="checkbox" name="addOns" value={addOn.id} checked={addOns.includes(addOn.id)} onChange={() => toggle(addOn.id)} />
              <span><b>{addOn.label}</b><small>{addOn.description}</small></span>
              <em>+{formatMoney(addOn.annualPremium)}</em>
            </label>
          ))}
        </div>
      </fieldset>

      <label>Deductible<select name="deductible" value={deductible}
        onChange={e => setDeductible(Number(e.target.value) as DeductibleChoice)}>
        {DEDUCTIBLE_CHOICES.map(choice => <option key={choice} value={choice}>{formatMoney(choice)}</option>)}
      </select></label>

      <p className="form-hint">Surcharges are added per vehicle for a {OLDER_VEHICLE_CUTOFF_YEAR} or older car and for business use, once for a driver licensed under {NEW_DRIVER_YEARS} years, and your no-claims bonus comes off the total.</p>
      <button className="primary-button full" type="submit" disabled={busy || unchanged}>
        {busy ? "Pricing…" : unchanged ? "Change something to get a price" : "Get this quote"}
      </button>
    </form>
  </Modal>;
}

function VehicleModal({ vehicle, busy, onClose, onSubmit }: {
  vehicle: Vehicle | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (vehicle: Omit<Vehicle, "id" | "updatedAt">, id: string | null) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      year: String(form.get("year") ?? ""), make: String(form.get("make") ?? ""),
      model: String(form.get("model") ?? ""), vin: String(form.get("vin") ?? ""),
      plate: String(form.get("plate") ?? ""),
    };
    const found = validateText(values, { year: 4, make: 40, model: 40, vin: 20, plate: 12 });
    if (!found.year && !/^(19|20)\d{2}$/.test(values.year.trim())) {
      found.year = "Enter a four-digit year between 1900 and 2099.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit({ ...values, primaryUse: String(form.get("primaryUse")) as Vehicle["primaryUse"] }, vehicle?.id ?? null);
  }

  return <Modal confirmDiscard labelledBy="vehicle-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">INSURED VEHICLE</p>
    <h2 id="vehicle-title">{vehicle ? "Update this vehicle" : "Add a vehicle"}</h2>
    <p>Use fictional vehicle details. Any change clears an open quote, because the price was calculated for the old ones.</p>
    <form onSubmit={submit} noValidate>
      <div className="field-row">
        <div><label>Year<input name="year" maxLength={4} inputMode="numeric" defaultValue={vehicle?.year ?? ""} {...fieldProps("year", errors)} /></label><FieldError name="year" errors={errors} /></div>
        <div><label>Make<input name="make" maxLength={40} defaultValue={vehicle?.make ?? ""} {...fieldProps("make", errors)} /></label><FieldError name="make" errors={errors} /></div>
      </div>
      <label>Model<input name="model" maxLength={40} defaultValue={vehicle?.model ?? ""} {...fieldProps("model", errors)} /></label>
      <FieldError name="model" errors={errors} />
      <label>VIN<input name="vin" maxLength={20} defaultValue={vehicle?.vin ?? ""} {...fieldProps("vin", errors)} /></label>
      <FieldError name="vin" errors={errors} />
      <div className="field-row">
        <div><label>Licence plate<input name="plate" maxLength={12} defaultValue={vehicle?.plate ?? ""} {...fieldProps("plate", errors)} /></label><FieldError name="plate" errors={errors} /></div>
        <label>Primary use<select name="primaryUse" defaultValue={vehicle?.primaryUse ?? "Commute"}>
          {VEHICLE_USES.map(use => <option key={use}>{use}</option>)}
        </select></label>
      </div>
      <p className="form-hint">All fields are required. Business use adds a surcharge for this vehicle.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : vehicle ? "Save vehicle" : "Add vehicle"}</button>
    </form>
  </Modal>;
}

function DriverModal({ driver, busy, onClose, onSubmit }: {
  driver: Driver | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (driver: Omit<Driver, "id" | "isPrimary" | "updatedAt">, id: string | null) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      fullName: String(form.get("fullName") ?? ""),
      licenseNumber: String(form.get("licenseNumber") ?? ""),
      licenseState: String(form.get("licenseState") ?? ""),
      yearsLicensed: String(form.get("yearsLicensed") ?? ""),
    };
    const found = validateText(values, { fullName: 80, licenseNumber: 30, licenseState: 40, yearsLicensed: 2 });
    if (!found.yearsLicensed && !/^\d{1,2}$/.test(values.yearsLicensed.trim())) {
      found.yearsLicensed = "Enter a whole number of years, 0 to 99.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit(values, driver?.id ?? null);
  }

  return <Modal confirmDiscard labelledBy="driver-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">NAMED DRIVER</p>
    <h2 id="driver-title">{driver ? "Update this driver" : "Add a driver"}</h2>
    <p>Use fictional licence details. Do not enter a real licence number.</p>
    <form onSubmit={submit} noValidate>
      <label>Full name<input name="fullName" maxLength={80} defaultValue={driver?.fullName ?? ""} {...fieldProps("fullName", errors)} /></label>
      <FieldError name="fullName" errors={errors} />
      <label>Licence number<input name="licenseNumber" maxLength={30} defaultValue={driver?.licenseNumber ?? ""} {...fieldProps("licenseNumber", errors)} /></label>
      <FieldError name="licenseNumber" errors={errors} />
      <div className="field-row">
        <div><label>Issuing state<input name="licenseState" maxLength={40} defaultValue={driver?.licenseState ?? ""} {...fieldProps("licenseState", errors)} /></label><FieldError name="licenseState" errors={errors} /></div>
        <div><label>Years licensed<input name="yearsLicensed" maxLength={2} inputMode="numeric" defaultValue={driver?.yearsLicensed ?? ""} {...fieldProps("yearsLicensed", errors)} /></label><FieldError name="yearsLicensed" errors={errors} /></div>
      </div>
      <p className="form-hint">All fields are required. Fewer than {NEW_DRIVER_YEARS} years licensed adds one surcharge to the policy.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : driver ? "Save driver" : "Add driver"}</button>
    </form>
  </Modal>;
}

function CancelPolicyModal({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <Modal confirmDiscard labelledBy="cancel-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">END THIS POLICY</p>
    <h2 id="cancel-title">Cancel your cover</h2>
    <p>Cover stops immediately and no claim can be filed against it afterwards. You can get a new quote at any time; a new policy starts its no-claims bonus from zero.</p>
    <form onSubmit={e => {
      e.preventDefault();
      const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
      const found = validateText({ reason }, { reason: 200 });
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, "reason"); return; }
      void onSubmit(reason);
    }} noValidate>
      <label>Why are you cancelling?<textarea name="reason" maxLength={200} placeholder="Sold the car." {...fieldProps("reason", errors)} /></label>
      <FieldError name="reason" errors={errors} />
      <p className="form-hint">Required, up to 200 characters. It is recorded on the policy.</p>
      <button className="danger-button full" type="submit" disabled={busy}>{busy ? "Cancelling…" : "Cancel this policy"}</button>
    </form>
  </Modal>;
}

function FileClaimModal({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (claim: Record<string, unknown>) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState("");
  const [withThirdParty, setWithThirdParty] = useState(false);

  const parsed = Number(estimate);
  const preview = Number.isInteger(parsed) && parsed > 0
    ? parsed <= FAST_TRACK_CLAIM_LIMIT
      ? `At or under ${formatMoney(FAST_TRACK_CLAIM_LIMIT)}, so this claim will be approved automatically.`
      : `Above ${formatMoney(FAST_TRACK_CLAIM_LIMIT)}, so this claim will start as pending review.`
    : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      incidentDate: String(form.get("incidentDate") ?? ""),
      description: String(form.get("description") ?? ""),
    };
    const found = validateText(values, { incidentDate: 20, description: 400 });
    const amount = Number(form.get("estimatedAmount"));
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > MAX_CLAIM_ESTIMATE) {
      found.estimatedAmount = `Enter a whole number of dollars between 1 and ${MAX_CLAIM_ESTIMATE.toLocaleString("en-US")}.`;
    }
    let thirdParty: Record<string, string> | null = null;
    if (withThirdParty) {
      thirdParty = {
        name: String(form.get("tpName") ?? ""), plate: String(form.get("tpPlate") ?? ""),
        insurer: String(form.get("tpInsurer") ?? ""),
      };
      Object.assign(found, validateText(
        { tpName: thirdParty.name, tpPlate: thirdParty.plate, tpInsurer: thirdParty.insurer },
        { tpName: 80, tpPlate: 12, tpInsurer: 80 },
      ));
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit({
      type: String(form.get("type")), incidentDate: values.incidentDate,
      description: values.description, estimatedAmount: amount, thirdParty,
    });
  }

  return <Modal confirmDiscard labelledBy="claim-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">NEW CLAIM</p>
    <h2 id="claim-title">File a claim</h2>
    <p>Describe a fictional incident. The estimate you enter decides whether an agent has to review it.</p>
    <form onSubmit={submit} noValidate>
      <label>Type of claim<select name="type" defaultValue="Collision">
        {CLAIM_TYPES.map(type => <option key={type} value={type}>{type} — {CLAIM_TYPE_HINTS[type]}</option>)}
      </select></label>
      <label>Date of the incident<input name="incidentDate" type="date" defaultValue="2026-07-18" max="2026-07-24" {...fieldProps("incidentDate", errors)} /></label>
      <FieldError name="incidentDate" errors={errors} />
      <label>What happened<textarea name="description" maxLength={400} placeholder="Describe the incident in a sentence or two" {...fieldProps("description", errors)} /></label>
      <FieldError name="description" errors={errors} />
      <label>Estimated repair cost (USD)<input name="estimatedAmount" inputMode="numeric" placeholder="1800"
        value={estimate} onChange={e => setEstimate(e.target.value.replace(/\D/g, "").slice(0, 6))}
        {...fieldProps("estimatedAmount", errors)} /></label>
      <FieldError name="estimatedAmount" errors={errors} />
      {preview && <p className="form-hint" aria-live="polite">{preview}</p>}

      <label className="switch-choice">
        <input type="checkbox" checked={withThirdParty} onChange={e => setWithThirdParty(e.target.checked)} />
        <b>Another driver was involved</b>
        <small>Their details go on the claim. All three fields are then required: half a set helps nobody.</small>
      </label>
      {withThirdParty && <>
        <label>Their name<input name="tpName" maxLength={80} {...fieldProps("tpName", errors)} /></label>
        <FieldError name="tpName" errors={errors} />
        <div className="field-row">
          <div><label>Their plate<input name="tpPlate" maxLength={12} {...fieldProps("tpPlate", errors)} /></label><FieldError name="tpPlate" errors={errors} /></div>
          <div><label>Their insurer<input name="tpInsurer" maxLength={80} {...fieldProps("tpInsurer", errors)} /></label><FieldError name="tpInsurer" errors={errors} /></div>
        </div>
      </>}

      <p className="form-hint">Whole dollars only, no cents. Use fictional details.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Filing…" : "File this claim"}</button>
    </form>
  </Modal>;
}

function UploadDocumentModal({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (document: { fileName: string; sizeLabel: string }) => Promise<void>;
}) {
  const [selected, setSelected] = useState<{ fileName: string; sizeLabel: string } | null>(null);
  const [error, setError] = useState("");

  return <Modal labelledBy="upload-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">CLAIM EVIDENCE</p>
    <h2 id="upload-title">Attach accident photos or documents</h2>
    <p>Nothing leaves your browser. The workflow records the file name and size so the claim can react, and the file itself is never read, uploaded, or stored.</p>
    <form onSubmit={e => {
      e.preventDefault();
      if (!selected) { setError("Choose a file to attach."); return; }
      void onSubmit(selected);
    }} noValidate>
      <label className="upload-field">
        <span>Choose a file</span>
        <input type="file" name="document" accept="image/*,.pdf" onChange={e => {
          const file = e.target.files?.[0];
          setError("");
          setSelected(file ? { fileName: file.name, sizeLabel: formatFileSize(file.size) } : null);
        }} />
      </label>
      {selected && <p className="form-hint" aria-live="polite">Ready to attach: <b>{selected.fileName}</b> ({selected.sizeLabel}).</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="form-hint">Any image or PDF is accepted. Do not attach anything real.</p>
      <button className="primary-button full" type="submit" disabled={busy || !selected}>{busy ? "Attaching…" : "Attach to my claim"}</button>
    </form>
  </Modal>;
}

/** Bytes as "1.4 MB". Only ever shown back to the person who picked the file. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AssistanceModal({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (assistance: { kind: AssistanceKind; location: string }) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <Modal confirmDiscard labelledBy="assistance-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">ROADSIDE ASSISTANCE</p>
    <h2 id="assistance-title">Request help</h2>
    <p>Your claims team sees the request straight away and dispatches a provider. No one is actually coming.</p>
    <form onSubmit={e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const location = String(form.get("location") ?? "");
      const found = validateText({ location }, { location: 160 });
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, "location"); return; }
      void onSubmit({ kind: String(form.get("kind")) as AssistanceKind, location });
    }} noValidate>
      <label>What do you need?<select name="kind" defaultValue="Tow">
        {ASSISTANCE_KINDS.map(kind => <option key={kind}>{kind}</option>)}
      </select></label>
      <label>Where are you?<input name="location" maxLength={160} placeholder="I-80 westbound, mile 42" {...fieldProps("location", errors)} /></label>
      <FieldError name="location" errors={errors} />
      <p className="form-hint">One request at a time. It closes when the provider marks it complete.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Sending…" : "Request assistance"}</button>
    </form>
  </Modal>;
}

function CardFields({ errors }: { errors: Record<string, string> }) {
  return <>
    <label>Name on card<input name="nameOnCard" maxLength={80} autoComplete="off" placeholder="Alex Carter" {...fieldProps("nameOnCard", errors)} /></label>
    <FieldError name="nameOnCard" errors={errors} />
    <label>Card number<input name="cardNumber" maxLength={19} inputMode="numeric" autoComplete="off" placeholder="4111 1111 1111 1111" {...fieldProps("cardNumber", errors)} /></label>
    <FieldError name="cardNumber" errors={errors} />
    <div className="field-row">
      <div><label>Expiry<input name="expiry" maxLength={5} autoComplete="off" placeholder="12/30" {...fieldProps("expiry", errors)} /></label><FieldError name="expiry" errors={errors} /></div>
      <div><label>CVV<input name="cvv" maxLength={3} inputMode="numeric" autoComplete="off" placeholder="123" {...fieldProps("cvv", errors)} /></label><FieldError name="cvv" errors={errors} /></div>
    </div>
    <p className="form-hint">
      The demo card <b>{DEMO_CARD_NUMBER.replace(/(\d{4})(?=\d)/g, "$1 ")}</b> with expiry <b>{DEMO_CARD_EXPIRY}</b> and CVV <b>{DEMO_CARD_CVV}</b> is accepted. Any other well-formed card is declined, so both outcomes are reachable.
    </p>
  </>;
}

function readCard(form: FormData): { values: CardInput; errors: Record<string, string> } {
  const values: CardInput = {
    nameOnCard: String(form.get("nameOnCard") ?? ""),
    cardNumber: String(form.get("cardNumber") ?? ""),
    expiry: String(form.get("expiry") ?? ""),
    cvv: String(form.get("cvv") ?? ""),
  };
  const errors = validateText(
    { nameOnCard: values.nameOnCard, cardNumber: values.cardNumber, expiry: values.expiry, cvv: values.cvv },
    { nameOnCard: 80, cardNumber: 19, expiry: 5, cvv: 3 },
  );
  if (!errors.cardNumber && !/^\d{16}$/.test(values.cardNumber.replace(/[\s-]/g, ""))) {
    errors.cardNumber = "Enter the 16 digits of the card.";
  }
  if (!errors.expiry && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(values.expiry.trim())) {
    errors.expiry = "Use MM/YY.";
  }
  if (!errors.cvv && !/^\d{3}$/.test(values.cvv.trim())) errors.cvv = "Enter the 3-digit CVV.";
  return { values, errors };
}

function PaymentModal({ invoice, methods, busy, onClose, onSubmit }: {
  invoice: Invoice;
  methods: PaymentMethod[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (invoiceId: string, payment: Record<string, unknown>) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [useSaved, setUseSaved] = useState(methods.length > 0);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (useSaved) { void onSubmit(invoice.id, { paymentMethodId: methodId }); return; }
    const { values, errors: found } = readCard(new FormData(event.currentTarget));
    setErrors(found);
    if (Object.keys(found).length > 0) { focusFirstInvalid(event.currentTarget, Object.keys(found)[0]); return; }
    void onSubmit(invoice.id, { card: values });
  }

  return <Modal confirmDiscard labelledBy="payment-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">PREMIUM PAYMENT</p>
    <h2 id="payment-title">Pay {formatMoney(invoice.amount)}</h2>
    <p>{invoice.description} · due {invoice.dueOn}. No card is charged and no money moves.</p>
    <form onSubmit={submit} noValidate>
      {methods.length > 0 && <fieldset>
        <legend>How would you like to pay?</legend>
        <div className="coverage-options">
          {methods.map(method => (
            <label key={method.id} className={useSaved && methodId === method.id ? "selected" : ""}>
              <input type="radio" name="payment-choice" checked={useSaved && methodId === method.id}
                onChange={() => { setUseSaved(true); setMethodId(method.id); }} />
              <span><b>{method.label}</b><small>{method.nameOnCard} · expires {method.expiry}</small></span>
              <em>Saved</em>
            </label>
          ))}
          <label className={!useSaved ? "selected" : ""}>
            <input type="radio" name="payment-choice" checked={!useSaved} onChange={() => setUseSaved(false)} />
            <span><b>Use a different card</b><small>Enter the details below.</small></span>
            <em>New</em>
          </label>
        </div>
      </fieldset>}
      {!useSaved && <CardFields errors={errors} />}
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Processing…" : `Pay ${formatMoney(invoice.amount)}`}</button>
    </form>
  </Modal>;
}

function SaveCardModal({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (card: CardInput) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <Modal confirmDiscard labelledBy="save-card-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">PAYMENT METHOD</p>
    <h2 id="save-card-title">Save a card</h2>
    <p>Only the last four digits, the expiry and the name are kept. The number itself is never stored anywhere.</p>
    <form onSubmit={e => {
      e.preventDefault();
      const { values, errors: found } = readCard(new FormData(e.currentTarget));
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, Object.keys(found)[0]); return; }
      void onSubmit(values);
    }} noValidate>
      <CardFields errors={errors} />
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : "Save this card"}</button>
    </form>
  </Modal>;
}

function InstalmentModal({ policy, busy, onClose, onSubmit }: {
  policy: Policy; busy: boolean; onClose: () => void; onSubmit: (plan: InstalmentPlan) => Promise<void>;
}) {
  const [plan, setPlan] = useState<InstalmentPlan>(policy.instalmentPlan);
  return <Modal labelledBy="instalment-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">BILLING</p>
    <h2 id="instalment-title">How you pay</h2>
    <p>Changing the plan reissues your open invoice at the new amount. The annual premium itself does not change.</p>
    <form onSubmit={e => { e.preventDefault(); void onSubmit(plan); }}>
      <fieldset>
        <legend>Instalment plan</legend>
        <div className="coverage-options">
          <label className={plan === "monthly" ? "selected" : ""}>
            <input type="radio" name="plan" checked={plan === "monthly"} onChange={() => setPlan("monthly")} />
            <span><b>Monthly{policy.instalmentPlan === "monthly" ? " · current" : ""}</b><small>Twelve payments a year</small></span>
            <em>{formatMoney(instalmentAmount(policy.annualPremium, "monthly"))}</em>
          </label>
          <label className={plan === "annual" ? "selected" : ""}>
            <input type="radio" name="plan" checked={plan === "annual"} onChange={() => setPlan("annual")} />
            <span><b>Annual{policy.instalmentPlan === "annual" ? " · current" : ""}</b><small>One payment a year</small></span>
            <em>{formatMoney(instalmentAmount(policy.annualPremium, "annual"))}</em>
          </label>
        </div>
      </fieldset>
      <button className="primary-button full" type="submit" disabled={busy || plan === policy.instalmentPlan}>
        {busy ? "Saving…" : plan === policy.instalmentPlan ? "That is your current plan" : "Switch plan"}
      </button>
    </form>
  </Modal>;
}

function RepairShopModal({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (shop: RepairShop) => Promise<void>;
}) {
  const [shop, setShop] = useState<RepairShop>(REPAIR_SHOPS[0]);
  return <Modal labelledBy="shop-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">REPAIR NETWORK</p>
    <h2 id="shop-title">Assign a repair shop</h2>
    <p>The inspection happens where the car goes, so a shop has to be assigned before one can be scheduled.</p>
    <form onSubmit={e => { e.preventDefault(); void onSubmit(shop); }}>
      <fieldset>
        <legend>Approved shops</legend>
        <div className="coverage-options">
          {REPAIR_SHOPS.map(name => (
            <label key={name} className={shop === name ? "selected" : ""}>
              <input type="radio" name="shop" checked={shop === name} onChange={() => setShop(name)} />
              <span><b>{name}</b><small>Approved network</small></span>
              <em><Icon name="wrench" size={16} /></em>
            </label>
          ))}
        </div>
      </fieldset>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Assigning…" : "Assign this shop"}</button>
    </form>
  </Modal>;
}

function InspectionModal({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (outcome: string, notes: string) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState("damage-confirmed");
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <Modal confirmDiscard labelledBy="inspection-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">INSPECTION</p>
    <h2 id="inspection-title">Record what the inspection found</h2>
    <p>The claim comes back to your desk either way. The outcome is evidence for the decision, not the decision itself.</p>
    <form onSubmit={e => {
      e.preventDefault();
      const notes = String(new FormData(e.currentTarget).get("notes") ?? "");
      const found = validateText({ notes }, { notes: 400 });
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, "notes"); return; }
      void onSubmit(outcome, notes);
    }} noValidate>
      <fieldset>
        <legend>Outcome</legend>
        <div className="coverage-options">
          <label className={outcome === "damage-confirmed" ? "selected" : ""}>
            <input type="radio" name="outcome" checked={outcome === "damage-confirmed"} onChange={() => setOutcome("damage-confirmed")} />
            <span><b>Damage confirmed</b><small>Consistent with what was reported</small></span><em>✓</em>
          </label>
          <label className={outcome === "damage-disputed" ? "selected" : ""}>
            <input type="radio" name="outcome" checked={outcome === "damage-disputed"} onChange={() => setOutcome("damage-disputed")} />
            <span><b>Damage disputed</b><small>Not consistent with what was reported</small></span><em>!</em>
          </label>
        </div>
      </fieldset>
      <label>Inspection notes<textarea name="notes" maxLength={400} placeholder="Rear panel and boot lid, as described." {...fieldProps("notes", errors)} /></label>
      <FieldError name="notes" errors={errors} />
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : "Record the inspection"}</button>
    </form>
  </Modal>;
}

function ClaimDecisionModal({ claim, decision, busy, onClose, onSubmit }: {
  claim: Claim;
  decision: ClaimDecisionAction;
  busy: boolean;
  onClose: () => void;
  onSubmit: (decision: ClaimDecisionAction, reviewNote: string) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const copy = {
    "approve-claim": {
      eyebrow: "APPROVE CLAIM", title: `Approve ${claim.reference}`,
      body: "Your note is shown to the policyholder alongside the decision. Approving does not release money: settling it does, and settling resets their no-claims bonus.",
      placeholder: "Damage is consistent with the photos and covered under the policy.",
      submit: "Approve this claim",
    },
    "reject-claim": {
      eyebrow: "REJECT CLAIM", title: `Reject ${claim.reference}`,
      body: "A rejection with no reason is the one thing a policyholder cannot act on, so the note is required.",
      placeholder: "The incident date falls outside the policy period.",
      submit: "Reject this claim",
    },
    "request-claim-information": {
      eyebrow: "REQUEST INFORMATION", title: `Ask for more on ${claim.reference}`,
      body: "The policyholder has to attach at least one document before the claim can come back to you.",
      placeholder: "Please attach a photo of the rear bumper and the repair quote.",
      submit: "Send this request",
    },
  }[decision];

  return <Modal confirmDiscard labelledBy="decision-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">{copy.eyebrow}</p>
    <h2 id="decision-title">{copy.title}</h2>
    <p>{copy.body}</p>
    <dl className="review-details">
      <div><dt>Policyholder</dt><dd>Alex Carter</dd></div>
      <div><dt>Claim</dt><dd>{claim.type} · {formatIsoDate(claim.incidentDate)}</dd></div>
      <div><dt>Estimate</dt><dd>{formatMoney(claim.estimatedAmount)}</dd></div>
      <div><dt>Inspection</dt><dd>{claim.inspection?.outcome ? (claim.inspection.outcome === "damage-confirmed" ? "Damage confirmed" : "Damage disputed") : "Not carried out"}</dd></div>
      <div><dt>Documents</dt><dd>{claim.documents.length === 0 ? "None attached" : `${claim.documents.length} attached`}</dd></div>
    </dl>
    <form onSubmit={e => {
      e.preventDefault();
      const reviewNote = String(new FormData(e.currentTarget).get("reviewNote") ?? "");
      const found = validateText({ reviewNote }, { reviewNote: 400 });
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, "reviewNote"); return; }
      void onSubmit(decision, reviewNote);
    }} noValidate>
      <label>Note to the policyholder<textarea name="reviewNote" maxLength={400} placeholder={copy.placeholder} {...fieldProps("reviewNote", errors)} /></label>
      <FieldError name="reviewNote" errors={errors} />
      <p className="form-hint">Required, up to 400 characters. Use fictional wording only.</p>
      <button className={decision === "reject-claim" ? "danger-button full" : "primary-button full"} type="submit" disabled={busy}>
        {busy ? "Saving…" : copy.submit}
      </button>
    </form>
  </Modal>;
}

function RefundModal({ invoice, busy, onClose, onSubmit }: {
  invoice: Invoice; busy: boolean; onClose: () => void;
  onSubmit: (invoiceId: string, reason: string) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return <Modal confirmDiscard labelledBy="refund-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">REFUND</p>
    <h2 id="refund-title">Refund {formatMoney(invoice.amount)}</h2>
    <p>{invoice.description}, paid with {invoice.paidWith}. No money moves: this demo records the refund and nothing else.</p>
    <form onSubmit={e => {
      e.preventDefault();
      const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
      const found = validateText({ reason }, { reason: 200 });
      setErrors(found);
      if (Object.keys(found).length > 0) { focusFirstInvalid(e.currentTarget, "reason"); return; }
      void onSubmit(invoice.id, reason);
    }} noValidate>
      <label>Why is this being refunded?<textarea name="reason" maxLength={200} placeholder="Duplicate charge after the cover change." {...fieldProps("reason", errors)} /></label>
      <FieldError name="reason" errors={errors} />
      <p className="form-hint">Required, up to 200 characters. It is shown to the policyholder.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Refunding…" : "Refund this invoice"}</button>
    </form>
  </Modal>;
}

function CertificateModal({ demo, onClose }: { demo: DemoState; onClose: () => void }) {
  const { policy, vehicles, drivers } = demo;

  function download() {
    downloadBlob(
      buildPdf(`Northlane Auto certificate ${policy.number}`, [
        { text: "Northlane Auto Insurance", size: 18, bold: true },
        { text: "Certificate of insurance", size: 13, bold: true, spaceBefore: 2 },
        { text: "FICTIONAL DEMONSTRATION DOCUMENT - NOT PROOF OF ANYTHING", size: 9, spaceBefore: 10 },
        { text: `Policy number: ${policy.number}`, spaceBefore: 14, bold: true },
        { text: `Status: ${policyStatusLabel(policy.status)}` },
        { text: `Cover: ${policy.coverage}` },
        { text: `Optional cover: ${describeAddOns(policy.addOns)}` },
        { text: `Deductible: ${formatMoney(policy.deductible)}` },
        { text: `Annual premium: ${formatMoney(policy.annualPremium)} (${policy.instalmentPlan})` },
        { text: `No-claims bonus: ${noClaimsDiscountPercent(policy.noClaimsYears)}% (${policy.noClaimsYears} years)` },
        { text: `Effective from: ${policy.effectiveFrom}` },
        { text: `Renews on: ${policy.renewsOn}` },
        { text: "Insured vehicles", spaceBefore: 14, bold: true },
        ...vehicles.map(v => ({ text: `- ${describeVehicle(v)}, VIN ${v.vin}, plate ${v.plate}, ${v.primaryUse}` })),
        { text: "Named drivers", spaceBefore: 14, bold: true },
        ...drivers.map(d => ({ text: `- ${d.fullName}${d.isPrimary ? " (policyholder)" : ""}, licence ${d.licenseNumber}, ${d.licenseState}` })),
        { text: "Issued by the Northlane Auto demo for QA automation training.", size: 9, spaceBefore: 18 },
      ]),
      `${policy.number.toLowerCase()}-certificate.pdf`,
    );
  }

  return <Modal labelledBy="certificate-title" className="detail-modal" dismissOnBackdrop onClose={onClose}>
    <p className="eyebrow">CERTIFICATE OF INSURANCE</p>
    <h2 id="certificate-title">{policy.number}</h2>
    <p>Alex Carter · {policy.coverage} cover · {policyStatusLabel(policy.status).toLowerCase()}</p>
    <table className="data-table">
      <caption>What the certificate states</caption>
      <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
      <tbody>
        <tr><th scope="row">Cover</th><td><b>{policy.coverage}</b> · {describeAddOns(policy.addOns)}</td></tr>
        <tr><th scope="row">Deductible</th><td>{formatMoney(policy.deductible)}</td></tr>
        <tr><th scope="row">Premium</th><td>{formatMoney(policy.annualPremium)} a year, billed {policy.instalmentPlan}</td></tr>
        <tr><th scope="row">Term</th><td>{policy.effectiveFrom} to {policy.renewsOn}</td></tr>
        <tr><th scope="row">Vehicles</th><td>{vehicles.map(describeVehicle).join(", ")}</td></tr>
        <tr><th scope="row">Drivers</th><td>{drivers.map(d => d.fullName).join(", ")}</td></tr>
      </tbody>
    </table>
    <p className="demo-disclaimer">All values are fictional and provided only for QA training.</p>
    <button className="primary-button full" onClick={download}><Icon name="download" size={15} /> Download PDF</button>
    <button className="secondary-button full" onClick={onClose}>Close</button>
  </Modal>;
}

function ClaimSummaryModal({ claim, policyNumber, onClose }: {
  claim: Claim; policyNumber: string; onClose: () => void;
}) {
  function download() {
    downloadBlob(buildCsv([
      ["Field", "Value"],
      ["Policyholder", "Alex Carter"],
      ["Policy", policyNumber],
      ["Claim reference", claim.reference],
      ["Type", claim.type],
      ["Incident date", formatIsoDate(claim.incidentDate)],
      ["Filed", claim.filedAt],
      ["Description", claim.description],
      ["Estimate", formatMoney(claim.estimatedAmount)],
      ["Status", claimStatusLabel(claim.status)],
      ["Decided automatically", claim.autoApproved ? "Yes" : "No"],
      ["Third party", claim.thirdParty ? `${claim.thirdParty.name} | ${claim.thirdParty.plate} | ${claim.thirdParty.insurer}` : "None"],
      ["Repair shop", claim.repairShop ?? "Not assigned"],
      ["Inspection", claim.inspection ? `${claim.inspection.scheduledFor} | ${claim.inspection.outcome ?? "not carried out"} | ${claim.inspection.notes ?? ""}` : "None"],
      ["Note", claim.reviewNote ?? "None"],
      ["Documents", claim.documents.length === 0 ? "None" : claim.documents.map(d => d.fileName).join(" | ")],
      ["Deductible applied", claim.settledDeductible === null ? "Not settled" : formatMoney(claim.settledDeductible)],
      ["Settlement", claim.settlementAmount === null ? "Not settled" : formatMoney(claim.settlementAmount)],
      ["Notice", "Fictional demo data for QA training. Not an insurance document and not advice."],
    ]), `${claim.reference.toLowerCase()}-summary.csv`);
  }

  return <Modal labelledBy="summary-title" className="detail-modal" dismissOnBackdrop onClose={onClose}>
    <p className="eyebrow">CLAIM SUMMARY</p>
    <h2 id="summary-title">{claim.reference}</h2>
    <p>Alex Carter · policy {policyNumber} · {claim.type} on {formatIsoDate(claim.incidentDate)}</p>
    <table className="data-table">
      <caption>Claim {claim.reference} summary</caption>
      <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
      <tbody>
        <tr><th scope="row">Status</th><td><b>{claimStatusLabel(claim.status)}</b></td></tr>
        <tr><th scope="row">Filed</th><td>{claim.filedAt}</td></tr>
        <tr><th scope="row">Estimate</th><td>{formatMoney(claim.estimatedAmount)}</td></tr>
        <tr><th scope="row">Decided automatically</th><td>{claim.autoApproved ? "Yes" : "No"}</td></tr>
        <tr><th scope="row">Third party</th><td>{claim.thirdParty ? `${claim.thirdParty.name} · ${claim.thirdParty.plate}` : "None"}</td></tr>
        <tr><th scope="row">Repair shop</th><td>{claim.repairShop ?? "Not assigned"}</td></tr>
        <tr><th scope="row">Documents</th><td>{claim.documents.length === 0 ? "None" : claim.documents.map(d => d.fileName).join(", ")}</td></tr>
        <tr><th scope="row">Settlement</th><td>{claim.settlementAmount === null ? "Not settled" : <b>{formatMoney(claim.settlementAmount)}</b>}</td></tr>
      </tbody>
    </table>
    {claim.reviewNote && <p className="review-status">{claim.reviewNote}</p>}
    <p className="demo-disclaimer">All values are fictional and provided only for QA training.</p>
    <button className="primary-button full" onClick={download}><Icon name="download" size={15} /> Download CSV</button>
    <button className="secondary-button full" onClick={onClose}>Close</button>
  </Modal>;
}

function DirectoryModal({ demo, initialPerson = null, onClose }: {
  demo: DemoState;
  initialPerson?: PolicyholderProfile | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PolicyholderProfile | null>(initialPerson);
  const results = policyholders.filter(person =>
    person.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const { policy, vehicles, drivers } = demo;
  const claim = openClaim(demo);
  const due = unpaidInvoices(demo);

  return <Modal labelledBy="directory-title" className="directory-modal" onClose={onClose}>
    {selected ? <>
      <button className="auth-back" type="button" onClick={() => setSelected(null)}>
        <Icon name="arrow-left" size={14} /> Back to results
      </button>
      <p className="eyebrow">POLICYHOLDER</p>
      <div className="directory-profile-heading">
        <span className="person-avatar">{selected.initials}</span>
        <div><h2 id="directory-title">{selected.name}</h2><p>{selected.email}</p></div>
      </div>
      <dl className="review-details">
        <div><dt>Policy number</dt><dd>{selected.name === "Alex Carter" ? policy.number : selected.policyNumber}</dd></div>
        <div><dt>Member since</dt><dd>{selected.memberSince}</dd></div>
        <div><dt>Vehicle</dt><dd>{selected.name === "Alex Carter" ? vehicles.map(describeVehicle).join(", ") : selected.vehicle}</dd></div>
        {selected.name === "Alex Carter" && <>
          <div><dt>Status</dt><dd>{policyStatusLabel(policy.status)}</dd></div>
          <div><dt>Cover</dt><dd>{policy.coverage} · {formatMoney(policy.annualPremium)} a year · {describeAddOns(policy.addOns)}</dd></div>
          <div><dt>No-claims bonus</dt><dd>{noClaimsDiscountPercent(policy.noClaimsYears)}%</dd></div>
          <div><dt>Named drivers</dt><dd>{drivers.map(d => `${d.fullName} (${d.yearsLicensed}y)`).join(", ")}</dd></div>
          <div><dt>Open claim</dt><dd>{claim ? `${claim.reference} · ${claimStatusLabel(claim.status)}` : "None"}</dd></div>
          <div><dt>Billing</dt><dd>{due.length === 0 ? "Nothing outstanding" : `${formatMoney(due[0].amount)} due ${due[0].dueOn}`}</dd></div>
        </>}
      </dl>
      <p className="demo-disclaimer">Sample data · Not a real policyholder</p>
    </> : <>
      <p className="eyebrow">POLICYHOLDER DIRECTORY</p>
      <h2 id="directory-title">Search policyholders</h2>
      <p>Find one of the five sample policyholders by name.</p>
      <label className="directory-input">
        <span>Policyholder name</span>
        <div><Icon name="search" size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name" /></div>
      </label>
      <div className="directory-results" aria-live="polite">
        {results.map(person => <button key={person.email} onClick={() => setSelected(person)}>
          <span className="person-avatar">{person.initials}</span>
          <span><strong>{person.name}</strong><small>{person.policyNumber} · {person.vehicle}</small></span>
          <Icon name="arrow-right" size={15} />
        </button>)}
        {results.length === 0 && <p>No policyholders found.</p>}
      </div>
    </>}
  </Modal>;
}
