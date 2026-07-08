/**
 * Worldpay Express — CIT (customer-initiated) example.
 *
 * The cardholder is present at checkout. You call Express, it declines, and you
 * must decide — synchronously, while the customer waits — whether to let them
 * retry, tell them to update their card, or prompt for a different method. Never
 * echo a fraud/lost/stolen reason back to the page; use `customerMessage`.
 *
 * Run: `npx tsx examples/worldpay-express-cit.ts`
 */

import { evaluateReattempt } from "@paynav/reattempt";
import {
  isExpressDecline,
  toReattemptInput,
  type WorldpayExpressResponse,
} from "./worldpay-express-mapping";

/**
 * React to a single Express checkout response. In a real app the return value
 * would drive your payment-route response (retry the card, swap methods, etc.).
 */
function handleCheckoutResponse(res: WorldpayExpressResponse) {
  if (!isExpressDecline(res)) {
    console.log(`✅ ${res.ExpressResponseMessage ?? "Approved"} — nothing to evaluate.`);
    return;
  }

  // Cardholder is on the page → context is "cit".
  const decision = evaluateReattempt(toReattemptInput(res, { context: "cit" }));

  console.log(
    `\nExpress: ${res.ExpressResponseCode}/${res.ExpressResponseMessage} · ` +
      `Host: ${res.HostResponseCode}${res.MerchantAdviceCode ? ` · MAC ${res.MerchantAdviceCode}` : ""}`,
  );
  console.log(`  allowed=${decision.allowed} reason=${decision.reason} action=${decision.recommendedAction}`);

  if (decision.allowed) {
    // Soft decline with the cardholder present: let them press "Pay" again.
    console.log("  → Keep the card entered; allow another attempt.");
  } else if (decision.customerMessage) {
    // Sanitized, safe to render. Do NOT surface HostResponseMessage on fraud codes.
    console.log(`  → Show the customer: "${decision.customerMessage}"`);
  }
}

// --- Representative Express checkout responses ---------------------------------

// 1. Do-not-honor (soft). Cardholder present → let them try again.
const doNotHonor: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "05", // do not honor
  CardLogo: "Visa",
  PaymentType: "3", // Cardholder Initiated
};

// 2. Invalid account (dead card). Prompt for a different instrument — but with a
//    generic message; never reveal the real reason.
const invalidAccount: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "14", // invalid account number
  CardLogo: "Visa",
  PaymentType: "3",
};

// 3. Expired card. Ask the customer to update or use another card.
const expired: WorldpayExpressResponse = {
  ExpressResponseCode: "21",
  ExpressResponseMessage: "Expired Card",
  HostResponseCode: "54", // expired card
  CardLogo: "Mastercard",
  PaymentType: "3",
};

// 4. Mastercard MAC 21 (recurring cancellation). For a *recurring* charge this
//    permanently blocks MIT — but here the cardholder is actively paying, so a
//    fresh CIT payment is allowed. (Since Jan 2026 the network still charges a
//    decline fee: feeIncurredOnDecline is true even though allowed is true.)
const macCancellation: WorldpayExpressResponse = {
  ExpressResponseCode: "20",
  ExpressResponseMessage: "Declined",
  HostResponseCode: "05",
  MerchantAdviceCode: "21",
  CardLogo: "Mastercard",
  PaymentType: "3",
};

for (const res of [doNotHonor, invalidAccount, expired, macCancellation]) {
  handleCheckoutResponse(res);
}

// --- CIT velocity: stop hammering the same dying card -------------------------
// If the customer keeps retrying the same card and it keeps returning the same
// code, stop re-authing and prompt for another method. Pass the prior attempts
// (with their decline codes) so the engine can see the repetition.
console.log("\n— CIT velocity —");
const t0 = new Date("2026-07-07T12:00:00Z");
const velocity = evaluateReattempt({
  network: "visa",
  context: "cit",
  declineCode: "05",
  attempts: [
    { at: t0, context: "cit", declineCode: "05" },
    { at: new Date(t0.getTime() + 60_000), context: "cit", declineCode: "05" },
  ],
  now: new Date(t0.getTime() + 120_000),
});
console.log(`  allowed=${velocity.allowed} reason=${velocity.reason} action=${velocity.recommendedAction}`);
console.log(`  → Show the customer: "${velocity.customerMessage}"`);
