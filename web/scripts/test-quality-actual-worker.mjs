// Test-only child process. No production entry point imports this file.
import { registerHooks } from "node:module";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { mock } from "node:test";
import { createHash } from "node:crypto";

let sdkOperation = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    // This worker belongs to the fixed September 27 historical regression suites.
    // No application resolver or operational runner imports this test-only hook.
    if (specifier === "./studio-plan-quality-provider-configuration-current")
      return {
        url: new URL(
          "../src/lib/studio-plan-quality-provider-configuration-20260927-test-fixture.ts",
          import.meta.url,
        ).href,
        shortCircuit: true,
      };
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "openai" && !sdkOperation)
      return {
        url: "data:text/javascript,export default class{constructor(){throw Error('provider forbidden')}}",
        shortCircuit: true,
      };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
        for (const extension of [".ts", ".tsx"]) {
          const target = new URL(specifier + extension, context.parentURL);
          if (existsSync(target)) return { url: target.href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(url) && !url.includes("/node_modules/")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
globalThis.fetch = () => {
  throw new Error("Network forbidden in synthetic worker");
};
const file = process.argv[2];
if (!file) throw new Error("Worker input required");
const input = JSON.parse(readFileSync(file, "utf8"));
sdkOperation =
  input.operation === "provider-generation-sdk-dispatch" ||
  input.operation === "provider-review-sdk-dispatch";
let runnerTransportCalls = 0;
if (input.clock) mock.timers.enable({ apis: ["Date"], now: new Date(input.clock) });
const source = path.resolve(
  fileURLToPath(new URL("../src/lib/studio-plan-quality-store.ts", import.meta.url)),
);
const { PlanQualityStore } = await import(pathToFileURL(source).href);
const store = new PlanQualityStore(input.directory, {
  actualEnvironment: "synthetic-test",
  providerEnvironment: "synthetic-test",
  ...(sdkOperation
    ? {
        providerSdkTestNetwork: {
          provenance: "synthetic-test",
          fetch: async (url, init) => {
            if (url !== "https://api.openai.com/v1/responses" || typeof init?.body !== "string")
              throw Error("Unexpected synthetic SDK wire");
            runnerTransportCalls++;
            appendFileSync(
              path.join(input.directory, "mock-sdk-fetches.jsonl"),
              JSON.stringify({
                runId:
                  input.operation === "provider-review-sdk-dispatch"
                    ? input.request.generation.dispatch.runId
                    : input.request.runId,
                sha256: createHash("sha256").update(init.body).digest("hex"),
              }) + "\n",
            );
            if (input.crashAfterDispatchSend) process.exit(78);
            if (input.loseDispatchResponse) throw new Error("Synthetic SDK response loss");
            return Response.json({
              id: "synthetic-sdk-worker",
              status: "completed",
              usage: { input_tokens: 20, output_tokens: 10 },
              output: [],
            });
          },
        },
      }
    : {}),
});
process.stdout.write("READY\n");
if (process.send) process.send({ kind: "ready" });
await new Promise((resolve) => process.once("message", resolve));
try {
  let result;
  if (input.operation === "provider-review-unobserved-stop-fixture") {
    // Native synthetic competing stop only; no production stop API is introduced here.
    const { DatabaseSync } = await import("node:sqlite");
    const { appendReviewUnobservedStop } =
      await import("../src/lib/studio-plan-quality-provider-review-dispatch-store-test-helpers.ts");
    const db = new DatabaseSync(path.join(input.directory, "quality-evaluation", "quality.sqlite"));
    db.function("quality_storage_contract", () => "quality-v9");
    db.exec("PRAGMA busy_timeout=5000");
    try {
      appendReviewUnobservedStop(
        db,
        store.providerGet(input.request.dispatch.generation.dispatch.runId),
      );
      result = { state: "stopped" };
    } finally {
      db.close();
    }
  } else if (input.operation === "provider-review-captured-stop-fixture") {
    const { DatabaseSync } = await import("node:sqlite");
    const { appendReviewTerminalFixture } =
      await import("../src/lib/studio-plan-quality-provider-review-validation-store-test-helpers.ts");
    const db = new DatabaseSync(path.join(input.directory, "quality-evaluation", "quality.sqlite"));
    db.function("quality_storage_contract", () => "quality-v9");
    db.exec("PRAGMA busy_timeout=5000");
    try {
      appendReviewTerminalFixture(
        db,
        store.providerGet(input.request.dispatch.generation.dispatch.runId),
      );
      result = { state: "stopped" };
    } finally {
      db.close();
    }
  } else if (input.operation === "provider-review-stop") {
    const { DatabaseSync } = await import("node:sqlite");
    if (input.crashAfterReviewStopInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      let inserts = 0;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (/^INSERT INTO quality_actual_(events|requests)\(/.test(sql)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            const result = run(...args);
            if (++inserts === input.crashAfterReviewStopInsert) process.exit(127);
            return result;
          });
        }
        return statement;
      });
    }
    if (input.crashBeforeReviewStopCommit || input.crashAfterReviewStopCommit) {
      const exec = DatabaseSync.prototype.exec;
      let first = true;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        const target = sql === "COMMIT" && first;
        if (target) first = false;
        if (target && input.crashBeforeReviewStopCommit) process.exit(126);
        const result = exec.call(this, sql);
        if (target && input.crashAfterReviewStopCommit) process.exit(125);
        return result;
      });
    }
    result = store.providerRecordReviewStop(input.request);
  } else if (input.operation === "provider-generation-stop") {
    const { DatabaseSync } = await import("node:sqlite");
    if (input.crashAfterStopInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      let inserts = 0;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (/^INSERT INTO quality_actual_(budget_events|events|requests)\(/.test(sql)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            const result = run(...args);
            if (++inserts === input.crashAfterStopInsert) process.exit(107);
            return result;
          });
        }
        return statement;
      });
    }
    if (input.crashBeforeStopCommit || input.crashAfterStopCommit) {
      const exec = DatabaseSync.prototype.exec;
      let first = true;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        const target = sql === "COMMIT" && first;
        if (target) first = false;
        if (target && input.crashBeforeStopCommit) process.exit(106);
        const result = exec.call(this, sql);
        if (target && input.crashAfterStopCommit) process.exit(105);
        return result;
      });
    }
    result = store.providerRecordGenerationStop(input.request);
  } else if (
    input.operation === "provider-generation-validation" ||
    input.operation === "provider-review-validation" ||
    input.operation === "provider-finalization"
  ) {
    const { DatabaseSync } = await import("node:sqlite");
    const finalizing = input.operation === "provider-finalization",
      crashAfterInsert = finalizing
        ? input.crashAfterFinalizationInsert
        : input.crashAfterValidationInsert,
      crashBeforeCommit = finalizing
        ? input.crashBeforeFinalizationCommit
        : input.crashBeforeValidationCommit,
      crashAfterCommit = finalizing
        ? input.crashAfterFinalizationCommit
        : input.crashAfterValidationCommit,
      crashBase = finalizing ? 115 : 95;
    if (crashAfterInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      let inserts = 0;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (/^INSERT INTO quality_actual_(artifacts|events|requests)\(/.test(sql)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            const result = run(...args);
            if (++inserts === crashAfterInsert) process.exit(crashBase + 2);
            return result;
          });
        }
        return statement;
      });
    }
    if (crashBeforeCommit || crashAfterCommit) {
      const exec = DatabaseSync.prototype.exec;
      let first = true;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        const target = sql === "COMMIT" && first;
        if (target) first = false;
        if (target && crashBeforeCommit) process.exit(crashBase + 1);
        const result = exec.call(this, sql);
        if (target && crashAfterCommit) process.exit(crashBase);
        return result;
      });
    }
    result = finalizing
      ? store.providerRecordFinalization(input.request)
      : input.operation === "provider-review-validation"
        ? store.providerRecordReviewValidation(input.request)
        : store.providerRecordGenerationValidation(input.request);
  } else if (
    input.operation === "provider-generation-response" ||
    input.operation === "provider-review-response"
  ) {
    const { DatabaseSync } = await import("node:sqlite");
    if (input.crashAfterResponseInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      let inserts = 0;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (/^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/.test(sql)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            const result = run(...args);
            if (++inserts === input.crashAfterResponseInsert) process.exit(87);
            return result;
          });
        }
        return statement;
      });
    }
    if (input.crashBeforeResponseCommit || input.crashAfterResponseCommit) {
      const exec = DatabaseSync.prototype.exec;
      let first = true;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        const target = sql === "COMMIT" && first;
        if (target) first = false;
        if (target && input.crashBeforeResponseCommit) process.exit(86);
        const result = exec.call(this, sql);
        if (target && input.crashAfterResponseCommit) process.exit(85);
        return result;
      });
    }
    result =
      input.operation === "provider-review-response"
        ? store.providerRecordReviewResponse(input.request)
        : store.providerRecordGenerationResponse(input.request);
  } else if (
    input.operation === "provider-generation-dispatch" ||
    input.operation === "provider-review-dispatch" ||
    sdkOperation
  ) {
    const reviewDispatch =
      input.operation === "provider-review-dispatch" ||
      input.operation === "provider-review-sdk-dispatch";
    const { DatabaseSync } = await import("node:sqlite");
    if (sdkOperation && input.pauseSdkPreparation) {
      const { default: OpenAI } = await import("openai");
      const original = OpenAI.prototype.prepareOptions;
      mock.method(OpenAI.prototype, "prepareOptions", async function (options) {
        await original.call(this, options);
        process.send?.({ kind: "preparing" });
        await new Promise((resolve) => process.once("message", resolve));
      });
    }
    if (input.crashAfterDispatchInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      let inserts = 0;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (/^INSERT INTO quality_actual_(artifacts|events|requests)\(/.test(sql)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            const result = run(...args);
            if (++inserts === input.crashAfterDispatchInsert) process.exit(77);
            return result;
          });
        }
        return statement;
      });
    }
    if (input.crashBeforeDispatchCommit || input.crashAfterDispatchCommit) {
      const exec = DatabaseSync.prototype.exec;
      let first = true;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        const target = sql === "COMMIT" && first;
        if (target) first = false;
        if (target && input.crashBeforeDispatchCommit) process.exit(76);
        const result = exec.call(this, sql);
        if (target && input.crashAfterDispatchCommit) process.exit(75);
        return result;
      });
    }
    if (sdkOperation) {
      result = await (reviewDispatch
        ? store.providerSimulateReviewSdkDispatch(input.request)
        : store.providerSimulateGenerationSdkDispatch(input.request));
    } else {
      const simulate = reviewDispatch
        ? store.providerSimulateReviewDispatch.bind(store)
        : store.providerSimulateGenerationDispatch.bind(store);
      result = await simulate(input.request, {
        provenance: "synthetic-test",
        send: async (request) => {
          runnerTransportCalls++;
          appendFileSync(
            path.join(input.directory, "mock-sends.jsonl"),
            JSON.stringify({
              runId: reviewDispatch ? input.request.generation.dispatch.runId : input.request.runId,
              requestDigest: request.request.requestDigest,
            }) + "\n",
          );
          if (input.crashAfterDispatchSend) process.exit(78);
          if (input.loseDispatchResponse) throw new Error("synthetic response loss");
        },
      });
    }
  } else if (input.operation === "start") result = store.actualStart(input.request);
  else if (input.operation === "provider-reserve") {
    if (input.crashBeforeReservationCommit) {
      const { DatabaseSync } = await import("node:sqlite");
      const prepare = DatabaseSync.prototype.prepare;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith("INSERT INTO quality_provider_reservation_bindings(")) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            run(...args);
            process.exit(76);
          });
        }
        return statement;
      });
    }
    result = store.providerReserve(input.request, input.review);
    if (input.crashAfterReservationCommit && result.newlyCommitted) process.exit(75);
  } else if (input.operation === "provider-transmission-approve") {
    const { DatabaseSync } = await import("node:sqlite");
    if (input.crashAfterApprovalInsert) {
      const prepare = DatabaseSync.prototype.prepare;
      mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith(`INSERT INTO ${input.crashAfterApprovalInsert}(`)) {
          const run = statement.run.bind(statement);
          mock.method(statement, "run", (...args) => {
            run(...args);
            process.exit(77);
          });
        }
        return statement;
      });
    }
    if (input.crashBeforeApprovalCommit) {
      const exec = DatabaseSync.prototype.exec;
      mock.method(DatabaseSync.prototype, "exec", function (sql) {
        if (sql === "COMMIT") process.exit(76);
        return exec.call(this, sql);
      });
    }
    result = store.providerApproveTransmission(input.request, input.review);
    if (input.crashAfterApprovalCommit && result.newlyCommitted) process.exit(75);
  } else if (input.operation === "policy-adopt") {
    result = store.providerPolicyAdopt(input.request, input.review);
    if (input.crashAfterPolicyCommit && result.newlyCommitted) process.exit(75);
  } else if (input.operation === "provider-start") result = store.providerStart(input.request);
  else if (input.operation === "provider-cancel")
    result = store.providerCancel(input.runId, input.request);
  else if (input.operation === "dispatch")
    result = store.actualRecordDispatch(input.runId, input.request);
  else if (input.operation === "provider-runner") {
    const { runQualityProviderSimulation } = await import(
      new URL("../src/lib/studio-plan-quality-provider-runner.ts", import.meta.url).href
    );
    const { actualTestPlan } = await import(
      new URL("../src/lib/studio-plan-quality-actual-test-helpers.ts", import.meta.url).href
    );
    const { providerExecutionTestResponse } = await import(
      new URL("../src/lib/studio-plan-quality-provider-execution-test-helpers.ts", import.meta.url)
        .href
    );
    const prep = store.providerGet(input.runId).run.preparation,
      registry = store.candidateRegistryGet(prep.scope.version);
    const index = registry.entries.findIndex(
      (entry) => entry.candidateId === prep.scope.candidateId,
    );
    if (input.crashAfterDispatch) {
      const dispatch = store.providerRecordDispatch.bind(store);
      store.providerRecordDispatch = (...args) => {
        const committed = dispatch(...args);
        if (committed.newlyCommitted && !committed.replayed) process.exit(75);
        return committed;
      };
    }
    result = await runQualityProviderSimulation(store, input.runId, input.request, {
      transport: {
        provenance: "synthetic-test",
        model: prep.model,
        contractDigest: input.request.payload.manifest.executionContract.contractDigest,
        send: async ({ request }) => {
          runnerTransportCalls++;
          process.send?.({ kind: "transport", phase: request.phase });
          if (input.holdGeneration && request.phase === "generation")
            await new Promise((resolve) => process.once("message", resolve));
          if (input.failGeneration && request.phase === "generation")
            throw new Error("Synthetic response not observed");
          return providerExecutionTestResponse(
            request.phase === "generation" ? actualTestPlan(registry, index) : { findings: [] },
          );
        },
      },
    });
  } else if (input.operation === "runner") {
    const { runQualityActualSimulation } = await import(
      new URL("../src/lib/studio-plan-quality-actual-runner.ts", import.meta.url).href
    );
    const { actualTestPlan, actualTestResponse } = await import(
      new URL("../src/lib/studio-plan-quality-actual-test-helpers.ts", import.meta.url).href
    );
    const { planQualityEvaluationDigest: digest } = await import(
      new URL("../src/lib/studio-plan-quality-evaluation.ts", import.meta.url).href
    );
    const prep = input.request.preparation;
    const registry = store.candidateRegistryGet(prep.scope.version);
    const index = registry.entries.findIndex(
      (entry) => entry.candidateId === prep.scope.candidateId,
    );
    if (input.crashAfterDispatch) {
      const dispatch = store.actualRecordDispatch.bind(store);
      store.actualRecordDispatch = (...args) => {
        const committed = dispatch(...args);
        if (committed.newlyCommitted && !committed.replayed) process.exit(75);
        return committed;
      };
    }
    result = await runQualityActualSimulation(store, input.request, {
      transport: {
        provenance: "synthetic-test",
        model: prep.model,
        contractDigest: prep.engine.contractDigest,
        send: async ({ request }) => {
          runnerTransportCalls++;
          process.send?.({ kind: "transport", phase: request.phase });
          if (input.holdGeneration && request.phase === "generation")
            await new Promise((resolve) => process.once("message", resolve));
          if (input.failGeneration && request.phase === "generation")
            throw new Error("Synthetic response not observed");
          return actualTestResponse(
            request.phase === "generation" ? actualTestPlan(registry, index) : { findings: [] },
          );
        },
      },
      tokenAdapter: {
        provenance: "synthetic-test",
        model: prep.model,
        contractDigest: prep.engine.contractDigest,
        evidenceDigest: digest(prep.evidence.tokens),
        tokenizerId: prep.evidence.tokens.tokenizerId,
        tokenizerVersion: prep.evidence.tokens.tokenizerVersion,
        measure: ({ request }) => prep.evidence.tokens[request.phase].inputUpperBound,
      },
    });
  } else throw new Error("Unsupported test operation");
  process.send?.({
    kind: "result",
    ok: true,
    result,
    transportCalls:
      input.operation === "runner" ||
      input.operation === "provider-runner" ||
      input.operation === "provider-generation-dispatch" ||
      input.operation === "provider-review-dispatch" ||
      sdkOperation
        ? runnerTransportCalls
        : input.operation === "dispatch" &&
            !input.omitTransport &&
            result.newlyCommitted === true &&
            result.replayed === false
          ? 1
          : 0,
  });
} catch (error) {
  process.send?.({
    kind: "result",
    ok: false,
    code: error.code ?? error.message,
    transportCalls: runnerTransportCalls,
  });
} finally {
  store.close();
  process.disconnect?.();
}
