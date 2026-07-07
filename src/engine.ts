/**
 * The reattempt-compliance decision engine.
 *
 * Pure and deterministic: no I/O, no globals, `now` injectable. Given the
 * network, the raw decline signal, whether the attempt is customer- (CIT) or
 * merchant-initiated (MIT), and the attempt history, it returns whether a
 * reattempt is permitted, why, the recommended action, the fee risk, and when
 * the next attempt becomes eligible.
 *
 * The engine deliberately does **not** manage the stored-credential framework
 * (CIT-establishes-credential flags, network transaction-ID chaining,
 * `off_session` parameters) — that plumbing belongs to your PSP. This decides
 * *whether and when* to attempt, not *how* the auth message is composed.
 */

import type {
  AttemptLike,
  AttemptRecord,
  DeclineOutcome,
  Network,
  ReattemptDecision,
  ReattemptInput,
  RecommendedAction,
  ReattemptReason,
  Timestamp,
  TransactionContext,
} from "./types";
import { VISA_DECLINE_RULES, VISA_REATTEMPT_CAP, VISA_WINDOW_DAYS } from "./data/visa";
import {
  MASTERCARD_DECLINE_RULES,
  MASTERCARD_MAC,
  MASTERCARD_MAC_DO_NOT_RETRY,
  MASTERCARD_RETRY_CAP,
  MASTERCARD_WINDOW_DAYS,
  type MacInfo,
} from "./data/mastercard";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/*
 * Operational best-practice heuristics below are NOT network mandates — they
 * are sensible defaults for retry/dunning UX, surfaced separately from the
 * cited network rules (via `suggestedRetryAt` and the velocity fields).
 */

/** CIT: how many identical declines in the velocity window trigger a stop. */
export const CIT_VELOCITY_IDENTICAL_LIMIT = 2;

/** CIT: the in-session window (minutes) over which identical declines are counted. */
export const CIT_VELOCITY_WINDOW_MINUTES = 30;

/** MIT: advisory spacing before retrying a soft decline, by response code (hours). */
export const MIT_SOFT_RETRY_SPACING_HOURS: Readonly<Record<string, number>> = {
  "51": 72, // insufficient funds — payday-aware spacing recovers more than hourly hammering
  "61": 72, // exceeds amount limit
  "65": 72, // exceeds frequency limit
};

/** MIT: default advisory spacing before retrying a soft decline (hours). */
export const DEFAULT_MIT_SOFT_RETRY_SPACING_HOURS = 24;

/** Sanitized, customer-safe checkout messages. Never reveal fraud/lost/stolen specifics. */
const CUSTOMER_MESSAGE = {
  hardDecline: "This card can't be used. Please try a different payment method.",
  updateRequired:
    "This card has expired or its details have changed. Please update your card or use another.",
  velocity: "This card was declined several times. Please use a different payment method.",
} as const;

/** Coerce a {@link Timestamp} to a `Date`, throwing on invalid input. */
function toDate(value: Timestamp): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}

function isAttemptRecord(a: AttemptLike): a is AttemptRecord {
  return typeof a === "object" && a !== null && !(a instanceof Date) && "at" in a;
}

interface ParsedAttempt {
  at: Date;
  declineCode?: string;
}

/** Resolved attempt history used for window, delay, and velocity math. */
interface History {
  /** Attempts already made, including the original decline. */
  attemptCount: number;
  /** Original decline time — the cap-window anchor. */
  anchor: Date;
  /** Most recent decline time — the anchor for MAC retry delays. */
  lastAttempt: Date;
  /** Parsed attempts with per-attempt codes (empty for the count-only path). */
  records: ParsedAttempt[];
}

