import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCaseInRepository,
  listCasesInRepository,
  MemoryCaseRowRepository,
  runCaseSession,
} from "./studio-case-session";
import { emptyProfile } from "./studio-schema";
import { StudioStore } from "./studio-storage";

const review = () => [];
const profile = { ...emptyProfile(), companyName: "합성 세션 회사" };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("server case session over a row repository", () => {
  it("applies the unchanged store logic and saves the new revision with CAS", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    const result = await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(
        created.id,
        {
          action: "profile",
          revision: 0,
          profile: { ...profile, technologySummary: "합성 기술 설명" },
        },
        review,
      ),
    );
    expect(result.revision).toBe(1);
    const saved = await repository.load(created.id);
    expect(saved.revision).toBe(1);
    expect(JSON.parse(saved.body).profile.technologySummary).toBe("합성 기술 설명");
  });

  it("matches what the local SQLite store stores for the same mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "venturepass-session-local-"));
    directories.push(directory);
    const local = new StudioStore(directory);
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    local.importCaseRow(await repository.load(created.id));
    const mutation = {
      action: "profile" as const,
      revision: 0,
      profile: { ...profile, technologySummary: "같은 변경" },
    };
    const fromLocal = local.mutate(created.id, mutation, review);
    const fromSession = await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(created.id, mutation, review),
    );
    local.close();
    const strip = (value: object) => ({ ...value, updatedAt: "", preparationAutomation: null });
    expect(strip(fromSession)).toEqual(strip(fromLocal));
  });

  it("rejects the second of two concurrent writers instead of losing the first update", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = runCaseSession(repository, created.id, async ({ store }) => {
      await gate;
      return store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...profile, industry: "첫 번째" } },
        review,
      );
    });
    await runCaseSession(repository, created.id, ({ store }) =>
      store.mutate(
        created.id,
        { action: "profile", revision: 0, profile: { ...profile, industry: "두 번째" } },
        review,
      ),
    );
    release();
    await expect(first).rejects.toMatchObject({ status: 409, code: "STALE_REVISION" });
    expect(JSON.parse((await repository.load(created.id)).body).profile.industry).toBe("두 번째");
  });

  it("keeps a checkpoint durable when later work fails", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    await expect(
      runCaseSession(repository, created.id, async ({ store, checkpoint }) => {
        store.mutate(
          created.id,
          { action: "profile", revision: 0, profile: { ...profile, industry: "저장된 단계" } },
          review,
        );
        await checkpoint();
        throw new Error("synthetic external failure");
      }),
    ).rejects.toThrow("synthetic external failure");
    const saved = await repository.load(created.id);
    expect(saved.revision).toBe(1);
    expect(JSON.parse(saved.body).profile.industry).toBe("저장된 단계");
  });

  it("does not write when the session only reads", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    const swap = vi.spyOn(repository, "compareAndSwap");
    const read = await runCaseSession(repository, created.id, ({ store }) => store.get(created.id));
    expect(read.profile.companyName).toBe("합성 세션 회사");
    expect(swap).not.toHaveBeenCalled();
  });

  it("removes the row only at the revision the session deleted", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    await runCaseSession(repository, created.id, ({ store }) => store.delete(created.id, 0));
    await expect(repository.load(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("lists summaries with the same refresh rules as the local list", async () => {
    const repository = new MemoryCaseRowRepository();
    await createCaseInRepository(repository, { ...profile, companyName: "합성 A" });
    await createCaseInRepository(repository, { ...profile, companyName: "합성 B" });
    const names = (await listCasesInRepository(repository)).map((item) => item.companyName);
    expect(names.sort()).toEqual(["합성 A", "합성 B"]);
  });

  it("refuses a row whose columns disagree with its body", async () => {
    const repository = new MemoryCaseRowRepository();
    const created = await createCaseInRepository(repository, profile);
    const row = await repository.load(created.id);
    await repository.compareAndSwap(0, { ...row, revision: 5 });
    await expect(
      runCaseSession(repository, created.id, ({ store }) => store.get(created.id)),
    ).rejects.toMatchObject({ code: "CASE_ROW_INVALID" });
  });
});
