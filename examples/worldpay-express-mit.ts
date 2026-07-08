/**
 * Worldpay Express — MIT (merchant-initiated) example.
 *
 * A dunning/rebill job charges a stored credential with the cardholder absent.
 * This is where excessive-reattempt rules bite: fee-bearing caps, issuer-directed
 * retry delays (Mastercard MAC 24–30), and permanent stop signals (MAC 03/21).
 * Call the engine as the *first step* of each scheduled retry — before you send
 * the auth to Express — and let the verdict gate or reshape the schedule.
 *
 * Run: `npx tsx examples/worldpay-express-mit.ts`
 */

import { evaluateReattempt, type ReattemptDecision } from "@paynav/reattempt";
import {
  toReattemptInput,
  type WorldpayExpressResponse,
} from "./worldpay-express-mapping";

/** The attempt history your dunning system already stores for this subscription. */
interface DunningState {
  /** Every prior Express attempt for this credential, including the original decline. */
  attempts: Date[];
}

/**
 * Decide what a dunning job should do next, given the last Express decline and
 * the attempt history. Returns the engine's decision; the caller reschedules,
 * pauses the subscription, or triggers an account-updater run accordingly.
 */
function planNextRetry(
  res: WorldpayExpressResponse,
  state: DunningState,
  now: Date,
): ReattemptDecision {
  // Cardholder absent, charging a stored credential → context is "mit".
  const decision = evaluateReattempt(
    toReattemptInput(res, { context: "mit", attempts: state.attempts, now }),
  );

  const when = decision.nextEligibleAt ?? decision.suggestedRetryAt;
  console.log(
    `\nHost ${res.HostResponseCode}${res.MerchantAdviceCode ? ` · MAC ${res.MerchantAdviceCode}` : ""} → ` +
      `allowed=${decision.allowed} reason=${decision.reason} action=${decision.recommendedAction}` +
      (decision.feeIncurredOnDecline ? " · ⚠️ decline fee incurred" : ""),
  );

  switch (decision.recommendedAction) {
    case "retry_now":
      console.log("  → Re-send the auth to Express now.");
      break;
    case "retry_after":
      console.log(`  → Reschedule the retry for ${when?.toISOString()}.`);
      break;
    case "run_account_updater":
      console.log("  → Run the account updater / refresh the network token, then retry.");
      break;
    case "cancel_subscription":
      console.log("  → Stop billing this credential; pause the subscription and notify the customer.");
      break;
    case "collect_new_instrument":
    case "do_not_retry":
      console.log("  → Do not retry as MIT; move the customer to a card-update flow.");
      break;
  }
  return decision;
}

const now = new Date("2026-07-07T09:00:00Z");
const firstDecline = new Date("2026-07-05T09:00:00Z");

// 1. Insufficient funds, no MAC. Retryable, but space it out (payday-aware).
const insufficientFunds: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "51", // insufficient funds
  CardLogo: "Visa",
  PaymentType: "1", // Recurring
  SubmissionType: "2", // Subsequent
};
planNextRetry(insufficientFunds, { attempts: [firstDecline] }, now);

// 2. Mastercard MAC 25 — issuer says "retry after 24 hours". The delay is
//    enforced for MIT; retrying early risks a fee.
const retryAfter24h: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "05",
  MerchantAdviceCode: "25", // retry after 24 hours
  CardLogo: "Mastercard",
  PaymentType: "1",
  SubmissionType: "2",
};
planNextRetry(
  retryAfter24h,
  { attempts: [new Date("2026-07-07T06:00:00Z")] }, // 3h ago — delay not elapsed
  now,
);

// 3. Mastercard MAC 01 — "new account information available". Don't retry the
//    old credential; run the account updater first.
const updateAvailable: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "05",
  MerchantAdviceCode: "01",
  CardLogo: "Mastercard",
  PaymentType: "1",
};
planNextRetry(updateAvailable, { attempts: [firstDecline] }, now);

// 4. Mastercard MAC 21 — recurring cancellation. Permanent MIT block, and (since
//    Jan 2026) the decline itself incurs a fee. Stop billing.
const cancelled: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "05",
  MerchantAdviceCode: "21",
  CardLogo: "Mastercard",
  PaymentType: "1",
};
planNextRetry(cancelled, { attempts: [firstDecline] }, now);

// 5. Lost/stolen (dead card) with no MAC. Blocks MIT permanently.
const lostCard: WorldpayExpressResponse = {
  ExpressResponseCode: "24",
  ExpressResponseMessage: "Pick Up Card",
  HostResponseCode: "41", // lost card
  CardLogo: "Visa",
  PaymentType: "1",
};
planNextRetry(lostCard, { attempts: [firstDecline] }, now);
