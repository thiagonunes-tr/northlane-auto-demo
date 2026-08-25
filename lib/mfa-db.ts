import { env } from "cloudflare:workers";
import {
  DEFAULT_CLAIMS,
  DEFAULT_DEMO_STATE,
  DEFAULT_DRIVERS,
  DEFAULT_INVOICES,
  DEFAULT_LAST_READ,
  DEFAULT_MESSAGES,
  DEFAULT_POLICY,
  DEFAULT_VEHICLES,
  DemoActionInput,
  DemoActorRole,
  DemoState,
  DemoStateAction,
  DemoTransitionResult,
  MessageReadState,
  isAssistanceRequest,
  isClaim,
  isDemoMessage,
  isDriver,
  isInvoice,
  isMessageReadState,
  isPaymentMethod,
  isPolicy,
  isQuote,
  isVehicle,
  transitionDemoState,
} from "./demo-state";

export {
  DEFAULT_DEMO_STATE,
  type AssistanceRequest,
  type Claim,
  type DemoMessage,
  type DemoState,
  type DemoStateAction,
  type Driver,
  type Invoice,
  type PaymentMethod,
  type MessageReadState,
  type Policy,
  type Quote,
  type Vehicle,
} from "./demo-state";

let initialized = false;

export type ChallengeRecord = {
  id: string;
  email: string;
  role: DemoActorRole;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

export type UserRecord = {
  email: string;
  name: string;
  role: DemoActorRole;
  password_hash: string;
  created_at: number;
};

export type PendingUserRecord = {
  challenge_id: string;
  email: string;
  name: string;
  role: DemoActorRole;
  password_hash: string;
  created_at: number;
};

const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function getMfaDb(): Promise<D1Database> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("The authentication database is not configured.");

  if (!initialized) {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS mfa_challenges (
        id text PRIMARY KEY NOT NULL,
        email text NOT NULL,
        role text NOT NULL,
        code_hash text NOT NULL,
        attempts integer DEFAULT 0 NOT NULL,
        created_at integer NOT NULL,
        expires_at integer NOT NULL,
        consumed_at integer
      )`),
      db.prepare(
        "CREATE INDEX IF NOT EXISTS mfa_challenges_email_created_idx ON mfa_challenges (email, created_at)",
      ),
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        email text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        role text NOT NULL,
        password_hash text NOT NULL,
        created_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS pending_users (
        challenge_id text PRIMARY KEY NOT NULL,
        email text NOT NULL,
        name text NOT NULL,
        role text NOT NULL,
        password_hash text NOT NULL,
        created_at integer NOT NULL
      )`),
      db.prepare(
        "CREATE INDEX IF NOT EXISTS pending_users_email_idx ON pending_users (email)",
      ),
      db.prepare(`CREATE TABLE IF NOT EXISTS demo_state (
        id text PRIMARY KEY NOT NULL,
        state_json text NOT NULL,
        updated_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS environment_meta (
        id text PRIMARY KEY NOT NULL,
        last_reset_at integer NOT NULL
      )`),
    ]);
    initialized = true;
  }

  return db;
}


export async function getStoredUser(email: string): Promise<UserRecord | null> {
  const db = await getMfaDb();
  return db
    .prepare(
      "SELECT email, name, role, password_hash, created_at FROM users WHERE email = ?",
    )
    .bind(email)
    .first<UserRecord>();
}

