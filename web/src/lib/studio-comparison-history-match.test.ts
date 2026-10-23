import { expect, it } from "vitest";
import { matchComparisonHistory } from "./studio-comparison-history-match";
import { decodeReservationView } from "./studio-comparison-reservations-wire";
const companyId = "0166ecb1-5bd0-4393-bb9e-000000000001",
  runId = "0166ecb1-5bd0-4393-bb9e-000000000002",
  clientRequestId = "0166ecb1-5bd0-4393-bb9e-000000000003",
  cancellationId = "0166ecb1-5bd0-4393-bb9e-000000000004";
const recordedAt = "2026-10-14T09:00:00.000Z";
function fixture() {
  const view = decodeReservationView(
    {
      kind: "comparison-reservation-view",
      companyId,
      companyRevision: 2,
      inspectedAt: recordedAt,
      input: { status: "not-configured", runId: null },
      currentContextVerified: false,
      policiesVerified: false,
      transmissionAllowed: false,
      consentRecorded: false,
      runtimeObserved: false,
      reservations: [
        {
          runId,
          companyRevision: 1,
          companyRevisionMatches: false,
          createdAt: recordedAt,
          expiresAt: "2026-10-14T10:00:00.000Z",
          reservationExpired: false,
          model: "synthetic",
          sectionKey: "overview",
          sectionTitle: "합성 기록",
          currency: "USD",
          unitScale: 6,
          reservedUnits: "100",
          latestEventKind: "finalized",
          history: {
            reservation: { clientRequestId, commandDigest: "a".repeat(64), recordedAt },
            cancellation: {
              clientRequestId: cancellationId,
              commandDigest: "b".repeat(64),
              recordedAt,
              releasedUnits: "100",
            },
            finalizedAt: recordedAt,
          },
        },
      ],
    },
    { id: companyId, revision: 2 },
  );
  const routing = {
    selection: { companyId, companyRevision: 1 },
    attempted: true,
    requestReference: { runId, clientRequestId },
  };
  return { view, routing };
}
it.each(["reservation", "cancellation"] as const)(
  "matches original %s after reload without current revision substitution",
  (kind) => {
    const { view, routing } = fixture();
    if (kind === "cancellation") routing.requestReference.clientRequestId = cancellationId;
    const saved = JSON.stringify(routing),
      before = JSON.stringify(view);
    expect(matchComparisonHistory(kind, JSON.parse(saved), view)).toContain(
      "요청과 저장된 기록이 일치합니다",
    );
    expect(JSON.stringify(routing)).toBe(saved);
    expect(JSON.stringify(view)).toBe(before);
  },
);
it.each(["reservation", "cancellation"] as const)(
  "does not infer %s from missing, legacy, unattempted, other company or different identities",
  (kind) => {
    const { view, routing } = fixture();
    if (kind === "cancellation") routing.requestReference.clientRequestId = cancellationId;
    expect(matchComparisonHistory(kind, null, view)).toContain("없습니다");
    expect(
      matchComparisonHistory(kind, { ...routing, requestReference: undefined }, view),
    ).toContain("대조할 수 없습니다");
    expect(matchComparisonHistory(kind, { ...routing, attempted: false }, view)).toContain(
      "검토만으로 완료 처리하지 않습니다",
    );
    expect(
      matchComparisonHistory(
        kind,
        { ...routing, selection: { ...routing.selection, companyId: runId } },
        view,
      ),
    ).toContain("없습니다");
    for (const key of ["clientRequestId", "runId"] as const)
      expect(
        matchComparisonHistory(
          kind,
          { ...routing, requestReference: { ...routing.requestReference, [key]: companyId } },
          view,
        ),
      ).toContain("다시 보내지 않습니다");
    view.reservations = [];
    expect(matchComparisonHistory(kind, routing, view)).toContain("실패나 미실행을 뜻하지 않으며");
  },
);
it("does not interpret other finalization as cancellation or another revision as the reserved request", () => {
  const { view, routing } = fixture();
  expect(
    matchComparisonHistory(
      "reservation",
      { ...routing, selection: { companyId, companyRevision: 2 } },
      view,
    ),
  ).toContain("찾지 못했습니다");
  view.reservations[0].history.cancellation = null;
  routing.requestReference.clientRequestId = cancellationId;
  expect(matchComparisonHistory("cancellation", routing, view)).toContain("찾지 못했습니다");
});
