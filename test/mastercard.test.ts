import { describe, it, expect } from "vitest";
import {
  evaluateReattempt,
  MASTERCARD_MAC,
  MASTERCARD_RETRY_CAP,
  MASTERCARD_EXCESS_FEE_USD,
} from "../src/index";

const within = new Date("2026-01-10T00:00:00.000Z");
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

describe("Mastercard — MAC 03/21 (recurring_revoked)", () => {
  it.each(["03", "21"])("MAC %s blocks MIT and incurs the decline fee", (mac) => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: mac,
      now: within,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("recurring_revoked");
    expect(d.category).toBe(`mac_${mac}`);
    expect(d.permanent).toBe(true);
    expect(d.recommendedAction).toBe("cancel_subscription");
    expect(d.feeRisk).toBe(true);
    expect(d.feeIncurredOnDecline).toBe(true);
  });

  it.each(["03", "21"])("MAC %s still permits a CIT (fee already charged on the decline)", (mac) => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "cit",
      declineCode: "05",
      merchantAdviceCode: mac,
      now: within,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
    expect(d.feeIncurredOnDecline).toBe(true);
  });

  it("charges the decline fee even on a first MIT decline (Jan 2026 rule)", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "03",
      priorAttempts: 1,
      firstAttemptAt: within,
      now: within,
    });
    expect(d.feeIncurredOnDecline).toBe(true);
  });
});

describe("Mastercard — MAC 01/04 (update_required) and MAC 02 (soft)", () => {
  it.each(["01", "04"])("MAC %s tells MIT to run the account updater", (mac) => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: mac,
      now: within,
    });
    expect(d.reason).toBe("update_required");
    expect(d.recommendedAction).toBe("run_account_updater");
    expect(d.category).toBe(`mac_${mac}`);
  });

  it("MAC 02 is a plain soft retry", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "02",
      attempts: [ANCHOR],
      now: ANCHOR,
    });
    expect(d.allowed).toBe(true);
    expect(d.category).toBe("mac_02");
  });

  it("normalizes an unpadded MAC ('3' -> mac_03)", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "3",
      now: within,
    });
    expect(d.category).toBe("mac_03");
    expect(d.reason).toBe("recurring_revoked");
  });
});

describe("Mastercard — MAC precedence over the raw code", () => {
  it("a recurring_revoked MAC overrides a soft raw code", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "51",
      merchantAdviceCode: "03",
      now: within,
    });
    expect(d.reason).toBe("recurring_revoked");
  });

  it("a soft MAC overrides a hard raw code", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "43", // stolen card, normally hard
      merchantAdviceCode: "02",
      attempts: [ANCHOR],
      now: ANCHOR,
    });
    expect(d.allowed).toBe(true);
    expect(d.category).toBe("mac_02");
  });
});

describe("Mastercard — raw decline codes when no MAC", () => {
  it.each(["04", "07", "14", "15", "41", "43", "57", "62"])(
    "hard decline %s blocks both contexts (no decline fee)",
    (code) => {
      const mit = evaluateReattempt({ network: "mastercard", context: "mit", declineCode: code, now: within });
      const cit = evaluateReattempt({ network: "mastercard", context: "cit", declineCode: code, now: within });
      expect(mit.reason).toBe("hard_decline");
      expect(cit.reason).toBe("hard_decline");
      expect(mit.category).toBe("mc_hard_decline");
      expect(mit.feeIncurredOnDecline).toBe(false);
    },
  );

  it.each(["05", "51", "61", "91", "96"])("soft decline %s is retryable", (code) => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: code,
      attempts: [ANCHOR],
      now: ANCHOR,
    });
    expect(d.allowed).toBe(true);
    expect(d.category).toBe("mc_soft_decline");
  });

  it("raw 54 (expired) is update_required", () => {
    const d = evaluateReattempt({ network: "mastercard", context: "mit", declineCode: "54", now: within });
    expect(d.reason).toBe("update_required");
    expect(d.category).toBe("mc_update_required");
  });

  it("unknown code -> soft, labelled 'unknown'", () => {
    const d = evaluateReattempt({ network: "mastercard", context: "mit", declineCode: "ZZ", attempts: [ANCHOR], now: ANCHOR });
    expect(d.allowed).toBe(true);
    expect(d.category).toBe("unknown");
  });
});

describe("Mastercard — MAC 24–30 issuer-directed delays", () => {
  it("maps every delay MAC to the documented wait", () => {
    const expected: Record<string, number> = {
      "24": 1, "25": 24, "26": 48, "27": 96, "28": 144, "29": 192, "30": 240,
    };
    for (const [code, hours] of Object.entries(expected)) {
      expect(MASTERCARD_MAC[code]?.delayHours).toBe(hours);
    }
  });

  it("MIT: blocks a retry before the delay elapses (MAC 25, 24h)", () => {
    const decline = new Date("2026-01-05T00:00:00.000Z");
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "25",
      attempts: [decline],
      now: new Date(decline.getTime() + 23 * HOUR),
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("retry_delay");
    expect(d.recommendedAction).toBe("retry_after");
    expect(d.nextEligibleAt).toEqual(new Date(decline.getTime() + 24 * HOUR));
  });

  it("MIT: permits a retry exactly at the delay boundary", () => {
    const decline = new Date("2026-01-05T00:00:00.000Z");
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "25",
      attempts: [decline],
      now: new Date(decline.getTime() + 24 * HOUR),
    });
    expect(d.allowed).toBe(true);
  });

  it("CIT: the cardholder is present, so the delay does not gate the retry", () => {
    const decline = new Date("2026-01-05T00:00:00.000Z");
    const d = evaluateReattempt({
      network: "mastercard",
      context: "cit",
      declineCode: "05",
      merchantAdviceCode: "25",
      attempts: [decline],
      now: new Date(decline.getTime() + 1 * HOUR),
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("anchors the delay on the most recent attempt", () => {
    const first = new Date("2026-01-05T00:00:00.000Z");
    const latest = new Date("2026-01-06T00:00:00.000Z");
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "24", // 1 hour
      attempts: [first, latest],
      now: new Date(latest.getTime() + 30 * 60_000),
    });
    expect(d.allowed).toBe(false);
    expect(d.nextEligibleAt).toEqual(new Date(latest.getTime() + HOUR));
  });
});

describe("Mastercard — 35-in-30-days MIT retry cap", () => {
  it("permits the 35th retry", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      priorAttempts: 35,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.allowed).toBe(true);
    expect(d.remainingAttempts).toBe(1);
  });

  it("blocks the 36th retry", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      priorAttempts: 36,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("reattempt_cap");
    expect(d.feeRisk).toBe(true);
  });

  it("recurring_revoked takes precedence over the cap", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "03",
      priorAttempts: 36,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(d.reason).toBe("recurring_revoked");
  });
});

describe("Mastercard — constants", () => {
  it("expose the cap and current excess-fee rate", () => {
    expect(MASTERCARD_RETRY_CAP).toBe(35);
    expect(MASTERCARD_EXCESS_FEE_USD).toBe(0.5);
  });
});
