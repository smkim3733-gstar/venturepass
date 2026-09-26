import { StudioError } from "./studio-http";

// One app process per desktop installation; shared across Next route bundles, not hosts.
const processState = globalThis as typeof globalThis & {
  __ventureinInputCompanyLocks?: Set<string>;
};
const locks = (processState.__ventureinInputCompanyLocks ??= new Set<string>());

export function assertVentureCompanyWritable(caseId: string) {
  if (locks.has(caseId))
    throw new StudioError(
      "공식 화면 입력이 진행 중입니다. 결과 확인 후 기업자료·계정을 변경해 주세요.",
      409,
      "INPUT_IN_PROGRESS",
    );
}

export async function withVentureInputCompanyLock<T>(caseId: string, action: () => Promise<T>) {
  assertVentureCompanyWritable(caseId);
  locks.add(caseId);
  try {
    return await action();
  } finally {
    locks.delete(caseId);
  }
}
