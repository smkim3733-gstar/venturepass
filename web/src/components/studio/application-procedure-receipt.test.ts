import { describe, it, expect } from "vitest";
import {
  applicationProcedureSaveAcknowledged,
  applicationProcedureUiContext,
} from "./application-procedures-ui";
import {
  procedureReceiptFixture,
  procedureReceiptResult,
  linkId,
} from "../../../scripts/fixtures/application-procedure-receipt";
describe("회차 절차 기존 비동기 요청 대조의 상위 수락 연결", () => {
  it("accepts exact correction and current synthetic context without mutating inputs", async () => {
    const { company, input, nonce, saved } = await procedureReceiptFixture();
    const before = JSON.stringify({ company, input, saved });
    expect(await applicationProcedureSaveAcknowledged(saved, company, nonce, input)).toBe(true);
    expect(await applicationProcedureUiContext(saved, saved.applicationProcedures.at(-1)!)).toEqual(
      [],
    );
    expect(JSON.stringify({ company, input, saved })).toBe(before);
  });
  it("accepts first manual record", async () => {
    const { company, initial, nonce } = await procedureReceiptFixture();
    company.applicationProcedures = [];
    const input = { ...initial, agencyVersionId: linkId(402) };
    expect(
      await applicationProcedureSaveAcknowledged(
        await procedureReceiptResult(company, input, nonce),
        company,
        nonce,
        input,
      ),
    ).toBe(true);
  });
  it("accepts explicit unknown dates and statuses without copying old values", async () => {
    const { company, input, nonce } = await procedureReceiptFixture();
    const cleared = {
      ...input,
      requester: "",
      requestedOn: "",
      dueOn: "",
      dueBasis: "",
      extensionStatus: "unknown" as const,
      extensionRequestedOn: "",
      extensionDecidedOn: "",
      extendedDueOn: "",
      extensionBasis: "",
      status: "unknown" as const,
      statusBasis: "",
      completionBasis: "",
      note: "",
    };
    expect(
      await applicationProcedureSaveAcknowledged(
        await procedureReceiptResult(company, cleared, nonce),
        company,
        nonce,
        cleared,
      ),
    ).toBe(true);
  });
  it.each([
    ["title", "다른 제목"],
    ["procedureType", "committee"],
    ["requester", "다른 요청 주체"],
    ["requestedOn", "2026-10-09"],
    ["dueOn", "2026-10-21"],
    ["dueBasis", "다른 안내기한 근거"],
    ["extensionStatus", "reported_denied"],
    ["extensionRequestedOn", "2026-10-10"],
    ["extensionDecidedOn", "2026-10-13"],
    ["extendedDueOn", "2026-11-04"],
    ["extensionBasis", "다른 연장 근거"],
    ["status", "reported_completed"],
    ["statusBasis", "다른 상태 근거"],
    ["completionBasis", "다른 완료 근거"],
    ["recordedBy", "다른 기록자"],
    ["note", "다른 메모"],
    ["procedureId", linkId(499)],
    ["previousVersionId", linkId(499)],
    ["version", 3],
    ["applicationId", linkId(499)],
    ["applicationMetadataVersionId", linkId(499)],
    ["agencyVersionId", linkId(401)],
    ["linkEventId", linkId(499)],
    ["inputDigest", "f".repeat(64)],
    ["clientRequestId", linkId(499)],
  ])("rejects different %s", async (key, value) => {
    const { company, input, nonce, saved } = await procedureReceiptFixture(),
      before = JSON.stringify(input);
    Object.assign(saved.applicationProcedures.at(-1)!, { [key]: value });
    expect(await applicationProcedureSaveAcknowledged(saved, company, nonce, input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["missing", "duplicate-nonce", "evidence", "company", "revision", "null", "malformed"])(
    "rejects %s",
    async (kind) => {
      const { company, input, nonce, saved } = await procedureReceiptFixture(),
        record = saved.applicationProcedures.at(-1)!;
      if (kind === "missing") saved.applicationProcedures.pop();
      if (kind === "duplicate-nonce") saved.applicationProcedures.push(structuredClone(record));
      if (kind === "evidence")
        record.evidence.push({
          sourceId: linkId(499),
          sourceUpdatedAt: "synthetic",
          quote: "다른 인용",
          locator: "1쪽",
        });
      if (kind === "company") saved.id = linkId(499);
      if (kind === "revision") saved.revision = company.revision - 1;
      expect(
        await applicationProcedureSaveAcknowledged(
          kind === "null" ? null : kind === "malformed" ? { id: company.id } : saved,
          company,
          nonce,
          input,
        ),
      ).toBe(false);
    },
  );
});
