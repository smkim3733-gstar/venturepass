import { describe, expect, it } from "vitest";
import type { VentureScreenField } from "@/lib/venturein-inspection";
import { ventureIssueFieldTarget } from "./venturein-issue-navigation";

function field(key: string, kind: "textarea" | "file" = "textarea"): VentureScreenField {
  return {
    key,
    kind,
    type: kind,
    id: key,
    name: key,
    labels: ["같은 합성 이름"],
    required: true,
    maxLength: null,
    accept: null,
    multiple: false,
    disabled: false,
    readOnly: false,
    options: [],
  };
}

describe("점검 결과의 연결 선택칸", () => {
  it("이름이 같아도 정확한 key와 종류별 순서로 이동하며 원본을 바꾸지 않는다", () => {
    const fields = [field("one"), field("file", "file"), field("two")];
    const before = structuredClone(fields);
    expect(ventureIssueFieldTarget(fields, "two")?.id).toBe("venture-text-1");
    expect(ventureIssueFieldTarget(fields, "file")?.id).toBe("venture-file-0");
    expect(fields).toEqual(before);
  });
  it("항목 key가 없거나 사라졌으면 다른 선택칸으로 대체하지 않는다", () => {
    expect(ventureIssueFieldTarget([field("one")])).toBeNull();
    expect(ventureIssueFieldTarget([field("one")], "missing")).toBeNull();
  });
  it("종류나 편집 가능 여부가 다른 중복 key도 거절한다", () => {
    expect(ventureIssueFieldTarget([field("one"), field("one", "file")], "one")).toBeNull();
    expect(
      ventureIssueFieldTarget([field("one"), { ...field("one"), disabled: true }], "one"),
    ).toBeNull();
  });
  it.each([{ disabled: true }, { readOnly: true }, { kind: "input" as const, type: "checkbox" }])(
    "직접 확인 항목 %j에는 연결 선택칸을 만들지 않는다",
    (change) => {
      expect(ventureIssueFieldTarget([{ ...field("one"), ...change }], "one")).toBeNull();
    },
  );
});
