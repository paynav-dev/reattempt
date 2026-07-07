import { describe, it, expect } from "vitest";
import {
  evaluateReattempt,
  VISA_DECLINE_RULES,
  VISA_REATTEMPT_CAP,
  VISA_FEE_DOMESTIC_USD,
  VISA_FEE_INTERNATIONAL_USD,
} from "../src/index";

const within = new Date("2026-01-10T00:00:00.000Z");
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");

const codesByOutcome = (outcome: string) =>
  Object.entries(VISA_DECLINE_RULES)
    .filter(([, r]) => r.outcome === outcome)
    .map(([code]) => code);

describe("Visa — hard declines (dead card, both contexts)", () => {
  const hard = codesByOutcome("hard_decline");

  it("recognizes the expected dead-card codes", () => {
    expect(new Set(hard)).toEqual(
      new Set(["04", "07", "12", "14", "15", "41", "43", "46", "57", "93"]),
    );
  });

  it.each(hard)("code %s blocks MIT permanently (cancel subscription)", (code) => {
    const d = evaluateReattempt({ network: "visa", context: "mit", declineCode: code, now: within });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("hard_decline");
    expect(d.permanent).toBe(true);
    expect(d.recommendedAction).toBe("cancel_subscription");
    expect(d.feeRisk).toBe(true);
    expect(d.customerMessage).toBeNull();
  });

  it.each(hard)("code %s blocks CIT too (collect a new instrument)", (code) => {
    const d = evaluateReattempt({ network: "visa", context: "cit", declineCode: code, now: within });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("hard_decline");
    expect(d.recommendedAction).toBe("collect_new_instrument");
    // Sanitized message — never reveals lost/stolen/fraud specifics.
    expect(d.customerMessage).toBe("This card can't be used. Please try a different payment method.");
    expect(d.customerMessage).not.toMatch(/stolen|lost|fraud/i);
  });
});

describe("Visa — stop-payment / revocation (recurring_revoked)", () => {
  const revoked = codesByOutcome("recurring_revoked");

  it("covers R0/R1/R3", () => {
    expect(new Set(revoked)).toEqual(new Set(["R0", "R1", "R3"]));
  });

  it.each(revoked)("code %s permanently blocks MIT", (code) => {
    const d = evaluateReattempt({ network: "visa", context: "mit", declineCode: code, now: within });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("recurring_revoked");
    expect(d.permanent).toBe(true);
    expect(d.recommendedAction).toBe("cancel_subscription");
    expect(d.note).toMatch(/customer-initiated/i);
  });

  it.each(revoked)("code %s still permits a CIT by the cardholder", (code) => {
    const d = evaluateReattempt({ network: "visa", context: "cit", declineCode: code, now: within });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
    expect(d.recommendedAction).toBe("retry_now");
  });
});

describe("Visa — data quality (update_required)", () => {
  it.each(["54", "N7"])("code %s asks MIT to run the account updater", (code) => {
    const d = evaluateReattempt({ network: "visa", context: "mit", declineCode: code, now: within });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("update_required");
    expect(d.permanent).toBe(false);
    expect(d.recommendedAction).toBe("run_account_updater");
  });

  it("asks a CIT customer to update / use another card", () => {
    const d = evaluateReattempt({ network: "visa", context: "cit", declineCode: "54", now: within });
    expect(d.recommendedAction).toBe("collect_new_instrument");
    expect(d.customerMessage).toMatch(/expired|update/i);
  });
});

describe("Visa — soft declines", () => {
  it("MIT: permitted now, with advisory spacing for insufficient funds", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "mit",
      declineCode: "51",
      attempts: [ANCHOR],
      now: ANCHOR,
    });
    expect(d.allowed).toBe(true);
    expect(d.recommendedAction).toBe("retry_after");
    expect(d.suggestedRetryAt).toEqual(new Date(ANCHOR.getTime() + 72 * 3_600_000));
    expect(d.remainingAttempts).toBe(VISA_REATTEMPT_CAP);
  });

  it("CIT: permitted now with no cap or spacing", () => {
    const d = evaluateReattempt({ network: "visa", context: "cit", declineCode: "05", now: within });
    expect(d.allowed).toBe(true);
    expect(d.recommendedAction).toBe("retry_now");
    expect(d.suggestedRetryAt).toBeNull();
    expect(d.remainingAttempts).toBeNull();
    expect(d.windowEndsAt).toBeNull();
  });

  it("unknown codes are treated as soft (retryable), labelled 'unknown'", () => {
    const d = evaluateReattempt({ network: "visa", context: "mit", declineCode: "ZZ", now: within });
    expect(d.allowed).toBe(true);
    expect(d.category).toBe("unknown");
  });
});

describe("Visa — 15-in-30-days MIT reattempt cap", () => {
  it("permits the 15th reattempt", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "mit",
      declineCode: "05",
      priorAttempts: 15,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.allowed).toBe(true);
    expect(d.remainingAttempts).toBe(1);
  });

  it("blocks the 16th reattempt", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "mit",
      declineCode: "05",
      priorAttempts: 16,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("reattempt_cap");
    expect(d.feeRisk).toBe(true);
    expect(d.nextEligibleAt).toEqual(d.windowEndsAt);
  });

  it("does NOT apply the 30-day cap to CIT", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      priorAttempts: 999,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
  });
});

describe("Visa — 30-day window edge (MIT)", () => {
  const base = {
    network: "visa" as const,
    context: "mit" as const,
    declineCode: "05",
    priorAttempts: 16,
    firstAttemptAt: ANCHOR,
  };
  const rawEnd = ANCHOR.getTime() + 30 * 86_400_000;

  it("still enforces the cap at exactly anchor + 30 days", () => {
    const d = evaluateReattempt({ ...base, now: new Date(rawEnd) });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("reattempt_cap");
  });

  it("resets one millisecond after the window closes", () => {
    const d = evaluateReattempt({ ...base, now: new Date(rawEnd + 1) });
    expect(d.allowed).toBe(true);
    expect(d.remainingAttempts).toBe(VISA_REATTEMPT_CAP);
  });
});

describe("Visa — fee constants", () => {
  it("match the published schedule", () => {
    expect(VISA_FEE_DOMESTIC_USD).toBe(0.1);
    expect(VISA_FEE_INTERNATIONAL_USD).toBe(0.15);
  });
});
