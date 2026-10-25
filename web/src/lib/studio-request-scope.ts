import { AsyncLocalStorage } from "node:async_hooks";
import type { CaseRowRepository } from "./studio-case-session";
import type { MemberDirectory } from "./studio-members";
import type { OriginalObjectStore } from "./studio-original-store";

/** Authenticated staff member of one organization (server mode only). */
export type StudioPrincipal = {
  userId: string;
  organizationId: string;
  role: "admin" | "editor" | "viewer";
  displayName: string;
};

/**
 * Server wiring. Authentication decides the principal; the repository is always derived from
 * that principal, never from request input.
 */
export type StudioServerRuntime = {
  /** Public origin of the deployed site, e.g. https://venturepass.example.com */
  origin: string;
  authenticate(request: Request): Promise<StudioPrincipal | null>;
  repositoryFor(principal: StudioPrincipal): CaseRowRepository;
  /** Private original-file storage; absent means uploads and downloads stay unavailable. */
  originals?: OriginalObjectStore;
  /** Staff memberships of the signed-in admin's organization. */
  members?: MemberDirectory;
};

type RequestScope = {
  principal: StudioPrincipal;
  repository: CaseRowRepository;
  originals?: OriginalObjectStore;
  members?: MemberDirectory;
};
const scope = new AsyncLocalStorage<RequestScope>();
let runtime: StudioServerRuntime | null = null;

export function configureServerRuntime(value: StudioServerRuntime | null) {
  runtime = value;
}
export function getServerRuntime() {
  return runtime;
}
/** Asking for server mode without a runtime must fail closed, never fall back to local data. */
export function serverModeRequested() {
  return process.env.VENTUREPASS_MODE === "server" || runtime !== null;
}
export function runInRequestScope<T>(value: RequestScope, run: () => T): T {
  return scope.run(value, run);
}
export function currentRequestScope() {
  return scope.getStore() ?? null;
}
