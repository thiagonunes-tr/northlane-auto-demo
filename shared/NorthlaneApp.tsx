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
  COVERAGE_BASE_PREMIUM,
  COVERAGE_DEDUCTIBLE,
  COVERAGE_TIERS,
  DEFAULT_DEMO_STATE,
  DEMO_CARD_CVV,
  DEMO_CARD_EXPIRY,
  DEMO_CARD_NUMBER,
  FAST_TRACK_CLAIM_LIMIT,
  MAX_CLAIM_ESTIMATE,
  NEW_DRIVER_YEARS,
  OLDER_VEHICLE_CUTOFF_YEAR,
  VEHICLE_USES,
  claimStatusLabel,
  countClaimsAwaitingAgent,
  countCustomerTodos,
  countUnreadMessages,
  formatMoney,
  hasOpenClaim,
} from "../lib/demo-state";
import type {
  CardInput,
  Claim,
  ClaimStatus,
  ClaimType,
  CoverageTier,
  DemoMessage,
  DemoState,
  DemoStateAction,
  Driver,
  Vehicle,
  VehicleUse,
} from "../lib/demo-state";
import { Icon, type IconName } from "./Icon";
import { Modal } from "./Modal";
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
 * know. Every dialog in the app lives here rather than in the screen that
 * opens it, which is what makes "at most one dialog is mounted" structural
 * instead of a rule someone has to remember: two mounted dialogs mean two
 * focus traps and two Escape listeners fighting each other.
 */
type PortalModal =
  | null
  | { kind: "account" }
  | { kind: "quote" }
  | { kind: "vehicle" }
  | { kind: "driver" }
  | { kind: "file-claim" }
  | { kind: "upload-document" }
  | { kind: "payment" }
  | { kind: "claim-summary" }
  | { kind: "directory"; person: PolicyholderProfile | null }
  | { kind: "decision"; decision: ClaimDecisionAction };

type AuthUser = { email: string; name: string; role: Role };
type CodeDelivery = "fixed" | "email";
type Challenge = {
  id: string;
  destination: string;
  email: string;
  password: string;
  requestedRole?: Role;
  delivery: CodeDelivery;
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
 * Closed claims belonging to the other policyholders. They give the agent's
 * queue the texture of a real book of business, and they are deliberately
 * inert: only the live claim in the shared state can be acted on.
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
type AgentNavId = "today" | "claims" | "messages";
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
  { id: "messages", label: "Messages", icon: "message" },
];

/** The four stages a claim passes through, and which statuses have reached each. */
const CLAIM_TIMELINE: { label: string; reachedWhen: ClaimStatus[] }[] = [
  { label: "Filed", reachedWhen: ["submitted", "in-review", "more-info-needed", "approved", "rejected", "settled"] },
  { label: "In review", reachedWhen: ["in-review", "more-info-needed", "approved", "rejected", "settled"] },
  { label: "Decision", reachedWhen: ["approved", "rejected", "settled"] },
  { label: "Settled", reachedWhen: ["settled"] },
];

const CLAIM_TYPES_WITH_HINT: { type: ClaimType; hint: string }[] = [
  { type: "Collision", hint: "Contact with another vehicle or object" },
  { type: "Theft", hint: "The vehicle or its parts were stolen" },
  { type: "Glass", hint: "Windscreen or window damage only" },
  { type: "Weather", hint: "Hail, flood, or storm damage" },
];

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

function policyholderFor(name: string): PolicyholderProfile | null {
  return policyholders.find(person => person.name === name) ?? null;
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

/** Renders a name as a profile button when it is in the directory, plain otherwise. */
function HolderAvatar({ name, onOpen }: {
  name: string;
  onOpen: (person: PolicyholderProfile) => void;
}) {
  const person = policyholderFor(name);
  if (!person) {
    return <span className="person-avatar">{initialsOf(name)}</span>;
  }
  return <PersonAvatarButton person={person} onOpen={onOpen} />;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase())
      .join("") || "NA"
  );
}

/** Where each role lands after signing in. */
function homeNavFor(role: Role): NavId {
  return role === "customer" ? "home" : "today";
}

/** The name of that destination, so the logo can say where it goes. */
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

/** Props that wire an input to its error message for assistive tech. */
function fieldProps(name: string, errors: Record<string, string>) {
  return errors[name]
    ? { "aria-invalid": true as const, "aria-describedby": `${name}-error` }
    : {};
}

/** The error <p> sits after the wrapping <label>, so query the control by name. */
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
  // Read once via a lazy initialiser rather than in an effect: setting state
  // synchronously in an effect body triggers a cascading render. The guard
  // covers the Worker render, where localStorage does not exist.
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

/**
 * A two-position switch rather than a three-option menu: the sun and the moon
 * name the two outcomes, and role="switch" gives assistive tech the on/off
 * semantics a menu of three values would not.
 */
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