function resolveHistory(input: ReattemptInput, now: Date): History {
  if (input.attempts && input.attempts.length > 0) {
    const records: ParsedAttempt[] = input.attempts
      .map((a): ParsedAttempt =>
        isAttemptRecord(a)
          ? { at: toDate(a.at), declineCode: a.declineCode }
          : { at: toDate(a) },
      )
      .sort((x, y) => x.at.getTime() - y.at.getTime());
    return {
      attemptCount: records.length,
      anchor: records[0]!.at,
      lastAttempt: records[records.length - 1]!.at,
      records,
    };
  }

  const anchor =
    input.firstAttemptAt !== undefined ? toDate(input.firstAttemptAt) : now;
  const attemptCount =
    input.priorAttempts !== undefined && input.priorAttempts > 0
      ? Math.floor(input.priorAttempts)
      : 1;
  // Without explicit timestamps we cannot know when the latest attempt was, so
  // we treat the decline under evaluation as happening `now` for delay math.
  return { attemptCount, anchor, lastAttempt: now, records: [] };
}

interface WindowMath {
  windowEnd: Date;
  remaining: number;
  capReached: boolean;
}

function windowMath(history: History, now: Date, cap: number, windowMs: number): WindowMath {
  const rawEnd = history.anchor.getTime() + windowMs;
  const windowActive = now.getTime() <= rawEnd;
  // Once the window from the original decline lapses, a reattempt now starts a
  // fresh cycle: the reattempt budget resets and the window re-anchors at `now`.
  const reattemptsSoFar = windowActive ? Math.max(0, history.attemptCount - 1) : 0;
  const remaining = Math.max(0, cap - reattemptsSoFar);
  return {
    windowEnd: windowActive ? new Date(rawEnd) : new Date(now.getTime() + windowMs),
    remaining,
    capReached: reattemptsSoFar >= cap,
  };
}

/** Count prior identical declines within the CIT velocity window, ending at `now`. */
function countRecentIdenticalDeclines(history: History, code: string, now: Date): number {
  const windowStart = now.getTime() - CIT_VELOCITY_WINDOW_MINUTES * 60_000;
  return history.records.filter(
    (r) =>
      r.declineCode !== undefined &&
      r.declineCode.trim().toUpperCase() === code &&
      r.at.getTime() >= windowStart &&
      r.at.getTime() <= now.getTime(),
  ).length;
}

interface Classification {
  outcome: DeclineOutcome;
  category: string;
  delayHours?: number;
  feeIncurredOnDecline: boolean;
}

function classifyVisa(code: string): Classification {
  const rule = VISA_DECLINE_RULES[code];
  if (!rule) return { outcome: "soft", category: "unknown", feeIncurredOnDecline: false };
  return { outcome: rule.outcome, category: rule.category, feeIncurredOnDecline: false };
}

/** Resolve a raw MAC string to a table entry, tolerating unpadded values. */
function resolveMac(mac: string | undefined): MacInfo | null {
  if (mac === undefined) return null;
  const raw = mac.trim();
  if (raw === "") return null;
  return MASTERCARD_MAC[raw] ?? MASTERCARD_MAC[raw.padStart(2, "0")] ?? null;
}

function classifyMastercard(code: string, mac: string | undefined): Classification {
  const macInfo = resolveMac(mac);
  if (macInfo) {
    // A recognized MAC is the issuer's explicit signal and takes precedence.
    return {
      outcome: macInfo.outcome,
      category: `mac_${macInfo.code}`,
      delayHours: macInfo.delayHours,
      feeIncurredOnDecline: MASTERCARD_MAC_DO_NOT_RETRY.has(macInfo.code),
    };
  }
  const rule = MASTERCARD_DECLINE_RULES[code];
  if (!rule) return { outcome: "soft", category: "unknown", feeIncurredOnDecline: false };
  const category =
    rule.outcome === "hard_decline"
      ? "mc_hard_decline"
      : rule.outcome === "update_required"
        ? "mc_update_required"
        : "mc_soft_decline";
  return { outcome: rule.outcome, category, feeIncurredOnDecline: false };
}

