# @paynav/reattempt

[![npm](https://img.shields.io/npm/v/@paynav/reattempt.svg)](https://www.npmjs.com/package/@paynav/reattempt)
[![license](https://img.shields.io/npm/l/@paynav/reattempt.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/@paynav/reattempt.svg)](./dist/index.d.ts)

**Card-network retry-compliance engine.** Given a declined Visa or Mastercard
card-not-present transaction — **customer-initiated (CIT)** or
**merchant-initiated (MIT)** — decide whether you may reattempt it, *why*, the
**recommended action**, the **fee risk**, and **when** the next attempt becomes
eligible.

Visa and Mastercard enforce hard rules on retrying declined CNP transactions,
with per-transaction fees for violations — and the correct handling differs
sharply between a checkout page and a dunning job. Most billing systems
re-implement these rules by hand from PDFs and get them wrong. This package
encodes the actual network rules, per context, as one pure function.

- **CIT and MIT aware.** The same decline can be a permanent block for a
  subscription retry yet perfectly fine on a checkout page. The engine knows.
- **Zero runtime dependencies.** Browser-safe (no Node APIs).
- **PSP / gateway / processor agnostic.** Feed the raw network response code —
  not a Stripe `decline_code` or Adyen `refusalReason`.
- **Pure & deterministic.** No I/O, no globals; inject `now` for tests.
- **Dual ESM + CJS**, first-class TypeScript types.

> ⚠️ **Not legal or compliance advice.** Card-network rules and fees change.
> These tables were verified in **July 2026** against the sources cited below;
> always confirm against Visa's and Mastercard's primary documents for your
> region and program. See [Disclaimer](#disclaimer).

## Install

```sh
npm install @paynav/reattempt
```

## Quickstart

```ts
import { evaluateReattempt } from "@paynav/reattempt";

// Merchant-initiated dunning retry after an insufficient-funds decline.
const decision = evaluateReattempt({
  network: "visa",
  context: "mit",
  declineCode: "51",                   // insufficient funds
  attempts: ["2026-07-01T09:00:00Z"],  // every attempt so far, incl. this decline
  now: "2026-07-01T10:00:00Z",
});

console.log(decision);
// {
//   allowed: true,
//   reason: 'ok',
//   category: 'visa_category_2',
//   context: 'mit',
//   permanent: false,
//   recommendedAction: 'retry_after',
//   feeRisk: false,
//   feeIncurredOnDecline: false,
//   nextEligibleAt: null,
//   suggestedRetryAt: 2026-07-04T09:00:00.000Z,   // advisory, payday-aware spacing
//   remainingAttempts: 15,
//   windowEndsAt: 2026-07-31T09:00:00.000Z,
//   customerMessage: null,
//   note: 'Retry is permitted now; the suggested time is advisory best-practice spacing, not a network mandate.'
// }
```

The same decline signal, two contexts — a revoked recurring authorization:

```ts
// MIT: the cardholder cancelled the recurring payment — permanent block.
evaluateReattempt({ network: "mastercard", context: "mit", declineCode: "05", merchantAdviceCode: "21" });
// { allowed: false, reason: 'recurring_revoked', permanent: true,
//   recommendedAction: 'cancel_subscription',
//   note: 'Cardholder revoked this recurring authorization. A customer-initiated (CIT) payment ... remains permitted.' }

// CIT: the same customer actively paying at checkout — permitted.
evaluateReattempt({ network: "mastercard", context: "cit", declineCode: "05", merchantAdviceCode: "21" });
// { allowed: true, reason: 'ok', recommendedAction: 'retry_now', ... }
```

## CIT vs MIT — why context matters

| | **CIT** (customer-initiated) | **MIT** (merchant-initiated) |
| --- | --- | --- |
| Cardholder | present (checkout, retry button) | absent (subscription, dunning) |
| Revocation / cancellation (Visa R0/R1/R3, MAC 03/21) | **permitted** — a fresh cardholder payment | **permanent block** → `cancel_subscription` |
| Dead card (lost/stolen/closed/invalid) | **blocked** → `collect_new_instrument` | **blocked** → `cancel_subscription` |
| "Get updated credentials" (MAC 01/04, expired) | `collect_new_instrument` | `run_account_updater` |
| Volume control | short-window **velocity** (stop after repeated identical declines) | 30-day **reattempt cap** |
| Issuer retry delay (MAC 24–30) | not gated (cardholder present) | enforced → `nextEligibleAt` |
| `customerMessage` | sanitized message for the UI | `null` (no customer present) |

Integration shape:

- **CIT / checkout** — call `evaluateReattempt()` in your payment route *before*
  hitting the PSP. On a block, don't call the PSP; show the sanitized
  `customerMessage` (never echo fraud reasons) and let the customer switch
  methods. Record every outcome, including successes.
- **MIT / dunning** — call it as the first step of each scheduled retry job. The
  verdict either gates the attempt (`allowed`, `nextEligibleAt`) or reshapes the
  schedule (`recommendedAction`, `suggestedRetryAt`), and a
  `recurring_revoked` / `hard_decline` verdict short-circuits into your
  "update your card" flow and pauses the subscription.

## API

### `evaluateReattempt(input): ReattemptDecision`

#### Input

| Field | Type | Notes |
| --- | --- | --- |
| `network` | `"visa" \| "mastercard"` | **Required.** Selects the rule set. |
| `context` | `"cit" \| "mit"` | **Required.** Customer- or merchant-initiated. |
| `declineCode` | `string` | **Required.** Raw network response code, e.g. `"05"`, `"51"`, `"14"`, `"R1"`. Case-insensitive, trimmed. |
| `merchantAdviceCode` | `string?` | Mastercard MAC, e.g. `"03"`, `"25"`. When recognized it **overrides** `declineCode`. Ignored for Visa. |
| `mitSubtype` | `"recurring" \| "unscheduled" \| "installment"?` | Carried for record-keeping; reserved for future rule refinement. |
| `attempts` | `(Timestamp \| AttemptRecord)[]?` | Every attempt so far, incl. the original decline and the one you're reacting to. Supply `AttemptRecord`s (`{ at, declineCode? }`) to enable CIT velocity. |
| `priorAttempts` | `number?` | Convenience alternative to `attempts`: count already made. Pair with `firstAttemptAt`. Cannot drive velocity. |
| `firstAttemptAt` | `Timestamp?` | Original decline time (cap-window anchor). Defaults to `now`. |
| `now` | `Timestamp?` | Injectable clock. Defaults to `new Date()`. |

`Timestamp` = `Date | string (ISO-8601) | number (epoch ms)`.

#### Decision

| Field | Type | Meaning |
| --- | --- | --- |
| `allowed` | `boolean` | May you reattempt **now**, in this context? |
| `reason` | `ReattemptReason` | `"ok"`, `"hard_decline"`, `"recurring_revoked"`, `"update_required"`, `"reattempt_cap"`, `"retry_delay"`, `"cit_velocity"`. |
| `category` | `string \| null` | Classification label, e.g. `"visa_category_1"`, `"mac_25"`, `"mc_hard_decline"`, `"unknown"`. Open string set. |
| `context` | `"cit" \| "mit"` | Echoes the evaluated context. |
| `permanent` | `boolean` | Is the block permanent for this context (vs a temporary cap/delay/velocity gate)? |
| `recommendedAction` | `RecommendedAction` | `"retry_now"`, `"retry_after"`, `"run_account_updater"`, `"collect_new_instrument"`, `"cancel_subscription"`, `"do_not_retry"`. |
| `feeRisk` | `boolean` | Would reattempting **now** risk/incur a network fee? |
| `feeIncurredOnDecline` | `boolean` | Does a fee already apply to the decline itself, regardless of retry? (Mastercard MAC 03/21, since Jan 2026.) |
| `nextEligibleAt` | `Date \| null` | Earliest **network-permitted** time when `allowed` is `false`; `null` = never / no mandated wait. |
| `suggestedRetryAt` | `Date \| null` | **Advisory** best-practice retry time (e.g. payday-aware MIT spacing). Not a network mandate. |
| `remainingAttempts` | `number \| null` | Reattempts left in the MIT window before the cap. `null` for CIT / do-not-retry. |
| `windowEndsAt` | `Date \| null` | End of the MIT cap window (anchor + 30 days). `null` for CIT / do-not-retry. |
| `customerMessage` | `string \| null` | Sanitized, customer-safe message for CIT UX. `null` for MIT / nothing to say. |
| `note` | `string \| null` | Human-readable nuance, when relevant. |

Rule tables and constants are also exported: `VISA_DECLINE_RULES`,
`VISA_DECLINE_CATEGORY`, `VISA_REATTEMPT_CAP`, `VISA_FEE_DOMESTIC_USD`,
`VISA_FEE_INTERNATIONAL_USD`, `MASTERCARD_MAC`, `MASTERCARD_DECLINE_RULES`,
`MASTERCARD_RETRY_CAP`, `MASTERCARD_EXCESS_FEE_USD`, plus the best-practice
heuristics `CIT_VELOCITY_IDENTICAL_LIMIT`, `CIT_VELOCITY_WINDOW_MINUTES`,
`MIT_SOFT_RETRY_SPACING_HOURS`, `DEFAULT_MIT_SOFT_RETRY_SPACING_HOURS`.

## The rules

Each decline resolves to an **outcome** that drives the verdict:

| Outcome | Meaning | CIT | MIT |
| --- | --- | --- | --- |
| `hard_decline` | dead card/account | blocked · `collect_new_instrument` | blocked · `cancel_subscription` |
| `recurring_revoked` | recurring authorization revoked | **allowed** · `retry_now` | blocked · `cancel_subscription` |
| `update_required` | credential must be refreshed | blocked · `collect_new_instrument` | blocked · `run_account_updater` |
| `soft` | transient/soft decline | allowed (velocity-gated) | allowed (cap-gated, spaced) |
| `delay` | issuer-directed retry delay (MAC 24–30) | allowed (present) | wait until `nextEligibleAt` |

### Visa — Excessive Reattempts framework

Effective 2021-04-17; fees since April 2022. **Cap:** ≤ **15 MIT reattempts in
30 days** (Categories 2–4 and unknown). Each excess reattempt ≈ **$0.10**
domestic / **$0.15** international.

- **Category 1 → `hard_decline`:** `04`, `07`, `12`, `14`, `15`, `41`, `43`,
  `46`, `57`, `93`.
- **Category 1 stop-payment/revocation → `recurring_revoked`:** `R0`, `R1`, `R3`.
- **Category 3 (data quality) → `update_required`:** `54`, `N7`.
- **Categories 2/4 → `soft`:** `51`, `61`, `65`, `05`, `01`, `02`, `19`, `91`, `96`.

*Sources: Visa Rules, "Updates to rules for declined transaction resubmission"
(usa.visa.com); CardPointe Visa decline-category reference.*

### Mastercard — Transaction Processing Excellence (TPE)

Driven by the **Merchant Advice Code (MAC)**; a recognized MAC overrides the raw
code. **Cap:** ≤ **35 MIT retries in 30 days**; **$0.50** per excess retry (2025
rate; $0.15 in 2023, $0.30 in 2024).

| MAC | Meaning | Outcome |
| --- | --- | --- |
| `01` | New account information available | `update_required` |
| `02` | Cannot approve now, try again later | `soft` |
| `03` | Do not try again | `recurring_revoked` |
| `04` | Token requirements not fulfilled | `update_required` |
| `21` | Payment cancellation | `recurring_revoked` |
| `24`–`30` | Retry after 1h / 24h / 2d / 4d / 6d / 8d / 10d | `delay` |

**January 2026 change:** the do-not-retry fee applies to **every** declined CNP
transaction carrying MAC 03 or MAC 21 — surfaced as `feeIncurredOnDecline: true`
even on a first decline, and even for a permitted CIT.

Without a MAC, raw codes classify as `hard_decline` (`04`, `07`, `14`, `15`,
`41`, `43`, `57`, `62`), `update_required` (`54`), or `soft`.

*Sources: Mastercard Merchant Advice Code reference (Braintree / TabaPay / payabl.
docs); Mastercard TPE fee guidance (Merchant Cost Consulting).*

### Best-practice heuristics (not network rules)

Surfaced separately from the cited rules, as sensible defaults you can tune:

- **CIT velocity** — after `CIT_VELOCITY_IDENTICAL_LIMIT` (2) identical declines
  within `CIT_VELOCITY_WINDOW_MINUTES` (30), stop re-authing and prompt for a
  different method (`cit_velocity` / `collect_new_instrument`).
- **MIT spacing** — `suggestedRetryAt` spaces soft-decline retries
  (`MIT_SOFT_RETRY_SPACING_HOURS`: 72h for insufficient-funds/limit codes, else
  24h). Advisory only; `allowed` is the compliance gate.

## Semantics & edge cases

- **Unknown decline code** → `soft` / `category: "unknown"`. MIT caps still apply.
- **Mastercard MAC precedence** — a recognized MAC always wins over `declineCode`.
- **Window anchoring / reset** — the MIT cap window is anchored at the original
  decline; once 30 days elapse it lapses and a reattempt starts a fresh cycle.
- **MAC delay anchoring** — MAC 24–30 delays are measured from the **most recent**
  attempt (the latest `attempts` timestamp, or `now` for the count shorthand).
- **Include the current decline** in `attempts` / `priorAttempts`.
- **CIT velocity needs codes** — only `AttemptRecord`s carrying `declineCode` can
  trigger it; the count-only path cannot.

## Scope

In scope: the raw-network-code + context → reattempt-decision mapping for Visa
and Mastercard CNP transactions.

Out of scope (by design): the **stored-credential framework** itself
(CIT-establishes-credential flags, network transaction-ID chaining, `off_session`
parameters) — your PSP owns that plumbing; a **persistence/store layer** (this
function is stateless — you pass the attempt history in); mapping PSP-specific
codes; and networks beyond Visa/Mastercard. This decides *whether and when* to
attempt, not *how* the auth is composed.

## Versioning

Follows semver. **Rule-data updates** (new codes, changed caps/fees/delays) ship
as **minor** releases with a [CHANGELOG](./CHANGELOG.md) entry noting the
effective date and source. Breaking API changes bump the major version.

## Disclaimer

This package is provided for engineering convenience and is **not legal,
compliance, or financial advice**. Card-network rules, fee schedules, and
response-code semantics change and vary by region, program, and merchant
agreement. Verify against Visa's and Mastercard's primary documentation before
relying on these results. Provided "as is", without warranty; see
[LICENSE](./LICENSE).

## License

[MIT](./LICENSE) © paynav
