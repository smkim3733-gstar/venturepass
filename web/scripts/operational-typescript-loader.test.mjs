import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const loader = new URL("./operational-typescript-loader.mjs", import.meta.url).href;
function run(code, conditions = true) {
  return spawnSync(
    process.execPath,
    [
      ...(conditions ? ["--conditions=react-server"] : []),
      "--import",
      loader,
      "--input-type=module",
      "-e",
      code,
    ],
    { cwd: app, encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
}
test("operational loader uses the real server-only condition/current evidence and installs no owner on import", () => {
  const result = run(`
    globalThis.fetch = () => { throw Error("Network forbidden"); };
    const { OperationalValidationSession } = await import("./src/lib/studio-operational-validation-session.ts");
    const server = await import("./src/lib/studio-plan-quality-provider-production-server.ts");
    const config = await import("./src/lib/studio-plan-quality-provider-configuration.ts");
    console.log(JSON.stringify({ callable: typeof OperationalValidationSession,
      owner: server.inspectProviderProductionServer().status,
      reviewedAt: config.getProviderConfigurationProposal().sources[0].reviewedAt }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    callable: "function",
    owner: "not-installed",
    reviewedAt: "2026-09-28T14:34:32.000Z",
  });
});
test("loader cannot stub away server-only or import historical fixtures/test helpers", () => {
  assert.notEqual(
    run('await import("./src/lib/studio-operational-validation-session.ts");', false).status,
    0,
  );
  for (const name of [
    "studio-plan-quality-provider-configuration-20260927-test-fixture",
    "studio-plan-quality-actual-test-helpers",
  ]) {
    const result = run(`await import("./src/lib/${name}.ts");`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OPERATIONAL_TEST_MODULE_FORBIDDEN/);
  }
});

test("a run without the explicit server condition stops before loading credentials or storage", () => {
  const result = spawnSync(process.execPath, ["scripts/operational-validation.mjs", "run"], {
    cwd: app,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "blocked",
    reason: "OPERATIONAL_LAUNCH_CONFIGURATION_REQUIRED",
  });
});

test("policy recovery without the explicit server condition cannot load keys or mutate the fixed journal", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/operational-validation.mjs", "recover-policy"],
    {
      cwd: app,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "blocked",
    reason: "POLICY_RECOVERY_UNCONFIRMED",
    transmissionAllowed: false,
  });
});

test("additional session imports with no owner or transport, and without loading synthetic modules", () => {
  const result = run(`
    globalThis.fetch = () => { throw Error("Network forbidden"); };
    const { AdditionalOperationalValidationSession } =
      await import("./src/lib/studio-operational-validation-additional-session.ts");
    const server = await import("./src/lib/studio-plan-quality-provider-production-server.ts");
    console.log(JSON.stringify({ callable: typeof AdditionalOperationalValidationSession,
      owner: server.inspectProviderProductionServer().status }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { callable: "function", owner: "not-installed" });
});
test("all explicit additional commands without the server condition reject before key/store access", () => {
  for (const command of ["additional-status", "additional-run", "additional-continue-review"]) {
    const result = spawnSync(process.execPath, ["scripts/operational-validation.mjs", command], {
      cwd: app,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "blocked");
  }
});
