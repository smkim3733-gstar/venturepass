import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudioCase } from "./studio-schema";
import { applicationMetadata } from "./studio-application-types";
import { currentApplicationNumberBinding } from "./studio-application-number";
import { applicationNumberBindingCommandSchema } from "./studio-application-number-types";
import { VentureinBoundMyStatusPanel, VentureBoundMyStatusResult } from "@/components/studio/venturein-bound-my-status-panel";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type { VentureSessionStatus } from "./venturein-schema";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, decrypt: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()), getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", async (original) => ({
  ...(await original<typeof import("./venturein-vault")>()), readVentureAccount: state.decrypt,
}));
import * as route from "@/app/api/studio/cases/[caseId]/venturein/bound-my-status/route";
import { readVentureBoundResult, ventureBoundReadCommand, type VentureBoundReadContext } from "./venturein-bound-my-status";
import * as collector from "./venturein-my-status-collector";
import { readBoundVentureMyStatus } from "./venturein-bound-my-status-service";
import "./venturein-runner";
import { ventureMyStatusUrl } from "./venturein-my-status";
import { myStatusExpected, myStatusHtml } from "./venturein-my-status-test-fixture";

// The production runner owns this process map. Seed only this isolated test's synthetic
// authenticated session; this is not a real login or evidence of authentication success.
type SyntheticSession = {
  status: VentureSessionStatus; cancelled: boolean; operationInProgress?: boolean;
  accountRevision?: number; authenticatedAt?: string; documentRevision: number;
  textInputTracking: true; browser: Browser; context: BrowserContext; page: Page;
};
const sessions = (globalThis as typeof globalThis & { __ventureinSessions: Map<string, SyntheticSession> }).__ventureinSessions;
let browser: Browser, context: BrowserContext, page: Page, session: SyntheticSession;
let dir: string, caseId: string, routed: number, applicationId: string, readCompanyRevision: number;
let bindingTarget: VentureBoundReadContext["target"];
const tables = ["studio_cases", "venture_accounts", "venture_workflows", "studio_prepared_packages"];
function rows() {
  const db = new DatabaseSync(join(dir, "studio.sqlite"), { readOnly: true });
  try { return tables.map(t => db.prepare("SELECT * FROM " + t + " ORDER BY 1").all()); }
  finally { db.close(); }
}
const command = () => ventureBoundReadCommand(expected());
function expected(): VentureBoundReadContext { return { caseId, companyRevision:readCompanyRevision,
 accountRevision:1, workflowRevision:1, sessionStartedAt:session.status.startedAt!,target:structuredClone(bindingTarget) }; }
function bind(number:string|null) {
 const c=state.store!.get(caseId), head=currentApplicationNumberBinding(c,applicationId).record;
 return state.store!.mutate(caseId,applicationNumberBindingCommandSchema.parse({
  action:"record-application-number",revision:c.revision,clientRequestId:randomUUID(),applicationId,
  metadataVersionId:applicationMetadata(c,applicationId)!.metadataVersionId,expectedPreviousBindingId:head?.id??null,
  operation:number===null?"release":"bind",applicationNumber:number,recordedBy:"Synthetic reviewer",reason:"Manual only",confirmed:true,
 }),()=>[]);
}
function correctRound(){const c=state.store!.get(caseId);return state.store!.mutate(caseId,{
 action:"correct-application",revision:c.revision,clientRequestId:randomUUID(),applicationId,
 previousVersionId:applicationMetadata(c,applicationId)!.metadataVersionId,title:"Changed round",kind:"new",
 plannedOn:"",criteriaNote:"",previousApplicationId:null,
},()=>[]);}
function editStored(edit:(c:StudioCase)=>void){const c=state.store!.get(caseId);edit(c);
 const db=new DatabaseSync(join(dir,"studio.sqlite"));try{db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(c),caseId);}finally{db.close();}}
