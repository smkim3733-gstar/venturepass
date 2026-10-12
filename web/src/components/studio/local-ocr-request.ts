export type LocalOcrRequestIdentity = { text: string; clientRequestId: string };

// The open preview owns a stable editor key. Each distinct submitted text owns
// its request ID; keeping these separate preserves the editor after a failure.
export function localOcrRequestIdentity(
  previous: LocalOcrRequestIdentity | null,
  text: string,
  createId: () => string,
): LocalOcrRequestIdentity {
  return previous?.text === text ? previous : { text, clientRequestId: createId() };
}
