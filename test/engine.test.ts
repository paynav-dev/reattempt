import { describe, it, expect } from "vitest";
import { evaluateReattempt, CIT_VELOCITY_IDENTICAL_LIMIT } from "../src/index";

const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const within = new Date("2026-01-10T00:00:00.000Z");
const MIN = 60_000;

describe("engine — input validation", () => {
  it("throws on an unsupported network", () => {
    // @ts-expect-error deliberately invalid network
    expect(() => evaluateReattempt({ network: "amex", context: "mit", declineCode: "05" })).toThrow(TypeError);
  });

  it("throws on an unsupported / missing context", () => {
    // @ts-expect-error deliberately invalid context
    expect(() => evaluateReattempt({ network: "visa", context: "batch", declineCode: "05" })).toThrow(TypeError);
    // @ts-expect-error missing context
    expect(() => evaluateReattempt({ network: "visa", declineCode: "05" })).toThrow(TypeError);
  });

  it("throws on a missing/empty declineCode", () => {
    expect(() => evaluateReattempt({ network: "visa", context: "mit", declineCode: "  " })).toThrow(TypeError);
  });

  it("throws on an unparseable timestamp", () => {
    expect(() =>
      evaluateReattempt({ network: "visa", context: "mit", declineCode: "05", now: "not-a-date" }),
    ).toThrow(TypeError);
    expect(() =>
      evaluateReattempt({ network: "visa", context: "mit", declineCode: "05", attempts: ["nope"] }),
    ).toThrow(TypeError);
  });
});

describe("engine — timestamp coercion", () => {
  const epoch = ANCHOR.getTime();
  const forms: Array<[string, string | number | Date]> = [
    ["Date", ANCHOR],
    ["ISO string", ANCHOR.toISOString()],
    ["epoch number", epoch],
  ];

  it.each(forms)("accepts a %s for firstAttemptAt (MIT cap)", (_label, value) => {
    const d = evaluateReattempt({
      network: "visa",
      context: "mit",
      declineCode: "05",
      priorAttempts: 16,
      firstAttemptAt: value,
      now: within,
    });
    expect(d.reason).toBe("reattempt_cap");
  });

  it.each(forms)("accepts a %s inside the attempts array (MIT delay)", (_label, value) => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      merchantAdviceCode: "25",
      attempts: [value],
      now: new Date(epoch + MIN),
    });
    expect(d.reason).toBe("retry_delay");
  });
});

describe("engine — CIT in-session velocity", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");

  it(`blocks after ${CIT_VELOCITY_IDENTICAL_LIMIT} identical soft declines in-session`, () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      attempts: [
        { at: new Date(now.getTime() - 10 * MIN), declineCode: "05" },
        { at: new Date(now.getTime() - 5 * MIN), declineCode: "05" },
      ],
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("cit_velocity");
    expect(d.recommendedAction).toBe("collect_new_instrument");
    expect(d.customerMessage).toMatch(/different payment method/i);
  });

  it("permits a first identical decline (below the limit)", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      attempts: [{ at: new Date(now.getTime() - 5 * MIN), declineCode: "05" }],
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
  });

  it("ignores identical declines outside the velocity window", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      attempts: [
        { at: new Date(now.getTime() - 40 * MIN), declineCode: "05" }, // outside 30-min window
        { at: new Date(now.getTime() - 5 * MIN), declineCode: "05" },
      ],
      now,
    });
    expect(d.allowed).toBe(true);
  });

  it("does not count declines with a different code", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      attempts: [
        { at: new Date(now.getTime() - 8 * MIN), declineCode: "51" },
        { at: new Date(now.getTime() - 4 * MIN), declineCode: "51" },
      ],
      now,
    });
    expect(d.allowed).toBe(true);
  });

  it("cannot trigger from the count-only path (no per-attempt codes)", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "05",
      priorAttempts: 50,
      firstAttemptAt: new Date(now.getTime() - 20 * MIN),
      now,
    });
    expect(d.allowed).toBe(true);
  });

  it("a hard decline still blocks CIT regardless of velocity", () => {
    const d = evaluateReattempt({
      network: "visa",
      context: "cit",
      declineCode: "43",
      attempts: [{ at: new Date(now.getTime() - 5 * MIN), declineCode: "43" }],
      now,
    });
    expect(d.reason).toBe("hard_decline");
  });
});

describe("engine — the two history input forms agree (MIT cap)", () => {
  it("attempts array and priorAttempts+firstAttemptAt yield the same verdict", () => {
    const attempts = Array.from({ length: 16 }, (_, i) => new Date(ANCHOR.getTime() + i * MIN));
    const viaArray = evaluateReattempt({ network: "visa", context: "mit", declineCode: "05", attempts, now: within });
    const viaCount = evaluateReattempt({
      network: "visa",
      context: "mit",
      declineCode: "05",
      priorAttempts: 16,
      firstAttemptAt: ANCHOR,
      now: within,
    });
    expect(viaArray.reason).toBe(viaCount.reason);
    expect(viaArray.remainingAttempts).toBe(viaCount.remainingAttempts);
  });
});

describe("engine — defaults", () => {
  it("defaults `now` to the current time when omitted", () => {
    const before = Date.now();
    const d = evaluateReattempt({ network: "visa", context: "mit", declineCode: "05" });
    const after = Date.now();
    expect(d.allowed).toBe(true);
    const end = d.windowEndsAt!.getTime();
    expect(end).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
    expect(end).toBeLessThanOrEqual(after + 30 * 86_400_000);
  });
});

describe("engine — MIT window reset after 30 days", () => {
  it("a fresh cycle begins once the original window lapses", () => {
    const d = evaluateReattempt({
      network: "mastercard",
      context: "mit",
      declineCode: "05",
      priorAttempts: 40,
      firstAttemptAt: ANCHOR,
      now: new Date(ANCHOR.getTime() + 31 * 86_400_000),
    });
    expect(d.allowed).toBe(true);
    expect(d.remainingAttempts).toBe(35);
  });
});