/** Maps a claim status onto the chip tones the rest of the app already uses. */
function claimChipTone(status: ClaimStatus): string {
  if (status === "submitted" || status === "in-review") return "pending";
  if (status === "more-info-needed") return "pending";
  if (status === "rejected") return "declined";
  if (status === "approved" || status === "settled") return "";
  return "neutral";
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
  // Derived rather than stored: setting state synchronously inside an effect
  // body triggers cascading renders. Track which account's state has landed.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState<DemoStateAction | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(new Date(2026, 6, 24)),
    [],
  );

  const role: Role = user?.role ?? "customer";
  const navEntries = role === "customer" ? CUSTOMER_NAV : AGENT_NAV;
  // A personal account shares Alex Carter's policy record; say so plainly.
  const sharedRecord = role === "customer" && user?.email !== DEMO_CUSTOMER_EMAIL;
  const unreadMessages = countUnreadMessages(demo, role);
  const displayName = user?.name ?? (role === "customer" ? "Alex Carter" : "Jordan Miller");
  const initials = initialsOf(displayName);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) return null;
        const data = (await response.json()) as { user: AuthUser };
        return data.user;
      })
      .then(sessionUser => {
        if (!active) return;
        setUser(sessionUser);
        // A restored session must land on a destination its role actually has.
        if (sessionUser) setActiveNav(homeNavFor(sessionUser.role));
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    fetch("/api/demo-state", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("The demo environment could not be loaded.");
        return response.json() as Promise<{ state: DemoState }>;
      })
      .then(data => {
        if (active) setDemo(data.state);
      })
      .catch(error => {
        if (active) {
          notify(
            "Environment unavailable",
            error instanceof Error ? error.message : "Please reload and try again.",
            "error",
          );
        }
      })
      .finally(() => {
        if (active) setLoadedFor(user.email);
      });
    return () => {
      active = false;
    };
  }, [user]);

  async function startLogin(
    email: string,
    password: string,
    requestedRole?: Role,
    skipMfa = false,
  ) {
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, role: requestedRole, skipMfa }),
      });
      const data = (await response.json()) as {
        challengeId?: string;
        destination?: string;
        codeDelivery?: CodeDelivery;
        user?: AuthUser;
        error?: string;
      };
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
        id: data.challengeId,
        destination: data.destination,
        email,
        password,
        requestedRole,
        delivery: data.codeDelivery === "email" ? "email" : "fixed",
      });
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Sign-in could not be completed.",
      );
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
      const data = (await response.json()) as { user?: AuthUser; error?: string };
      if (!response.ok || !data.user) {
        throw new Error(data.error ?? "The code could not be verified.");
      }
      setUser(data.user);
      setChallenge(null);
      setActiveNav(homeNavFor(data.user.role));
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "The code could not be verified.",
      );
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

  function notify(
    title: string,
    message: string,
    tone: "success" | "error" = "success",
  ) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ title, message, tone });
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 4200);
  }

  /**
   * The API's error strings are part of its documented contract and are
   * written for an integrator. Two of them name the other role, which reads as
   * a non-sequitur to the person who just clicked something.
   */
  function friendlyActionError(status: number, apiError?: string): string {
    if (status === 403) return "That action is not available for your account.";
    if (status === 401) return "Your session ended. Sign in again to continue.";
    if (status === 409) {
      return `${apiError ?? "This step is not available yet."}`;
    }
    return apiError ?? "The change could not be saved.";
  }

  /**
   * A null `successTitle` runs the action silently: no success toast and no
   * error toast. Clearing a read marker is housekeeping the user did not ask
   * for, and announcing it would be chrome reporting on itself.
   */
  async function performDemoAction(
    action: DemoStateAction,
    successTitle: string | null,
    successMessage: string,
    input: {
      coverage?: CoverageTier;
      vehicle?: Omit<Vehicle, "updatedAt">;
      driver?: Omit<Driver, "updatedAt">;
      claim?: {
        type: ClaimType;
        incidentDate: string;
        description: string;
        estimatedAmount: number;
      };
      document?: { fileName: string; sizeLabel: string };
      reviewNote?: string;
      card?: CardInput;
      messageBody?: string;
    } = {},
  ): Promise<boolean> {
    if (demoBusy) return false;
    setDemoBusy(action);
    try {
      const response = await fetch("/api/demo-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...input }),
      });
      const data = (await response.json()) as { state?: DemoState; error?: string };
      if (!response.ok || !data.state) {
        throw new Error(friendlyActionError(response.status, data.error));
      }
      setDemo(data.state);
      if (successTitle !== null) notify(successTitle, successMessage);
      return true;
    } catch (error) {
      if (successTitle !== null) {
        notify(
          "Action not saved",
          error instanceof Error ? error.message : "Please try again.",
          "error",
        );
      }
      return false;
    } finally {
      setDemoBusy(null);
    }
  }

  /* ---- customer actions ---- */

  async function requestQuote(coverage: CoverageTier) {
    const priced = COVERAGE_BASE_PREMIUM[coverage];
    const saved = await performDemoAction(
      "request-quote",
      "Quote ready",
      `Your ${coverage} quote starts from ${formatMoney(priced)} a year. Review it before accepting.`,
      { coverage },
    );
    if (saved) closeModal();
  }

  async function acceptQuote() {
    const saved = await performDemoAction(
      "accept-quote",
      "Coverage changed",
      "Your policy and your next invoice were reissued at the new price.",
    );
    if (saved) closeModal();
  }

  async function discardQuote() {
    await performDemoAction(
      "discard-quote",
      "Quote discarded",
      "Your policy is unchanged.",
    );
  }

  async function updateVehicle(vehicle: Omit<Vehicle, "updatedAt">) {
    const saved = await performDemoAction(
      "update-vehicle",
      "Vehicle updated",
      "Any open quote was cleared, because the price was calculated for the old vehicle.",
      { vehicle },
    );
    if (saved) closeModal();
  }

  async function updateDriver(driver: Omit<Driver, "updatedAt">) {
    const saved = await performDemoAction(
      "update-driver",
      "Driver updated",
      "Any open quote was cleared, because the price was calculated for the old driver.",
      { driver },
    );
    if (saved) closeModal();
  }

  async function fileClaim(claim: {
    type: ClaimType;
    incidentDate: string;
    description: string;
    estimatedAmount: number;
  }) {
    const fastTracked = claim.estimatedAmount <= FAST_TRACK_CLAIM_LIMIT;
    const saved = await performDemoAction(
      "file-claim",
      "Claim filed",
      fastTracked
        ? `Estimates of ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} or less are approved automatically, so this claim is already approved.`
        : `Estimates above ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} go to an agent, so this claim is pending review.`,
      { claim },
    );
    if (saved) {
      closeModal();
      setActiveNav("claims");
    }
  }

  async function uploadDocument(document: { fileName: string; sizeLabel: string }) {
    const saved = await performDemoAction(
      "upload-claim-document",
      "Document attached",
      `${document.fileName} was attached to your claim. Nothing is stored: this demo records the file name only.`,
      { document },
    );
    if (saved) closeModal();
  }

  async function respondToReview() {
    await performDemoAction(
      "respond-to-claim-review",
      "Sent back for review",
      "Your agent can now continue reviewing the claim.",
    );
  }

  async function payInvoice(card: CardInput) {
    const saved = await performDemoAction(
      "pay-invoice",
      "Payment accepted",
      "No money moved: this demo records the payment and nothing else.",
      { card },
    );
    if (saved) closeModal();
  }

  /* ---- agent actions ---- */

  async function startClaimReview() {
    await performDemoAction(
      "start-claim-review",
      "Review started",
      "The claim is now assigned to you and the policyholder can see it.",
    );
  }

  async function decideClaim(action: ClaimDecisionAction, reviewNote: string) {
    const copy = {
      "approve-claim": {
        title: "Claim approved",
        message: "The policyholder can see the decision. Settle it to record the payout.",
      },
      "reject-claim": {
        title: "Claim rejected",
        message: "Your note is now visible to the policyholder.",
      },
      "request-claim-information": {
        title: "More information requested",
        message: "The policyholder has to attach a document before the claim comes back.",
      },
    }[action];
    const saved = await performDemoAction(action, copy.title, copy.message, {
      reviewNote,
    });
    if (saved) closeModal();
  }

  async function settleClaim() {
    await performDemoAction(
      "settle-claim",
      "Claim settled",
      "The payout is the estimate less the policy deductible. No money moved.",
    );
  }

  /* ---- shared actions ---- */

  async function sendMessage(messageBody: string) {
    return performDemoAction(
      "send-message",
      "Message sent",
      role === "customer"
        ? "Your claims team can now read your message."
        : "The policyholder can now read your reply.",
      { messageBody },
    );
  }

  async function markMessagesRead() {
    // Silent: reading a thread is not an event worth a toast.
    if (demoBusy) return;
    try {
      const response = await fetch("/api/demo-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-messages-read" }),
      });
      const data = (await response.json()) as { state?: DemoState };
      if (response.ok && data.state) setDemo(data.state);
    } catch {
      // A failed read marker is not worth interrupting the user over.
    }
  }

  const openDirectory = (person: PolicyholderProfile | null = null) =>
    setActiveModal({ kind: "directory", person });

  const messageCenter = () => (
    <MessageCenter
      role={role}
      sharedRecord={sharedRecord}
      messages={demo.messages}
      busy={demoBusy !== null}
      unread={unreadMessages}
      onSend={sendMessage}
      onRead={markMessagesRead}
    />
  );

  const customerDestinations: Record<CustomerNavId, () => ReactNode> = {
    home: () => (
      <CustomerHome
        sharedRecord={sharedRecord}
        firstName={displayName.split(/\s+/)[0] || "there"}
        demo={demo}
        busyAction={demoBusy}
        onGoTo={setActiveNav}
        onOpenQuote={() => setActiveModal({ kind: "quote" })}
        onAcceptQuote={acceptQuote}
        onDiscardQuote={discardQuote}
        onFileClaim={() => setActiveModal({ kind: "file-claim" })}
        onPay={() => setActiveModal({ kind: "payment" })}
      />
    ),
    policy: () => (
      <PolicyView
        sharedRecord={sharedRecord}
        demo={demo}
        busyAction={demoBusy}
        onOpenQuote={() => setActiveModal({ kind: "quote" })}
        onAcceptQuote={acceptQuote}
        onDiscardQuote={discardQuote}
        onOpenVehicle={() => setActiveModal({ kind: "vehicle" })}
        onOpenDriver={() => setActiveModal({ kind: "driver" })}
      />
    ),
    claims: () => (
      <CustomerClaims
        sharedRecord={sharedRecord}
        demo={demo}
        busyAction={demoBusy}
        onFileClaim={() => setActiveModal({ kind: "file-claim" })}
        onUpload={() => setActiveModal({ kind: "upload-document" })}
        onRespond={respondToReview}
        onOpenSummary={() => setActiveModal({ kind: "claim-summary" })}
      />
    ),
    billing: () => (
      <BillingView
        sharedRecord={sharedRecord}
        demo={demo}
        onPay={() => setActiveModal({ kind: "payment" })}
      />
    ),
    messages: messageCenter,
  };

  const agentDestinations: Record<AgentNavId, () => ReactNode> = {
    today: () => (
      <AgentToday
        firstName={displayName.split(/\s+/)[0] || "there"}
        demo={demo}
        onGoTo={setActiveNav}
        onOpenDirectory={openDirectory}
      />
    ),
    claims: () => (
      <AgentClaims
        demo={demo}
        busyAction={demoBusy}
        onStartReview={startClaimReview}
        onDecide={decision => setActiveModal({ kind: "decision", decision })}
        onSettle={settleClaim}
        onOpenSummary={() => setActiveModal({ kind: "claim-summary" })}
        onOpenDirectory={openDirectory}
      />
    ),
    messages: messageCenter,
  };

  const destinations: Partial<Record<NavId, () => ReactNode>> =
    role === "customer" ? customerDestinations : agentDestinations;

  if (authLoading) return <AuthLoading />;
  if (!user) {
    return <AuthScreen
      challenge={challenge}
      busy={authBusy}
      error={authError}
      onLogin={startLogin}
      onVerify={verifyCode}
      onBack={() => { setChallenge(null); setAuthError(""); }}
      onResend={() =>
        challenge && startLogin(challenge.email, challenge.password, challenge.requestedRole)
      }
    />;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      {/* The primary navigation sits early in the DOM so the mobile bar is not
          the last tab stop on small screens, where it is the only nav. */}
      <nav className="mobile-nav" aria-label="Primary">
        {navEntries.map(entry => (
          <button
            key={entry.id}
            className={activeNav === entry.id ? "active" : ""}
            onClick={() => setActiveNav(entry.id)}
          >
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
            <button
              key={entry.id}
              className={activeNav === entry.id ? "nav-item active" : "nav-item"}
              onClick={() => setActiveNav(entry.id)}
            >
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
            <button
              className="top-user"
              onClick={() => setActiveModal({ kind: "account" })}
              aria-label="Account settings"
            >
              <span className="avatar">{initials}</span>
              <span>
                <strong>{displayName}</strong>
                <small>{role === "customer" ? "Policyholder · Account settings" : "Claims agent · Account settings"}</small>
              </span>
            </button>
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          aria-busy={(user !== null && loadedFor !== user.email) || demoBusy !== null}
        >
          {(destinations[activeNav] ?? destinations[homeNavFor(role)])?.() ?? null}
        </main>

        <footer className="app-footer">
          <p>Northlane Auto Insurance is a fictional insurer for QA automation training. No policy exists, no claim is real, and no money moves.</p>
          <p>Demo data · {dateLabel}</p>
        </footer>
      </div>

      {activeModal?.kind === "quote" && (
        <QuoteModal
          demo={demo}
          busy={demoBusy !== null}
          onClose={closeModal}
          onSubmit={requestQuote}
        />
      )}
      {activeModal?.kind === "vehicle" && (
        <VehicleModal
          vehicle={demo.vehicle}
          busy={demoBusy !== null}
          onClose={closeModal}
          onSubmit={updateVehicle}
        />
      )}
      {activeModal?.kind === "driver" && (
        <DriverModal
          driver={demo.driver}
          busy={demoBusy !== null}
          onClose={closeModal}
          onSubmit={updateDriver}
        />
      )}
      {activeModal?.kind === "file-claim" && (
        <FileClaimModal busy={demoBusy !== null} onClose={closeModal} onSubmit={fileClaim} />
      )}
      {activeModal?.kind === "upload-document" && (
        <UploadDocumentModal busy={demoBusy !== null} onClose={closeModal} onSubmit={uploadDocument} />
      )}
      {activeModal?.kind === "payment" && (
        <PaymentModal
          invoice={demo.invoice}
          busy={demoBusy !== null}
          onClose={closeModal}
          onSubmit={payInvoice}
        />
      )}
      {activeModal?.kind === "decision" && demo.claim && (
        <ClaimDecisionModal
          claim={demo.claim}
          decision={activeModal.decision}
          busy={demoBusy !== null}
          onClose={closeModal}
          onSubmit={decideClaim}
        />
      )}
      {activeModal?.kind === "claim-summary" && (
        <ClaimSummaryModal claim={demo.claim} policyNumber={demo.policy.number} onClose={closeModal} />
      )}
      {activeModal?.kind === "directory" && (
        <DirectoryModal
          demo={demo}
          initialPerson={activeModal.person}
          onClose={closeModal}
        />
      )}
      {activeModal?.kind === "account" && (
        <AccountModal
          user={user}
          onClose={closeModal}
          onDeleted={() => { closeModal(); setUser(null); setActiveNav(homeNavFor(role)); }}
          onSignOut={signOut}
        />
      )}

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
    ? { email: DEMO_CUSTOMER_EMAIL, password: "CustomerDemo!2026", label: "Policyholder", code: "111111" }
    : selectedAccess === "agent"
      ? { email: "agent.demo@testrigor-mail.com", password: "AgentDemo!2026", label: "Claims agent", code: "222222" }
      : null;

  function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    void onLogin(
      String(form.get("demo-email") ?? ""),
      String(form.get("demo-password") ?? ""),
      selectedAccess === "create"
        ? newAccountRole
        : selectedAccess === "agent"
          ? "agent"
          : "customer",
      submitter?.value === "skip-mfa",
    );
  }

  async function copyCredential(type: "email" | "password", value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedCredential(type);
    window.setTimeout(
      () => setCopiedCredential(current => (current === type ? null : current)),
      1600,
    );
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onVerify(code);
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
          <small>The shared demo accounts use a fixed code shown on the next screen. Accounts you create receive one by email when a mail provider is configured.</small>
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
            <div className="credential-row">
              <div><span>Verification code</span><code>{credentials.code}</code></div>
            </div>
            <p>Continue to enter the fixed code, or use the button above to sign in without it.</p>
          </div> : <div className="demo-credentials" aria-label="New account instructions">
            <div className="demo-credentials-heading"><strong>Create a new account</strong><span>Password + verification code</span></div>
            <p>Choose whether you are a policyholder or an agent, then enter your email and create a password with at least 8 characters.</p>
            <p>Your account is saved once you enter the verification code on the next screen.</p>
          </div>}
        </> : <>
          <button className="auth-back" type="button" onClick={onBack}><Icon name="arrow-left" size={14} /> Back to sign in</button>
          <div className="mail-icon"><Icon name={challenge.delivery === "email" ? "mail" : "shield-check"} size={24} /></div>
          <p className="eyebrow">{challenge.delivery === "email" ? "CHECK YOUR EMAIL" : "TWO-STEP VERIFICATION"}</p>
          <h2>Enter your verification code</h2>
          {challenge.delivery === "email"
            ? <p className="auth-subtitle">We sent a six-digit code to <strong>{challenge.destination}</strong>. It expires in 10 minutes.</p>
            : <p className="auth-subtitle">This demo account uses a fixed code instead of email, so the flow never depends on a mailbox.</p>}

          {challenge.delivery === "fixed" && <div className="fixed-code-note">
            <strong>DEMO VERIFICATION CODE</strong>
            <code>{fixedCodeFor(challenge)}</code>
            <p>Documented and unchanging. A test can hardcode it; a live audience can read it off the screen.</p>
          </div>}

          <form className="auth-form code-form" onSubmit={submitCode}>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- this step exists only to
                type the code, and focus arrives here after a deliberate navigation,
                not on initial page load. */}
            <label>Verification code<input className="code-input" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" placeholder="000000" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus required /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="primary-button auth-submit" type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Verify and sign in"}</button>
          </form>
          {challenge.delivery === "email" && <p className="resend-copy">
            Didn&apos;t receive it? <button type="button" onClick={onResend} disabled={busy}>Send a new code</button>
          </p>}
        </>}
      </div>
      <p className="privacy-copy">
        Protected access · Demo environment · No real policy data ·{" "}
        <button type="button" onClick={() => window.location.assign("/api-docs")}>
          QA API documentation
        </button>
      </p>
    </section>
  </main>;
}

