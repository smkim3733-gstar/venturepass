import { z } from "zod";

export const ventureinUrls = {
  login: "https://www.smes.go.kr/venturein/auth/viewLogin",
  securityInstall: "https://www.smes.go.kr/venturein/resources/raonnx/install/install.html",
  application: "https://www.smes.go.kr/venturein/aply/v2",
  terms: "https://www.smes.go.kr/venturein/cmmn/terms",
} as const;

export const ventureAccountInputSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    loginId: z.string().trim().min(1, "벤처인 아이디를 입력해 주세요.").max(200),
    password: z.string().min(1, "비밀번호를 입력해 주세요.").max(512),
  })
  .strict();

export type VentureAccountStatus = {
  saved: boolean;
  maskedLoginId: string | null;
  updatedAt: string | null;
  revision: number;
};

export type VentureSessionState =
  | "idle"
  | "starting"
  | "awaiting_setup"
  | "awaiting_login"
  | "awaiting_auth"
  | "connected_unmapped"
  | "login_failed"
  | "stopped";

export type VentureSessionStatus = {
  state: VentureSessionState;
  message: string;
  startedAt: string | null;
  updatedAt: string | null;
};

export type VenturePreparation = {
  planId: string | null;
  planVersion: number | null;
  planTitle: string | null;
  sections: { key: string; title: string; content: string; needsConfirmation: boolean }[];
  attachments: { id: string; name: string; originalName: string }[];
  blockers: string[];
};

export type VentureConnectionStatus = {
  account: VentureAccountStatus;
  session: VentureSessionStatus;
  preparation: VenturePreparation;
  credentialStorage: "windows-dpapi" | "unavailable";
  automaticSubmissionAvailable: false;
};
