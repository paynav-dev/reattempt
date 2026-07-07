/**
 * Public type surface for `@paynav/reattempt`.
 *
 * The engine is a pure decision function: raw network decline signals in,
 * a structured, context-aware reattempt-compliance decision out. No
 * PSP/gateway-specific code mapping and no stored-credential plumbing lives
 * here — feed the raw network response code and say whether the attempt is
 * customer-initiated (CIT) or merchant-initiated (MIT).
 */

/** Card network whose reattempt rules apply. */
export type Network = "visa" | "mastercard";

/**
 * Who initiates the transaction. The correct handling differs sharply:
 *  - `"cit"` — **customer-initiated**: the cardholder is present (checkout,
 *    "update payment method", a retry button). Authentication is available and
 *    a cardholder-consented payment is a fresh authorization.
 *  - `"mit"` — **merchant-initiated**: the cardholder is absent and you charge a
 *    stored credential (subscriptions, usage billing, installments, dunning).
 *    This is where excessive-reattempt rules do most of their damage.
 */
export type TransactionContext = "cit" | "mit";

/**
 * Sub-type of a merchant-initiated transaction. Carried for record-keeping and
 * reserved for future subtype-specific rule refinement; the current engine does
 * not branch on it.
 */
export type MitSubtype = "recurring" | "unscheduled" | "installment";

/**
 * A timestamp accepted by the engine. `Date`, an ISO-8601 string, or an epoch
 * milliseconds number are all coerced with `new Date(value)`.
 */
export type Timestamp = Date | string | number;

/**
 * A prior attempt. May be a bare {@link Timestamp}, or a record carrying the
 * attempt's context and its own decline code — the latter enables CIT
 * in-session velocity detection (repeated identical declines).
 */
export interface AttemptRecord {
  /** When the attempt happened. */
  at: Timestamp;
  /** Whether that attempt was customer- or merchant-initiated. */
  context?: TransactionContext;
  /** MIT sub-type of that attempt, if applicable. */
  mitSubtype?: MitSubtype;
  /** The decline code that attempt returned; enables CIT velocity logic. */
  declineCode?: string;
}

/** An attempt supplied to the engine: a bare timestamp or a full record. */
export type AttemptLike = Timestamp | AttemptRecord;

/**
 * How a decline should be handled, independent of the caps/velocity windows.
 *  - `"hard_decline"` — the card/account is dead; blocks **both** CIT and MIT,
 *    permanently (lost/stolen/pickup/closed/invalid).
 *  - `"recurring_revoked"` — the recurring authorization was revoked/cancelled;
 *    blocks **MIT** permanently, but a cardholder-initiated (CIT) payment is
 *    still permitted (Visa stop-payment/revocation, Mastercard MAC 03/21).
 *  - `"update_required"` — the stored credential must be refreshed before any
 *    retry (Mastercard MAC 01/04, expired card). Retrying as-is won't help.
 *  - `"soft"` — a transient/soft decline; retryable subject to caps (MIT) or
 *    velocity (CIT).
 *  - `"delay"` — a Mastercard issuer-directed retry delay (MAC 24–30).
 */
export type DeclineOutcome =
  | "hard_decline"
  | "recurring_revoked"
  | "update_required"
  | "soft"
  | "delay";

/** Input to {@link evaluateReattempt}. */
export interface ReattemptInput {
  /** Card network. Its rule set is selected from this. */
  network: Network;

  /** Whether this attempt is customer-initiated (`"cit"`) or merchant-initiated (`"mit"`). */
  context: TransactionContext;

  /**
   * Raw network response / decline code, e.g. Visa `"14"`, Mastercard `"05"`,
   * or Visa stop-payment `"R1"`. Case-insensitive; leading/trailing space is
   * trimmed. This is the network's own code — not a PSP abstraction such as
   * Stripe `decline_code` or Adyen `refusalReason`.
   */
  declineCode: string;

  /**
   * Mastercard Merchant Advice Code (MAC), when the issuer supplied one
   * (e.g. `"03"`, `"21"`, `"25"`). When present and recognized it *overrides*
   * the raw `declineCode` classification, because it is the issuer's explicit
   * guidance. Ignored for `network: "visa"`.
   */
  merchantAdviceCode?: string;

  /** MIT sub-type of the current transaction. Optional; carried, not yet branched on. */
  mitSubtype?: MitSubtype;

  /**
   * Every attempt already made for this transaction/credential, **including the
   * original decline and the one you're reacting to**. Order does not matter.
   * Supply {@link AttemptRecord}s with `declineCode` to enable CIT velocity
   * detection. Prefer this over {@link priorAttempts} when you have the data.
   */
  attempts?: AttemptLike[];