export async function storeUser(user: UserRecord): Promise<void> {
  const db = await getMfaDb();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (email, name, role, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(user.email, user.name, user.role, user.password_hash, user.created_at)
    .run();
}

export async function deleteStoredUser(email: string): Promise<boolean> {
  const db = await getMfaDb();
  const normalized = email.trim().toLowerCase();
  const results = await db.batch([
    db.prepare("DELETE FROM mfa_challenges WHERE email = ?").bind(normalized),
    db.prepare("DELETE FROM pending_users WHERE email = ?").bind(normalized),
    db.prepare("DELETE FROM users WHERE email = ?").bind(normalized),
  ]);
  return Boolean(results[2]?.meta.changes);
}

export async function getPendingUser(
  challengeId: string,
): Promise<PendingUserRecord | null> {
  const db = await getMfaDb();
  return db
    .prepare(
      `SELECT challenge_id, email, name, role, password_hash, created_at
       FROM pending_users WHERE challenge_id = ?`,
    )
    .bind(challengeId)
    .first<PendingUserRecord>();
}

export async function deletePendingUser(challengeId: string): Promise<void> {
  const db = await getMfaDb();
  await db
    .prepare("DELETE FROM pending_users WHERE challenge_id = ?")
    .bind(challengeId)
    .run();
}

async function resetEnvironmentIfDue(db: D1Database): Promise<void> {
  const now = Date.now();
  const meta = await db
    .prepare("SELECT last_reset_at FROM environment_meta WHERE id = 'global'")
    .first<{ last_reset_at: number }>();

  if (!meta) {
    await db
      .prepare(
        "INSERT INTO environment_meta (id, last_reset_at) VALUES ('global', ?)",
      )
      .bind(now)
      .run();
    return;
  }

  if (now - meta.last_reset_at < RESET_INTERVAL_MS) return;

  await db.batch([
    db.prepare("DELETE FROM demo_state"),
    db
      .prepare("UPDATE environment_meta SET last_reset_at = ? WHERE id = 'global'")
      .bind(now),
    db.prepare("DELETE FROM mfa_challenges WHERE expires_at < ?").bind(now),
    db
      .prepare("DELETE FROM pending_users WHERE created_at < ?")
      .bind(now - RESET_INTERVAL_MS),
  ]);
}

/**
 * Reads the single shared state row, validating every field on the way out.
 *
 * A field that fails its guard falls back to its seed value rather than being
 * repaired in place: a half-valid record would leave the UI reasoning about
 * entries the guards already rejected.
 */
export async function getDemoState(): Promise<DemoState> {
  const db = await getMfaDb();
  await resetEnvironmentIfDue(db);
  const record = await db
    .prepare("SELECT state_json FROM demo_state WHERE id = 'global'")
    .first<{ state_json: string }>();
  if (!record) return freshDemoState();

  try {
    const state = JSON.parse(record.state_json) as Partial<DemoState>;

    const messages =
      Array.isArray(state.messages) && state.messages.every(isDemoMessage)
        ? state.messages
        : DEFAULT_MESSAGES;

    // Drop read markers that no longer point at a surviving message.
    const messageIds = new Set(messages.map(message => message.id));
    const storedLastRead = isMessageReadState(state.lastRead)
      ? state.lastRead
      : DEFAULT_LAST_READ;
    const lastRead: MessageReadState = {
      customer:
        storedLastRead.customer && messageIds.has(storedLastRead.customer)
          ? storedLastRead.customer
          : null,
      agent:
        storedLastRead.agent && messageIds.has(storedLastRead.agent)
          ? storedLastRead.agent
          : null,
    };

    // Each list falls back whole rather than per entry: a partially valid list
    // leaves the UI reasoning about entries the guards already rejected. The
    // two that must never be empty fall back when they are, because a policy
    // with no vehicle or no driver cannot be priced at all.
    const vehicles =
      Array.isArray(state.vehicles) &&
      state.vehicles.length > 0 &&
      state.vehicles.every(isVehicle)
        ? state.vehicles
        : DEFAULT_VEHICLES;
    const drivers =
      Array.isArray(state.drivers) &&
      state.drivers.length > 0 &&
      state.drivers.every(isDriver) &&
      state.drivers.some(driver => driver.isPrimary)
        ? state.drivers
        : DEFAULT_DRIVERS;

    return {
      policy: isPolicy(state.policy) ? state.policy : DEFAULT_POLICY,
      vehicles,
      drivers,
      quote: isQuote(state.quote) ? state.quote : null,
      claims:
        Array.isArray(state.claims) && state.claims.every(isClaim)
          ? state.claims
          : DEFAULT_CLAIMS,
      assistance:
        Array.isArray(state.assistance) && state.assistance.every(isAssistanceRequest)
          ? state.assistance
          : [],
      invoices:
        Array.isArray(state.invoices) &&
        state.invoices.length > 0 &&
        state.invoices.every(isInvoice)
          ? state.invoices
          : DEFAULT_INVOICES,
      paymentMethods:
        Array.isArray(state.paymentMethods) &&
        state.paymentMethods.every(isPaymentMethod)
          ? state.paymentMethods
          : [],
      messages,
      lastRead,
    };
  } catch {
    return freshDemoState();
  }
}

export async function saveDemoState(state: DemoState): Promise<DemoState> {
  const db = await getMfaDb();
  await resetEnvironmentIfDue(db);
  await db
    .prepare(
      `INSERT INTO demo_state (id, state_json, updated_at)
       VALUES ('global', ?, ?)
       ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(state), Date.now())
    .run();
  return state;
}

export async function applyDemoStateAction(
  action: DemoStateAction,
  role: DemoActorRole,
  input: DemoActionInput = {},
): Promise<DemoTransitionResult> {
  const currentState = await getDemoState();
  const transition = transitionDemoState(currentState, action, role, input);
  if (!transition.ok) return transition;

  await saveDemoState(transition.state);
  return transition;
}

export async function resetDemoState(): Promise<DemoState> {
  const db = await getMfaDb();
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM demo_state WHERE id = 'global'"),
    db
      .prepare(
        `INSERT INTO environment_meta (id, last_reset_at)
         VALUES ('global', ?)
         ON CONFLICT(id) DO UPDATE SET last_reset_at = excluded.last_reset_at`,
      )
      .bind(now),
  ]);
  return freshDemoState();
}

/**
 * A deep copy of the seed state. Handing out the module-level constants would
 * let one request's mutation leak into the next reader's "fresh" environment.
 */
function freshDemoState(): DemoState {
  return {
    ...DEFAULT_DEMO_STATE,
    policy: { ...DEFAULT_POLICY, addOns: [...DEFAULT_POLICY.addOns] },
    vehicles: DEFAULT_VEHICLES.map(vehicle => ({ ...vehicle })),
    drivers: DEFAULT_DRIVERS.map(driver => ({ ...driver })),
    quote: null,
    claims: DEFAULT_CLAIMS.map(claim => ({ ...claim, documents: [...claim.documents] })),
    assistance: [],
    invoices: DEFAULT_INVOICES.map(invoice => ({ ...invoice })),
    paymentMethods: [],
    messages: DEFAULT_MESSAGES.map(message => ({ ...message })),
    lastRead: { ...DEFAULT_LAST_READ },
  };
}
