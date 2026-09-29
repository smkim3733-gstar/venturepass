import "server-only";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { providerProductionDirectory } from "./studio-plan-quality-provider-production-directory";
import {
  createProviderProductionRuntime,
  inspectProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { ProviderProductionExecutionService } from "./studio-plan-quality-provider-production-service";
import {
  providerProductionSelectionSchema,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";
import { unavailableProviderProductionView } from "./studio-plan-quality-provider-production-view";

type Lifetime = Readonly<{
  status: "not-installed" | "ready" | "draining" | "closed";
  activeExecutions: number;
  retainedCaptures: number;
}>;
const unavailable = (raw: unknown): ProviderProductionView => {
  const parsed = providerProductionSelectionSchema.safeParse(raw);
  return unavailableProviderProductionView(
    parsed.success ? parsed.data : null,
    parsed.success ? "execution-unavailable" : "invalid-selection",
  );
};

/** Sole owner of this DB/runtime/service. It never shares the default app-store cache.
 * No caller can close its DB, extract a capture, or swap its runtime. */
class ProductionServer {
  readonly #runtime: ProviderProductionRuntime;
  readonly #store: PlanQualityStore;
  readonly #service: ProviderProductionExecutionService;
  #state: "ready" | "draining" | "closed" = "ready";

  constructor() {
    const directory = providerProductionDirectory();
    this.#runtime = createProviderProductionRuntime();
    try {
      this.#store = new PlanQualityStore(directory, { providerProductionRuntime: this.#runtime });
      this.#service = new ProviderProductionExecutionService(this.#store);
    } catch {
      revokeProviderProductionRuntime(this.#runtime);
      throw Error("PROVIDER_PRODUCTION_SERVER_INSTALL_FAILED");
    }
  }

  #refresh() {
    if (
      this.#state === "ready" &&
      inspectProviderProductionRuntime(this.#runtime).status !== "configured"
    )
      this.#state = "draining";
    this.#closeIfDrained();
  }

  #closeIfDrained() {
    if (this.#state !== "draining") return;
    const retained = this.#service.retention();
    if (retained.activeExecutions || retained.retainedCaptures) return;
    try {
      this.#store.close();
      this.#state = "closed";
    } catch {
      // Keep the owner pinned and installation blocked. A later lifetime check may retry.
    }
  }

  inspect(): Lifetime {
    this.#refresh();
    return Object.freeze({ status: this.#state, ...this.#service.retention() });
  }

  retire(): Lifetime {
    if (this.#state !== "closed") {
      revokeProviderProductionRuntime(this.#runtime);
      this.#state = "draining";
      this.#closeIfDrained();
    }
    return this.inspect();
  }

  async execute(raw: unknown): Promise<ProviderProductionView> {
    this.#refresh();
    if (this.#state !== "ready") return unavailable(raw);
    try {
      // No HTTP AbortSignal is accepted: disconnect does not prove provider cancellation.
      return await this.#service.execute(raw);
    } finally {
      this.#refresh();
    }
  }

  recover(raw: unknown): ProviderProductionView {
    this.#refresh();
    if (this.#state === "closed") return unavailable(raw);
    try {
      // The ORIGINAL store/capture remain usable after key/path changes or module reload.
      return this.#service.recover(raw);
    } finally {
      this.#refresh();
    }
  }
}

type ServerPort = Pick<ProductionServer, "execute" | "recover" | "inspect" | "retire">;
type Registry = { version: 1; epoch: object; owner: ServerPort | null };
const slot = Symbol.for("venturepass.provider-production.server.v1");
const epoch = Object.freeze({});
const globals = globalThis as typeof globalThis & { [slot]?: Registry };
let registry: Registry;
const descriptor = Object.getOwnPropertyDescriptor(globals, slot);
if (descriptor) {
  // Never overwrite an unknown owner: it might still hold an in-flight call or raw capture.
  if (!("value" in descriptor) || descriptor.value?.version !== 1)
    throw Error("PROVIDER_PRODUCTION_SERVER_REGISTRY_UNAVAILABLE");
  registry = descriptor.value as Registry;
  registry.owner?.retire();
  registry.epoch = epoch;
} else {
  registry = { version: 1, epoch, owner: null };
  Object.defineProperty(globals, slot, { value: registry, writable: false, configurable: false });
}

/** EXPLICIT trusted server composition only; no route, default-store getter, import or key
 * presence calls this. Creates no policy/approval/reservation and sends no provider request.
 * A draining owner cannot be replaced, even by another explicit installation. */
export function installProviderProductionServer(): Lifetime {
  if (arguments.length || registry.epoch !== epoch)
    throw Error("PROVIDER_PRODUCTION_SERVER_INSTALL_FORBIDDEN");
  if (registry.owner && registry.owner.inspect().status !== "closed")
    throw Error("PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED");
  const owner = new ProductionServer();
  // Closures from this module retain authentic old runtime/store identities across HMR.
  registry.owner = Object.freeze({
    execute: owner.execute.bind(owner),
    recover: owner.recover.bind(owner),
    inspect: owner.inspect.bind(owner),
    retire: owner.retire.bind(owner),
  });
  return owner.inspect();
}

export function inspectProviderProductionServer(): Lifetime {
  return (
    registry.owner?.inspect() ??
    Object.freeze({ status: "not-installed", activeExecutions: 0, retainedCaptures: 0 })
  );
}

export function retireProviderProductionServer(): Lifetime {
  return registry.owner?.retire() ?? inspectProviderProductionServer();
}

/** Future execute HTTP calls this shared owner; it must never install/create per request. */
export async function executeProviderProductionSelection(
  raw: unknown,
): Promise<ProviderProductionView> {
  if (registry.epoch !== epoch || !registry.owner) return unavailable(raw);
  return registry.owner.execute(raw);
}

/** Capture-only, same-process recovery; absence must never fall back to a fresh send. */
export function recoverProviderProductionSelection(raw: unknown): ProviderProductionView {
  if (registry.epoch !== epoch || !registry.owner) return unavailable(raw);
  return registry.owner.recover(raw);
}