function request(body: unknown = command(), suffix = "", origin = "http://localhost:3000") {
  return new Request(`http://localhost:3000/api/studio/cases/${caseId}/venturein/bound-my-status${suffix}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const read = (body: unknown = command()) => route.POST(request(body), { params: Promise.resolve({ caseId }) });
beforeAll(async () => { browser = await chromium.launch({ channel: "msedge", headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venture-bound-session-test-"));
  state.store = new StudioStore(dir);
  caseId = state.store.create({ ...emptyProfile(), companyName: "합성 읽기 회사", businessNumber: myStatusExpected.businessNumber }).id;
  state.store.saveVentureAccountEnvelope(caseId, 0, Buffer.from("synthetic-unusable-ciphertext"), "synthetic***");
  state.store.saveVentureWorkflowEnvelope(caseId, 0, JSON.stringify({ snapshot: null, draft: null, history: [] }));
  state.decrypt.mockReset().mockImplementation(() => { throw Error("Never decrypt for a read"); });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("No external requests"); }));
  context = await browser.newContext({ serviceWorkers: "block" }); routed = 0;
  await context.route("**/*", async (r) => {
    routed++;
    if (!r.request().isNavigationRequest()) { await r.abort(); return; }
    await r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: myStatusHtml() });
  });
  page = await context.newPage();
  await page.goto(ventureMyStatusUrl + "?SYNTHETIC-PRIVATE-QUERY=1");
  const now = new Date().toISOString();
  session = { status: { state: "connected_unmapped", message: "synthetic", startedAt: now, updatedAt: now },
    cancelled: false, accountRevision: 1, authenticatedAt: now, documentRevision: 1,
    textInputTracking: true, browser, context, page };
  sessions.set(caseId, session);
  applicationId=state.store!.mutate(caseId,{action:"create-application",revision:0,clientRequestId:randomUUID(),
   title:"Synthetic selected round",kind:"new",plannedOn:"",criteriaNote:"",previousApplicationId:null},()=>[]).applications[0].id;
  const c=bind(myStatusExpected.applicationNumber!);readCompanyRevision=c.revision;
  const record=currentApplicationNumberBinding(c,applicationId).record!;
  bindingTarget={applicationId,metadataVersionId:record.command.metadataVersionId,bindingId:record.id,
   bindingDigest:record.recordDigest,applicationNumber:record.command.applicationNumber!};
  page.on("framenavigated", () => { session.documentRevision++; });
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); expect(state.decrypt).not.toHaveBeenCalled();
  sessions.delete(caseId);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await context?.close(); state.store?.close();
  const r = relative(resolve(tmpdir()), resolve(dir));
  if (!r.startsWith("venture-bound-session-test-") || r.includes("..")) throw Error("Unsafe cleanup");
  rmSync(dir, { recursive: true, force: true });
});

it("returns only the literal saved-number row via real synthetic Edge/SQLite/route and changes no rows or auth", async () => {
  const before = rows(), html = await page.content(), auth = session.authenticatedAt;
  const response = await read(), value = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(readVentureBoundResult(value, expected())).toEqual(value);
  expect(value.observation.target).toMatchObject({ state: "matched", applicationNumber: "SYNTHETIC-REQUEST-B",
    row: { resultText: "확인", applicationDateText: "2030-01-01" } });
  expect(value).toMatchObject({ scope: "manual-application-binding", applicationAttribution: "manual-unverified",
    observation: { officialStatusChecked: false, receiptVerified: false, databaseChanged: false, transmissionAllowed: false,
      certificateApplicationLink: "unverified", progressAttribution: "unverified" } });
  expect(JSON.stringify(value)).not.toMatch(/SYNTHETIC-REQUEST-A|SYNTHETIC-CERT|PRIVATE|777-77|synthetic-unusable|lastCheckedAt/);
  expect(rows()).toEqual(before); expect(await page.content()).toBe(html); expect(session.authenticatedAt).toBe(auth);
  expect(routed).toBe(1); expect("GET" in route).toBe(false);
  state.store!.close(); state.store = new StudioStore(dir);
  expect(rows()).toEqual(before);
  sessions.delete(caseId); expect((await read()).status).toBe(409); expect(rows()).toEqual(before);
});
it.each(["bindingId","bindingDigest","applicationId","metadataVersionId"])("rejects wrong original %s before DOM collection", async field => {
  const spy = vi.spyOn(collector,"collectVentureMyStatus"), before=rows();
  const target = {...command().target,[field]: field==="bindingDigest"?"0".repeat(64):randomUUID()};
  expect((await read({...command(),target})).status).toBe(409);
  expect(spy).not.toHaveBeenCalled();expect(rows()).toEqual(before);
});
it.each([
 {applicationNumber:"SYNTHETIC-REQUEST-B"},{receiptNumber:"SYNTHETIC-REQUEST-B"},
 {confirmed:false},{observation:{origin:"page-observation"}},{businessNumber:"777-77-00001"},
 {action:"read-current-my-status"},{target:{applicationNumber:"SYNTHETIC-REQUEST-B"}},
])("rejects untrusted caller additions %j", async extra=>{
 const spy=vi.spyOn(collector,"collectVentureMyStatus");
 expect((await read({...command(),...extra})).status).toBe(400);expect(spy).not.toHaveBeenCalled();
});
it("rejects query, Origin, non-JSON and oversized requests",async()=>{
 const before=rows(), spy=vi.spyOn(collector,"collectVentureMyStatus");
 for(const req of [request(command(),"?x=1"),request(command(),"","https://example.invalid"),
  new Request(request().url,{method:"POST",body:"{}"}),request({...command(),extra:"x".repeat(8192)})]){
  expect([400,403,413]).toContain((await route.POST(req,{params:Promise.resolve({caseId})})).status);
 }
 expect(spy).not.toHaveBeenCalled();expect(rows()).toEqual(before);
});
it.each(["release","correction","metadata","company-number","missing-history","damaged-history"])(
 "rejects %s even with the latest company revision",async kind=>{
  const c=state.store!.get(caseId);
  if(kind==="release")bind(null);
  if(kind==="correction")bind("SYNTHETIC-REQUEST-A");
  if(kind==="metadata")correctRound();
  if(kind==="company-number")state.store!.mutate(caseId,{action:"profile",revision:c.revision,
    profile:{...c.profile,businessNumber:"888-88-00002"}},()=>[]);
  if(kind==="missing-history"||kind==="damaged-history")editStored(v=>{
    if(kind==="missing-history")delete v.applicationNumberBindings;
    else v.applicationNumberBindings!.headDigest="0".repeat(64);
  });
  const before=rows(),spy=vi.spyOn(collector,"collectVentureMyStatus");
  expect((await read({...command(),companyRevision:state.store!.get(caseId).revision})).status).toBe(409);
  expect(spy).not.toHaveBeenCalled();expect(rows()).toEqual(before);
});
it.each(["correction","release","metadata","same-revision-corruption"])("rejects %s during await without leaking a late row",async kind=>{
 const original=collector.collectVentureMyStatus;
 vi.spyOn(collector,"collectVentureMyStatus").mockImplementationOnce(async(...args)=>{
  const value=await original(...args);
  if(kind==="correction")bind("SYNTHETIC-REQUEST-A");
  if(kind==="release")bind(null);
  if(kind==="metadata")correctRound();
  if(kind==="same-revision-corruption")editStored(v=>{v.applicationNumberBindings!.headDigest="0".repeat(64);});
  return value;
 });
 const response=await read();expect(response.status).toBe(409);
 expect(await response.text()).not.toMatch(/SYNTHETIC-REQUEST|observation|PRIVATE/);
 expect(session.operationInProgress).toBe(false);
});
it("holds the existing operation lock and copies caller target before await",async()=>{
 const original=collector.collectVentureMyStatus;let release!:()=>void;
 const spy=vi.spyOn(collector,"collectVentureMyStatus").mockImplementationOnce(async(...args)=>{
  await new Promise<void>(r=>{release=r;});return original(...args);
 });
 const body=command(),before=rows();const first=readBoundVentureMyStatus(caseId,body);
 body.target.bindingId=randomUUID();body.companyRevision=999;
 expect((await read()).status).toBe(409);release();
 expect((await first).target.bindingId).toBe(bindingTarget.bindingId);
 expect(spy).toHaveBeenCalledTimes(1);expect(rows()).toEqual(before);
});
it.each(["not-found","empty","missing","duplicate","masked","unsupported"])("keeps %s unverified without choosing another row",async kind=>{
 const table=page.locator('table').filter({has:page.getByText("신청번호",{exact:true})});
 if(kind==="not-found")await table.locator("tbody tr").nth(1).locator("td").nth(1).evaluate(e=>{e.textContent="SYNTHETIC-request-b";});
 if(kind==="empty")await table.locator("tbody").evaluate(e=>{e.replaceChildren();});
 if(kind==="missing")await table.evaluate(e=>e.remove());
 if(kind==="duplicate")await table.locator("tbody tr").nth(1).locator("td").nth(1).evaluate(e=>{e.textContent="SYNTHETIC-REQUEST-A";});
 if(kind==="masked")await table.locator("tbody tr").nth(1).locator("td").nth(1).evaluate(e=>{e.textContent="SYNTHETIC-***";});
 if(kind==="unsupported")await table.locator("th").first().evaluate(e=>{e.textContent="Unknown";});
 const before=rows(), response=await read();expect(response.status).toBe(200);
 const value=readVentureBoundResult(await response.json(),expected());
 expect(value.observation.target.row).toBeNull();
 expect(value.observation.target.state).toBe(["not-found","empty"].includes(kind)?"not-observed":"unverified");
 expect(rows()).toEqual(before);expect(routed).toBe(1);
});
it.each(["permission","origin","number","row-number","binding","digest","metadata","case","revision","extra","table","empty-match"])(
 "rejects client response mismatch %s",async kind=>{
 const value=await(await read()).json();
 if(kind==="permission")value.observation.officialStatusChecked=true;
 if(kind==="origin")value.observation.origin="supplied-observation";
 if(kind==="number")value.target.applicationNumber="OTHER";
 if(kind==="row-number")value.observation.target.row.applicationNumber="OTHER";
 if(kind==="binding")value.target.bindingId=randomUUID();
 if(kind==="digest")value.target.bindingDigest="0".repeat(64);
 if(kind==="metadata")value.target.metadataVersionId=randomUUID();
 if(kind==="case")value.caseId=randomUUID();
 if(kind==="revision")value.companyRevision++;
 if(kind==="extra")value.observation.certificates=[];
 if(kind==="table")value.observation.applicationTable={state:"not-present"};
 if(kind==="empty-match")value.observation.target.row=null;
 expect(()=>readVentureBoundResult(value,expected())).toThrow();
});
it("SSR makes no read; target command omits the displayed number; decoded output is copied and inert",async()=>{
 const before=rows();
 const markup=renderToStaticMarkup(createElement(VentureinBoundMyStatusPanel,{
  company:state.store!.get(caseId),context:{caseId,companyRevision:readCompanyRevision,accountRevision:1,workflowRevision:1,
   sessionStartedAt:session.status.startedAt!},blocked:false,maskedLoginId:"synthetic***",
 }));
 expect(markup).toContain("직접 선택");expect(markup).not.toContain("<script");expect(fetch).not.toHaveBeenCalled();
 const original=await(await read()).json();
 const raw=structuredClone(original);raw.observation.target.row.resultText='<img src=x onerror="PRIVATE">';
 const parsed=readVentureBoundResult(raw,expected());
 raw.observation.target.row.resultText="changed";
 const output=renderToStaticMarkup(createElement(VentureBoundMyStatusResult,{value:parsed}));
 expect(output).toContain("&lt;img");expect(output).not.toContain("<img");
 const command=ventureBoundReadCommand(expected());
 expect(command.target).not.toHaveProperty("applicationNumber");
 expect(command).not.toHaveProperty("caseId");
 expect(rows()).toEqual(before);
});
