import { afterEach, describe, it, expect, vi } from "vitest";
import {
  PublicEvidenceJournal,
  PublicEvidenceRecoveryError,
  publicEvidenceRecoveryMessage,
  publicEvidenceBrowserLock,
} from "./public-evidence-recovery";
import { emptyPublicEvidence, preparePublicEvidence } from "@/lib/studio-public-evidence";
import { recoveryCompany, save } from "../../../scripts/fixtures/guided-public-recovery";

function setup() {
  const company = recoveryCompany();
  const request = preparePublicEvidence(
    company,
    {
      ...emptyPublicEvidence,
      title: "Synthetic title",
      url: "https://example.invalid/private-path",
      quote: "Do not persist this evidence body",
      readOn: "2026-10-10",
    },
    "d0000000-0000-4000-8000-000000000001",
    "2026-10-10T01:00:00.000Z",
    true,
  );
  const data = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
  let held = false;
  const lock = async <T>(_name: string, task: () => Promise<T>) => {
    if (held) throw Error("busy");
    held = true;
    try {
      return await task();
    } finally {
      held = false;
    }
  };
  let response: unknown = company;
  const transport = vi.fn(async () => response);
  const journal = () => new PublicEvidenceJournal(company.id, storage, lock, transport);
  const current = () => company;
  const acknowledged = save(company, request.command);
  const pending = async () => {
    await expect(journal().save(request, current, () => {})).rejects.toThrow();
    return (await journal().read())!;
  };
  return {
    company,
    request,
    data,
    storage,
    lock,
    transport,
    journal,
    current,
    acknowledged,
    pending,
    response: (value: unknown) => {
      response = value;
    },
  };
}
describe("public evidence reload recovery", () => {
  it("restores minimal identity in a fresh journal, reads exact evidence once and never resends", async () => {
    const s = setup(),
      original = await s.pending();
    const stored = s.data.get(s.journal().key)!;
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual([
      "caseId",
      "digest",
      "format",
      "revision",
      "sectionKey",
      "sourceId",
    ]);
    for (const forbidden of [
      s.request.command.source.text,
      "Synthetic title",
      "example.invalid",
      "Do not persist",
    ])
      expect(stored).not.toContain(forbidden);
    expect(await s.journal().read()).toEqual(original);
    const readsBefore = s.transport.mock.calls.length;
    s.response(s.acknowledged);
    expect((await s.journal().recover(original, s.current)).request.command.source.text).toBe(
      s.request.command.source.text,
    );
    expect(s.transport.mock.calls.length).toBe(readsBefore + 1);
    expect(s.transport.mock.calls.at(-1)).toEqual([]);
    expect(await s.journal().read()).toBeNull();
  });
  it.each([
    "old revision",
    "other company",
    "different text",
    "different name",
    "duplicate ID",
    "newer current",
  ])("keeps the original pending request for %s", async (kind) => {
    const s = setup(),
      original = await s.pending(),
      raw = structuredClone(s.acknowledged);
    if (kind === "old revision") raw.revision = s.company.revision;
    if (kind === "other company") raw.id = "e0000000-0000-4000-8000-000000000001";
    if (kind === "different text") raw.sources[0].text += " changed";
    if (kind === "different name") raw.sources[0].name += " changed";
    if (kind === "duplicate ID") raw.sources.push(raw.sources[0]);
    s.response(raw);
    const current = () =>
      kind === "newer current" ? { ...s.company, revision: raw.revision + 1 } : s.company;
    await expect(s.journal().recover(original, current)).rejects.toThrow();
    expect(await s.journal().read()).toEqual(original);
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["read", "write", "readback"])(
    "sends nothing if browser persistence fails at %s",
    async (kind) => {
      const s = setup();
      if (kind === "read")
        s.storage.getItem.mockImplementation(() => {
          throw Error("denied");
        });
      if (kind === "write")
        s.storage.setItem.mockImplementation(() => {
          throw Error("quota");
        });
      if (kind === "readback") s.storage.setItem.mockImplementation(() => {});
      await expect(s.journal().save(s.request, s.current, () => {})).rejects.toThrow();
      expect(s.transport).not.toHaveBeenCalled();
    },
  );
  it("retains identity when removing an acknowledged request fails", async () => {
    const s = setup(),
      original = await s.pending();
    s.response(s.acknowledged);
    s.storage.removeItem.mockImplementationOnce(() => {
      throw Error("denied");
    });
    await expect(s.journal().recover(original, s.current)).rejects.toThrow();
    expect(await s.journal().read()).toEqual(original);
    await s.journal().recover(original, s.current);
    expect(await s.journal().read()).toBeNull();
  });
  it.each(["other company", "extra body", "oversized", "digest", "revision", "section"])(
    "rejects a damaged or replaced browser record: %s",
    async (kind) => {
      const s = setup(),
        original = await s.pending(),
        key = s.journal().key;
      const changed: Record<string, unknown> = { ...original };
      if (kind === "other company") changed.caseId = "e0000000-0000-4000-8000-000000000001";
      if (kind === "extra body") changed.text = "must not be stored";
      if (kind === "digest") changed.digest = "0".repeat(64);
      if (kind === "revision") changed.revision = original.revision - 1;
      if (kind === "section") changed.sectionKey = "problem";
      s.data.set(key, kind === "oversized" ? "x".repeat(1025) : JSON.stringify(changed));
      const before = s.transport.mock.calls.length;
      await expect(s.journal().recover(original, s.current)).rejects.toThrow();
      expect(s.transport.mock.calls.length).toBe(before);
      if (["digest", "revision", "section"].includes(kind)) {
        s.response(s.acknowledged);
        await expect(s.journal().recover((await s.journal().read())!, s.current)).rejects.toThrow();
      } else await expect(s.journal().read()).rejects.toThrow();
      expect(s.storage.removeItem).not.toHaveBeenCalled();
    },
  );
  it("blocks another tab during the first send and after an uncertain response", async () => {
    const s = setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.transport.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return s.company;
    });
    const first = s
      .journal()
      .save(s.request, s.current, () => {})
      .catch(() => {});
    await started;
    const duringWrite = await Promise.all([s.journal().read(), s.journal().read()]);
    expect(duringWrite[0]).toEqual(duringWrite[1]);
    expect(duringWrite[0]?.sourceId).toBe(s.request.command.source.id);
    await expect(s.journal().save(s.request, s.current, () => {})).rejects.toThrow();
    release();
    await first;
    const count = s.transport.mock.calls.length;
    await expect(s.journal().save(s.request, s.current, () => {})).rejects.toThrow();
    expect(s.transport.mock.calls.length).toBe(count);
  });
  it("does not remove a newer record or accept a company switch during response hashing", async () => {
    const s = setup(),
      original = await s.pending();
    s.transport.mockImplementationOnce(async () => {
      s.data.set(s.journal().key, JSON.stringify({ ...original, digest: "0".repeat(64) }));
      return s.acknowledged;
    });
    await expect(s.journal().recover(original, s.current)).rejects.toThrow();
    expect(s.storage.removeItem).not.toHaveBeenCalled();
    s.data.set(s.journal().key, JSON.stringify(original));
    s.response(s.acknowledged);
    await expect(
      s
        .journal()
        .recover(original, () => ({ id: "e0000000-0000-4000-8000-000000000001", revision: 0 })),
    ).rejects.toThrow();
    expect(await s.journal().read()).toEqual(original);
  });
});