/** Build a decision, filling defaults for the fields not explicitly set. */
function verdict(
  v: Partial<ReattemptDecision> &
    Pick<ReattemptDecision, "reason" | "category" | "context" | "recommendedAction">,
): ReattemptDecision {
  // Fields are listed in canonical order so `console.log` reads logically.
  return {
    allowed: v.allowed ?? false,
    reason: v.reason,
    category: v.category,
    context: v.context,
    permanent: v.permanent ?? false,
    recommendedAction: v.recommendedAction,
    feeRisk: v.feeRisk ?? false,
    feeIncurredOnDecline: v.feeIncurredOnDecline ?? false,
    nextEligibleAt: v.nextEligibleAt ?? null,
    suggestedRetryAt: v.suggestedRetryAt ?? null,
    remainingAttempts: v.remainingAttempts ?? null,
    windowEndsAt: v.windowEndsAt ?? null,
    customerMessage: v.customerMessage ?? null,
    note: v.note ?? null,
  };
}

/**
 * Evaluate whether a declined card transaction may be reattempted under the
 * relevant card-network rules, for the given transaction context.
 *
 * @throws TypeError on an unsupported `network`/`context`, an empty
 * `declineCode`, or an unparseable timestamp.
 */
export function evaluateReattempt(input: ReattemptInput): ReattemptDecision {
  const network: Network = input.network;
  if (network !== "visa" && network !== "mastercard") {
    throw new TypeError(
      `Unsupported network: ${JSON.stringify(network)}. Expected "visa" or "mastercard".`,
    );
  }
  const context: TransactionContext = input.context;
  if (context !== "cit" && context !== "mit") {
    throw new TypeError(
      `Unsupported context: ${JSON.stringify(context)}. Expected "cit" or "mit".`,
    );
  }
  if (typeof input.declineCode !== "string" || input.declineCode.trim() === "") {
    throw new TypeError("declineCode is required and must be a non-empty string.");
  }

  const now = input.now === undefined ? new Date() : toDate(input.now);
  const code = input.declineCode.trim().toUpperCase();
  const history = resolveHistory(input, now);

  const classification =
    network === "visa"
      ? classifyVisa(code)
      : classifyMastercard(code, input.merchantAdviceCode);

  const cap = network === "visa" ? VISA_REATTEMPT_CAP : MASTERCARD_RETRY_CAP;
  const windowDays = network === "visa" ? VISA_WINDOW_DAYS : MASTERCARD_WINDOW_DAYS;

  return decide({ classification, context, code, history, now, cap, windowMs: windowDays * DAY_MS });
}

interface DecideParams {
  classification: Classification;
  context: TransactionContext;
  code: string;
  history: History;
  now: Date;
  cap: number;
  windowMs: number;
}