/**
 * Which fixed code this challenge expects. The two shared accounts have one
 * each; anything else falls back to the generic code the API uses when no mail
 * provider is configured.
 */
function fixedCodeFor(challenge: Challenge): string {
  if (challenge.email.trim().toLowerCase() === DEMO_CUSTOMER_EMAIL) return "111111";
  if (challenge.email.trim().toLowerCase() === "agent.demo@testrigor-mail.com") return "222222";
  return "123456";
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
  const fixedDemoAccount = [
    DEMO_CUSTOMER_EMAIL,
    "agent.demo@testrigor-mail.com",
  ].includes(user.email);

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
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error ?? "The account could not be deleted.");
      }
      onDeleted();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The account could not be deleted.",
      );
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
      <div>
        <strong>Protected demo account</strong>
        <p>Fixed accounts cannot be deleted, so shared QA credentials remain available.</p>
      </div>
    </div> : <form className="danger-zone" onSubmit={deleteAccount}>
      <div>
        <strong>Delete account permanently</strong>
        <p>This removes the user, pending registrations, and verification challenges. The shared fictional policy data is not affected.</p>
      </div>
      <label>Current password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
      <label>Type DELETE to confirm<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" required /></label>
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
      <p>The policy, vehicle, claim, and invoice below belong to <b>Alex Carter</b>, the fictional policyholder every demo account shares. Nothing here is yours, and nothing here is real.</p>
    </div>
  </section>;
}

function QuickCard({ color, icon, title, text, action, onClick, done = false, disabled = false }: {
  color: string;
  icon: IconName;
  title: string;
  text: string;
  action: string;
  onClick: () => void | Promise<unknown>;
  done?: boolean;
  disabled?: boolean;
}) {
  return <button className="quick-card" onClick={onClick} disabled={disabled}>
    <span className={`quick-icon ${color}`}><Icon name={done ? "check" : icon} size={20} /></span>
    <span>
      <strong>{title}</strong>
      <small>{text}</small>
      <b>{action} <Icon name="arrow-right" size={13} /></b>
    </span>
  </button>;
}

