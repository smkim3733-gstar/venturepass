import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agencyAppendMutationSchema,
  agencyRecordInputSchema,
  agencyRecordSchema,
  agencyNoticeDetailsSchema,
  assertAgencyCapacity,
  buildAgencyRecord,
  isAgencyRecordReplay,
  isAgencyNoticeRecord,
  type AgencyEvidenceSnapshot,
  type AgencyRecord,
  type AgencyRecordInput,
  type AgencyNoticeDetails,
} from "./studio-agency-records";

const now = "2026-09-25T07:00:00.000Z";
function request(): Extract<AgencyRecordInput, { kind: "request" }> {
  return {
    kind: "request",
    institution: "가상 평가기관",
    title: "가상 보완 요청",
    body: "담당자가 전사한 시험용 요청입니다.",
    occurredOn: "2026-09-24",
    dueOn: "2026-10-01",
    dueNote: "담당자가 원문에서 확인한 날짜. 앱 추산 아님.",
    note: "자동 수신·기관 확인 아님",
    sourceIds: [],
  };
}
function evidence(): AgencyEvidenceSnapshot {
  return {
    sourceId: randomUUID(),
    sourceName: "가상 원본",
    originalName: "request.pdf",
    mimeType: "application/pdf",
    sizeBytes: 100,
    sha256: "a".repeat(64),
    capturedAt: now,
    sourceUpdatedAt: now,
  };
}
function append(
  records: AgencyRecord[],
  input: AgencyRecordInput,
  proof: AgencyEvidenceSnapshot[] = [],
) {
  return buildAgencyRecord(records, input, {
    id: randomUUID(),
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    recordedAt: now,
    evidence: proof,
  });
}
function response(
  initial: AgencyRecord,
  previousVersionId: string | null = null,
): Extract<AgencyRecordInput, { kind: "response" }> {
  return {
    kind: "response",
    requestRecordId: initial.id,
    previousVersionId,
    title: "가상 답변",
    body: "로컬 답변 초안",
    occurredOn: "",
    note: "",
    sourceIds: [],
    responseStatus: "draft",
  };
}

const blankNotices: AgencyNoticeDetails[] = [
  {
    category: "payment",
    amountWon: "",
    dueOn: "",
    dueNote: "",
    paidOn: "",
    referenceNumber: "",
    statusText: "",
  },
  { category: "receipt", receiptNumber: "", receivedOn: "", statusText: "" },
  { category: "visit", scheduledOn: "", timeText: "", location: "", preparation: "" },
  { category: "decision", decisionText: "", notifiedOn: "", reasons: "" },
  {
    category: "certificate",
    certificateNumber: "",
    issuedOn: "",
    validFrom: "",
    validUntil: "",
    statusText: "",
  },
];
function notice(
  details: AgencyNoticeDetails = blankNotices[0],
): Extract<AgencyRecordInput, { kind: "notice" }> {
  return {
    kind: "notice",
    institution: "i",
    title: "t",
    body: "x",
    occurredOn: "",
    note: "",
    sourceIds: [],
    details,
  };
}

