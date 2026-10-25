import { z } from "zod";
import type { SqlExecutor } from "./studio-postgres-repository";
import type { StudioPrincipal } from "./studio-request-scope";

/** Verified identity from the identity provider (Supabase Auth in production). */
export type VerifiedIdentity = { userId: string; email: string };
/** Must verify the token with the provider; returns null for any invalid or expired token. */
export type AccessTokenVerifier = (token: string) => Promise<VerifiedIdentity | null>;

export const sessionCookieName = "vp_access_token";
const tokenPattern = /^[A-Za-z0-9._-]{20,4096}$/;

/** Bearer header (API clients) or the HttpOnly session cookie set by the login route. */
export function accessTokenFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match && tokenPattern.test(match[1]) ? match[1] : null;
  }
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== sessionCookieName) continue;
    const value = decodeURIComponent(rest.join("="));
    return tokenPattern.test(value) ? value : null;
  }
  return null;
}

type MembershipRow = {
  organization_id: string;
  email: string;
  display_name: string;
  role: StudioPrincipal["role"];
  status: "pending" | "active" | "disabled";
};
const role = z.enum(["admin", "editor", "viewer"]);

/**
 * Turns a request into a principal: provider-verified identity, then the stored membership.
 * Unknown, pending or disabled members get null (401), never a default organization.
 */
export function createPrincipalResolver(executor: SqlExecutor, verify: AccessTokenVerifier) {
  return async (request: Request): Promise<StudioPrincipal | null> => {
    const token = accessTokenFrom(request);
    if (!token) return null;
    const identity = await verify(token);
    if (!identity || !z.string().uuid().safeParse(identity.userId).success) return null;
    const { rows } = await executor.query<MembershipRow>(
      "SELECT organization_id, email, display_name, role, status FROM venture_memberships WHERE user_id = $1",
      [identity.userId],
    );
    const member = rows[0];
    if (!member || member.status !== "active" || !role.safeParse(member.role).success) return null;
    // The membership email is the approved account; a changed provider email needs re-approval.
    if (member.email.toLowerCase() !== identity.email.toLowerCase()) return null;
    return {
      userId: identity.userId,
      organizationId: member.organization_id,
      role: member.role,
      displayName: member.display_name,
    };
  };
}