function Metric({ value, label, detail, tone }: {
  value: string;
  label: string;
  detail: string;
  tone: string;
}) {
  return <div className={`metric-card ${tone}`}>
    <strong>{value}</strong>
    <h2>{label}</h2>
    <p>{detail}</p>
  </div>;
}

/** The banner that names the single next thing the policyholder should do. */
function NextStep({ demo, busyAction, onOpenQuote, onAcceptQuote, onPay, onGoTo }: {
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onOpenQuote: () => void;
  onAcceptQuote: () => void | Promise<unknown>;
  onPay: () => void;
  onGoTo: (id: NavId) => void;
}) {
  if (demo.quote) {
    return <section className="next-step" aria-label="Next step">
      <div>
        <p className="eyebrow">NEXT STEP</p>
        <strong>A {demo.quote.coverage} quote is waiting</strong>
        <p>{formatMoney(demo.quote.annualPremium)} a year, {formatMoney(demo.quote.monthlyPremium)} a month. Accepting it changes your policy and reissues your invoice.</p>
      </div>
      <button className="primary-button" disabled={busyAction !== null} onClick={() => void onAcceptQuote()}>
        <Icon name="check" size={17} /> {busyAction === "accept-quote" ? "Saving…" : "Accept this quote"}
      </button>
    </section>;
  }
  if (demo.claim?.status === "more-info-needed") {
    return <section className="next-step" aria-label="Next step">
      <div>
        <p className="eyebrow">NEXT STEP</p>
        <strong>Your claim needs more information</strong>
        <p>{demo.claim.reviewNote}</p>
      </div>
      <button className="primary-button" onClick={() => onGoTo("claims")}>
        <Icon name="upload" size={17} /> Open the claim
      </button>
    </section>;
  }
  if (demo.invoice.status === "unpaid") {
    return <section className="next-step" aria-label="Next step">
      <div>
        <p className="eyebrow">NEXT STEP</p>
        <strong>{formatMoney(demo.invoice.amount)} is due on {demo.invoice.dueOn}</strong>
        <p>{demo.invoice.description}. No money moves: this demo records the payment and nothing else.</p>
      </div>
      <button className="primary-button" onClick={onPay}>
        <Icon name="credit-card" size={17} /> Pay now
      </button>
    </section>;
  }
  return <section className="next-step" aria-label="Next step">
    <div>
      <p className="eyebrow">NOTHING OUTSTANDING</p>
      <strong>Your policy is up to date</strong>
      <p>Change your coverage to see a new price, or file a claim to start the claims workflow.</p>
    </div>
    <button className="secondary-button" onClick={onOpenQuote}>
      <Icon name="receipt" size={17} /> Get a new quote
    </button>
  </section>;
}

/* -------------------------------------------------------------------------- */
/* Policyholder screens                                                        */
/* -------------------------------------------------------------------------- */

function PolicyHero({ demo, onOpen }: { demo: DemoState; onOpen: () => void }) {
  const { policy, vehicle } = demo;
  return <section className="hero-card" aria-label="Your policy">
    <div className="hero-copy">
      <span className="status-pill"><i></i> POLICY ACTIVE</span>
      <p className="hero-date">Policy {policy.number} · renews {policy.renewsOn}</p>
      <h2>{policy.coverage} coverage · {formatMoney(policy.deductible)} deductible</h2>
      <p className="hero-person">
        <span className="hero-person-avatar" aria-hidden="true"><Icon name="car" size={16} /></span>
        <span>
          <strong>{vehicle.year} {vehicle.make} {vehicle.model}</strong>
          <small>Plate {vehicle.plate} · {vehicle.primaryUse}</small>
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

function CustomerHome({ sharedRecord, firstName, demo, busyAction, onGoTo, onOpenQuote, onAcceptQuote, onDiscardQuote, onFileClaim, onPay }: {
  sharedRecord: boolean;
  firstName: string;
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onGoTo: (id: NavId) => void;
  onOpenQuote: () => void;
  onAcceptQuote: () => void | Promise<unknown>;
  onDiscardQuote: () => void | Promise<unknown>;
  onFileClaim: () => void;
  onPay: () => void;
}) {
  const { quote, claim, invoice } = demo;
  const todos = countCustomerTodos(demo);

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Hello, {firstName}.</h1>
        <p className="subtitle">{todos === 0 ? "Nothing needs your attention today." : todos === 1 ? "One thing needs your attention today." : `${todos} things need your attention today.`}</p>
      </div>
      <button className="primary-button" onClick={onFileClaim} disabled={hasOpenClaim(demo)}>
        <Icon name="plus" size={17} /> File a claim
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}
    <NextStep demo={demo} busyAction={busyAction} onOpenQuote={onOpenQuote} onAcceptQuote={onAcceptQuote} onPay={onPay} onGoTo={onGoTo} />
    <PolicyHero demo={demo} onOpen={() => onGoTo("policy")} />

    <div className="section-heading">
      <div><h2>Your cover</h2><p>Every card here reflects your current state.</p></div>
    </div>
    <div className="quick-grid">
      {quote && <QuickCard
        color="sky"
        icon="receipt"
        title={`${quote.coverage} quote · ${formatMoney(quote.annualPremium)}/yr`}
        text={`Quoted ${quote.quotedAt}. Accept it to change your policy, or discard it.`}
        action="Open policy"
        onClick={() => onGoTo("policy")}
      />}
      {invoice.status === "unpaid" && <QuickCard
        color="violet"
        icon="credit-card"
        title={`${formatMoney(invoice.amount)} premium due`}
        text={`${invoice.description} · due ${invoice.dueOn}`}
        action="Open billing"
        onClick={() => onGoTo("billing")}
      />}
      {invoice.status === "paid" && <QuickCard
        color="green"
        icon="credit-card"
        title="Premium paid"
        text={`${invoice.paidWith} · ${invoice.paidAt}`}
        action="Open billing"
        onClick={() => onGoTo("billing")}
        done
      />}
      {claim ? <QuickCard
        color={claim.status === "rejected" ? "coral" : claim.status === "settled" ? "green" : "accent"}
        icon="clipboard"
        title={`Claim ${claim.reference} · ${claimStatusLabel(claim.status)}`}
        text={`${claim.type} on ${formatIsoDate(claim.incidentDate)} · estimate ${formatMoney(claim.estimatedAmount)}`}
        action="Open claims"
        onClick={() => onGoTo("claims")}
        done={claim.status === "settled"}
      /> : <QuickCard
        color="coral"
        icon="clipboard"
        title="No open claim"
        text={`Estimates of ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} or less are approved automatically. Anything higher goes to an agent.`}
        action="File a claim"
        onClick={onFileClaim}
      />}
      {quote && <QuickCard
        color="coral"
        icon="close"
        title="Discard the open quote"
        text="Leaves your current coverage and invoice exactly as they are."
        action="Discard quote"
        onClick={onDiscardQuote}
        disabled={busyAction !== null}
      />}
    </div>
  </div>;
}

