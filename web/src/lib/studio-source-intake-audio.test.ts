import { describe, expect, it } from "vitest";
import { validateSourceIntakeAudio } from "./studio-source-intake-audio";

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}
function mp3() {
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0]).copy(frame);
  return Buffer.concat([frame, frame]);
}
function box(type: string, body: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, body]);
}
function m4a(handler = "soun") {
  return Buffer.concat([
    box("ftyp", Buffer.from("M4A \0\0\0\0M4A ")),
    box(
      "moov",
      box(
        "trak",
        box(
          "mdia",
          box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(handler), Buffer.alloc(12)])),
        ),
      ),
    ),
    box("mdat", Buffer.from("synthetic encoded samples")),
  ]);
}
function element(id: string, body: Buffer) {
  const size =
    body.length < 127
      ? Buffer.from([0x80 | body.length])
      : Buffer.from([0x40 | (body.length >> 8), body.length & 255]);
  return Buffer.concat([Buffer.from(id, "hex"), size, body]);
}
function webm(type = 2, codec = "A_OPUS", unknown = false) {
  const header = element("1a45dfa3", element("4282", Buffer.from("webm")));
  const tracks = element(
    "1654ae6b",
    element(
      "ae",
      Buffer.concat([element("83", Buffer.from([type])), element("86", Buffer.from(codec))]),
    ),
  );
  const cluster = element("1f43b675", element("a3", Buffer.from([0x81, 0, 0, 0x80, 1, 2, 3])));
  const content = Buffer.concat([tracks, cluster]);
  const segment = unknown
    ? Buffer.concat([Buffer.from("18538067ff", "hex"), content])
    : element("18538067", content);
  return Buffer.concat([header, segment]);
}
describe("외부 전사 전 보수적 음성 컨테이너 입구 검사", () => {
  it.each([
    ["fixture.wav", "audio/wav", wav()],
    ["fixture.mp3", "audio/mpeg", mp3()],
    ["fixture.m4a", "audio/mp4", m4a()],
    ["fixture.webm", "audio/webm", webm()],
    ["stream.webm", null, webm(2, "A_VORBIS", true)],
    [
      "tagged.mp3",
      null,
      Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mp3()]),
    ],
  ] as const)("%s를 형식 확인하며 시간·전사 결과를 만들지 않는다", (name, mimeType, buffer) => {
    const original = { name, mimeType, buffer },
      before = Buffer.from(buffer);
    expect(validateSourceIntakeAudio(original)).toEqual(original);
    expect(buffer).toEqual(before);
    expect(Object.keys(validateSourceIntakeAudio(original)).sort()).toEqual([
      "buffer",
      "mimeType",
      "name",
    ]);
  });
  it.each([
    ["test.wav", Buffer.from("RIFF0000WAVE")],
    ["test.wav", Buffer.from("not audio")],
    ["test.mp3", Buffer.from("ID3")],
    ["test.mp3", mp3().subarray(0, 417)],
    ["test.m4a", box("ftyp", Buffer.from("M4A \0\0\0\0M4A "))],
    ["test.m4a", m4a("vide")],
    ["test.webm", webm(1, "V_VP9")],
    ["test.webm", webm(2, "A_UNKNOWN")],
    ["test.webm", Buffer.from("1a45dfa3ff", "hex")],
    ["test.webm", Buffer.from("00000000", "hex")],
  ] as const)("%s 헤더만·영상·손상·미지원 구조는 거부한다", (name, buffer) => {
    expect(() => validateSourceIntakeAudio({ name, mimeType: null, buffer })).toThrow(
      expect.objectContaining({ code: "INTAKE_ORIGINAL_FORMAT" }),
    );
  });
  it.each(["../file.mp3", "C:\\file.wav", "nul.m4a", "file.webm.", "file.ogg", "file.mp4"])(
    "지원 밖 이름 %s를 거부한다",
    (name) => {
      expect(() => validateSourceIntakeAudio({ name, mimeType: null, buffer: mp3() })).toThrow();
    },
  );
  it.each([
    ["fixture.mp3", "video/mp4", mp3()],
    ["fixture.wav", "audio/mpeg", wav()],
    ["fixture.m4a", "application/pdf", m4a()],
    ["fixture.webm", "video/webm", webm()],
  ] as const)("%s의 다른 MIME %s를 거부한다", (name, mimeType, buffer) => {
    expect(() => validateSourceIntakeAudio({ name, mimeType, buffer })).toThrow();
  });
  it("컨테이너에 선언한 범위 밖 길이와 빈 데이터는 거부한다", () => {
    const wave = wav();
    wave.writeUInt32LE(0x7fffffff, 40);
    const mp4 = m4a();
    mp4.writeUInt32BE(0x7fffffff, 0);
    const id3 = Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]),
      mp3(),
    ]);
    for (const [name, buffer] of [
      ["file.wav", wave],
      ["file.m4a", mp4],
      ["file.mp3", id3],
    ] as const)
      expect(() => validateSourceIntakeAudio({ name, mimeType: null, buffer })).toThrow();
    for (const buffer of [Buffer.alloc(0), Buffer.alloc(12 * 1024 * 1024 + 1)])
      expect(() => validateSourceIntakeAudio({ name: "file.wav", mimeType: null, buffer })).toThrow(
        expect.objectContaining({ code: "INTAKE_FILE_LIMIT" }),
      );
  });
  it("작은 WebM 하위 요소의 반복도 전체 탐색 한도에서 거부한다", () => {
    const base = webm(),
      marker = Buffer.from("1f43b675", "hex"),
      start = base.indexOf(marker);
    const cluster = element(
      "1f43b675",
      Buffer.concat([
        element("a3", Buffer.from([0x81, 0, 0, 0x80, 1])),
        element("a3", Buffer.from([0x81, 0, 0, 0x80, 2])),
      ]),
    );
    const headerLength = base.indexOf(Buffer.from("18538067", "hex"));
    const tracksStart = headerLength + 5;
    const excessive = Buffer.concat([
      base.subarray(0, headerLength),
      Buffer.from("18538067ff", "hex"),
      base.subarray(tracksStart, start),
      ...Array(7000).fill(cluster),
    ]);
    expect(() =>
      validateSourceIntakeAudio({ name: "many.webm", mimeType: null, buffer: excessive }),
    ).toThrow(expect.objectContaining({ code: "INTAKE_ORIGINAL_FORMAT" }));
  });
  it("M4A 호환 브랜드 목록도 제한하여 큰 메타데이터 배열 생성을 막는다", () => {
    const normal = m4a(),
      firstBoxSize = normal.readUInt32BE(0);
    const buffer = Buffer.concat([
      box("ftyp", Buffer.concat([Buffer.from("M4A \0\0\0\0"), Buffer.alloc(65 * 4, 0x41)])),
      normal.subarray(firstBoxSize),
    ]);
    expect(() => validateSourceIntakeAudio({ name: "many.m4a", mimeType: null, buffer })).toThrow();
  });
});
