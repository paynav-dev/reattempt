# Using `@paynav/reattempt` with your PSP / processor

`@paynav/reattempt` is **processor-agnostic on purpose.** It takes the **raw
Visa/Mastercard network codes** — not a gateway's own abstraction — so it works
behind any PSP that surfaces those codes. Your integration job is a small,
mechanical one: pull four values out of the response your processor already
gives you and hand them to `evaluateReattempt()`.

- **[What the engine needs](#what-the-engine-needs)**
- **[The one gotcha: raw network code ≠ your PSP's decline code](#the-one-gotcha-raw-network-code--your-psps-decline-code)**
- **[Worldpay Express (Element Express) — full mapping](#worldpay-express-element-express--full-mapping)**
- **[Other processors — the general recipe](#other-processors--the-general-recipe)**

## What the engine needs

Everything `evaluateReattempt()` decides comes from four inputs (plus the attempt
history you already keep). See the [README](../README.md#api) for the full type.

| Engine input | Type | What it is |
| --- | --- | --- |
| `network` | `"visa" \| "mastercard"` | The card brand. |
| `context` | `"cit" \| "mit"` | Customer-initiated (cardholder present) vs merchant-initiated (stored credential, cardholder absent). |
| `declineCode` | `string` | The **raw network/issuer response code** — e.g. `"05"`, `"51"`, `"14"`, `"54"`, `"R1"`. |
| `merchantAdviceCode` | `string?` | Mastercard **Merchant Advice Code** (MAC), when the issuer returned one — e.g. `"03"`, `"21"`, `"25"`. Ignored for Visa. |

So "can I use this with my PSP?" reduces to: **does my PSP expose the raw network
response code and (for Mastercard) the MAC?** For most card processors the answer
is yes — they are pass-through fields on the auth response. The mapping below is
worked end-to-end for **Worldpay Express**; the [general recipe](#other-processors--the-general-recipe)
tells you where to look for any other processor.

## The one gotcha: raw network code ≠ your PSP's decline code

Most gateways return **two** kinds of "decline code":

1. **Their own abstraction** — a normalized, gateway-branded status
   (Stripe `outcome.decline_code` / `outcome.advice_code`, Adyen `refusalReason`,
   Worldpay `ExpressResponseCode`). Convenient for display, but **not** a network
   code and **not** what this engine wants.
2. **The raw network/issuer code** — the ISO 8583 reason code the issuer
   actually returned (`05`, `51`, `14`, …), usually on a separate field
   (Worldpay `HostResponseCode`, Stripe `network_decline_code`, Adyen
   `refusalReasonRaw`).

**Feed the engine the raw one.** Use your PSP's own status only to detect *that*
a decline happened, then pass the raw network code as `declineCode`. Passing the
abstraction will mis-classify the decline.

## Worldpay Express (Element Express) — full mapping

Field names, enum values, and the MAC list below are from the **Express
Interface Specification v3** (© 2025 Worldpay), Appendix 1 "Response Codes", and
the `PaymentType` / `CardLogo` enumerations. A runnable, copy-pasteable mapping
helper lives in [`examples/worldpay-express-mapping.ts`](../examples/worldpay-express-mapping.ts).

### Response fields → engine inputs

| Express response field | → | Engine input | Notes |
| --- | --- | --- | --- |
| `HostResponseCode` | → | `declineCode` | The **raw** issuer/network code (`String(3)`), e.g. `"05"`, `"51"`, `"14"`, `"54"`, `"R1"`. This is the one the engine wants. |
| `MerchantAdviceCode` | → | `merchantAdviceCode` | Mastercard MAC. Response-only field; present on many Mastercard declines. Pass it through as-is. |
| `CardLogo` | → | `network` | `"Visa"` → `"visa"`, `"Mastercard"` → `"mastercard"`. Other brands (Amex, Discover, …) aren't covered by this engine. |
| `PaymentType` | → | `context`, `mitSubtype` | Credential-on-file payment type — see the enum table below. |
| `SubmissionType` | → | *(context corroboration)* | `"1"` Initial ≈ the CIT that set up the credential; `"2"` Subsequent / `"3"` Resubmission ≈ later MIT. |
| `ExpressResponseCode` | → | *(not the engine's input)* | Worldpay's own summary: `"0"` approved, `"20"` declined, `"21"` expired, `"24"` pick-up. Use it to detect a decline; **don't** use it as `declineCode`. |
| `NetworkTransactionID` | → | *(out of scope)* | Stored-credential chaining id. Your PSP uses it to compose the next MIT auth; the engine doesn't. |
| `MarketCode` | → | *(out of scope)* | Industry type (eCommerce, MOTO, …). Not a reattempt input. |

### `PaymentType` → `context`

`PaymentType` distinguishes cardholder- from merchant-initiated stored-credential
transactions:

| `PaymentType` | Meaning | Engine `context` | Engine `mitSubtype` |
| --- | --- | --- | --- |
| `3` | Cardholder Initiated | `"cit"` | — |
| `1` | Recurring | `"mit"` | `"recurring"` |
| `2` | Installment | `"mit"` | `"installment"` |
| `4` | Credential on File | `"mit"` * | `"unscheduled"` |

\* `"4"` is generic credential-on-file. A *cardholder-present* credential-on-file
checkout is really CIT — so prefer setting `context` from **what you're doing**
(a checkout route → `"cit"`; a dunning job → `"mit"`), which you always know at
the call site, and use `PaymentType` only as a fallback. The helper does exactly
this: `toReattemptInput(res, { context: "cit" })`.

### `MerchantAdviceCode` values

Worldpay may return these MAC values (spec Appendix). The engine recognizes the
ones that carry a reattempt meaning; the rest fall back to the raw
`HostResponseCode`:

| MAC | Meaning | Engine handling |
| --- | --- | --- |
| `01` | New account information | `update_required` → run account updater |
| `02` | Try again later | `soft` (retryable) |
| `03` | Do not try again | `recurring_revoked` (+ decline fee since Jan 2026) |
| `04` | Token requirements not fulfilled | `update_required` |
| `21` | Recurring payment cancellation | `recurring_revoked` (+ decline fee since Jan 2026) |
| `24`–`30` | Retry after 1h / 24h / 2d / 4d / 6d / 8d / 10d | `delay` — enforced for MIT |
| `22`, `40`, `41` | Product-code / prepaid / single-use-VCN advisories | **not** recognized → engine uses the raw `HostResponseCode` |

For **Visa**, a recognized MAC is ignored — the engine classifies on
`HostResponseCode`. Passing `merchantAdviceCode` for a Visa transaction is
harmless; it simply has no effect.

### Worked mapping

```ts
import { evaluateReattempt } from "@paynav/reattempt";
import { toReattemptInput, isExpressDecline } from "./examples/worldpay-express-mapping";

// `res` is your Worldpay Express transaction response.
if (isExpressDecline(res)) {
  const decision = evaluateReattempt(
    toReattemptInput(res, { context: "mit", attempts: priorAttempts }),
  );
  // decision.allowed / recommendedAction / nextEligibleAt / feeIncurredOnDecline …
}
```

Full, runnable walkthroughs:

- **CIT / checkout** — [`examples/worldpay-express-cit.ts`](../examples/worldpay-express-cit.ts)
- **MIT / dunning** — [`examples/worldpay-express-mit.ts`](../examples/worldpay-express-mit.ts)

## Other processors — the general recipe

The engine doesn't ship per-PSP tables (mapping every gateway's fields is a
separate concern — see [Scope](../README.md#scope)). But the recipe is the same
for any card processor:

1. **`network`** — from the card brand the processor reports (a `brand` /
   `cardType` / `CardLogo` field, or the BIN).
2. **`context`** — from *what your code is doing*: a checkout/route with the
   cardholder present is `"cit"`; a scheduled rebill/dunning job is `"mit"`.
   Corroborate with any stored-credential/COF indicator on the request.
3. **`declineCode`** — the **raw network/issuer response code**, not the
   gateway's normalized status. This is the field that matters; find it.
4. **`merchantAdviceCode`** — the Mastercard MAC, if the processor surfaces it.

Where the raw network code and MAC typically live (**verify against your
processor's current docs — these are starting points, not guarantees**):

| Processor | Raw network code | Merchant Advice Code |
| --- | --- | --- |
| **Worldpay Express** | `HostResponseCode` | `MerchantAdviceCode` |
| **Stripe** | `charge.outcome.network_decline_code` | `charge.outcome.network_advice_code` |
| **Adyen** | `additionalData.refusalReasonRaw` | `additionalData.merchantAdviceCode` |
| **Braintree** | `processorResponseCode` | `merchantAdvice` (where surfaced) |
| **Checkout.com** | `response_code` | `processing.merchant_advice_code` (where surfaced) |

Stripe also exposes abstracted `charge.outcome.advice_code` values
(`do_not_try_again`, `try_again_later`, `confirm_card_data`) — use those to
detect *that* a decline happened, but pass the raw `network_advice_code` as
`merchantAdviceCode`, not the enum.

If a processor only gives you its own abstracted status and never the raw
network code, you cannot use this engine reliably — find the raw field first,
or switch to a processor/API version that surfaces it. Mapping abstracted status
strings to guessed network codes will mis-classify declines.

> ⚠️ Card-network rules, fees, and response-code semantics change and vary by
> region and program. This mapping reflects the cited Worldpay spec; always
> confirm against your processor's and the networks' primary documentation. See
> the [README disclaimer](../README.md#disclaimer).