function PolicyView({ sharedRecord, demo, busyAction, onOpenQuote, onAcceptQuote, onDiscardQuote, onOpenVehicle, onOpenDriver }: {
  sharedRecord: boolean;
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onOpenQuote: () => void;
  onAcceptQuote: () => void | Promise<unknown>;
  onDiscardQuote: () => void | Promise<unknown>;
  onOpenVehicle: () => void;
  onOpenDriver: () => void;
}) {
  const { policy, vehicle, driver, quote } = demo;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Policy</h1>
        <p className="subtitle">Your cover, the car it protects, and the driver it names.</p>
      </div>
      <button className="secondary-button" onClick={onOpenQuote}>
        <Icon name="receipt" size={16} /> Get a quote
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}

    {quote && <section className="panel record-list" aria-label="Open quote">
      <div className="panel-heading">
        <div><h2>Quote {quote.reference}</h2><p>{quote.coverage} coverage · quoted {quote.quotedAt}</p></div>
        <span className="review-status pending">Awaiting your decision</span>
      </div>
      <ul className="quote-breakdown">
        {quote.breakdown.map(line => (
          <li key={line.label}><span>{line.label}</span><span>{formatMoney(line.amount)}</span></li>
        ))}
        <li className="total"><span>Total each year</span><span>{formatMoney(quote.annualPremium)}</span></li>
      </ul>
      <dl className="review-details">
        <div><dt>Monthly premium</dt><dd>{formatMoney(quote.monthlyPremium)}</dd></div>
        <div><dt>Deductible</dt><dd>{formatMoney(quote.deductible)}</dd></div>
        <div><dt>Change from now</dt><dd>{quote.annualPremium === policy.annualPremium ? "No change" : `${quote.annualPremium > policy.annualPremium ? "+" : "−"}${formatMoney(Math.abs(quote.annualPremium - policy.annualPremium))} a year`}</dd></div>
      </dl>
      <button className="primary-button full" onClick={() => void onAcceptQuote()} disabled={busyAction !== null}>
        {busyAction === "accept-quote" ? "Saving…" : `Switch to ${quote.coverage} coverage`}
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
          <p>{formatMoney(policy.annualPremium)} a year · {formatMoney(policy.deductible)} deductible · effective {policy.effectiveFrom}</p>
          <small>Policy {policy.number} · last change: {policy.updatedAt}</small>
        </div>
        <button className="secondary-button" onClick={onOpenQuote}>Change coverage</button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon sky"><Icon name="car" size={18} /></span>
        <div>
          <p className="eyebrow">INSURED VEHICLE</p>
          <h2>{vehicle.year} {vehicle.make} {vehicle.model}</h2>
          <p>VIN {vehicle.vin} · plate {vehicle.plate}</p>
          <small>Primary use: {vehicle.primaryUse} · last change: {vehicle.updatedAt}</small>
        </div>
        <button className="secondary-button" onClick={onOpenVehicle}>Update vehicle</button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon violet"><Icon name="id-card" size={18} /></span>
        <div>
          <p className="eyebrow">NAMED DRIVER</p>
          <h2>{driver.fullName}</h2>
          <p>Licence {driver.licenseNumber} · {driver.licenseState}</p>
          <small>{driver.yearsLicensed} years licensed · last change: {driver.updatedAt}</small>
        </div>
        <button className="secondary-button" onClick={onOpenDriver}>Update driver</button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon green"><Icon name="receipt" size={18} /></span>
        <div>
          <p className="eyebrow">HOW YOUR PRICE IS SET</p>
          <h2>Rating rules</h2>
          <p>A base rate for the coverage level, plus a surcharge for a {OLDER_VEHICLE_CUTOFF_YEAR} or older vehicle, a driver licensed under {NEW_DRIVER_YEARS} years, or business use.</p>
          <small>Fictional arithmetic for QA training. Not risk pricing.</small>
        </div>
        <button className="secondary-button" onClick={onOpenQuote}>See a priced quote</button>
      </article>
    </div>
  </div>;
}

function CustomerClaims({ sharedRecord, demo, busyAction, onFileClaim, onUpload, onRespond, onOpenSummary }: {
  sharedRecord: boolean;
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onFileClaim: () => void;
  onUpload: () => void;
  onRespond: () => void | Promise<unknown>;
  onOpenSummary: () => void;
}) {
  const { claim, policy } = demo;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Claims</h1>
        <p className="subtitle">{claim ? `Claim ${claim.reference} · ${claimStatusLabel(claim.status)}` : "You have no claim on file."}</p>
      </div>
      <button className="primary-button" onClick={onFileClaim} disabled={hasOpenClaim(demo)}>
        <Icon name="plus" size={17} /> File a claim
      </button>
    </div>

    {sharedRecord && <SharedRecordNotice />}

    {!claim ? <section className="panel empty-panel" aria-label="No claim on file">
      <p>Nothing has been claimed on this policy. Filing a claim starts the review workflow that the claims agent picks up.</p>
      <button className="primary-button" onClick={onFileClaim}><Icon name="plus" size={17} /> File a claim</button>
    </section> : <>
      {claim.status === "more-info-needed" && <section className="next-step" aria-label="Next step for your claim">
        <div>
          <p className="eyebrow">NEXT STEP</p>
          <strong>Your agent asked for more information</strong>
          <p>{claim.reviewNote}</p>
        </div>
        <button className="primary-button" onClick={onUpload}><Icon name="upload" size={17} /> Attach a document</button>
      </section>}

      <section className="panel record-list" aria-label="Your claim">
        <div className="panel-heading">
          <div><h2>{claim.type} · {formatIsoDate(claim.incidentDate)}</h2><p>Filed {claim.filedAt} · reference {claim.reference}</p></div>
          <span className={`review-status ${claimChipTone(claim.status)}`}>{claimStatusLabel(claim.status)}</span>
        </div>

        <dl className="review-details">
          <div><dt>What happened</dt><dd>{claim.description}</dd></div>
          <div><dt>Your estimate</dt><dd>{formatMoney(claim.estimatedAmount)}</dd></div>
          <div><dt>Policy deductible</dt><dd>{formatMoney(policy.deductible)}</dd></div>
          {claim.settlementAmount !== null && <div><dt>Settled for</dt><dd><b>{formatMoney(claim.settlementAmount)}</b> · estimate less the deductible</dd></div>}
          {claim.reviewNote && <div><dt>{claim.autoApproved ? "Why" : "Agent note"}</dt><dd>{claim.reviewNote}</dd></div>}
        </dl>

        <ol className="status-timeline" aria-label="Claim progress">
          {CLAIM_TIMELINE.map(step => (
            <li key={step.label} className={step.reachedWhen.includes(claim.status) ? "reached" : ""}>{step.label}</li>
          ))}
        </ol>
      </section>

      <div className="section-heading">
        <div><h2>Documents</h2><p>Photos and paperwork attached to this claim.</p></div>
      </div>
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

        <button
          className="secondary-button full"
          onClick={onUpload}
          disabled={claim.status === "settled" || claim.status === "rejected"}
        >
          <Icon name="upload" size={16} /> Attach a document
        </button>
        {claim.status === "more-info-needed" && <button
          className="primary-button full"
          onClick={() => void onRespond()}
          disabled={busyAction !== null || claim.documents.length === 0}
        >
          {busyAction === "respond-to-claim-review" ? "Sending…" : "Send back for review"}
        </button>}
        <button className="secondary-button full" onClick={onOpenSummary}>
          <Icon name="download" size={16} /> Open claim summary
        </button>
      </section>
    </>}
  </div>;
}

function BillingView({ sharedRecord, demo, onPay }: {
  sharedRecord: boolean;
  demo: DemoState;
  onPay: () => void;
}) {
  const { invoice, policy } = demo;
  const paid = invoice.status === "paid";

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">POLICYHOLDER PORTAL</p>
        <h1>Billing</h1>
        <p className="subtitle">{paid ? "Nothing is outstanding on this policy." : `${formatMoney(invoice.amount)} is due on ${invoice.dueOn}.`}</p>
      </div>
    </div>

    {sharedRecord && <SharedRecordNotice />}

    <div className="document-grid">
      <article className="panel document-card">
        <span className={`activity-icon ${paid ? "green" : "violet"}`}><Icon name="credit-card" size={18} /></span>
        <div>
          <p className="eyebrow">{paid ? "PAID" : "DUE"}</p>
          <h2>{formatMoney(invoice.amount)}</h2>
          <p>{invoice.description} · due {invoice.dueOn}</p>
          <span className={`review-status ${paid ? "" : "pending"}`}>{paid ? `Paid with ${invoice.paidWith}` : "Unpaid"}</span>
        </div>
        <button className="secondary-button" onClick={onPay} disabled={paid}>
          {paid ? "Paid" : "Pay this invoice"}
        </button>
      </article>

      <article className="panel document-card">
        <span className="activity-icon accent"><Icon name="shield-check" size={18} /></span>
        <div>
          <p className="eyebrow">WHAT YOU PAY FOR</p>
          <h2>{policy.coverage} coverage</h2>
          <p>{formatMoney(policy.annualPremium)} a year across twelve instalments, with a {formatMoney(policy.deductible)} deductible on each claim.</p>
          <small>Policy {policy.number} · renews {policy.renewsOn}</small>
        </div>
        <span />
      </article>
    </div>

    <p className="demo-disclaimer">Fake payment form · No card is charged and no money moves. Use {DEMO_CARD_NUMBER.replace(/(\d{4})(?=\d)/g, "$1 ")} with expiry {DEMO_CARD_EXPIRY} and CVV {DEMO_CARD_CVV}.</p>
  </div>;
}

/* -------------------------------------------------------------------------- */
/* Claims agent screens                                                        */
/* -------------------------------------------------------------------------- */

