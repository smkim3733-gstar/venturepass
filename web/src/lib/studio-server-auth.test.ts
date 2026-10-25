import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureVenturePassSchema, type SqlExecutor } from "./studio-postgres-repository";
import {
  accessTokenFrom,
  createPrincipalResolver,
  sessionCookieName,
  type VerifiedIdentity,
} from "./studio-server-auth";

let database: PGlite;
let executor: SqlExecutor;
const organizationId = randomUUID();
const activeUser = randomUUID();
const pendingUser = randomUUID();
const disabledUser = randomUUID();
const tokens: Record<string, VerifiedIdentity> = {};
const token = (name: string) => `${name}-${"x".repeat(24)}`;

beforeEach(async () => {
  database = new PGlite();
  executor = {
    query: async (text, params) => {
      const result = await database.query(text, params);
      return { rows: result.rows as never[], affectedRows: result.affectedRows ?? 0 };
    },
  };
  await ensureVenturePassSchema(executor);
  await executor.query("INSERT INTO venture_organizations (id, name) VALUES ($1, $2)", [
    organizationId,
    "가상 조직",
  ]);
  for (const [userId, status, email] of [
    [activeUser, "active", "active@example.test"],
    [pendingUser, "pending", "pending@example.test"],
    [disabledUser, "disabled", "disabled@example.test"],
  ])
    await executor.query(
      "INSERT INTO venture_memberships (user_id, organization_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'editor', $5)",
      [userId, organizationId, email, "가상 담당자", status],
    );
  tokens[token("active")] = { userId: activeUser, email: "Active@Example.test" };
  tokens[token("pending")] = { userId: pendingUser, email: "pending@example.test" };
  tokens[token("disabled")] = { userId: disabledUser, email: "disabled@example.test" };
  tokens[token("stranger")] = { userId: randomUUID(), email: "stranger@example.test" };
  tokens[token("moved")] = { userId: activeUser, email: "other@example.test" };
});
afterEach(async () => {
  await database.close();
});

const resolver = () => createPrincipalResolver(executor, async (value) => tokens[value] ?? null);
const withCookie = (value: string) =>
  new Request("https://venturepass.test/api/studio/cases", {
    headers: { cookie: `other=1; ${sessionCookieName}=${encodeURIComponent(value)}` },
  });

describe("server login to staff principal", () => {
  it("maps an active member to its organization and role", async () => {
    expect(await resolver()(withCookie(token("active")))).toEqual({
      userId: activeUser,
      organizationId,
      role: "editor",
      displayName: "가상 담당자",
    });
  });

  it.each(["pending", "disabled", "stranger", "moved", "forged"])(
    "denies %s accounts instead of assigning any organization",
    async (name) => {
      expect(await resolver()(withCookie(token(name)))).toBeNull();
    },
  );

  it("accepts a bearer token and ignores malformed credentials", async () => {
    const bearer = new Request("https://venturepass.test/x", {
      headers: { authorization: `Bearer ${token("active")}` },
    });
    expect((await resolver()(bearer))?.userId).toBe(activeUser);
    expect(accessTokenFrom(new Request("https://venturepass.test/x"))).toBeNull();
    expect(
      accessTokenFrom(
        new Request("https://venturepass.test/x", { headers: { authorization: "Basic abc" } }),
      ),
    ).toBeNull();
    expect(accessTokenFrom(withCookie("short"))).toBeNull();
  });
});
