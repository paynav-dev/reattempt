# Examples

Runnable, copy-pasteable integrations of `@paynav/reattempt`. These use
**Worldpay Express** (Element Express) as the processor — see
[`docs/processors.md`](../docs/processors.md) for the field-by-field mapping and
for the general recipe that applies to any PSP.

| File | Shows |
| --- | --- |
| [`worldpay-express-mapping.ts`](./worldpay-express-mapping.ts) | The shared helper: turn a Worldpay Express response into a `ReattemptInput` (`HostResponseCode` → `declineCode`, `MerchantAdviceCode` → `merchantAdviceCode`, `CardLogo` → `network`, `PaymentType` → `context`/`mitSubtype`). |
| [`worldpay-express-cit.ts`](./worldpay-express-cit.ts) | **CIT / checkout** — cardholder present. Allow-a-retry vs show a sanitized `customerMessage`, and the in-session velocity stop. |
| [`worldpay-express-mit.ts`](./worldpay-express-mit.ts) | **MIT / dunning** — cardholder absent. Gate/reschedule a rebill from the verdict: retry delays (MAC 24–30), account-updater, permanent stops (MAC 03/21), decline fees. |

## Run them

**From this repo** (install the local package, then run with `tsx`):

```sh
npm install
npm run build && npm install .
npx tsx examples/worldpay-express-cit.ts
npx tsx examples/worldpay-express-mit.ts
```

**From a consuming project** (`npm install @paynav/reattempt`):

```sh
npx tsx examples/worldpay-express-cit.ts
npx tsx examples/worldpay-express-mit.ts
```

The example responses are hand-built plain objects, so no Worldpay account or
network access is needed — they just illustrate the mapping and the resulting
decisions. Swap in a real Express response object and the same code applies.
