import "server-only";

const wireHeaders = new Set([
  "accept",
  "authorization",
  "content-type",
  "user-agent",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-retry-count",
  "x-stainless-timeout",
]);

/** Internal SDK boundary. This checks an already supplied authorization header, never creates
 * permission to send. The returned wire contains that header and must remain inside the driver.
 * Never attach the key, input, SDK exception or cause to an error. */
export function snapshotProviderSdkWire(
  rawBody: string,
  apiKey: string,
  url: unknown,
  input: unknown,
): RequestInit {
  try {
    if (url !== "https://api.openai.com/v1/responses" || !input || typeof input !== "object")
      throw Error();
    const fields = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(fields).some(
        (key) =>
          typeof key !== "string" ||
          !["method", "body", "headers", "signal", "redirect"].includes(key),
      )
    )
      throw Error();
    if (Object.values(fields).some((field) => !("value" in field))) throw Error();
    if (
      fields.method?.value !== "POST" ||
      fields.body?.value !== rawBody ||
      fields.redirect?.value !== "error" ||
      !(fields.signal?.value instanceof AbortSignal)
    )
      throw Error();
    const headers = new Headers(fields.headers?.value);
    if (
      [...headers.keys()].some((key) => !wireHeaders.has(key)) ||
      headers.get("authorization") !== `Bearer ${apiKey}` ||
      headers.get("content-type") !== "application/json" ||
      headers.get("x-stainless-retry-count") !== "0"
    )
      throw Error();
    return {
      method: "POST",
      body: rawBody,
      headers,
      signal: fields.signal.value,
      redirect: "error",
    };
  } catch {
    throw Error("PROVIDER_SDK_WIRE_REJECTED");
  }
}
