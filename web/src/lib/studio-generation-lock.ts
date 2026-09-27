// Shared by the guided and legacy generation entry points in this Node process.
const shared = globalThis as typeof globalThis & { __venturepassGenerationJobs?: Set<string> };
export const studioGenerationJobs = (shared.__venturepassGenerationJobs ??= new Set<string>());
