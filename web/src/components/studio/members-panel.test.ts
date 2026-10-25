import { describe, expect, it } from "vitest";
import type { StudioStatus } from "@/lib/studio-schema";
import { membersBlockedReason } from "./members-panel";

const status = (patch: Partial<StudioStatus>) =>
  ({ storage: "server", ...patch }) as unknown as StudioStatus;

describe("staff management page access", () => {
  it("opens only for a signed-in admin on the web service", () => {
    expect(membersBlockedReason(null)).toBeNull();
    expect(
      membersBlockedReason(status({ user: { displayName: "가상", role: "admin" } })),
    ).toBeNull();
    expect(
      membersBlockedReason(status({ user: { displayName: "가상", role: "editor" } })),
    ).toContain("관리자만");
    expect(membersBlockedReason(status({ storage: "local" }))).toContain("웹 서비스에서만");
  });
});
