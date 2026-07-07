/**
 * Visa declined-transaction reattempt rules.
 *
 * Framework: Visa's "Updates to rules for declined transaction resubmission"
 * (Visa Rules; effective 2021-04-17, fees applied since 2022-04). A declined
 * card-not-present transaction is classified into one of four categories; the
 * category determines whether — and how often — it may be reattempted.
 *
 * Primary sources (verified 2026-07):
 *   - Visa Rules / "Updates to rules for declined transaction resubmission",
 *     usa.visa.com merchant resources.
 *   - CardPointe "Visa decline categories" reference table
 *     (developer.cardpointe.com), which republishes Visa's response-code ->
 *     category mapping.
 *   - Qualpay / Merchant Cost Consulting summaries of the Visa reattempt fee.
 *
 * CIT vs MIT: Visa's stop-payment / revocation responses (R0/R1/R3) are
 * "Category 1" in the framework, but they revoke the *recurring authorization*
 * — they block merchant-initiated (MIT) retries permanently, while a fresh
 * cardholder-initiated (CIT) payment remains permitted. They are therefore
 * given the `recurring_revoked` outcome; the truly dead-card Category 1 codes
 * get `hard_decline` (both contexts).
 */

import type { DeclineOutcome } from "../types";

/** Maximum MIT reattempts (retries after the original decline) within the window. */
export const VISA_REATTEMPT_CAP = 15;

/** Cap window length, in days, anchored at the original decline. */
export const VISA_WINDOW_DAYS = 30;

/** Per-violating-reattempt fee, domestic (USD). Source: Visa reattempt fee schedule. */
export const VISA_FEE_DOMESTIC_USD = 0.1;

/** Per-violating-reattempt fee, international (USD). Source: Visa reattempt fee schedule. */
export const VISA_FEE_INTERNATIONAL_USD = 0.15;

/**
 * Visa reattempt categories (the framework's own labels, surfaced for display).
 *  - `visa_category_1`: "Issuer will never approve."
 *  - `visa_category_2`: "Issuer cannot approve at this time."
 *  - `visa_category_3`: "Data quality" — correct/revalidate, then retry.
 *  - `visa_category_4`: "Generic."
 */
export type VisaCategory =
  | "visa_category_1"
  | "visa_category_2"
  | "visa_category_3"
  | "visa_category_4";

/** A Visa response-code rule: its framework category and the engine's handling. */
export interface VisaRule {
  /** Visa's framework category label (display / citation). */
  category: VisaCategory;
  /** How the engine handles it. */
  outcome: DeclineOutcome;
}

/**
 * Visa response code -> rule. Keys are uppercase network response codes. Codes
 * absent from this table are treated as `unknown` / `soft` by the engine
 * (retryable, still cap-bound for MIT). Per-code source notes inline.
 */
export const VISA_DECLINE_RULES: Readonly<Record<string, VisaRule>> = {
  // --- Category 1 — dead card/account: hard decline, both contexts ---
  "04": { category: "visa_category_1", outcome: "hard_decline" }, // Pick up card
  "07": { category: "visa_category_1", outcome: "hard_decline" }, // Pick up card, special condition (fraud)
  "12": { category: "visa_category_1", outcome: "hard_decline" }, // Invalid transaction
  "14": { category: "visa_category_1", outcome: "hard_decline" }, // Invalid account number
  "15": { category: "visa_category_1", outcome: "hard_decline" }, // No such issuer
  "41": { category: "visa_category_1", outcome: "hard_decline" }, // Lost card, pick up
  "43": { category: "visa_category_1", outcome: "hard_decline" }, // Stolen card, pick up
  "46": { category: "visa_category_1", outcome: "hard_decline" }, // Closed account
  "57": { category: "visa_category_1", outcome: "hard_decline" }, // Transaction not permitted to cardholder
  "93": { category: "visa_category_1", outcome: "hard_decline" }, // Violation of law; cannot complete

  // --- Category 1 — stop payment / revocation: recurring_revoked (MIT-only) ---
  R0: { category: "visa_category_1", outcome: "recurring_revoked" }, // Stop payment order
  R1: { category: "visa_category_1", outcome: "recurring_revoked" }, // Revocation of authorization order
  R3: { category: "visa_category_1", outcome: "recurring_revoked" }, // Revocation of all authorizations order

  // --- Category 3 — data quality: update the credential, then retry ---
  "54": { category: "visa_category_3", outcome: "update_required" }, // Expired card
  N7: { category: "visa_category_3", outcome: "update_required" }, // CVV2 (card verification) failure

  // --- Category 2 — issuer cannot approve at this time: soft ---
  "51": { category: "visa_category_2", outcome: "soft" }, // Insufficient funds
  "61": { category: "visa_category_2", outcome: "soft" }, // Exceeds approval amount limit
  "65": { category: "visa_category_2", outcome: "soft" }, // Exceeds withdrawal frequency limit

  // --- Category 4 — generic: soft ---
  "05": { category: "visa_category_4", outcome: "soft" }, // Do not honor
  "01": { category: "visa_category_4", outcome: "soft" }, // Refer to card issuer
  "02": { category: "visa_category_4", outcome: "soft" }, // Refer to card issuer, special condition
  "19": { category: "visa_category_4", outcome: "soft" }, // Re-enter transaction
  "91": { category: "visa_category_4", outcome: "soft" }, // Issuer or switch inoperative
  "96": { category: "visa_category_4", outcome: "soft" }, // System malfunction
};

/**
 * Convenience view: Visa response code -> framework category label. Derived
 * from {@link VISA_DECLINE_RULES}.
 */
export const VISA_DECLINE_CATEGORY: Readonly<Record<string, VisaCategory>> =
  Object.fromEntries(
    Object.entries(VISA_DECLINE_RULES).map(([code, rule]) => [code, rule.category]),
  );