describe("수동 통보와 정정의 별도 계약", () => {
  it.each(blankNotices)(
    "$category 선택 상세값은 모두 미확인으로 저장하며 요청 필드를 만들지 않는다",
    (details) => {
      const input = agencyRecordInputSchema.parse(notice(details));
      const saved = append([], input);
      expect(saved).toMatchObject({
        kind: "notice",
        noticeRecordId: saved.id,
        previousVersionId: null,
        version: 1,
        origin: "manual",
        details,
      });
      expect(isAgencyNoticeRecord(saved)).toBe(true);
      for (const key of [
        "requestRecordId",
        "requestVersionId",
        "dueOn",
        "dueNote",
        "responseStatus",
      ])
        expect(saved).not.toHaveProperty(key);
      expect(agencyRecordSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    },
  );
  it("통보 정정은 별도 버전을 만들고 명시 분류 정정과 이전 원문을 함께 보존한다", () => {
    const first = append([], notice(blankNotices[0]));
    const old = structuredClone(first);
    const corrected = append([first], {
      ...notice(blankNotices[4]),
      kind: "notice-correction",
      noticeRecordId: first.id,
      previousVersionId: first.id,
      body: "분류와 통보 내용의 명시 정정",
    });
    expect(corrected).toMatchObject({
      kind: "notice-correction",
      noticeRecordId: first.id,
      previousVersionId: first.id,
      version: 2,
      details: { category: "certificate" },
    });
    expect(first).toEqual(old);
    expect(() =>
      append([first, corrected], {
        ...notice(),
        kind: "notice-correction",
        noticeRecordId: first.id,
        previousVersionId: first.id,
      }),
    ).toThrow("최신 버전");
  });
  it("통보를 요청·답변으로 연결하거나 요청·다른 정정본을 최초 통보로 삼지 않는다", () => {
    const initialRequest = append([], request());
    const initialNotice = append([initialRequest], notice());
    const corrected = append([initialRequest, initialNotice], {
      ...notice(),
      kind: "notice-correction",
      noticeRecordId: initialNotice.id,
      previousVersionId: initialNotice.id,
    });
    expect(() => append([initialRequest, initialNotice], response(initialNotice))).toThrow(
      "최초 요청",
    );
    expect(() =>
      append([initialRequest, initialNotice], {
        ...request(),
        kind: "request-correction",
        requestRecordId: initialNotice.id,
        previousVersionId: initialNotice.id,
      }),
    ).toThrow("최초 요청");
    for (const wrong of [initialRequest, corrected])
      expect(() =>
        append([initialRequest, initialNotice, corrected], {
          ...notice(),
          kind: "notice-correction",
          noticeRecordId: wrong.id,
          previousVersionId: wrong.id,
        }),
      ).toThrow("최초 통보");
    expect(() =>
      append([], {
        ...notice(),
        kind: "notice-correction",
        noticeRecordId: initialNotice.id,
        previousVersionId: initialNotice.id,
      }),
    ).toThrow("최초 통보");
  });
  it("통보와 요청의 이력이 섞여도 요청·답변의 버전 및 canonical 입력 키는 그대로다", () => {
    const first = append([], request());
    const event = append([first], notice());
    const reply = append([first, event], response(first));
    expect(reply).toMatchObject({
      kind: "response",
      requestRecordId: first.id,
      requestVersionId: first.id,
      version: 1,
    });
    expect(agencyRecordSchema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(Object.keys(agencyRecordInputSchema.parse(request()))).toEqual([
      "kind",
      "title",
      "body",
      "occurredOn",
      "note",
      "sourceIds",
      "institution",
      "dueOn",
      "dueNote",
    ]);
    expect(Object.keys(agencyRecordInputSchema.parse(response(first)))).toEqual([
      "kind",
      "requestRecordId",
      "previousVersionId",
      "responseStatus",
      "title",
      "body",
      "occurredOn",
      "note",
      "sourceIds",
    ]);
  });
  it.each(["0", "1", "9007199254740991", ""])(
    "납부 금액의 원 단위 정수 또는 미확인 허용: %s",
    (amountWon) => {
      expect(agencyNoticeDetailsSchema.safeParse({ ...blankNotices[0], amountWon }).success).toBe(
        true,
      );
    },
  );
  it.each(["01", "1,000", "1e3", "-1", "1.5", "9007199254740992", "1\n", " 1", "1 ", "-0"])(
    "금액 임의변환 없이 잘못된 문자열을 거부: %j",
    (amountWon) => {
      expect(agencyNoticeDetailsSchema.safeParse({ ...blankNotices[0], amountWon }).success).toBe(
        false,
      );
    },
  );
  it("확인서 기간은 미확인·한쪽 날짜만 허용하고 실제 두 날짜의 역순만 거부한다", () => {
    const details = blankNotices[4];
    for (const period of [
      { validFrom: "2026-09-25", validUntil: "" },
      { validFrom: "", validUntil: "2026-09-25" },
      { validFrom: "2026-09-25", validUntil: "2026-09-25" },
    ])
      expect(agencyNoticeDetailsSchema.safeParse({ ...details, ...period }).success).toBe(true);
    expect(
      agencyNoticeDetailsSchema.safeParse({
        ...details,
        validFrom: "2026-09-26",
        validUntil: "2026-09-25",
      }).success,
    ).toBe(false);
    expect(
      agencyNoticeDetailsSchema.safeParse({ ...details, issuedOn: "2026-02-30" }).success,
    ).toBe(false);
  });
  it("다른 분류 속성·요청 링크·자동 검증 주장 주입을 거부한다", () => {
    for (const extra of [
      { requestRecordId: randomUUID() },
      { responseStatus: "reported-sent" },
      { noticeRecordId: randomUUID() },
      { verified: true },
    ])
      expect(agencyRecordInputSchema.safeParse({ ...notice(), ...extra }).success).toBe(false);
    expect(
      agencyNoticeDetailsSchema.safeParse({ ...blankNotices[0], certificateNumber: "번호" })
        .success,
    ).toBe(false);
    expect(
      agencyNoticeDetailsSchema.safeParse({ ...blankNotices[0], category: "other" }).success,
    ).toBe(false);
    const missing = { ...blankNotices[1] } as Record<string, unknown>;
    delete missing.receiptNumber;
    expect(agencyNoticeDetailsSchema.safeParse(missing).success).toBe(false);
  });
  it("표시용 시간 원문은 변환하지 않고 그대로 보존한다", () => {
    const details = { ...blankNotices[2], timeText: "오전 중 (확정 시간 미기재)" };
    const parsed = agencyNoticeDetailsSchema.parse(details);
    expect(parsed).toEqual(details);
  });
  it.each(blankNotices)(
    "$category 모든 추가 상세 문자열과 발생일을 200k 합계에 반영한다",
    (details) => {
      const first = append([], {
        ...notice(details),
        body: "x".repeat(20_000 - 2 - details.category.length),
      });
      if (!isAgencyNoticeRecord(first)) throw new Error("Expected a notice");
      const full = Array.from({ length: 10 }, () => structuredClone(first));
      expect(() => assertAgencyCapacity(full)).not.toThrow();
      for (const key of Object.keys(details).filter((key) => key !== "category")) {
        const next = structuredClone(full);
        Object.assign(next[0].details, {
          [key]: /On|From|Until/.test(key) ? "2026-09-25" : key === "amountWon" ? "1" : "x",
        });
        expect(() => assertAgencyCapacity(next)).toThrow("보관 한도");
      }
      const next = structuredClone(full);
      next[0].occurredOn = "2026-09-25";
      expect(() => assertAgencyCapacity(next)).toThrow("보관 한도");
    },
  );
});

describe("기관 기록 입력 계약", () => {
  it("초안·빈 날짜는 허용하고 담당자 발송 기록에는 확인 날짜를 요구한다", () => {
    const first = append([], request());
    expect(agencyRecordInputSchema.safeParse(response(first)).success).toBe(true);
    expect(
      agencyRecordInputSchema.safeParse({ ...response(first), responseStatus: "reported-sent" })
        .success,
    ).toBe(false);
    expect(
      agencyRecordInputSchema.safeParse({
        ...response(first),
        responseStatus: "reported-sent",
        occurredOn: "2026-09-25",
      }).success,
    ).toBe(true);
  });
  it.each([
    { occurredOn: "2026-02-30" },
    { dueOn: "tomorrow" },
    { body: " " },
    { body: "x".repeat(20_001) },
    { institution: "" },
    { sourceIds: Array.from({ length: 11 }, () => randomUUID()) },
  ])("잘못되거나 한도를 넘는 입력을 거부한다: %j", (change) => {
    expect(agencyRecordInputSchema.safeParse({ ...request(), ...change }).success).toBe(false);
  });
  it.each([
    { id: randomUUID() },
    { evidence: [] },
    { origin: "agency-verified" },
    { version: 9 },
    { recordedAt: now },
  ])("서버 이력 필드 주입을 거부한다: %j", (forged) => {
    expect(agencyRecordInputSchema.safeParse({ ...request(), ...forged }).success).toBe(false);
  });
  it("같은 원본 중복과 mutation 최상위 서버 필드 주입도 거부한다", () => {
    const id = randomUUID();
    expect(agencyRecordInputSchema.safeParse({ ...request(), sourceIds: [id, id] }).success).toBe(
      false,
    );
    expect(
      agencyAppendMutationSchema.safeParse({
        action: "append-agency-record",
        revision: 0,
        clientRequestId: id,
        record: request(),
        agencyRecords: [],
      }).success,
    ).toBe(false);
  });
});

describe("기관 요청·답변 버전의 append 계약", () => {
  it("요청 정정과 답변 버전을 별도로 올리고 이전 기록과 근거를 바꾸지 않는다", () => {
    const first = append([], request());
    const old = structuredClone(first);
    const reply1 = append([first], response(first));
    const correction = append([first, reply1], {
      ...request(),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
      institution: "정정된 가상 기관",
      body: "정정된 요청",
      dueOn: "2026-10-05",
    });
    const reply2 = append([first, reply1, correction], {
      ...response(first, reply1.id),
      body: "두 번째 답변 버전",
    });
    expect(first).toEqual(old);
    expect(correction).toMatchObject({
      requestRecordId: first.id,
      requestVersionId: correction.id,
      previousVersionId: first.id,
      version: 2,
      origin: "manual",
    });
    expect(reply1).toMatchObject({
      version: 1,
      requestVersionId: first.id,
      responseStatus: "draft",
      institution: first.institution,
    });
    expect(reply2).toMatchObject({
      version: 2,
      previousVersionId: reply1.id,
      requestVersionId: correction.id,
      institution: correction.institution,
      dueOn: "",
      dueNote: "",
    });
  });
  it("이 회사에 없는 최초 요청 또는 정정 항목을 루트 요청으로 사용할 수 없다", () => {
    const first = append([], request());
    const correction = append([first], {
      ...request(),
      kind: "request-correction",
      requestRecordId: first.id,
      previousVersionId: first.id,
    });
    expect(() => append([], response(first))).toThrow("최초 요청");
    expect(() => append([first, correction], response(correction))).toThrow("최초 요청");
  });
  it("이미 새 버전이 있으면 옛 답변을 덮거나 갈라서 수정하지 않는다", () => {
    const first = append([], request());
    const reply = append([first], response(first));
    expect(() => append([first, reply], response(first))).toThrow("최신 버전");
    expect(() => append([first, reply], response(first, first.id))).toThrow("최신 버전");
  });
  it("동일 요청 nonce 재전송은 같은 정규 입력만 허용한다", () => {
    const first = append([], request());
    expect(isAgencyRecordReplay([first], first.clientRequestId, first.inputDigest)).toBe(true);
    expect(isAgencyRecordReplay([first], randomUUID(), first.inputDigest)).toBe(false);
    expect(() => isAgencyRecordReplay([first], first.clientRequestId, "b".repeat(64))).toThrow(
      "다른 내용",
    );
  });
  it("기록 수와 합산 문자 한도는 이전 항목을 자르지 않고 거부한다", () => {
    const first = append([], request());
    const many = Array.from({ length: 200 }, () => structuredClone(first));
    expect(() => append(many, request())).toThrow("보관 한도");
    expect(many).toHaveLength(200);
    expect(() =>
      assertAgencyCapacity(
        Array.from({ length: 11 }, () => ({ ...first, body: "x".repeat(20_000) })),
      ),
    ).toThrow("보관 한도");
  });
});

describe("증빙 스냅샷 불변", () => {
  it("원본 선택과 스냅샷의 대상·순서는 일치해야 한다", () => {
    expect(() => append([], request(), [evidence()])).toThrow("일치하지");
  });
  it.each(["sha256", "sizeBytes", "originalName", "mimeType"] as const)(
    "이미 연결한 원본의 %s 변경을 새 연결로 덮지 않는다",
    (key) => {
      const proof = evidence();
      const input = { ...request(), sourceIds: [proof.sourceId] };
      const first = append([], input, [proof]);
      const changed = { ...proof };
      if (key === "sha256") changed.sha256 = "b".repeat(64);
      if (key === "sizeBytes") changed.sizeBytes += 1;
      if (key === "originalName") changed.originalName = "other.pdf";
      if (key === "mimeType") changed.mimeType = null;
      expect(() => append([first], input, [changed])).toThrow("변경되었습니다");
      expect(first.evidence[0]).toEqual(proof);
    },
  );
  it("원본 바이트가 같으면 자료 제목·본문 편집 시각을 새 기록에 남기되 과거 메타는 보존한다", () => {
    const proof = evidence();
    const input = { ...request(), sourceIds: [proof.sourceId] };
    const first = append([], input, [proof]);
    const changed = {
      ...proof,
      sourceName: "새 자료 제목",
      sourceUpdatedAt: "2026-09-25T08:00:00.000Z",
    };
    const next = append([first], input, [changed]);
    expect(next.evidence[0]).toEqual(changed);
    expect(first.evidence[0]).toEqual(proof);
  });
  it("각 파일이 허용 범위여도 한 기록 합계 24MiB를 초과하면 거부한다", () => {
    const proof = Array.from({ length: 3 }, () => ({ ...evidence(), sizeBytes: 9 * 1024 * 1024 }));
    expect(() =>
      append([], { ...request(), sourceIds: proof.map((item) => item.sourceId) }, proof),
    ).toThrow("24MiB");
  });
});