function AgentToday({ firstName, demo, onGoTo, onOpenDirectory }: {
  firstName: string;
  demo: DemoState;
  onGoTo: (id: NavId) => void;
  onOpenDirectory: (person?: PolicyholderProfile | null) => void;
}) {
  const { claim } = demo;
  const awaitingYou = countClaimsAwaitingAgent(demo);
  const fixturesWaiting = queueFixtures.filter(item => item.waiting).length;
  const exposure = claim && claim.status !== "rejected" && claim.status !== "settled"
    ? claim.estimatedAmount
    : 0;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">CLAIMS DASHBOARD</p>
        <h1>Good morning, {firstName}.</h1>
        <p className="subtitle">Claims from the policyholder portal, and the book they belong to.</p>
      </div>
      <button className="secondary-button" onClick={() => onOpenDirectory(null)}>
        <Icon name="search" size={16} /> Search policyholders
      </button>
    </div>

    <div className="metric-grid">
      <Metric
        value={String(awaitingYou + fixturesWaiting)}
        label="Claims awaiting you"
        detail={awaitingYou === 0 ? "None from the portal" : "One from the portal"}
        tone="sky"
      />
      <Metric
        value={formatMoney(exposure)}
        label="Open estimate"
        detail={exposure === 0 ? "Nothing open" : `Claim ${claim?.reference}`}
        tone="coral"
      />
      <Metric
        value={String(policyholders.length)}
        label="Policies in book"
        detail="Sample directory"
        tone="accent"
      />
    </div>

    <div className="agent-layout">
      <div className="panel queue-panel">
        <div className="panel-heading">
          <div><h2>Claim queue</h2><p>Friday, July 24</p></div>
        </div>
        {claim && <div className="queue-row highlighted">
          <strong>{claim.reference}</strong>
          <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
          <div><b>Alex Carter</b><small>{claim.type} · {formatMoney(claim.estimatedAmount)} · policyholder portal</small></div>
          <span className={`queue-status${claim.status === "submitted" || claim.status === "more-info-needed" ? " waiting" : ""}`}>{claimStatusLabel(claim.status)}</span>
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
        {!claim && <p className="empty-note">Nothing new from the policyholder portal. When Alex Carter files a claim it appears here.</p>}
      </div>

      <div className="panel request-panel">
        <div className="panel-heading">
          <div><h2>Needs a decision</h2><p>From the policyholder portal</p></div>
          {awaitingYou > 0 && <span className="count-badge">{awaitingYou}</span>}
        </div>
        {awaitingYou === 0
          ? <p className="empty-note">No portal claim is waiting on you.</p>
          : <>
            <p className="empty-note">Claim {claim?.reference} is {claimStatusLabel(claim?.status ?? "submitted").toLowerCase()}.</p>
            <button className="secondary-button full" onClick={() => onGoTo("claims")}>
              Open claims <Icon name="arrow-right" size={13} />
            </button>
          </>}
      </div>
    </div>
  </div>;
}

function AgentClaims({ demo, busyAction, onStartReview, onDecide, onSettle, onOpenSummary, onOpenDirectory }: {
  demo: DemoState;
  busyAction: DemoStateAction | null;
  onStartReview: () => void | Promise<unknown>;
  onDecide: (decision: ClaimDecisionAction) => void;
  onSettle: () => void | Promise<unknown>;
  onOpenSummary: () => void;
  onOpenDirectory: (person?: PolicyholderProfile | null) => void;
}) {
  const { claim, policy } = demo;

  return <div className="page-content">
    <div className="welcome-row">
      <div>
        <p className="eyebrow">CLAIMS DASHBOARD</p>
        <h1>Claims</h1>
        <p className="subtitle">Claims submitted from the policyholder portal that need a decision.</p>
      </div>
    </div>

    <section className="panel request-panel" aria-label="Claims from the policyholder portal">
      {!claim && <p className="empty-note">No claim on file. Anything the policyholder files appears here.</p>}

      {claim && <div className={`request-card${claim.status === "settled" || claim.status === "rejected" ? "" : " highlighted"}`}>
        <div className="request-top">
          <HolderAvatar name="Alex Carter" onOpen={onOpenDirectory} />
          <div><strong>Alex Carter</strong><small>{claim.reference} · {claim.type} · {formatIsoDate(claim.incidentDate)}</small></div>
          <span className={`review-status ${claimChipTone(claim.status)}`}>{claimStatusLabel(claim.status)}</span>
        </div>

        <dl className="review-details">
          <div><dt>Policy</dt><dd>{policy.number} · {policy.coverage}</dd></div>
          <div><dt>What happened</dt><dd>{claim.description}</dd></div>
          <div><dt>Estimate</dt><dd>{formatMoney(claim.estimatedAmount)}{claim.autoApproved ? ` · at or under the ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} fast-track limit` : ` · above the ${formatMoney(FAST_TRACK_CLAIM_LIMIT)} fast-track limit`}</dd></div>
          <div><dt>Deductible</dt><dd>{formatMoney(policy.deductible)}</dd></div>
          <div><dt>Would settle for</dt><dd>{formatMoney(Math.max(0, claim.estimatedAmount - policy.deductible))}</dd></div>
          <div><dt>Documents</dt><dd>{claim.documents.length === 0 ? "None attached" : claim.documents.map(document => document.fileName).join(", ")}</dd></div>
          {claim.reviewNote && <div><dt>{claim.autoApproved ? "Why" : "Last note"}</dt><dd>{claim.reviewNote}</dd></div>}
          {claim.settlementAmount !== null && <div><dt>Settled for</dt><dd><b>{formatMoney(claim.settlementAmount)}</b></dd></div>}
        </dl>

        <div className="request-actions">
          {claim.status === "submitted" && <button
            className="approve"
            onClick={() => void onStartReview()}
            disabled={busyAction !== null}
          >{busyAction === "start-claim-review" ? "Opening…" : "Start review"}</button>}

          {claim.status === "in-review" && <>
            <button className="reject" onClick={() => onDecide("request-claim-information")} disabled={busyAction !== null}>Request information</button>
            <button className="reject" onClick={() => onDecide("reject-claim")} disabled={busyAction !== null}>Reject</button>
            <button className="approve" onClick={() => onDecide("approve-claim")} disabled={busyAction !== null}>Approve</button>
          </>}

          {claim.status === "more-info-needed" && <button className="reject" disabled>Waiting on the policyholder</button>}

          {claim.status === "approved" && <button
            className="approve"
            onClick={() => void onSettle()}
            disabled={busyAction !== null}
          >{busyAction === "settle-claim" ? "Settling…" : `Settle for ${formatMoney(Math.max(0, claim.estimatedAmount - policy.deductible))}`}</button>}
        </div>

        <button className="text-action" onClick={onOpenSummary}>
          Generate claim summary <Icon name="arrow-right" size={13} />
        </button>
      </div>}

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
          <textarea id="message-body" value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} placeholder="Write a demo message…" required />
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
  onSubmit: (coverage: CoverageTier) => Promise<void>;
}) {
  const { policy } = demo;
  const [coverage, setCoverage] = useState<CoverageTier>(
    COVERAGE_TIERS.find(tier => tier !== policy.coverage) ?? "Standard",
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(coverage);
  }

  return <Modal labelledBy="quote-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">NEW QUOTE</p>
    <h2 id="quote-title">Price a different coverage level</h2>
    <p>The price is calculated against the vehicle and driver currently on your policy. Your existing cover is unchanged until you accept.</p>
    <form onSubmit={submit}>
      <fieldset>
        <legend>Coverage level</legend>
        <div className="coverage-options">
          {COVERAGE_TIERS.map(tier => {
            const current = tier === policy.coverage;
            return <label key={tier} className={coverage === tier ? "selected" : ""}>
              <input
                type="radio"
                name="coverage"
                value={tier}
                checked={coverage === tier}
                disabled={current}
                onChange={() => setCoverage(tier)}
              />
              <span>
                <b>{tier}{current ? " · your current cover" : ""}</b>
                <small>Base rate {formatMoney(COVERAGE_BASE_PREMIUM[tier])} a year · {formatMoney(COVERAGE_DEDUCTIBLE[tier])} deductible</small>
              </span>
              <em>{formatMoney(COVERAGE_BASE_PREMIUM[tier])}</em>
            </label>;
          })}
        </div>
      </fieldset>
      <p className="form-hint">Surcharges are added on top of the base rate for a {OLDER_VEHICLE_CUTOFF_YEAR} or older vehicle, a driver licensed under {NEW_DRIVER_YEARS} years, and business use. Your current cover cannot be re-quoted.</p>
      <button className="primary-button full" type="submit" disabled={busy || coverage === policy.coverage}>
        {busy ? "Pricing…" : "Get this quote"}
      </button>
    </form>
  </Modal>;
}

