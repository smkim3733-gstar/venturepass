import "server-only";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { cancellationSelectionSchema } from "./studio-comparison-cancellation-wire";
import { createComparisonCancellation } from "./studio-comparison-cancellation";
function configuration() {
  const data = process.env.VENTURE_DATA_DIR,
    control = process.env.VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR,
    id = process.env.VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID;
  if (!data || !control || !id) throw Error("NOT_CONFIGURED");
  if (!isAbsolute(data) || !isAbsolute(control)) throw Error("CONFIGURATION_INVALID");
  return {
    dataRoot: resolve(data),
    controlDirectory: resolve(control),
    databaseInstanceId: z.string().uuid().parse(id),
  };
}
export function openConfiguredCancellation(raw: unknown) {
  const selection = cancellationSelectionSchema.parse(raw),
    config = configuration(),
    owner = createComparisonCancellation({ ...config, selection });
  function current() {
    try {
      if (JSON.stringify(configuration()) !== JSON.stringify(config)) throw Error("CHANGED");
    } catch {
      owner.revoke();
      throw Error("CONFIGURATION_CHANGED");
    }
  }
  return Object.freeze({
    ...owner,
    review() {
      current();
      return owner.review();
    },
    cancel(consent: unknown) {
      current();
      return owner.cancel(consent);
    },
  });
}