// Error boundaries: unknown server/schema details must never become product instructions.
describe("public evidence recovery messages", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([null, { error: "PRIVATE_SERVER_FIELD" }, { revision: "PRIVATE_REVISION" }])(
    "keeps an invalid response pending and hides schema details: %j",
    async (response) => {
      const s = setup(),
        original = await s.pending();
      s.response(response);
      const error = await s
        .journal()
        .recover(original, s.current)
        .catch((error: unknown) => error);
      expect(publicEvidenceRecoveryMessage(error)).toContain(
        "저장 여부를 아직 확인하지 못했습니다",
      );
      expect(publicEvidenceRecoveryMessage(error)).not.toMatch(
        /PRIVATE|invalid_type|revision|expected/,
      );
      expect(await s.journal().read()).toEqual(original);
      expect(s.storage.removeItem).not.toHaveBeenCalled();
    },
  );
  it("does not trust server exception text or a forged local failure code", async () => {
    const s = setup(),
      original = await s.pending();
    s.transport.mockRejectedValueOnce(
      Object.assign(Error("PRIVATE_SERVER_TRACE"), { reason: "busy" }),
    );
    const error = await s
      .journal()
      .recover(original, s.current)
      .catch((error: unknown) => error);
    expect(publicEvidenceRecoveryMessage(error)).toContain("저장 여부를 아직 확인하지 못했습니다");
    expect(publicEvidenceRecoveryMessage(error)).not.toContain("PRIVATE_SERVER_TRACE");
    expect(await s.journal().read()).toEqual(original);
  });
  it("classifies browser storage failure at its source and keeps the pending record", async () => {
    const s = setup(),
      original = await s.pending();
    s.storage.getItem.mockImplementationOnce(() => {
      throw Error("PRIVATE_STORAGE_PATH");
    });
    const before = s.transport.mock.calls.length;
    const error = await s
      .journal()
      .recover(original, s.current)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PublicEvidenceRecoveryError);
    expect(publicEvidenceRecoveryMessage(error)).toContain(
      "브라우저에서 복구 기록을 읽거나 보관하지 못했습니다",
    );
    expect(publicEvidenceRecoveryMessage(error)).not.toContain("PRIVATE_STORAGE_PATH");
    expect(s.transport.mock.calls.length).toBe(before);
    expect(await s.journal().read()).toEqual(original);
  });
  it("distinguishes unavailable and occupied browser locks without starting a task", async () => {
    const task = vi.fn(async () => true);
    vi.stubGlobal("navigator", {});
    const unavailable = await publicEvidenceBrowserLock("synthetic", task).catch((e: unknown) => e);
    expect(publicEvidenceRecoveryMessage(unavailable)).toContain(
      "이 브라우저에서는 저장 요청을 안전하게 구분할 수 없습니다",
    );
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) =>
          callback(null),
      },
    });
    const busy = await publicEvidenceBrowserLock("synthetic", task).catch((e: unknown) => e);
    expect(publicEvidenceRecoveryMessage(busy)).toContain(
      "다른 창에서 이 회사의 공개 근거 저장을 확인 중입니다",
    );
    expect(task).not.toHaveBeenCalled();
  });
});

