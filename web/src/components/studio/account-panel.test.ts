import { describe, expect, it } from "vitest";
import type { StudioStatus } from "@/lib/studio-schema";
import { accountBlockedReason, passwordFormProblem } from "./account-panel";

const status = (patch: Partial<StudioStatus>) =>
  ({ storage: "server", ...patch }) as unknown as StudioStatus;
const form = (patch: Partial<Parameters<typeof passwordFormProblem>[0]> = {}) => ({
  currentPassword: "current-password",
  newPassword: "new-password-123",
  confirmPassword: "new-password-123",
  ...patch,
});

describe("own account page", () => {
  it("opens for any signed-in member of the web service, viewers included", () => {
    expect(accountBlockedReason(null)).toBeNull();
    expect(
      accountBlockedReason(status({ user: { displayName: "가상", role: "viewer" } })),
    ).toBeNull();
    expect(accountBlockedReason(status({}))).toContain("로그인했을 때만");
    expect(
      accountBlockedReason(
        status({ storage: "local", user: { displayName: "가상", role: "admin" } }),
      ),
    ).toContain("웹 서비스");
  });

  it("checks the form before sending", () => {
    expect(passwordFormProblem(form())).toBeNull();
    expect(passwordFormProblem(form({ currentPassword: "" }))).toContain("지금 비밀번호");
    expect(passwordFormProblem(form({ newPassword: "short", confirmPassword: "short" }))).toContain(
      "10자 이상",
    );
    expect(passwordFormProblem(form({ confirmPassword: "different-123" }))).toContain(
      "서로 다릅니다",
    );
    expect(
      passwordFormProblem(
        form({ newPassword: "current-password", confirmPassword: "current-password" }),
      ),
    ).toContain("다른 비밀번호");
  });
});