function VehicleModal({ vehicle, busy, onClose, onSubmit }: {
  vehicle: Vehicle;
  busy: boolean;
  onClose: () => void;
  onSubmit: (vehicle: Omit<Vehicle, "updatedAt">) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      year: String(form.get("year") ?? ""),
      make: String(form.get("make") ?? ""),
      model: String(form.get("model") ?? ""),
      vin: String(form.get("vin") ?? ""),
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
    void onSubmit({
      ...values,
      primaryUse: String(form.get("primaryUse")) as VehicleUse,
    });
  }

  return <Modal confirmDiscard labelledBy="vehicle-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">INSURED VEHICLE</p>
    <h2 id="vehicle-title">Update vehicle information</h2>
    <p>Use fictional vehicle details. Changing the vehicle clears any open quote, because the price was calculated for the old one.</p>
    <form onSubmit={submit} noValidate>
      <div className="field-row">
        <div>
          <label>Year<input name="year" maxLength={4} inputMode="numeric" defaultValue={vehicle.year} {...fieldProps("year", errors)} /></label>
          <FieldError name="year" errors={errors} />
        </div>
        <div>
          <label>Make<input name="make" maxLength={40} defaultValue={vehicle.make} {...fieldProps("make", errors)} /></label>
          <FieldError name="make" errors={errors} />
        </div>
      </div>
      <label>Model<input name="model" maxLength={40} defaultValue={vehicle.model} {...fieldProps("model", errors)} /></label>
      <FieldError name="model" errors={errors} />
      <label>VIN<input name="vin" maxLength={20} defaultValue={vehicle.vin} {...fieldProps("vin", errors)} /></label>
      <FieldError name="vin" errors={errors} />
      <div className="field-row">
        <div>
          <label>Licence plate<input name="plate" maxLength={12} defaultValue={vehicle.plate} {...fieldProps("plate", errors)} /></label>
          <FieldError name="plate" errors={errors} />
        </div>
        <label>Primary use<select name="primaryUse" defaultValue={vehicle.primaryUse}>
          {VEHICLE_USES.map(use => <option key={use}>{use}</option>)}
        </select></label>
      </div>
      <p className="form-hint">All fields are required. Business use adds a surcharge to any new quote.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : "Save vehicle"}</button>
    </form>
  </Modal>;
}

function DriverModal({ driver, busy, onClose, onSubmit }: {
  driver: Driver;
  busy: boolean;
  onClose: () => void;
  onSubmit: (driver: Omit<Driver, "updatedAt">) => Promise<void>;
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
    const found = validateText(values, {
      fullName: 80,
      licenseNumber: 30,
      licenseState: 40,
      yearsLicensed: 2,
    });
    if (!found.yearsLicensed && !/^\d{1,2}$/.test(values.yearsLicensed.trim())) {
      found.yearsLicensed = "Enter a whole number of years, 0 to 99.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit(values);
  }

  return <Modal confirmDiscard labelledBy="driver-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">NAMED DRIVER</p>
    <h2 id="driver-title">Update driver information</h2>
    <p>Use fictional licence details. Do not enter a real licence number.</p>
    <form onSubmit={submit} noValidate>
      <label>Full name<input name="fullName" maxLength={80} defaultValue={driver.fullName} {...fieldProps("fullName", errors)} /></label>
      <FieldError name="fullName" errors={errors} />
      <label>Licence number<input name="licenseNumber" maxLength={30} defaultValue={driver.licenseNumber} {...fieldProps("licenseNumber", errors)} /></label>
      <FieldError name="licenseNumber" errors={errors} />
      <div className="field-row">
        <div>
          <label>Issuing state<input name="licenseState" maxLength={40} defaultValue={driver.licenseState} {...fieldProps("licenseState", errors)} /></label>
          <FieldError name="licenseState" errors={errors} />
        </div>
        <div>
          <label>Years licensed<input name="yearsLicensed" maxLength={2} inputMode="numeric" defaultValue={driver.yearsLicensed} {...fieldProps("yearsLicensed", errors)} /></label>
          <FieldError name="yearsLicensed" errors={errors} />
        </div>
      </div>
      <p className="form-hint">All fields are required. Fewer than {NEW_DRIVER_YEARS} years licensed adds a surcharge to any new quote.</p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Saving…" : "Save driver"}</button>
    </form>
  </Modal>;
}

function FileClaimModal({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (claim: {
    type: ClaimType;
    incidentDate: string;
    description: string;
    estimatedAmount: number;
  }) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState("");

  const parsedEstimate = Number(estimate);
  const estimatePreview =
    Number.isInteger(parsedEstimate) && parsedEstimate > 0
      ? parsedEstimate <= FAST_TRACK_CLAIM_LIMIT
        ? `At or under ${formatMoney(FAST_TRACK_CLAIM_LIMIT)}, so this claim will be approved automatically.`
        : `Above ${formatMoney(FAST_TRACK_CLAIM_LIMIT)}, so this claim will start as pending review.`
      : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      incidentDate: String(form.get("incidentDate") ?? ""),
      description: String(form.get("description") ?? ""),
      estimatedAmount: String(form.get("estimatedAmount") ?? ""),
    };
    const found = validateText(
      { incidentDate: values.incidentDate, description: values.description },
      { incidentDate: 20, description: 400 },
    );
    const amount = Number(values.estimatedAmount);
    if (
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > MAX_CLAIM_ESTIMATE
    ) {
      found.estimatedAmount = `Enter a whole number of dollars between 1 and ${MAX_CLAIM_ESTIMATE.toLocaleString("en-US")}.`;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit({
      type: String(form.get("type")) as ClaimType,
      incidentDate: values.incidentDate,
      description: values.description,
      estimatedAmount: amount,
    });
  }

  return <Modal confirmDiscard labelledBy="claim-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">NEW CLAIM</p>
    <h2 id="claim-title">File a claim</h2>
    <p>Describe a fictional incident. The estimate you enter decides whether an agent has to review it.</p>
    <form onSubmit={submit} noValidate>
      <label>Type of claim<select name="type" defaultValue="Collision">
        {CLAIM_TYPES_WITH_HINT.map(entry => (
          <option key={entry.type} value={entry.type}>{entry.type} — {entry.hint}</option>
        ))}
      </select></label>
      <label>Date of the incident<input name="incidentDate" type="date" defaultValue="2026-07-18" max="2026-07-24" {...fieldProps("incidentDate", errors)} /></label>
      <FieldError name="incidentDate" errors={errors} />
      <label>What happened<textarea name="description" maxLength={400} placeholder="Describe the incident in a sentence or two" {...fieldProps("description", errors)} /></label>
      <FieldError name="description" errors={errors} />
      <label>Estimated repair cost (USD)<input
        name="estimatedAmount"
        inputMode="numeric"
        placeholder="1800"
        value={estimate}
        onChange={event => setEstimate(event.target.value.replace(/\D/g, "").slice(0, 6))}
        {...fieldProps("estimatedAmount", errors)}
      /></label>
      <FieldError name="estimatedAmount" errors={errors} />
      {estimatePreview && <p className="form-hint" aria-live="polite">{estimatePreview}</p>}
      <p className="form-hint">All fields are required. Whole dollars only, no cents.</p>
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

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) {
      setError("Choose a file to attach.");
      return;
    }
    void onSubmit(selected);
  }

  return <Modal labelledBy="upload-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">CLAIM EVIDENCE</p>
    <h2 id="upload-title">Attach accident photos or documents</h2>
    <p>Nothing leaves your browser. The workflow records the file name and size so the claim can react, and the file itself is never read, uploaded, or stored.</p>
    <form onSubmit={submit} noValidate>
      <label className="upload-field">
        <span>Choose a file</span>
        <input
          type="file"
          name="document"
          accept="image/*,.pdf"
          onChange={event => {
            const file = event.target.files?.[0];
            setError("");
            setSelected(file ? { fileName: file.name, sizeLabel: formatFileSize(file.size) } : null);
          }}
        />
      </label>
      {selected && <p className="form-hint" aria-live="polite">
        Ready to attach: <b>{selected.fileName}</b> ({selected.sizeLabel}).
      </p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="form-hint">Any image or PDF is accepted. Do not attach anything real.</p>
      <button className="primary-button full" type="submit" disabled={busy || !selected}>
        {busy ? "Attaching…" : "Attach to my claim"}
      </button>
    </form>
  </Modal>;
}