describe("public evidence cross-tab completion", () => {
  it("lets the remaining tab confirm exact evidence after another tab has removed the receipt", async () => {
    const s = setup(),
      original = await s.pending();
    const other = s.journal();
    const otherReceipt = (await other.read())!;
    s.response(s.acknowledged);
    const before = s.transport.mock.calls.length;
    await other.recover(otherReceipt, s.current);
    expect(await s.journal().read()).toBeNull();
    const result = await s.journal().recover(original, s.current);
    expect(result.request.command.source.text).toBe(s.request.command.source.text);
    expect(result.company.plans).toEqual(s.acknowledged.plans);
    expect(s.transport.mock.calls.slice(before)).toEqual([[], []]);
    expect(s.storage.removeItem).toHaveBeenCalledTimes(1);
    expect(s.storage.setItem).toHaveBeenCalledTimes(1);
  });
  it.each([
    "old revision",
    "other company",
    "different text",
    "duplicate ID",
    "missing ID",
    "newer current",
    "switched current",
  ])("does not infer success from an absent receipt: %s", async (kind) => {
    const s = setup(),
      original = await s.pending();
    s.data.delete(s.journal().key);
    const raw = structuredClone(s.acknowledged);
    if (kind === "old revision") raw.revision = s.company.revision;
    if (kind === "other company") raw.id = "e0000000-0000-4000-8000-000000000001";
    if (kind === "different text") raw.sources[0].text += " changed";
    if (kind === "duplicate ID") raw.sources.push(raw.sources[0]);
    if (kind === "missing ID") raw.sources = [];
    s.response(raw);
    const current = () =>
      kind === "newer current"
        ? { ...s.company, revision: raw.revision + 1 }
        : kind === "switched current"
          ? { ...s.company, id: "e0000000-0000-4000-8000-000000000001" }
          : s.company;
    const before = s.transport.mock.calls.length;
    await expect(s.journal().recover(original, current)).rejects.toThrow();
    expect(s.transport.mock.calls.slice(before)).toEqual([[]]);
    expect(s.storage.removeItem).not.toHaveBeenCalled();
    expect(await s.journal().read()).toBeNull();
  });
  it("preserves a new receipt that appears while the remaining tab is reading its result", async () => {
    const s = setup(),
      original = await s.pending();
    const key = s.journal().key;
    s.data.delete(key);
    const replacement = {
      ...original,
      sourceId: "d0000000-0000-4000-8000-000000000099",
      digest: "0".repeat(64),
    };
    s.transport.mockImplementationOnce(async () => {
      s.data.set(key, JSON.stringify(replacement));
      return s.acknowledged;
    });
    await expect(s.journal().recover(original, s.current)).rejects.toThrow();
    expect(await s.journal().read()).toEqual(replacement);
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it("still rejects a receipt disappearing during a lookup that began with it present", async () => {
    const s = setup(),
      original = await s.pending();
    s.transport.mockImplementationOnce(async () => {
      s.data.delete(s.journal().key);
      return s.acknowledged;
    });
    await expect(s.journal().recover(original, s.current)).rejects.toThrow();
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
});

describe("public evidence explicit draft refresh", () => {
  it("reads the latest company without writing or acknowledging any receipt", async () => {
    const s = setup();
    s.response(s.acknowledged);
    expect(await s.journal().refresh(s.current)).toEqual(s.acknowledged);
    expect(s.transport.mock.calls).toEqual([[]]);
    expect(s.storage.setItem).not.toHaveBeenCalled();
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["malformed", "other company", "old revision"])(
    "rejects %s without changing browser records",
    async (kind) => {
      const s = setup();
      const raw = structuredClone(s.acknowledged);
      if (kind === "other company") raw.id = "e0000000-0000-4000-8000-000000000001";
      if (kind === "old revision") raw.revision = s.company.revision;
      s.response(kind === "malformed" ? { revision: "PRIVATE_FIELD" } : raw);
      await expect(s.journal().refresh(() => s.acknowledged)).rejects.toMatchObject({
        reason: "refresh",
      });
      expect(s.transport.mock.calls).toEqual([[]]);
      expect(s.data.size).toBe(0);
      expect(s.storage.removeItem).not.toHaveBeenCalled();
    },
  );
  it("does not read a server response while an unresolved receipt exists", async () => {
    const s = setup(),
      pending = await s.pending();
    s.transport.mockClear();
    await expect(s.journal().refresh(s.current)).rejects.toMatchObject({ reason: "refresh" });
    expect(s.transport).not.toHaveBeenCalled();
    expect(await s.journal().read()).toEqual(pending);
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it("retains a receipt arriving during the GET and rejects resuming", async () => {
    const s = setup(),
      pending = await s.pending();
    s.data.clear();
    s.transport.mockClear();
    s.transport.mockImplementationOnce(async () => {
      s.data.set(s.journal().key, JSON.stringify(pending));
      return s.acknowledged;
    });
    await expect(s.journal().refresh(s.current)).rejects.toMatchObject({ reason: "refresh" });
    expect(s.transport.mock.calls).toEqual([[]]);
    expect(await s.journal().read()).toEqual(pending);
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it.each(["newer current", "switched current", "older current"])(
    "rechecks the current company after GET: %s",
    async (kind) => {
      const s = setup();
      let current = { id: s.company.id, revision: s.acknowledged.revision };
      s.transport.mockImplementationOnce(async () => {
        if (kind === "newer current") current = { ...current, revision: current.revision + 1 };
        if (kind === "switched current")
          current = { ...current, id: "e0000000-0000-4000-8000-000000000001" };
        if (kind === "older current") current = { ...current, revision: s.company.revision };
        return kind === "older current" ? s.company : s.acknowledged;
      });
      await expect(s.journal().refresh(() => current)).rejects.toMatchObject({ reason: "refresh" });
      expect(s.data.size).toBe(0);
    },
  );
  it.each(["before", "after"])("fails closed if browser reading fails %s GET", async (when) => {
    const s = setup();
    const deny = () => {
      throw Error("PRIVATE_STORAGE_PATH");
    };
    if (when === "before") s.storage.getItem.mockImplementation(deny);
    else
      s.transport.mockImplementationOnce(async () => {
        s.storage.getItem.mockImplementation(deny);
        return s.acknowledged;
      });
    await expect(s.journal().refresh(s.current)).rejects.toMatchObject({ reason: "storage" });
    expect(s.transport.mock.calls.length).toBe(when === "before" ? 0 : 1);
    expect(s.storage.setItem).not.toHaveBeenCalled();
    expect(s.storage.removeItem).not.toHaveBeenCalled();
  });
  it("keeps the company lock across GET and rejects a concurrent refresh", async () => {
    const s = setup();
    let finish!: (value: unknown) => void;
    s.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = s.journal().refresh(s.current);
    await expect(s.journal().refresh(s.current)).rejects.toThrow("busy");
    expect(s.transport).toHaveBeenCalledTimes(1);
    finish(s.acknowledged);
    expect(await first).toEqual(s.acknowledged);
    expect(s.data.size).toBe(0);
  });
  it("does not query when the current company already differs", async () => {
    const s = setup();
    await expect(
      s.journal().refresh(() => ({ id: "e0000000-0000-4000-8000-000000000001", revision: 0 })),
    ).rejects.toMatchObject({ reason: "refresh" });
    expect(s.transport).not.toHaveBeenCalled();
  });
  it("shows a safe draft-refresh message without trusting a remote reason or message", () => {
    const value = publicEvidenceRecoveryMessage(
      Object.assign(Error("PRIVATE_HTTP_TRACE"), { reason: "busy" }),
      "refresh",
    );
    expect(value).toContain("최신 회사 자료를 확인하지 못했습니다.");
    expect(value).not.toContain("PRIVATE_");
    expect(value).toBe(publicEvidenceRecoveryMessage(new PublicEvidenceRecoveryError("refresh")));
  });
});
