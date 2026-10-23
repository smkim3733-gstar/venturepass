import "server-only";
import { createComparisonProviderRuntime } from "./studio-comparison-provider-runtime";
import { createComparisonExecutionApproval } from "./studio-comparison-execution-approval";

/** Called only after the local HTTP boundary has read/released a valid open request.
 * Construction reads explicit server configuration only; no SQL/SDK client/send.
 * The existing reserved run and policies come solely from that pinned configuration. */
export async function openConfiguredComparison(companyId: string, companyRevision: number) {
  const runtime = createComparisonProviderRuntime();
  try {
    const settings = runtime.approvalSettings();
    if (settings.companyId !== companyId || settings.companyRevision !== companyRevision)
      throw Error("COMPARISON_INPUT_SELECTION_CHANGED");
    return {
      runId: settings.runId,
      approval: createComparisonExecutionApproval(runtime, settings),
      runtime,
    };
  } catch {
    // No resource acquisition is possible above. The unused runtime closes synchronously.
    runtime.close();
    throw Error("COMPARISON_INPUT_UNAVAILABLE");
  }
}
