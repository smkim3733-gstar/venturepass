import type { VentureScreenSnapshot } from "./venturein-inspection";
import {
  ventureMyApplicationHeaders, ventureMyCertificateHeaders, ventureMyStatusUrl,
  type VentureMyStatusExpected, type VentureMyTable,
} from "./venturein-my-status";

// Entirely invented fixtures; no customer page values, dates, IDs or copied HTML.
export const myStatusExpected: VentureMyStatusExpected = {
  businessNumber: "777-77-00001", applicationNumber: "SYNTHETIC-REQUEST-B",
};
export function myStatusFixture(): {
  screen: VentureScreenSnapshot; applications: VentureMyTable; certificates: VentureMyTable;
} {
  const screen: VentureScreenSnapshot = {
    id: "synthetic-screen", observedAt: "2031-04-01T01:00:00.000Z",
    url: ventureMyStatusUrl, title: "합성 MY벤처현황",
    companyEvidence: [{ kind: "businessNumber", label: "사업자등록번호", value: "777-77-00001", source: "table" }],
    fields: [], truncated: false, warnings: [],
  };
  const applications: VentureMyTable = {
    state: "observed", headers: [...ventureMyApplicationHeaders],
    rows: [
      ["2", "SYNTHETIC-REQUEST-A", "2031-03-01", "2031-03-20", "탈락", "PRIVATE-IGNORED", "", ""],
      ["1", "SYNTHETIC-REQUEST-B", "2030-01-01", "", "확인", "", "", ""],
    ],
  };
  const certificates: VentureMyTable = {
    state: "observed", headers: [...ventureMyCertificateHeaders, ""],
    rows: [["1", "혁신성장유형", "2030-01-03", "2030-01-03 ~ 2033-01-02", "SYNTHETIC-CERT-9",
      "2030-01-03", "PRIVATE-CHANGES", "PRIVATE-DETAIL", "", "PRIVATE-PRINT"]],
  };
  return { screen, applications, certificates };
}
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function myStatusHtml(input = myStatusFixture(), splitInside = true) {
  const table = (data: VentureMyTable, kind: string, split = false) => {
    if (data.state !== "observed") return "";
    const caption = kind === "application" ? "벤처확인 신청이력 목록 - 합성" : "벤처확인서 이력 목록 - 합성";
    const head = data.headers.map((h) => "<th>" + escape(h) + "</th>").join("");
    const body = data.rows.map((r) => "<tr>" + r.map((c) => "<td>" + escape(c) + "</td>").join("") + "</tr>").join("");
    if (split) return '<div class="board_write_box" id="cert-scope"><table><caption>' + caption +
      "</caption><thead><tr>" + head + "</tr></thead></table>" + (splitInside ? "" : "</div>") +
      '<div class="board_list_scroll"><table><caption>' + caption + "</caption><tbody>" + body +
      "</tbody></table></div>" + (splitInside ? "</div>" : "");
    return '<div class="board_write_box"><table><caption>' + caption + "</caption><thead><tr>" + head +
      "</tr></thead><tbody>" + body + "</tbody></table></div>";
  };
  return '<!doctype html><html><head><meta charset="utf-8"><title>합성 MY벤처현황</title></head><body>' +
    '<a href="/venturein/auth/logout">로그아웃</a><a href="/venturein/auth/viewLogin">로그인</a>' +
    '<h2>MY벤처현황</h2><table><tr><th>사업자등록번호</th><td>777-77-00001</td></tr>' +
    '<tr><th>담당자</th><td>PRIVATE-CONTACT</td></tr></table>' +
    '<input type="hidden" name="csrf" value="PRIVATE-TOKEN">' +
    table(input.applications, "application") + table(input.certificates, "certificate", true) +
    '<ol class="process_flow"><li class="on">진행 안내<ul><li>신청완료일: 합성</li></ul></li></ol>' +
    '<button onclick="document.body.dataset.clicked=1">결제영수증</button></body></html>';
}