  /**
   * Convenience alternative to {@link attempts}: the number of attempts already
   * made (including the original decline). Combine with {@link firstAttemptAt}.
   * Ignored when {@link attempts} is provided. (No per-attempt codes, so it
   * cannot drive CIT velocity.)
   */
  priorAttempts?: number;

  /**
   * The original decline timestamp — the anchor for the network's cap window.
   * Used with {@link priorAttempts}. Ignored when {@link attempts} is provided.
   * Defaults to {@link now} when omitted.
   */
  firstAttemptAt?: Timestamp;

  /** Injectable clock for deterministic evaluation. Defaults to `new Date()`. */
  now?: Timestamp;
}

/** Why the engine reached its {@link ReattemptDecision.allowed} verdict. */
export type ReattemptReason =
  /** A reattempt is permitted now. */
  | "ok"
  /** Dead card/account — never reattempt, in any context. */
  | "hard_decline"
  /** Recurring authorization revoked — never reattempt as MIT (CIT still allowed). */
  | "recurring_revoked"
  /** Stored credential must be updated before retrying. */
  | "update_required"
  /** Network reattempt/retry cap reached (MIT). */
  | "reattempt_cap"
  /** Mastercard MAC 24–30 issuer-directed delay has not yet elapsed (MIT). */
  | "retry_delay"
  /** CIT in-session velocity limit: too many identical declines in a row. */
  | "cit_velocity";

/**
 * Suggested next action for the caller's retry/dunning logic. A richer signal
 * than `allowed` alone — turns the verdict from a bouncer into a dunning brain.
 */
export type RecommendedAction =
  /** Reattempt now. */
  | "retry_now"
  /** Reattempt later; see {@link ReattemptDecision.nextEligibleAt} / `suggestedRetryAt`. */
  | "retry_after"
  /** Refresh the stored credential (account updater / network token), then retry. */
  | "run_account_updater"
  /** Obtain a different payment instrument (CIT: prompt for another card). */
  | "collect_new_instrument"
  /** Stop billing this credential; e.g. pause the subscription and notify. */
  | "cancel_subscription"
  /** Do not reattempt at all. */
  | "do_not_retry";

/** Structured decision returned by {@link evaluateReattempt}. */
export interface ReattemptDecision {
  /** Whether a reattempt is permitted **right now**, in the given context. */
  allowed: boolean;

  /** Machine-readable justification for {@link allowed}. */
  reason: ReattemptReason;

  /**
   * Classification label for the decline, e.g. `"visa_category_1"`, `"mac_25"`,
   * `"mc_hard_decline"`, or `"unknown"`. Treat as an open string set.
   */
  category: string | null;

  /** Echoes the {@link ReattemptInput.context} the decision was made for. */
  context: TransactionContext;

  /**
   * Whether the block is **permanent** for this context (hard decline, or a
   * revoked recurring authorization for MIT) rather than a temporary
   * cap/delay/velocity gate.
   */
  permanent: boolean;

  /** Suggested next action for retry/dunning logic. */
  recommendedAction: RecommendedAction;

  /**
   * `true` when reattempting **now** would risk or incur a network
   * excessive-reattempt / do-not-retry fee.
   */
  feeRisk: boolean;

  /**
   * `true` when a fee already applies to the decline that just occurred,
   * independent of whether you reattempt. As of Mastercard's January 2026
   * change this is the case for **every** declined CNP transaction carrying
   * MAC 03 or MAC 21, even a first decline.
   */
  feeIncurredOnDecline: boolean;

  /**
   * Earliest **network-permitted** time to reattempt, when {@link allowed} is
   * `false`. `null` means *never* (hard decline / revoked-for-MIT) or that no
   * network-mandated wait applies. From a MAC 24–30 delay or a cap-window reset.
   */
  nextEligibleAt: Date | null;

  /**
   * **Advisory** best-practice retry time (e.g. payday-aware spacing for
   * insufficient-funds MIT retries). Not a network mandate — optimization
   * guidance layered on top of {@link nextEligibleAt}. `null` when not
   * applicable (e.g. CIT, where the cardholder is present).
   */
  suggestedRetryAt: Date | null;

  /**
   * Reattempts still permitted within the current MIT window before the cap.
   * `null` for CIT (not cap-gated) and for do-not-retry declines.
   */
  remainingAttempts: number | null;

  /**
   * End of the current MIT cap window (anchor + 30 days). `null` for CIT and
   * for do-not-retry declines, where no cap window applies.
   */
  windowEndsAt: Date | null;

  /**
   * A **sanitized**, customer-safe message for CIT checkout UX. Never reveals
   * fraud/lost/stolen specifics. `null` when there is no customer to show it to
   * (MIT) or nothing to say.
   */
  customerMessage: string | null;

  /** Human-readable note explaining a nuance of the verdict, when relevant. */
  note: string | null;
}
