/**
 * `@paynav/reattempt` — card-network retry-compliance engine.
 *
 * Decide whether a declined Visa/Mastercard card-not-present transaction may be
 * reattempted — customer-initiated (CIT) or merchant-initiated (MIT) — why, the
 * recommended action, the fee risk, and when the next attempt becomes eligible.
 *
 * @packageDocumentation
 */

export {
  evaluateReattempt,
  CIT_VELOCITY_IDENTICAL_LIMIT,
  CIT_VELOCITY_WINDOW_MINUTES,
  MIT_SOFT_RETRY_SPACING_HOURS,
  DEFAULT_MIT_SOFT_RETRY_SPACING_HOURS,
} from "./engine";

export type {
  Network,
  TransactionContext,
  MitSubtype,
  Timestamp,
  AttemptRecord,
  AttemptLike,
  DeclineOutcome,
  ReattemptInput,
  ReattemptReason,
  RecommendedAction,
  ReattemptDecision,
} from "./types";

// Rule data & constants, exported for advanced use, display, and testing.
export {
  VISA_REATTEMPT_CAP,
  VISA_WINDOW_DAYS,
  VISA_FEE_DOMESTIC_USD,
  VISA_FEE_INTERNATIONAL_USD,
  VISA_DECLINE_RULES,
  VISA_DECLINE_CATEGORY,
  type VisaCategory,
  type VisaRule,
} from "./data/visa";

export {
  MASTERCARD_RETRY_CAP,
  MASTERCARD_WINDOW_DAYS,
  MASTERCARD_EXCESS_FEE_USD,
  MASTERCARD_MAC,
  MASTERCARD_MAC_DO_NOT_RETRY,
  MASTERCARD_DECLINE_RULES,
  type MacInfo,
  type MastercardCodeRule,
} from "./data/mastercard";
