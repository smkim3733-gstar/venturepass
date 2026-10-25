import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as addRoute } from "@/app/api/studio/members/route";
import { PATCH as updateRoute } from "@/app/api/studio/members/[userId]/route";
import { POST as passwordRoute } from "@/app/api/studio/members/[userId]/password/route";
import type { StaffAccounts } from "./studio-members";
import { ensureVenturePassSchema, type SqlExecutor } from "./studio-postgres-repository";
import { configureServerRuntime } from "./studio-request-scope";
import type { VerifiedIdentity } from "./studio-server-auth";
import { createServerRuntime } from "./studio-server-bootstrap";

vi.mock("server-only", () => ({}));

const origin = "https://venturepass.test";
const orgA = randomUUID();
const orgB = randomUUID();
const people = {
  admin: { userId: randomUUID(), org: orgA, role: "admin", name: "가상 관리자" },
  editor: { userId: randomUUID(), org: orgA, role: "editor", name: "가상 작성자" },
  other: { userId: randomUUID(), org: orgB, role: "admin", name: "가상 B 관리자" },
} as const;
type Person = keyof typeof people;
const email = (person: Person) => `${person}@venturepass.test`;
const token = (person: Person) => `${person}-${"t".repeat(24)}`;

let database: PGlite;
let executor: SqlExecutor;
let accounts: StaffAccounts & { created: string[]; passwords: Map<string, string> };

function request(path: string, person: Person | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (person) headers.set("authorization", `Bearer ${token(person)}`);
  if (init.method && init.method !== "GET") headers.set("origin", origin);
  return new Request(`${origin}${path}`, { ...init, headers });
}
const send = (method: string, body: unknown) => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const target = (userId: string) => ({ params: Promise.resolve({ userId }) });
const newMember = {
  email: "New.Staff@venturepass.test",
  displayName: "가상 새 담당",
  role: "viewer",
  password: "temporary-pass-1",
};

