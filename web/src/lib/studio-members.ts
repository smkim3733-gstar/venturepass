import { z } from "zod";
import { jsonResponse, StudioError } from "./studio-http";
import type { SqlExecutor } from "./studio-postgres-repository";
import { currentRequestScope, type StudioPrincipal } from "./studio-request-scope";

export type StudioMember = {
  userId: string;
  email: string;
  displayName: string;
  role: StudioPrincipal["role"];
  status: "pending" | "active" | "disabled";
  createdAt: string;
};

/**
 * Login accounts at the identity provider (Supabase Auth admin API in production).
 * Needs the server-only service role key; without it staff can be listed and changed, not added.
 */
export interface StaffAccounts {
  /** Creates a confirmed account and returns its user id; an existing email throws 409. */
  create(email: string, password: string): Promise<string>;
  setPassword(userId: string, password: string): Promise<void>;
  /** Rollback only: removes an account created a moment ago whose membership was not saved. */
  remove(userId: string): Promise<void>;
}

const role = z.enum(["admin", "editor", "viewer"]);
const status = z.enum(["pending", "active", "disabled"]);
const displayName = z.string().trim().min(1, "이름을 입력해 주세요.").max(100);
/** Same rule for a first password, an admin reset and a member's own change. */
export const staffPassword = z
  .string()
  .min(10, "비밀번호는 10자 이상으로 정해 주세요.")
  .max(72, "비밀번호는 72자 이하로 정해 주세요.");
const addSchema = z
  .object({
    email: z.string().trim().toLowerCase().email("이메일 형식을 확인해 주세요.").max(320),
    displayName,
    role,
    password: staffPassword,
  })
  .strict();
const updateSchema = z
  .object({ displayName: displayName.optional(), role: role.optional(), status: status.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "바꿀 내용을 골라 주세요.");
const passwordSchema = z.object({ password: staffPassword }).strict();

type Row = {
  user_id: string;
  email: string;
  display_name: string;
  role: StudioMember["role"];
  status: StudioMember["status"];
  created_at: string | Date;
};
const columns = "user_id, email, display_name, role, status, created_at";
const toMember = (row: Row): StudioMember => ({
  userId: row.user_id,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  status: row.status,
  createdAt: new Date(row.created_at).toISOString(),
});
const notFound = () => new StudioError("담당자를 찾지 못했습니다.", 404, "MEMBER_NOT_FOUND");

/** Every query is scoped to the acting admin's organization; other organizations look absent. */
export class MemberDirectory {
  constructor(
    private executor: SqlExecutor,
    private accounts: StaffAccounts | null,
  ) {}

  async list(organizationId: string) {
    const { rows } = await this.executor.query<Row>(
      `SELECT ${columns} FROM venture_memberships WHERE organization_id = $1 ORDER BY created_at, email`,
      [organizationId],
    );
    return rows.map(toMember);
  }

  async add(organizationId: string, raw: unknown) {
    const input = addSchema.parse(raw);
    const accounts = this.requireAccounts();
    const userId = await accounts.create(input.email, input.password);
    try {
      const { rows } = await this.executor.query<Row>(
        `INSERT INTO venture_memberships (user_id, organization_id, email, display_name, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active') RETURNING ${columns}`,
        [userId, organizationId, input.email, input.displayName, input.role],
      );
      return toMember(rows[0]);
    } catch (error) {
      await accounts.remove(userId).catch(() => {});
      throw error;
    }
  }

  async update(actor: StudioPrincipal, userId: string, raw: unknown) {
    const patch = updateSchema.parse(raw);
    // An admin never demotes or disables themself, so the organization always keeps one admin.
    if (userId === actor.userId && (patch.role || patch.status))
      throw new StudioError(
        "본인의 역할과 사용 상태는 바꿀 수 없습니다. 다른 관리자에게 요청해 주세요.",
        409,
        "SELF_CHANGE",
      );
    const { rows } = await this.executor.query<Row>(
      `UPDATE venture_memberships
          SET display_name = COALESCE($3, display_name),
              role = COALESCE($4, role),
              status = COALESCE($5, status),
              updated_at = now()
        WHERE organization_id = $1 AND user_id = $2
        RETURNING ${columns}`,
      [
        actor.organizationId,
        userId,
        patch.displayName ?? null,
        patch.role ?? null,
        patch.status ?? null,
      ],
    );
    if (!rows[0]) throw notFound();
    return toMember(rows[0]);
  }

  async resetPassword(organizationId: string, userId: string, raw: unknown) {
    const input = passwordSchema.parse(raw);
    const accounts = this.requireAccounts();
    const { rows } = await this.executor.query<{ user_id: string }>(
      "SELECT user_id FROM venture_memberships WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    if (!rows[0]) throw notFound();
    await accounts.setPassword(userId, input.password);
  }

  private requireAccounts() {
    if (!this.accounts)
      throw new StudioError(
        "담당자 계정을 만들 설정(service role 키)이 없습니다.",
        503,
        "ACCOUNTS_NOT_CONFIGURED",
      );
    return this.accounts;
  }
}

/** Server mode, signed-in admin only. The local PC app has no staff accounts. */
export function adminScope() {
  const scope = currentRequestScope();
  if (!scope) throw new StudioError("이 기능은 웹 서비스에서만 사용합니다.", 404, "SERVER_ONLY");
  if (scope.principal.role !== "admin")
    throw new StudioError("관리자만 담당자를 관리할 수 있습니다.", 403, "ADMIN_REQUIRED");
  if (!scope.members)
    throw new StudioError("담당자 관리가 설정되지 않았습니다.", 503, "MEMBERS_NOT_CONFIGURED");
  return { principal: scope.principal, members: scope.members };
}

export async function listMembers() {
  const { principal, members } = adminScope();
  return jsonResponse({
    members: await members.list(principal.organizationId),
    selfUserId: principal.userId,
  });
}
export async function addMember(raw: unknown) {
  const { principal, members } = adminScope();
  return jsonResponse(await members.add(principal.organizationId, raw), 201);
}
export async function updateMember(userId: string, raw: unknown) {
  const { principal, members } = adminScope();
  return jsonResponse(await members.update(principal, userId, raw));
}
export async function resetMemberPassword(userId: string, raw: unknown) {
  const { principal, members } = adminScope();
  await members.resetPassword(principal.organizationId, userId, raw);
  return jsonResponse({ ok: true });
}
