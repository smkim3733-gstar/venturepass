import "server-only";
import { resolve } from "node:path";

/** Ambient server configuration only; never accept a directory in a browser command. */
export function providerProductionDirectory() {
  return resolve(process.env.VENTURE_DATA_DIR || resolve(process.cwd(), ".venture-pass"));
}