/** Bytes as "1.4 MB". Only ever shown back to the person who picked the file. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PaymentModal({ invoice, busy, onClose, onSubmit }: {
  invoice: DemoState["invoice"];
  busy: boolean;
  onClose: () => void;
  onSubmit: (card: CardInput) => Promise<void>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      nameOnCard: String(form.get("nameOnCard") ?? ""),
      cardNumber: String(form.get("cardNumber") ?? ""),
      expiry: String(form.get("expiry") ?? ""),
      cvv: String(form.get("cvv") ?? ""),
    };
    const found = validateText(values, {
      nameOnCard: 80,
      cardNumber: 19,
      expiry: 5,
      cvv: 3,
    });
    if (!found.cardNumber && !/^\d{16}$/.test(values.cardNumber.replace(/[\s-]/g, ""))) {
      found.cardNumber = "Enter the 16 digits of the card.";
    }
    if (!found.expiry && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(values.expiry.trim())) {
      found.expiry = "Use MM/YY.";
    }
    if (!found.cvv && !/^\d{3}$/.test(values.cvv.trim())) {
      found.cvv = "Enter the 3-digit CVV.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, Object.keys(found)[0]);
      return;
    }
    void onSubmit(values);
  }

  return <Modal confirmDiscard labelledBy="payment-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">PREMIUM PAYMENT</p>
    <h2 id="payment-title">Pay {formatMoney(invoice.amount)}</h2>
    <p>{invoice.description} · due {invoice.dueOn}. No card is charged and no money moves.</p>
    <form onSubmit={submit} noValidate>
      <label>Name on card<input name="nameOnCard" maxLength={80} autoComplete="off" placeholder="Alex Carter" {...fieldProps("nameOnCard", errors)} /></label>
      <FieldError name="nameOnCard" errors={errors} />
      <label>Card number<input name="cardNumber" maxLength={19} inputMode="numeric" autoComplete="off" placeholder="4111 1111 1111 1111" {...fieldProps("cardNumber", errors)} /></label>
      <FieldError name="cardNumber" errors={errors} />
      <div className="field-row">
        <div>
          <label>Expiry<input name="expiry" maxLength={5} autoComplete="off" placeholder="12/30" {...fieldProps("expiry", errors)} /></label>
          <FieldError name="expiry" errors={errors} />
        </div>
        <div>
          <label>CVV<input name="cvv" maxLength={3} inputMode="numeric" autoComplete="off" placeholder="123" {...fieldProps("cvv", errors)} /></label>
          <FieldError name="cvv" errors={errors} />
        </div>
      </div>
      <p className="form-hint">
        The demo card <b>{DEMO_CARD_NUMBER.replace(/(\d{4})(?=\d)/g, "$1 ")}</b> with expiry <b>{DEMO_CARD_EXPIRY}</b> and CVV <b>{DEMO_CARD_CVV}</b> is accepted. Any other well-formed card is declined, so both outcomes are reachable.
      </p>
      <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Processing…" : `Pay ${formatMoney(invoice.amount)}`}</button>
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
      eyebrow: "APPROVE CLAIM",
      title: `Approve ${claim.reference}`,
      body: "Your note is shown to the policyholder alongside the decision. Approving does not release money: settling it does.",
      placeholder: "Damage is consistent with the photos and covered under the policy.",
      submit: "Approve this claim",
    },
    "reject-claim": {
      eyebrow: "REJECT CLAIM",
      title: `Reject ${claim.reference}`,
      body: "A rejection with no reason is the one thing a policyholder cannot act on, so the note is required.",
      placeholder: "The incident date falls outside the policy period.",
      submit: "Reject this claim",
    },
    "request-claim-information": {
      eyebrow: "REQUEST INFORMATION",
      title: `Ask for more on ${claim.reference}`,
      body: "The policyholder has to attach at least one document before the claim can come back to you.",
      placeholder: "Please attach a photo of the rear bumper and the repair quote.",
      submit: "Send this request",
    },
  }[decision];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = { reviewNote: String(form.get("reviewNote") ?? "") };
    const found = validateText(values, { reviewNote: 400 });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid(event.currentTarget, "reviewNote");
      return;
    }
    void onSubmit(decision, values.reviewNote);
  }

  return <Modal confirmDiscard labelledBy="decision-title" className="form-modal" closeDisabled={busy} onClose={onClose}>
    <p className="eyebrow">{copy.eyebrow}</p>
    <h2 id="decision-title">{copy.title}</h2>
    <p>{copy.body}</p>
    <dl className="review-details">
      <div><dt>Policyholder</dt><dd>Alex Carter</dd></div>
      <div><dt>Claim</dt><dd>{claim.type} · {formatIsoDate(claim.incidentDate)}</dd></div>
      <div><dt>Estimate</dt><dd>{formatMoney(claim.estimatedAmount)}</dd></div>
      <div><dt>Documents</dt><dd>{claim.documents.length === 0 ? "None attached" : `${claim.documents.length} attached`}</dd></div>
    </dl>
    <form onSubmit={submit} noValidate>
      <label>Note to the policyholder<textarea name="reviewNote" maxLength={400} placeholder={copy.placeholder} {...fieldProps("reviewNote", errors)} /></label>
      <FieldError name="reviewNote" errors={errors} />
      <p className="form-hint">Required, up to 400 characters. Use fictional wording only.</p>
      <button
        className={decision === "reject-claim" ? "danger-button full" : "primary-button full"}
        type="submit"
        disabled={busy}
      >{busy ? "Saving…" : copy.submit}</button>
    </form>
  </Modal>;
}

function downloadClaimSummary(claim: Claim, policyNumber: string) {
  const rows: string[][] = [
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
    ["Note", claim.reviewNote ?? "None"],
    ["Documents", claim.documents.length === 0 ? "None" : claim.documents.map(document => document.fileName).join(" | ")],
    ["Settlement", claim.settlementAmount === null ? "Not settled" : formatMoney(claim.settlementAmount)],
    ["Notice", "Fictional demo data for QA training. Not an insurance document and not advice."],
  ];
  const csv = rows
    .map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${claim.reference.toLowerCase()}-summary.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ClaimSummaryModal({ claim, policyNumber, onClose }: {
  claim: Claim | null;
  policyNumber: string;
  onClose: () => void;
}) {
  // Reachable: the shared environment resets on a timer, so the claim a second
  // tab is reading can stop existing while this dialog is open. Saying so
  // beats rendering an empty table.
  if (!claim) {
    return <Modal labelledBy="summary-title" className="detail-modal" dismissOnBackdrop onClose={onClose}>
      <h2 id="summary-title">No claim on file</h2>
      <p>The shared demo environment was reset while this was open. Close this and file a claim again.</p>
      <button className="primary-button full" onClick={onClose}>Close</button>
    </Modal>;
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
        <tr><th scope="row">Documents</th><td>{claim.documents.length === 0 ? "None" : claim.documents.map(document => document.fileName).join(", ")}</td></tr>
        <tr><th scope="row">Settlement</th><td>{claim.settlementAmount === null ? "Not settled" : <b>{formatMoney(claim.settlementAmount)}</b>}</td></tr>
      </tbody>
    </table>
    {claim.reviewNote && <p className="review-status">{claim.reviewNote}</p>}
    <p className="demo-disclaimer">All values are fictional and provided only for QA training.</p>
    <button className="primary-button full" onClick={() => downloadClaimSummary(claim, policyNumber)}>
      <Icon name="download" size={15} /> Download CSV
    </button>
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
  const { policy, claim, invoice, vehicle, driver } = demo;

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
        <div><dt>Policy number</dt><dd>{selected.policyNumber}</dd></div>
        <div><dt>Member since</dt><dd>{selected.memberSince}</dd></div>
        <div><dt>Vehicle</dt><dd>{selected.name === "Alex Carter" ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : selected.vehicle}</dd></div>
        {selected.name === "Alex Carter" && <>
          <div><dt>Coverage</dt><dd>{policy.coverage} · {formatMoney(policy.annualPremium)} a year</dd></div>
          <div><dt>Named driver</dt><dd>{driver.fullName} · {driver.yearsLicensed} years licensed</dd></div>
          <div><dt>Open claim</dt><dd>{claim ? `${claim.reference} · ${claimStatusLabel(claim.status)}` : "None"}</dd></div>
          <div><dt>Billing</dt><dd>{formatMoney(invoice.amount)} · {invoice.status === "paid" ? "Paid" : `Due ${invoice.dueOn}`}</dd></div>
        </>}
      </dl>
      <p className="demo-disclaimer">Sample data · Not a real policyholder</p>
    </> : <>
      <p className="eyebrow">POLICYHOLDER DIRECTORY</p>
      <h2 id="directory-title">Search policyholders</h2>
      <p>Find one of the five sample policyholders by name.</p>
      <label className="directory-input">
        <span>Policyholder name</span>
        <div>
          <Icon name="search" size={17} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name" />
        </div>
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
