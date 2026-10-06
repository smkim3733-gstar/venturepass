"use client";

import Link from "next/link";
import { ComparisonReviewOpinion } from "./comparison-review-opinion";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useComparisonReviewScreen, type ComparisonReviewReactFrame } from "@/lib/studio-public-claim-comparison-review-react";
import { createExampleReviewRequest } from "@/lib/comparison-review-example-http";
import { useComparisonReviewExample } from "./comparison-review-example-provider";

type Props = { frame: ComparisonReviewReactFrame; claim: string;
  sources: { id: string; title: string; excerpt: string }[] };
type Screen = NonNullable<ReturnType<typeof useComparisonReviewExample>["owner"]>["screen"];

function ConnectedReview({ screen, frame }: { screen: Screen; frame: ComparisonReviewReactFrame }) {
  const review = useComparisonReviewScreen(screen, frame);
  const [message, setMessage] = useState("");
  function read() {
    const started = review.read({ signal: new AbortController().signal,
      startRequest: createExampleReviewRequest(window.location.origin, frame.snapshot.id,
        { runId: frame.expected.runId, dispatchCommandDigest: frame.expected.dispatchCommandDigest,
          mode: frame.expected.mode }, window.fetch.bind(window)) });
    setMessage(started.ok ? "" : "이전 읽기 상태를 확인한 뒤 다시 시도해 주세요.");
  }
  const closed = screen.getSnapshot().state.closed;

  return <section className="space-y-4" aria-label="합성 검토 결과">
    <div className="flex flex-wrap gap-2">
      <Button onClick={read} disabled={!review.canPrepare}>검토 결과 읽기</Button>
      <Button variant="outline" onClick={() => { review.cancel(); setMessage("읽기를 취소했습니다."); }}
        disabled={!review.occupied || review.canForget}>읽기 취소</Button>
      <Button variant="outline" onClick={() => { review.release(); setMessage(""); }}
        disabled={!review.occupied || !review.canForget}>표시 비우기</Button>
      <Button variant="ghost" onClick={() => screen.close()} disabled={closed}>예제 종료</Button>
    </div>
    <p role="status" className="text-sm text-muted-foreground">
      {closed ? "예제가 종료되었습니다. 이 창에서는 새 읽기를 시작하지 않습니다."
        : review.occupied && !review.canForget ? "읽기 또는 정리 상태를 확인 중입니다. 자동으로 다시 요청하지 않습니다."
        : message || "버튼을 눌러 고정된 합성 검토 결과를 확인하세요."}
    </p>
    {review.display?.kind === "error" && <p role="alert" className="rounded-lg border p-4">{review.display.message}</p>}
    <ComparisonReviewOpinion result={review.display?.kind === "result" ? review.display.result : null} />
    {(review.notificationFailed || review.observationFailed) &&
      <p role="alert">읽기 상태를 확인하지 못했습니다. 이 창의 원래 요청을 보관합니다.</p>}
  </section>;
}

export function ComparisonReviewExample({ frame, claim, sources }: Props) {
  const { owner, open } = useComparisonReviewExample();
  // This page has one immutable, schema-checked synthetic fixture. A Next RSC
  // refresh can deserialize that same frame into a new object. Keep its snapshot
  // reference only when the entire frame is byte-for-byte equal; changed props
  // still reach the existing hook and invalidate its current display.
  const [original] = useState(() => ({ key: JSON.stringify(frame), frame: structuredClone(frame) }));
  const currentFrame = JSON.stringify(frame) === original.key ? original.frame : frame;
  return <div className="mx-auto max-w-3xl space-y-6">
    <div className="flex items-center justify-between gap-3">
      <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">합성 자료 · 개발 예제</span>
      <Link href="/studio" prefetch={false} className="text-sm underline underline-offset-4">스튜디오로 돌아가기</Link>
    </div>
    <div><p data-testid="example-provenance" className="text-sm text-muted-foreground">합성 저장 결과의 시점 고정 사본입니다. 현재 회사 상태를 확인하거나 실시간으로 조회하지 않습니다.</p>
        <h1 className="text-2xl font-bold">공개 근거 검토 예제</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">실제 회사 자료 없이 검토 결과를 읽고 비우는 흐름을 확인합니다.
        고객 자료 저장·전송, 유료 AI 호출, 원고 채택은 수행하지 않습니다.</p></div>
    <div className="space-y-4 rounded-xl border bg-white p-5">
      <div><h2 className="text-sm font-semibold">예제 회사의 원고 주장</h2><p className="mt-2">{claim}</p></div>
      {sources.map((s) => <div key={s.id} className="border-t pt-4">
        <h2 className="text-sm font-semibold">{s.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{s.excerpt}</p>
      </div>)}
    </div>
    {owner ? <ConnectedReview screen={owner.screen} frame={currentFrame} />
      : <Button onClick={open}>합성 예제 시작</Button>}
    <p className="text-xs leading-5 text-muted-foreground">화면을 이동해도 이 창의 원래 읽기는 보관됩니다.
      새로고침·창 종료 후 보관은 지원하지 않습니다. 예제 종료와 서버 작업 복구는 별개입니다.</p>
  </div>;
}
