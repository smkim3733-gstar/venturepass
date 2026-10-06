import "server-only";

/** Passive fixed options. No SDK, environment, credentials or execution authority. */
export const providerTransportSdkOptions = Object.freeze({
  baseURL: "https://api.openai.com/v1",
  maxRetries: 0,
  timeout: 120_000,
  logLevel: "off",
  adminAPIKey: null,
  webhookSecret: null,
  organization: null,
  project: null,
  fetchOptions: Object.freeze({ redirect: "error" }),
} as const);