beforeEach(async () => {
  database = new PGlite();
  executor = {
    query: async (text, params) => {
      const result = await database.query(text, params);
      return { rows: result.rows as never[], affectedRows: result.affectedRows ?? 0 };
    },
  };
  await ensureVenturePassSchema(executor);
  for (const id of [orgA, orgB])
    await executor.query("INSERT INTO venture_organizations (id, name) VALUES ($1, $2)", [
      id,
      "가상 조직",
    ]);
  for (const [key, person] of Object.entries(people))
    await executor.query(
      `INSERT INTO venture_memberships (user_id, organization_id, email, display_name, role, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [person.userId, person.org, email(key as Person), person.name, person.role],
    );
  accounts = {
    created: [],
    passwords: new Map(),
    async create() {
      const id = randomUUID();
      accounts.created.push(id);
      return id;
    },
    async setPassword(userId, password) {
      accounts.passwords.set(userId, password);
    },
    async remove(userId) {
      accounts.created = accounts.created.filter((id) => id !== userId);
    },
  };
  const verify = async (value: string): Promise<VerifiedIdentity | null> => {
    const person = (Object.keys(people) as Person[]).find((key) => token(key) === value);
    return person ? { userId: people[person].userId, email: email(person) } : null;
  };
  configureServerRuntime(createServerRuntime(origin, executor, verify, undefined, accounts));
});
afterEach(async () => {
  configureServerRuntime(null);
  await database.close();
});

describe("staff management on the web service", () => {
  it("lists only the admin's own organization and marks the caller", async () => {
    const response = await listRoute(request("/api/studio/members", "admin"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.selfUserId).toBe(people.admin.userId);
    expect(body.members.map((member: { email: string }) => member.email).sort()).toEqual([
      email("admin"),
      email("editor"),
    ]);
  });

  it("keeps non-admins and signed-out visitors out", async () => {
    expect((await listRoute(request("/api/studio/members", "editor"))).status).toBe(403);
    expect((await listRoute(request("/api/studio/members", null))).status).toBe(401);
    const add = await addRoute(request("/api/studio/members", "editor", send("POST", newMember)));
    expect(add.status).toBe(403);
    expect(accounts.created).toHaveLength(0);
  });

  it("adds an active member with a new login account and lets them sign in", async () => {
    const response = await addRoute(
      request("/api/studio/members", "admin", send("POST", newMember)),
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      email: "new.staff@venturepass.test",
      role: "viewer",
      status: "active",
    });
    expect(accounts.created).toEqual([created.userId]);
    const { rows } = await executor.query<{ organization_id: string }>(
      "SELECT organization_id FROM venture_memberships WHERE user_id = $1",
      [created.userId],
    );
    expect(rows[0].organization_id).toBe(orgA);
  });

  it("rejects a short password before creating any account", async () => {
    const response = await addRoute(
      request("/api/studio/members", "admin", send("POST", { ...newMember, password: "short" })),
    );
    expect(response.status).toBe(400);
    expect(accounts.created).toHaveLength(0);
  });

  it("removes the new account again when the membership cannot be saved", async () => {
    const runtime = createServerRuntime(
      origin,
      {
        query: async (text, params) => {
          if (text.includes("INSERT INTO venture_memberships")) throw new Error("insert failed");
          return executor.query(text, params);
        },
      },
      async (value) =>
        value === token("admin") ? { userId: people.admin.userId, email: email("admin") } : null,
      undefined,
      accounts,
    );
    configureServerRuntime(runtime);
    const response = await addRoute(
      request("/api/studio/members", "admin", send("POST", newMember)),
    );
    expect(response.status).toBe(500);
    expect(accounts.created).toHaveLength(0);
  });

  it("changes another member's role and status, and disabling blocks their next request", async () => {
    const response = await updateRoute(
      request(
        `/api/studio/members/${people.editor.userId}`,
        "admin",
        send("PATCH", { status: "disabled" }),
      ),
      target(people.editor.userId),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("disabled");
    expect((await listRoute(request("/api/studio/members", "editor"))).status).toBe(401);
    const promoted = await updateRoute(
      request(
        `/api/studio/members/${people.editor.userId}`,
        "admin",
        send("PATCH", { role: "admin", status: "active" }),
      ),
      target(people.editor.userId),
    );
    expect((await promoted.json()).role).toBe("admin");
  });

  it("never lets an admin demote or disable themself", async () => {
    const response = await updateRoute(
      request(
        `/api/studio/members/${people.admin.userId}`,
        "admin",
        send("PATCH", { role: "editor" }),
      ),
      target(people.admin.userId),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("SELF_CHANGE");
    const renamed = await updateRoute(
      request(
        `/api/studio/members/${people.admin.userId}`,
        "admin",
        send("PATCH", { displayName: "가상 대표" }),
      ),
      target(people.admin.userId),
    );
    expect((await renamed.json()).displayName).toBe("가상 대표");
  });

  it("treats members of another organization as absent", async () => {
    const update = await updateRoute(
      request(
        `/api/studio/members/${people.other.userId}`,
        "admin",
        send("PATCH", { status: "disabled" }),
      ),
      target(people.other.userId),
    );
    expect(update.status).toBe(404);
    const reset = await passwordRoute(
      request(
        `/api/studio/members/${people.other.userId}/password`,
        "admin",
        send("POST", { password: "another-pass-1" }),
      ),
      target(people.other.userId),
    );
    expect(reset.status).toBe(404);
    expect(accounts.passwords.size).toBe(0);
  });

  it("sets a new password for a member of the same organization", async () => {
    const response = await passwordRoute(
      request(
        `/api/studio/members/${people.editor.userId}/password`,
        "admin",
        send("POST", { password: "another-pass-1" }),
      ),
      target(people.editor.userId),
    );
    expect(response.status).toBe(200);
    expect(accounts.passwords.get(people.editor.userId)).toBe("another-pass-1");
  });

  it("answers 503 for adding staff when no account service is configured", async () => {
    configureServerRuntime(
      createServerRuntime(origin, executor, async (value) =>
        value === token("admin") ? { userId: people.admin.userId, email: email("admin") } : null,
      ),
    );
    const response = await addRoute(
      request("/api/studio/members", "admin", send("POST", newMember)),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ACCOUNTS_NOT_CONFIGURED");
  });
});

describe("staff management in the local PC app", () => {
  it("is not available without the web service", async () => {
    configureServerRuntime(null);
    const response = await listRoute(new Request("http://localhost:3000/api/studio/members"));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("SERVER_ONLY");
  });
});
