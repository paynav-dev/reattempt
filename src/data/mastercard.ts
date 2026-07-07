/**
 * Mastercard declined-transaction reattempt rules.
 *
 * Framework: Mastercard "Transaction Processing Excellence" (TPE) program,
 * driven primarily by the issuer-supplied Merchant Advice Code (MAC) in DE 48,
 * subelement 84. The MAC, when present, is the issuer's explicit instruction
 * and takes precedence over the raw response code.
 *
 * Primary sources (verified 2026-07):
 *   - Mastercard Merchant Advice Code reference (as republished by Braintree,
 *     TabaPay, and payabl. developer docs).
 *   - Mastercard TPE / "excessive declined authorization" fee guidance
 *     (Merchant Cost Consulting; payments-industry summaries).
 *
 * Key dates / CIT vs MIT:
 *   - MAC 24–30 (issuer-directed retry delays) added 2024.
 *   - MAC 03 ("do not try again") and MAC 21 ("payment cancellation") are
 *     recurring-merchant stop signals: they block MIT permanently but a
 *     cardholder-initiated (CIT) payment remains permitted -> `recurring_revoked`.
 *   - Since January 2026, the do-not-retry fee applies to *every* declined CNP
 *     transaction carrying MAC 03 or MAC 21 — not only to subsequent retries.
 */

import type { DeclineOutcome } from "../types";

/** Maximum MIT retries (after the original decline) within the window. */
export const MASTERCARD_RETRY_CAP = 35;

/** Cap window length, in days, anchored at the original decline. */
export const MASTERCARD_WINDOW_DAYS = 30;

/**
 * Per-excess-retry fee (USD), 2025 rate. Historical: $0.15 (2023), $0.30
 * (2024), $0.50 (2025). Source: Merchant Cost Consulting TPE fee schedule.
 */
export const MASTERCARD_EXCESS_FEE_USD = 0.5;

/** A single Merchant Advice Code entry. */
export interface MacInfo {
  /** Two-digit MAC value, e.g. `"03"`. */
  code: string;
  /** Human-readable meaning. */
  label: string;
  /** How the engine handles this MAC. */
  outcome: DeclineOutcome;
  /** For `delay` MACs (24–30): minimum wait before retrying, in hours. */
  delayHours?: number;
  /** Optional advisory shown in docs; not part of the decision logic. */
  advisory?: string;
}

/**
 * Mastercard Merchant Advice Code table.
 *
 * MAC 03/21 are terminal for MIT (`recurring_revoked`). MAC 01/04 require a
 * credential refresh (`update_required`). MAC 24–30 encode issuer-directed
 * minimum retry delays. MAC 02 is a plain soft "try again later".
 */
export const MASTERCARD_MAC: Readonly<Record<string, MacInfo>> = {
  "01": {
    code: "01",
    label: "New account information available",
    outcome: "update_required",
    advisory: "Obtain updated card credentials (e.g. Account Updater) before retrying.",
  },
  "02": {
    code: "02",
    label: "Cannot approve at this time, try again later",
    outcome: "soft",
  },
  "03": {
    code: "03",
    label: "Do not try again",
    outcome: "recurring_revoked",
  },
  "04": {
    code: "04",
    label: "Token requirements not fulfilled for this token requestor",
    outcome: "update_required",
    advisory: "Resolve the token/credential requirement (e.g. network token refresh) before retrying.",
  },
  "21": {
    code: "21",
    label: "Payment cancellation (do not try again)",
    outcome: "recurring_revoked",
  },
  // MAC 24–30: issuer-directed minimum retry delays (added 2024).
  "24": { code: "24", label: "Retry after 1 hour", outcome: "delay", delayHours: 1 },
  "25": { code: "25", label: "Retry after 24 hours", outcome: "delay", delayHours: 24 },
  "26": { code: "26", label: "Retry after 2 days", outcome: "delay", delayHours: 48 },
  "27": { code: "27", label: "Retry after 4 days", outcome: "delay", delayHours: 96 },
  "28": { code: "28", label: "Retry after 6 days", outcome: "delay", delayHours: 144 },
  "29": { code: "29", label: "Retry after 8 days", outcome: "delay", delayHours: 192 },
  "30": { code: "30", label: "Retry after 10 days", outcome: "delay", delayHours: 240 },
};

/**
 * MACs whose presence on a decline triggers the Mastercard do-not-retry fee
 * (charged on the decline itself since January 2026).
 */
export const MASTERCARD_MAC_DO_NOT_RETRY: ReadonlySet<string> = new Set(["03", "21"]);

/** A raw Mastercard response-code rule (consulted only when no MAC is present). */
export interface MastercardCodeRule {
  outcome: DeclineOutcome;
}

/**
 * Raw Mastercard response code -> rule, consulted only when no (recognized)
 * Merchant Advice Code is supplied. Codes absent here are treated as `unknown`
 * / `soft` (retryable, still cap-bound for MIT).
 */
export const MASTERCARD_DECLINE_RULES: Readonly<Record<string, MastercardCodeRule>> = {
  // Hard declines — dead card, both contexts.
  "04": { outcome: "hard_decline" }, // Pick up card
  "07": { outcome: "hard_decline" }, // Pick up card, special condition (fraud)
  "14": { outcome: "hard_decline" }, // Invalid card number
  "15": { outcome: "hard_decline" }, // No such issuer
  "41": { outcome: "hard_decline" }, // Lost card
  "43": { outcome: "hard_decline" }, // Stolen card
  "57": { outcome: "hard_decline" }, // Transaction not permitted to cardholder
  "62": { outcome: "hard_decline" }, // Restricted card

  // Data quality — refresh the credential first.
  "54": { outcome: "update_required" }, // Expired card

  // Soft declines — retryable (subject to the cap for MIT).
  "01": { outcome: "soft" }, // Refer to card issuer
  "02": { outcome: "soft" }, // Refer to card issuer, special condition
  "05": { outcome: "soft" }, // Do not honor
  "51": { outcome: "soft" }, // Insufficient funds
  "61": { outcome: "soft" }, // Exceeds withdrawal amount limit
  "65": { outcome: "soft" }, // Exceeds withdrawal frequency limit
  "91": { outcome: "soft" }, // Issuer or switch inoperative
  "96": { outcome: "soft" }, // System malfunction
};
