import { describe, expect, it } from "vitest";
import { serverSettingsFromEnv } from "./studio-server-bootstrap";

const complete = {
  VENTUREPASS_MODE: "server",
  VENTUREPASS_ORIGIN: "https://venturepass.example.test/some/path",
  DATABASE_URL: "postgres://user:secret@db.example.test:6543/postgres",
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
} as unknown as NodeJS.ProcessEnv;

describe("server settings from the hosting environment", () => {
  it("accepts a complete https configuration and keeps only the origin", () => {
    expect(serverSettingsFromEnv(complete)).toMatchObject({
      origin: "https://venturepass.example.test",
      supabase: { url: "https://project.supabase.test", anonKey: "anon" },
    });
  });

  it.each([
    ["local mode", { ...complete, VENTUREPASS_MODE: undefined }],
    ["missing database", { ...complete, DATABASE_URL: "" }],
    ["missing anon key", { ...complete, SUPABASE_ANON_KEY: " " }],
    ["plain http origin", { ...complete, VENTUREPASS_ORIGIN: "http://venturepass.example.test" }],
    ["invalid origin", { ...complete, VENTUREPASS_ORIGIN: "not a url" }],
  ])("stays unconfigured for %s", (_label, env) => {
    expect(serverSettingsFromEnv(env as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