function decide(p: DecideParams): ReattemptDecision {
  const { classification: c, context, code, history, now } = p;
  const feeOnDecline = c.feeIncurredOnDecline;
  const wm = windowMath(history, now, p.cap, p.windowMs);

  // 1. Hard decline — dead card/account. Blocks both contexts, permanently.
  if (c.outcome === "hard_decline") {
    return verdict({
      allowed: false,
      reason: "hard_decline",
      category: c.category,
      context,
      permanent: true,
      recommendedAction: context === "cit" ? "collect_new_instrument" : "cancel_subscription",
      feeRisk: true,
      feeIncurredOnDecline: feeOnDecline,
      remainingAttempts: 0,
      customerMessage: context === "cit" ? CUSTOMER_MESSAGE.hardDecline : null,
      note: "This card cannot be used for any transaction; a different instrument is required.",
    });
  }

  // 2. Recurring authorization revoked/cancelled. MIT is permanently blocked;
  //    a cardholder-initiated (CIT) payment is still permitted.
  if (c.outcome === "recurring_revoked") {
    if (context === "mit") {
      return verdict({
        allowed: false,
        reason: "recurring_revoked",
        category: c.category,
        context,
        permanent: true,
        recommendedAction: "cancel_subscription",
        feeRisk: true,
        feeIncurredOnDecline: feeOnDecline,
        remainingAttempts: 0,
        note: "Cardholder revoked this recurring authorization. A customer-initiated (CIT) payment by the cardholder remains permitted.",
      });
    }
    return verdict({
      allowed: true,
      reason: "ok",
      category: c.category,
      context,
      recommendedAction: "retry_now",
      feeIncurredOnDecline: feeOnDecline,
      note: "The recurring authorization was revoked, but a cardholder-initiated payment is permitted.",
    });
  }

  // 3. Credential must be updated before any retry (both contexts).
  if (c.outcome === "update_required") {
    return verdict({
      allowed: false,
      reason: "update_required",
      category: c.category,
      context,
      permanent: false,
      recommendedAction: context === "mit" ? "run_account_updater" : "collect_new_instrument",
      feeIncurredOnDecline: feeOnDecline,
      remainingAttempts: context === "mit" ? wm.remaining : null,
      windowEndsAt: context === "mit" ? wm.windowEnd : null,
      customerMessage: context === "cit" ? CUSTOMER_MESSAGE.updateRequired : null,
      note: "The stored credential must be updated (account updater / new card) before retrying.",
    });
  }

  // From here the outcome is `soft` or `delay` — a retryable decline.

  // 4. CIT: caps do not apply; in-session velocity does.
  if (context === "cit") {
    const identical = countRecentIdenticalDeclines(history, code, now);
    if (identical >= CIT_VELOCITY_IDENTICAL_LIMIT) {
      return verdict({
        allowed: false,
        reason: "cit_velocity",
        category: c.category,
        context,
        recommendedAction: "collect_new_instrument",
        feeIncurredOnDecline: feeOnDecline,
        customerMessage: CUSTOMER_MESSAGE.velocity,
        note: `This card was declined ${identical} time(s) in quick succession; prompt for a different payment method.`,
      });
    }
    // Cardholder present: an issuer retry-delay (MAC 24–30) does not gate a CIT.
    return verdict({
      allowed: true,
      reason: "ok",
      category: c.category,
      context,
      recommendedAction: "retry_now",
      feeIncurredOnDecline: feeOnDecline,
    });
  }

  // === MIT path (soft / delay) ===

  // 5. Cap reached — an additional retry would be an excess (fee-bearing).
  if (wm.capReached) {
    return verdict({
      allowed: false,
      reason: "reattempt_cap",
      category: c.category,
      context,
      recommendedAction: "retry_after",
      feeRisk: true,
      feeIncurredOnDecline: feeOnDecline,
      nextEligibleAt: wm.windowEnd,
      suggestedRetryAt: wm.windowEnd,
      remainingAttempts: 0,
      windowEndsAt: wm.windowEnd,
      note: "Network reattempt cap reached; the window must reset before retrying.",
    });
  }

  // 6. Issuer-directed delay (MAC 24–30) that has not yet elapsed.
  if (c.outcome === "delay" && c.delayHours !== undefined) {
    const eligibleAt = new Date(history.lastAttempt.getTime() + c.delayHours * HOUR_MS);
    if (now.getTime() < eligibleAt.getTime()) {
      return verdict({
        allowed: false,
        reason: "retry_delay",
        category: c.category,
        context,
        recommendedAction: "retry_after",
        feeIncurredOnDecline: feeOnDecline,
        nextEligibleAt: eligibleAt,
        suggestedRetryAt: eligibleAt,
        remainingAttempts: wm.remaining,
        windowEndsAt: wm.windowEnd,
        note: "Issuer-directed retry delay is still in effect.",
      });
    }
  }

  // 7. Retryable now. Layer advisory best-practice spacing on top.
  const spacingHours = MIT_SOFT_RETRY_SPACING_HOURS[code] ?? DEFAULT_MIT_SOFT_RETRY_SPACING_HOURS;
  const suggested = new Date(history.lastAttempt.getTime() + spacingHours * HOUR_MS);
  const suggestedRetryAt = suggested.getTime() > now.getTime() ? suggested : null;
  return verdict({
    allowed: true,
    reason: "ok",
    category: c.category,
    context,
    recommendedAction: suggestedRetryAt ? "retry_after" : "retry_now",
    feeIncurredOnDecline: feeOnDecline,
    suggestedRetryAt,
    remainingAttempts: wm.remaining,
    windowEndsAt: wm.windowEnd,
    note: suggestedRetryAt
      ? "Retry is permitted now; the suggested time is advisory best-practice spacing, not a network mandate."
      : null,
  });
}
