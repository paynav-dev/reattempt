/**
 * Map a Worldpay Express (Element Express) response onto a `@paynav/reattempt`
 * {@link ReattemptInput}.
 *
 * `@paynav/reattempt` takes **raw card-network codes**, not a processor's own
 * abstraction. Worldpay Express happens to expose exactly the fields it needs:
 *
 *   - `HostResponseCode`   — the raw issuer/network response code → `declineCode`
 *   - `MerchantAdviceCode` — the Mastercard MAC                   → `merchantAdviceCode`
 *   - `CardLogo`           — the payment brand                    → `network`
 *   - `PaymentType`        — credential-on-file payment type      → `context` / `mitSubtype`
 *
 * `ExpressResponseCode` is Worldpay's *own* success/failure summary (`"0"` =
 * approved, `"20"` = declined, …). Use it to decide whether a decline even
 * happened — never feed it to the engine as the decline code; it is not a
 * network code.
 *
 * Field names and enum values are from the Express Interface Specification v3
 * (© 2025 Worldpay), Appendix 1 "Response Codes", `PaymentType`, and `CardLogo`.
 *
 * @see ../docs/processors.md
 */

import type {
  MitSubtype,
  Network,
  ReattemptInput,
  TransactionContext,
} from "@paynav/reattempt";

/**
 * The subset of an Express transaction response this mapping reads. A real
 * response has many more fields; only these matter for a reattempt decision.
 */
export interface WorldpayExpressResponse {
  /** Worldpay's own outcome summary: `"0"` approved, `"20"` declined, `"21"` expired, … */
  ExpressResponseCode: string;
  /** Human-readable form of {@link ExpressResponseCode}. */
  ExpressResponseMessage?: string;
  /** Raw issuer/network response code, e.g. `"05"`, `"51"`, `"14"`, `"54"`, `"R1"`. */
  HostResponseCode?: string;
  /** Human-readable issuer message (processor-dependent). */
  HostResponseMessage?: string;
  /** Mastercard Merchant Advice Code, e.g. `"03"`, `"21"`, `"25"`. Response field only. */
  MerchantAdviceCode?: string;
  /** Payment brand: `"Visa"`, `"Mastercard"`, `"Discover"`, `"Amex"`, … */
  CardLogo?: string;
  /** Credential-on-file payment type: `"1"` Recurring, `"2"` Installment, `"3"` Cardholder-Initiated, `"4"` Credential-on-File. */
  PaymentType?: string;
  /** Credential-on-file submission type: `"1"` Initial, `"2"` Subsequent, `"3"` Resubmission, … */
  SubmissionType?: string;
  /** Stored-credential chaining id. The engine does not use it — your PSP does. */
  NetworkTransactionID?: string;
}

/** `CardLogo` → engine {@link Network}. Brands the engine does not cover map to `null`. */
export function networkFromCardLogo(cardLogo: string | undefined): Network | null {
  switch (cardLogo?.trim().toLowerCase()) {
    case "visa":
      return "visa";
    case "mastercard":
      return "mastercard";
    default:
      // Amex, Discover, Diners Club, JCB, Carte Blanche, Union Pay, Other — not
      // covered by this engine (Visa/Mastercard only).
      return null;
  }
}

/**
 * Derive the engine {@link TransactionContext} from `PaymentType` when you do
 * not already know it. Prefer passing `context` explicitly: at the call site you
 * almost always know whether this is a checkout (CIT) or a dunning job (MIT), and
 * that is more reliable than reverse-engineering it from the stored value.
 *
 * `"4"` (generic Credential-on-File) is treated as MIT here, but a *cardholder-
 * present* credential-on-file checkout is CIT — override it when the customer is
 * on the page.
 */
export function contextFromPaymentType(
  paymentType: string | undefined,
): TransactionContext | null {
  switch (paymentType) {
    case "3": // Cardholder Initiated
      return "cit";
    case "1": // Recurring
    case "2": // Installment
    case "4": // Credential on File (see caveat above)
      return "mit";
    default:
      return null;
  }
}

/** `PaymentType` → engine {@link MitSubtype} (record-keeping only; the engine does not branch on it). */
export function mitSubtypeFromPaymentType(
  paymentType: string | undefined,
): MitSubtype | undefined {
  switch (paymentType) {
    case "1":
      return "recurring";
    case "2":
      return "installment";
    case "4":
      return "unscheduled";
    default:
      return undefined;
  }
}

/**
 * `true` when the Express response is a decline the engine should evaluate.
 * Approvals (`"0"`), partial approvals (`"5"`), and duplicate approvals (`"22"`)
 * are not declines — do not evaluate them. A decline without a
 * {@link WorldpayExpressResponse.HostResponseCode} is not evaluable either
 * (gateway/system errors may set `ExpressResponseCode` alone).
 */
export function isExpressDecline(res: WorldpayExpressResponse): boolean {
  return (
    !["0", "5", "22"].includes(res.ExpressResponseCode) &&
    res.HostResponseCode !== undefined &&
    res.HostResponseCode.trim() !== ""
  );
}

/** Extra history/clock inputs to forward to the engine, plus context/network overrides. */
export interface MappingOptions
  extends Pick<ReattemptInput, "attempts" | "priorAttempts" | "firstAttemptAt" | "now"> {
  /** Override the derived context. Recommended: you know CIT vs MIT at the call site. */
  context?: TransactionContext;
  /** Override the brand derived from `CardLogo`. */
  network?: Network;
}

/**
 * Convert an Express decline response into a {@link ReattemptInput}.
 *
 * @throws Error if the brand is unsupported, the context cannot be determined,
 * or the response carries no `HostResponseCode` (call {@link isExpressDecline}
 * first — an approval has nothing to evaluate).
 */
export function toReattemptInput(
  res: WorldpayExpressResponse,
  opts: MappingOptions = {},
): ReattemptInput {
  const network = opts.network ?? networkFromCardLogo(res.CardLogo);
  if (!network) {
    throw new Error(
      `Unsupported or missing CardLogo: ${JSON.stringify(res.CardLogo)} (engine covers Visa/Mastercard).`,
    );
  }

  const context = opts.context ?? contextFromPaymentType(res.PaymentType);
  if (!context) {
    throw new Error(
      `Cannot determine context from PaymentType ${JSON.stringify(res.PaymentType)}; pass { context } explicitly.`,
    );
  }

  if (!res.HostResponseCode) {
    throw new Error(
      "No HostResponseCode on the response — nothing to evaluate. Guard with isExpressDecline() first.",
    );
  }

  return {
    network,
    context,
    declineCode: res.HostResponseCode,
    merchantAdviceCode: res.MerchantAdviceCode,
    mitSubtype: mitSubtypeFromPaymentType(res.PaymentType),
    attempts: opts.attempts,
    priorAttempts: opts.priorAttempts,
    firstAttemptAt: opts.firstAttemptAt,
    now: opts.now,
  };
}
