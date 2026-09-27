// Test-only child process. No production entry point imports this file.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";
import { mock } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "openai")
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
if (input.clock) mock.timers.enable({ apis: ["Date"], now: new Date(input.clock) });
const source = path.resolve(
  fileURLToPath(new URL("../src/lib/studio-plan-quality-store.ts", import.meta.url)),
);
const { PlanQualityStore } = await import(pathToFileURL(source).href);
const store = new PlanQualityStore(input.directory, {
  actualEnvironment: "synthetic-test",
  providerEnvironment: "synthetic-test",
});
process.stdout.write("READY\n");
if (process.send) process.send({ kind: "ready" });
await new Promise((resolve) => process.once("message", resolve));
let runnerTransportCalls = 0;
try {
  let result;
  if (input.operation === "start") result = store.actualStart(input.request);
  else if (input.operation === "provider-start") result = store.providerStart(input.request);
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
      input.operation === "runner" || input.operation === "provider-runner"
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
