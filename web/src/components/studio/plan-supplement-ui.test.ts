import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { supplementFixture } from "@/lib/studio-plan-supplement-test-helpers";
import { StudioStore } from "@/lib/studio-storage";
import { preparePlanSupplement } from "@/lib/studio-plan-supplement";
import { buildPlanSupplementExecutionApproval } from "@/lib/studio-plan-supplement-execution-state";
import { planSupplementResult } from "@/lib/studio-plan-supplement-result";
import {
  preparePlanSupplementAdoption,
  inspectPlanSupplementAdoption,
} from "@/lib/studio-plan-supplement-adoption";
import { planSupplementExecutionCommandSchema } from "@/lib/studio-plan-supplement-execution-types";
import { planSupplementAdoptionCommandSchema } from "@/lib/studio-plan-supplement-adoption-types";
import {
  SupplementRequestJournal,
  SupplementHttpError,
  supplementInput,
  validateSupplementPreview,
  validateSupplementStatus,
  validateSupplementComparison,
  type SupplementLock,
  type SupplementTransport,
  type SupplementStatus,
} from "./plan-supplement-ui";
import { PlanSupplementPanel } from "./plan-supplement-panel";
vi.mock("server-only", () => ({}));
let directory: string, store: StudioStore, f: ReturnType<typeof supplementFixture>;
let memory: Map<string, string>, sends: unknown[], failure: "" | "before" | "after";
let locked: boolean;
const lock: SupplementLock = async (_name, task) => {
  if (locked) throw Error("locked");
  locked = true;
  try {
    return await task();
  } finally {
    locked = false;
  }
};
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
};
const read = () => store.get(f.value.id);
function status(): SupplementStatus {
  const company = read();
  return {
    company,
    active: false,
    retainedCapture: false,
    transmissionAllowed: false,
    executions: (company.planSupplementExecutions ?? []).map((record) => ({
      record,
      ...planSupplementResult(company, record),
    })),
  };
}
function preview() {
  const company = read();
  return {
    ...preparePlanSupplement(company, f.input),
    approval: buildPlanSupplementExecutionApproval(company, f.input, "fixture-model"),
    aiConfigured: true,
  };
}
function command() {
  return planSupplementExecutionCommandSchema.parse({
    action: "propose-section",
    clientRequestId: randomUUID(),
    input: f.input,
    approval: preview().approval,
    approved: true,
  });
}
const transport: SupplementTransport = async (_path, raw) => {
  if (!raw)
    return _path === "execution"
      ? status()
      : {
          caseId: f.value.id,
          revision: read().revision,
          receipts: read().planSupplementAdoptions ?? [],
          databaseChanged: false,
          transmissionAllowed: false,
        };
  sends.push(structuredClone(raw));
  if (failure === "before") throw Error("lost before server");
  if ((raw as { action: string }).action === "propose-section") {
    const cmd = planSupplementExecutionCommandSchema.parse(raw);
    const started = store.beginPlanSupplementExecution(f.value.id, cmd, () => "fixture-model");
    if (started.owner) {
      started.owner.withCurrentWriter(() => undefined);
      started.owner.retain({
        kind: "response",
        rawJson: JSON.stringify({
          id: "synthetic-response",
          model: "fixture-model",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(f.draft) }],
            },
          ],
        }),
      });
      started.owner.persist();
      started.owner.close();
    }
  } else if ((raw as { action: string }).action === "inspect-adoption") {
    return inspectPlanSupplementAdoption(
      read(),
      planSupplementAdoptionCommandSchema.parse((raw as { command: unknown }).command),
    );
  } else
    store.adoptPlanSupplement(f.value.id, planSupplementAdoptionCommandSchema.parse(raw), () => []);
  if (failure === "after") throw Error("response lost");
  return status();
};
const journal = (custom = transport, customStorage = storage) =>
  new SupplementRequestJournal(f.value.id, customStorage, lock, custom);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-supplement-ui-"));
  store = new StudioStore(directory);
  f = supplementFixture();
  const created = store.create(f.value.profile);
  f.value.id = created.id;
  (store as unknown as { db: DatabaseSync }).db
    .prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?")
    .run(f.value.revision, JSON.stringify(f.value), created.id);
  memory = new Map();
  sends = [];
  failure = "";
  locked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("network forbidden");
    }),
  );
});
afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("unsafe fixture path");
  rmSync(directory, { recursive: true, force: true });
});
it("builds the exact selected input from 100 sources and preserves the current company", async () => {
  const before = JSON.stringify(read());
  expect(await supplementInput(read(), 0, "development", [f.value.sources[0].id])).toEqual(f.input);
  expect(JSON.stringify(read())).toBe(before);
  expect(await supplementInput(read(), 100, "development", [f.value.sources[0].id])).toBeNull();
  expect(await supplementInput(read(), 0, "development", [])).toBeNull();
});
it("validates exact preview with no other section/profile/source content", async () => {
  const p = await validateSupplementPreview(preview(), read(), f.input);
  expect(p.payload).not.toContain("EXCLUDED");
  expect(p.payload).not.toContain("PRIVATE_PROFILE");
});
it.each(["payload", "model-binding", "source", "plan", "company", "purpose", "limit"])(
  "rejects changed preview %s",
  async (kind) => {
    const p = preview(),
      c = read();
    if (kind === "payload") p.payload += " ";
    if (kind === "model-binding") p.approval.binding.basePlanSha256 = "a".repeat(64);
    if (kind === "source") c.sources[0].text += "changed";
    if (kind === "plan") c.plans[0].content.summary += "changed";
    if (kind === "company") c.id = randomUUID();
    if (kind === "purpose") Object.assign(p.approval, { purpose: "generate-plan" });
    if (kind === "limit") Object.assign(p, { characterLimit: 999999 });
    await expect(validateSupplementPreview(p, c, f.input)).rejects.toThrow();
  },
);
it("checks status company/revision and complete stored command hash", async () => {
  await journal().execute(command());
  const s = status();
  await expect(validateSupplementStatus(s, randomUUID())).rejects.toThrow();
  await expect(validateSupplementStatus(s, f.value.id, s.company.revision + 1)).rejects.toThrow();
  s.executions[0].record.commandSha256 = "b".repeat(64);
  await expect(validateSupplementStatus(s, f.value.id)).rejects.toThrow();
});
it("keeps an uncertain command and recovers through GET only after reload", async () => {
  failure = "after";
  const cmd = command();
  await expect(journal().execute(cmd)).rejects.toThrow("response lost");
  expect(await journal().pending()).toEqual(cmd);
  const snapshot = JSON.stringify(read());
  failure = "";
  store.close();
  store = new StudioStore(directory);
  const s = await journal().read();
  expect(s.executions).toHaveLength(1);
  expect(sends).toHaveLength(1);
  expect(await journal().pending()).toBeNull();
  expect(JSON.stringify(read())).toBe(snapshot);
});
it("does not resend an absent request on read and only explicitly retries the full original command", async () => {
  failure = "before";
  const cmd = command();
  await expect(journal().execute(cmd)).rejects.toThrow();
  await journal().read();
  expect(sends).toHaveLength(1);
  expect(await journal().pending()).toEqual(cmd);
  await expect(journal().execute(command())).rejects.toThrow();
  failure = "";
  await journal().execute(cmd, true);
  expect(sends).toEqual([cmd, cmd]);
});
it("a first direct non-acceptance may release; an uncertain retry rejection must retain", async () => {
  const reject: SupplementTransport = async () => {
    throw new SupplementHttpError("rejected", false);
  };
  const cmd = command();
  await expect(journal(reject).execute(cmd)).rejects.toThrow();
  expect(await journal().pending()).toBeNull();
  failure = "before";
  await expect(journal().execute(cmd)).rejects.toThrow();
  await expect(journal(reject).execute(cmd, true)).rejects.toThrow();
  expect(await journal().pending()).toEqual(cmd);
});
it.each(["write", "reread", "corrupt", "new-field"])(
  "fails before dispatch for browser storage %s",
  async (kind) => {
    const cmd = command();
    const broken = {
      ...storage,
      setItem: (key: string, value: string) => {
        if (kind === "write") throw Error("storage denied");
        const item = JSON.parse(value);
        if (kind === "reread") return;
        if (kind === "corrupt") item.sha256 = "c".repeat(64);
        if (kind === "new-field") item.key = "forbidden";
        storage.setItem(key, JSON.stringify(item));
      },
    };
    await expect(journal(transport, broken).execute(cmd)).rejects.toThrow();
    expect(sends).toHaveLength(0);
  },
);
it("does not persist selected source bodies or manuscript bodies", async () => {
  failure = "before";
  await expect(journal().execute(command())).rejects.toThrow();
  const saved = [...memory.values()][0];
  expect(saved).not.toContain(f.value.sources[0].text);
  expect(saved).not.toContain("PRIVATE_TITLE");
  expect(saved).not.toContain("PRIVATE_OLD_CITATION");
});
it("snapshots a caller command before lock acquisition and excludes another tab", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const cmd = command(),
    original = structuredClone(cmd);
  const port = new SupplementRequestJournal(
    f.value.id,
    storage,
    async (name, task) =>
      lock(name, async () => {
        await waiting;
        return task();
      }),
    transport,
  );
  const first = port.execute(cmd);
  cmd.input.target = {
    ...cmd.input.target,
    questionText: "caller mutation",
  } as typeof cmd.input.target;
  await expect(journal().execute(original)).rejects.toThrow("locked");
  release();
  await first;
  expect(sends).toEqual([original]);
});
it("validates a captured comparison and recovers adoption ack loss without a second version", async () => {
  const initialPlans = JSON.stringify(read().plans),
    initialSources = JSON.stringify(read().sources);
  await journal().execute(command());
  const s = status(),
    run = s.executions[0].record;
  const compared = await validateSupplementComparison(
    preparePlanSupplementAdoption(read(), read().revision, run.id),
    s,
    run.id,
  );
  const cmd = planSupplementAdoptionCommandSchema.parse({
    ...compared.selection,
    action: "adopt-section-supplement",
    clientRequestId: randomUUID(),
    confirmed: true,
  });
  failure = "after";
  await expect(journal().execute(cmd)).rejects.toThrow("response lost");
  const adopted = JSON.stringify(read());
  store.close();
  store = new StudioStore(directory);
  failure = "";
  await journal().read();
  expect(sends).toHaveLength(2);
  expect(JSON.stringify(read())).toBe(adopted);
  expect(read().plans).toHaveLength(2);
  expect(JSON.stringify(read().plans.slice(0, 1))).toBe(initialPlans);
  expect(JSON.stringify(read().sources)).toBe(initialSources);
});
it.each(["supplied", "other-section", "body", "company", "capture"])(
  "rejects changed comparison %s",
  async (kind) => {
    await journal().execute(command());
    const s = status(),
      id = s.executions[0].record.id;
    const p = preparePlanSupplementAdoption(read(), read().revision, id);
    if (kind === "supplied") Object.assign(p.proposal, { origin: "supplied-draft" });
    if (kind === "other-section") p.proposal.content.sections[0].content += "changed";
    if (kind === "body") p.proposal.after.content += "changed";
    if (kind === "company") p.selection.caseId = randomUUID();
    if (kind === "capture") p.selection.captureSha256 = "d".repeat(64);
    await expect(validateSupplementComparison(p, s, id)).rejects.toThrow();
  },
);
it("renders a read-first screen without automatic consent or a writable comparison", () => {
  const html = renderToStaticMarkup(
    createElement(PlanSupplementPanel, {
      company: read(),
      onCompany: vi.fn(),
      onBusyChange: vi.fn(),
      onUnsettledChange: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  expect(html).toContain("보완 자료로 한 항목 수정하기");
  expect(html).toContain("저장 상태 확인");
  expect(html).not.toContain("비교한 수정안을 새 버전으로 저장");
  expect(fetch).not.toHaveBeenCalled();
  expect(sends).toHaveLength(0);
});

async function pendingAdoption(stale = true) {
  await journal().execute(command());
  const c = read();
  const cmd = planSupplementAdoptionCommandSchema.parse({
    ...preparePlanSupplementAdoption(c, c.revision, c.planSupplementExecutions![0].id).selection,
    action: "adopt-section-supplement",
    clientRequestId: randomUUID(),
    confirmed: true,
  });
  failure = "before";
  await expect(journal().execute(cmd)).rejects.toThrow("lost before server");
  failure = "";
  if (stale) saveManual();
  return cmd;
}
function saveManual() {
  const c = read();
  store.mutate(
    c.id,
    {
      action: "save-plan",
      revision: c.revision,
      planId: c.plans.at(-1)!.id,
      content: { ...c.plans.at(-1)!.content, summary: `직접 수정 ${c.revision}` },
    },
    () => [],
  );
}
it("only explicitly closes a proven stale adoption; read/reopen and proof do not clear or write", async () => {
  const cmd = await pendingAdoption();
  const before = JSON.stringify(read());
  store.close();
  store = new StudioStore(directory);
  await journal().read();
  expect(await journal().pending()).toEqual(cmd);
  const { inspection } = await journal().inspectClosure(cmd);
  expect(inspection?.canClose).toBe(true);
  expect(await journal().pending()).toEqual(cmd);
  expect(() => journal().closeUnadopted(inspection!, false)).toThrow();
  const result = await journal().closeUnadopted(inspection!, true);
  expect(result.outcome).toBe("closed-without-adoption");
  expect(await journal().pending()).toBeNull();
  expect(JSON.stringify(read())).toBe(before);
  expect(sends.map((s) => (s as { action: string }).action)).toEqual([
    "propose-section",
    "adopt-section-supplement",
    "inspect-adoption",
    "inspect-adoption",
  ]);
});
it("same-revision uncertainty cannot be closed; only the original explicit command may store", async () => {
  const cmd = await pendingAdoption(false);
  const { inspection } = await journal().inspectClosure(cmd);
  expect(inspection?.state).toBe("unconfirmed");
  expect(() => journal().closeUnadopted(inspection!, true)).toThrow();
  expect(await journal().pending()).toEqual(cmd);
  await journal().execute(cmd, true);
  expect(read().planSupplementAdoptions).toHaveLength(1);
  expect(await journal().pending()).toBeNull();
});
it("a displayed closure proof is invalidated by a later edit and must be explicitly refreshed", async () => {
  const cmd = await pendingAdoption();
  const first = (await journal().inspectClosure(cmd)).inspection!;
  saveManual();
  await expect(journal().closeUnadopted(first, true)).rejects.toThrow();
  expect(await journal().pending()).toEqual(cmd);
  const fresh = (await journal().inspectClosure(cmd)).inspection!;
  await journal().closeUnadopted(fresh, true);
  expect(read().plans).toHaveLength(3);
});
it.each([
  "read-failed",
  "inspect-failed",
  "wrong-command",
  "wrong-revision",
  "wrong-hash",
  "extra-field",
  "remove-failed",
  "lock",
])("preserves the original pending command on failed or changed closure %s", async (kind) => {
  const cmd = await pendingAdoption();
  const proof = (await journal().inspectClosure(cmd)).inspection!;
  const before = JSON.stringify(read());
  const custom: SupplementTransport = async (path, raw) => {
    if (kind === "read-failed" && !raw) throw Error("read failed");
    const value = await transport(path, raw);
    if ((raw as { action?: string } | undefined)?.action === "inspect-adoption") {
      if (kind === "inspect-failed") throw Error("inspection failed");
      const result = structuredClone(value) as typeof proof;
      if (kind === "wrong-command") result.command.clientRequestId = randomUUID();
      if (kind === "wrong-revision") result.revision++;
      if (kind === "wrong-hash") result.commandSha256 = "0".repeat(64);
      if (kind === "extra-field") Object.assign(result, { reset: true });
      return result;
    }
    return value;
  };
  if (kind === "lock") locked = true;
  const customStorage =
    kind === "remove-failed"
      ? {
          ...storage,
          removeItem: () => {
            throw Error("denied");
          },
        }
      : storage;
  await expect(journal(custom, customStorage).closeUnadopted(proof, true)).rejects.toThrow();
  locked = false;
  expect(await journal().pending()).toEqual(cmd);
  expect(JSON.stringify(read())).toBe(before);
});
it("an original saved receipt is recovered as adopted instead of offering stale closure", async () => {
  const cmd = await pendingAdoption(false);
  store.adoptPlanSupplement(f.value.id, cmd, () => []);
  saveManual();
  const before = JSON.stringify(read());
  const result = await journal().inspectClosure(cmd);
  expect(result.inspection).toBeNull();
  expect(await journal().pending()).toBeNull();
  expect(JSON.stringify(read())).toBe(before);
});
