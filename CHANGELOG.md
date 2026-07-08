# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule-data updates (new codes, changed caps, fees, or delays) ship as **minor**
releases; each entry notes the effective date and source.

## [0.1.2] - 2026-07-07

### Added

- **`docs/processors.md`** — how to feed the engine from a PSP/processor. A full,
  field-by-field mapping for **Worldpay Express** (Element Express) —
  `HostResponseCode` → `declineCode`, `MerchantAdviceCode` → `merchantAdviceCode`,
  `CardLogo` → `network`, `PaymentType` → `context`/`mitSubtype` — plus the
  general recipe and a pointer table for Stripe / Adyen / Braintree / Checkout.com.
  Clarifies the key gotcha: pass the **raw network code**, not the gateway's own
  abstracted decline status.
- **`examples/`** — runnable CIT (checkout) and MIT (dunning) walkthroughs against
  Worldpay Express, plus a reusable `worldpay-express-mapping.ts` helper.
- README "Using it with your PSP" section linking the above.

Docs only — no changes to the engine or its rule tables.

### Fixed

- Corrected Stripe MAC field path to `charge.outcome.network_advice_code` (was
  incorrectly pointed at `payment_method_details.card`).
- `isExpressDecline()` now requires a non-empty `HostResponseCode`.
- npm tarball now includes `docs/`, `examples/`, and `CHANGELOG.md`.

## [0.1.1] - 2026-07-07

### Fixed

- Corrected the `repository`, `homepage`, and `bugs` URLs to the actual
  `paynav-dev/reattempt` GitHub org (were `paynav/reattempt`), fixing the
  Repository/Homepage links on the npm package page.
- Switched the README license badge to a static MIT badge so it no longer shows
  "package not found" (the shields.io npm-license lookup was unreliable for the
  freshly published scoped package).

## [0.1.0] - 2026-07-07

### Added

- Initial release. `evaluateReattempt()` — a pure, zero-dependency decision
  function for Visa/Mastercard card-not-present reattempt compliance.
- **CIT / MIT context awareness** (`context: "cit" | "mit"`). Verdicts diverge:
  - Recurring revocation/cancellation (Visa R0/R1/R3, Mastercard MAC 03/21)
    permanently blocks MIT but permits a cardholder-initiated (CIT) payment
    (`recurring_revoked`).
  - Dead-card declines block both contexts (`hard_decline`).
  - `recommendedAction` vocabulary (`run_account_updater`,
    `collect_new_instrument`, `cancel_subscription`, `retry_now`/`retry_after`,
    `do_not_retry`) and a `permanent` flag turn the verdict into dunning guidance.
  - CIT in-session **velocity** limit (repeated identical declines) and a
    sanitized `customerMessage` for checkout UX; MIT 30-day reattempt caps.
  - Advisory `suggestedRetryAt` (best-practice spacing, not a network mandate).
- **Visa** Excessive Reattempts framework: Categories 1–4 response-code
  classification and the 15-reattempts-in-30-days cap.
- **Mastercard** Transaction Processing Excellence: Merchant Advice Codes
  (01–04, 21, 24–30), the 35-retries-in-30-days cap, hard/soft raw-code
  classification, and the January 2026 rule charging a fee on every declined
  CNP transaction carrying MAC 03/21 (`feeIncurredOnDecline`).
- `attempts` accept `AttemptRecord`s (`{ at, context?, mitSubtype?, declineCode? }`)
  as well as bare timestamps.
- Exported rule tables, constants, and best-practice heuristics.
- Dual ESM + CJS builds with bundled TypeScript declarations.

[0.1.2]: https://github.com/paynav-dev/reattempt/releases/tag/v0.1.2
[0.1.1]: https://github.com/paynav-dev/reattempt/releases/tag/v0.1.1
[0.1.0]: https://github.com/paynav-dev/reattempt/releases/tag/v0.1.0
