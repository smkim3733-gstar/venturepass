import { describe, expect, it } from "vitest";
import { companyListResponse } from "./company-list-response";
import { companyListFixture } from "../../../scripts/fixtures/company-list";

describe("company list response", () => {
  it("accepts complete summaries, order and original input without mutation", () => {
    const f = companyListFixture();
    const original = JSON.stringify(f.response);
    expect(companyListResponse(f.response)).toEqual(f.response.cases);
    expect(JSON.stringify(f.response)).toBe(original);
  });
  it("accepts a verified empty list", () => expect(companyListResponse({ cases: [] })).toEqual([]));
  it("accepts legacy summaries without optional attention", () => {
    const f = companyListFixture();
    delete f.response.cases[0].attention;
    expect(companyListResponse(f.response)).toEqual(f.response.cases);
  });
  it("allows the same name under distinct IDs", () => {
    const f = companyListFixture();
    f.response.cases[1].companyName = f.response.cases[0].companyName;
    expect(companyListResponse(f.response)).toEqual(f.response.cases);
  });
  const malformed: [string, unknown][] = [
    ["null", null],
    ["missing", {}],
    ["array", []],
    ["null list", { cases: null }],
    ["string list", { cases: "" }],
    ["null row", { cases: [null] }],
    ["mixed error", { cases: [], error: "failed" }],
  ];
  it.each(malformed)("rejects %s", (_, value) => expect(companyListResponse(value)).toBeNull());
  const changes: [string, (f: ReturnType<typeof companyListFixture>) => void][] = [
    [
      "duplicate ID",
      (f) => {
        f.response.cases[1].id = f.response.cases[0].id;
      },
    ],
    [
      "invalid ID",
      (f) => {
        f.response.cases[0].id = "other";
      },
    ],
    [
      "blank name",
      (f) => {
        f.response.cases[0].companyName = "  ";
      },
    ],
    [
      "invalid stage",
      (f) => {
        Object.assign(f.response.cases[0], { stage: "approved" });
      },
    ],
    [
      "negative revision",
      (f) => {
        f.response.cases[0].revision = -1;
      },
    ],
    [
      "fractional revision",
      (f) => {
        f.response.cases[0].revision = 1.5;
      },
    ],
    [
      "unsafe count",
      (f) => {
        f.response.cases[0].sourceCount = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "negative plan count",
      (f) => {
        f.response.cases[0].planCount = -1;
      },
    ],
    [
      "string task count",
      (f) => {
        Object.assign(f.response.cases[0], { pendingTaskCount: "2" });
      },
    ],
    [
      "invalid timestamp",
      (f) => {
        f.response.cases[0].updatedAt = "unknown";
      },
    ],
    [
      "negative attention count",
      (f) => {
        f.response.cases[0].attention!.pendingSourceCount = -1;
      },
    ],
    [
      "wrong review flag",
      (f) => {
        Object.assign(f.response.cases[0].attention!, { planReviewRequired: "false" });
      },
    ],
    [
      "wrong diagnosis",
      (f) => {
        Object.assign(f.response.cases[0].attention!, { diagnosisState: "passed" });
      },
    ],
    [
      "wrong preparation",
      (f) => {
        Object.assign(f.response.cases[0].attention!, { preparationState: "success" });
      },
    ],
    [
      "non-array due dates",
      (f) => {
        Object.assign(f.response.cases[0].attention!, { pendingDueDates: 123 });
      },
    ],
    [
      "non-string due date",
      (f) => {
        Object.assign(f.response.cases[0].attention!, { pendingDueDates: [1] });
      },
    ],
    [
      "invalid entered date format",
      (f) => {
        f.response.cases[0].attention!.pendingDueDates = ["next week"];
      },
    ],
    [
      "negative certificate count",
      (f) => {
        f.response.cases[0].attention!.certificate!.missingUntilCount = -1;
      },
    ],
    [
      "non-array certificate dates",
      (f) => {
        Object.assign(f.response.cases[0].attention!.certificate!, { recordedUntilDates: null });
      },
    ],
    [
      "invalid second row",
      (f) => {
        Object.assign(f.response.cases[1], { industry: null });
      },
    ],
  ];
  it.each(changes)("rejects the whole list for %s", (_, change) => {
    const f = companyListFixture();
    change(f);
    expect(companyListResponse(f.response)).toBeNull();
  });
});
