import { StudioError } from "./studio-http";
import {
  sourceIntakeAudioExtensions,
  sourceIntakeExternalLimits,
  sourceIntakeExternalNameSchema,
} from "./studio-source-intake-external-types";

function invalid(): never {
  throw new StudioError(
    "지원되는 음성 파일의 확장자·형식·내용 구조를 확인해 주세요.",
    415,
    "INTAKE_ORIGINAL_FORMAT",
  );
}
const fourcc = (bytes: Buffer, at: number) => bytes.toString("ascii", at, at + 4);
// Admission checks only: no decoding, duration calculation, transcription or external request.
// RIFF: https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-
function wave(bytes: Buffer) {
  if (
    bytes.length < 44 ||
    fourcc(bytes, 0) !== "RIFF" ||
    fourcc(bytes, 8) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalid();
  let format = false,
    data = false,
    offset = 12,
    count = 0;
  while (offset < bytes.length) {
    if (++count > 4000 || offset + 8 > bytes.length) invalid();
    const name = fourcc(bytes, offset),
      size = bytes.readUInt32LE(offset + 4),
      start = offset + 8,
      end = start + size;
    if (end + (size % 2) > bytes.length) invalid();
    if (name === "fmt ") {
      if (format || size < 16) invalid();
      const encoding = bytes.readUInt16LE(start),
        channels = bytes.readUInt16LE(start + 2),
        rate = bytes.readUInt32LE(start + 4),
        align = bytes.readUInt16LE(start + 12),
        bits = bytes.readUInt16LE(start + 14);
      if (
        ![1, 3, 0xfffe].includes(encoding) ||
        !channels ||
        channels > 32 ||
        !rate ||
        rate > 768000 ||
        !align ||
        ![8, 16, 24, 32, 64].includes(bits)
      )
        invalid();
      if (
        encoding === 0xfffe &&
        (size < 40 ||
          bytes.readUInt16LE(start + 16) < 22 ||
          ![1, 3].includes(bytes.readUInt32LE(start + 24)))
      )
        invalid();
      format = true;
    }
    if (name === "data" && size > 0) data = true;
    offset = end + (size % 2);
  }
  if (!format || !data) invalid();
}
// MPEG header framing uses the public bit layout; no compressed samples are interpreted.
// Reference implementation: https://github.com/quodlibet/mutagen/blob/main/mutagen/mp3/__init__.py
function mp3(bytes: Buffer) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (
      bytes.length < 10 ||
      ![2, 3, 4].includes(bytes[3]) ||
      bytes[4] === 255 ||
      bytes.subarray(6, 10).some((byte) => byte > 127)
    )
      invalid();
    const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    offset = 10 + size + (bytes[3] === 4 && bytes[5] & 0x10 ? 10 : 0);
  }
  let format = "";
  for (let frame = 0; frame < 2; frame++) {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0)
      invalid();
    const version = (bytes[offset + 1] >> 3) & 3,
      layer = (bytes[offset + 1] >> 1) & 3,
      index = bytes[offset + 2] >> 4,
      sample = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || sample === 3) invalid();
    const signature = `${version}:${sample}`;
    if (format && format !== signature) invalid();
    format = signature;
    const rates =
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length =
      Math.floor(((version === 3 ? 144 : 72) * rates[index] * 1000) / sampleRate) +
      ((bytes[offset + 2] >> 1) & 1);
    if (length < 4 || offset + length > bytes.length) invalid();
    offset += length;
  }
}
type Box = { type: string; start: number; end: number };
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (result.length >= 4000 || start + 8 > end) invalid();
    let size = bytes.readUInt32BE(start),
      header = 8;
    const type = fourcc(bytes, start + 4);
    if (size === 1) {
      if (start + 16 > end || bytes.readUInt32BE(start + 8) !== 0) invalid();
      size = bytes.readUInt32BE(start + 12);
      header = 16;
    } else if (size === 0) size = end - start;
    if (size < header || size > end - start) invalid();
    result.push({ type, start: start + header, end: start + size });
    start += size;
  }
  return result;
}
// hdlr handler_type soun identifies an audio media track, not a filename's claimed type.
// https://developer.apple.com/documentation/quicktime-file-format/handler_reference_atom
function m4a(bytes: Buffer) {
  const top = boxes(bytes),
    ftyp = top.find((box) => box.type === "ftyp"),
    moov = top.filter((box) => box.type === "moov");
  if (
    !ftyp ||
    ftyp.end - ftyp.start < 8 ||
    ftyp.end - ftyp.start > 8 + 64 * 4 ||
    (ftyp.end - ftyp.start) % 4 ||
    moov.length !== 1 ||
    !top.some((box) => box.type === "mdat" && box.end > box.start)
  )
    invalid();
  const brands = [fourcc(bytes, ftyp.start)];
  for (let at = ftyp.start + 8; at < ftyp.end; at += 4) brands.push(fourcc(bytes, at));
  if (!brands.some((brand) => ["M4A ", "M4B ", "isom", "iso2", "mp41", "mp42"].includes(brand)))
    invalid();
  const tracks = boxes(bytes, moov[0].start, moov[0].end).filter((box) => box.type === "trak");
  if (!tracks.length || tracks.length > 32) invalid();
  for (const track of tracks) {
    const media = boxes(bytes, track.start, track.end).filter((box) => box.type === "mdia");
    if (media.length !== 1) invalid();
    const handlers = boxes(bytes, media[0].start, media[0].end).filter(
      (box) => box.type === "hdlr",
    );
    if (
      handlers.length !== 1 ||
      handlers[0].end - handlers[0].start < 12 ||
      fourcc(bytes, handlers[0].start + 8) !== "soun"
    )
      invalid();
  }
}
type Element = { id: number; start: number; end: number };
function vint(bytes: Buffer, start: number, end: number, identifier: boolean) {
  if (start >= end || bytes[start] === 0) return invalid();
  let marker = 0x80,
    length = 1;
  while (!(bytes[start] & marker)) {
    marker >>= 1;
    length++;
  }
  if (length > (identifier ? 4 : 8) || start + length > end) return invalid();
  let value = identifier ? bytes[start] : bytes[start] & (marker - 1),
    unknown = !identifier && value === marker - 1;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[start + index];
    unknown &&= bytes[start + index] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) return invalid();
  return { value, length, unknown };
}
function elements(
  bytes: Buffer,
  start: number,
  end: number,
  unknownAllowed = false,
  budget = { remaining: 20_000 },
): Element[] {
  const result: Element[] = [];
  while (start < end) {
    if (result.length >= 10000 || --budget.remaining < 0) invalid();
    const id = vint(bytes, start, end, true),
      size = vint(bytes, start + id.length, end, false),
      body = start + id.length + size.length;
    if (size.unknown && (!unknownAllowed || ![0x18538067, 0x1f43b675].includes(id.value)))
      invalid();
    const finish = size.unknown ? end : body + size.value;
    if (finish > end || finish < body) invalid();
    result.push({ id: id.value, start: body, end: finish });
    start = finish;
  }
  return result;
}
function uint(bytes: Buffer, element: Element) {
  if (element.end <= element.start || element.end - element.start > 4) return invalid();
  return bytes.readUIntBE(element.start, element.end - element.start);
}
// https://www.matroska.org/technical/elements.html (WebM TrackType=audio, CodecID, Cluster)
function webm(bytes: Buffer) {
  const budget = { remaining: 20_000 };
  const read = (start: number, end: number, unknown = false) =>
    elements(bytes, start, end, unknown, budget);
  const top = read(0, bytes.length, true),
    header = top[0],
    segments = top.filter((entry) => entry.id === 0x18538067);
  if (header?.id !== 0x1a45dfa3 || segments.length !== 1) invalid();
  const types = read(header.start, header.end).filter((entry) => entry.id === 0x4282);
  if (types.length !== 1 || bytes.toString("ascii", types[0].start, types[0].end) !== "webm")
    invalid();
  const children = read(segments[0].start, segments[0].end, true),
    tracks = children.filter((entry) => entry.id === 0x1654ae6b),
    clusters = children.filter((entry) => entry.id === 0x1f43b675);
  if (tracks.length !== 1 || !clusters.length) invalid();
  const entries = read(tracks[0].start, tracks[0].end).filter((entry) => entry.id === 0xae);
  if (!entries.length || entries.length > 32) invalid();
  for (const entry of entries) {
    const fields = read(entry.start, entry.end),
      type = fields.filter((value) => value.id === 0x83),
      codecs = fields.filter((value) => value.id === 0x86);
    if (
      type.length !== 1 ||
      uint(bytes, type[0]) !== 2 ||
      codecs.length !== 1 ||
      !["A_OPUS", "A_VORBIS"].includes(bytes.toString("ascii", codecs[0].start, codecs[0].end))
    )
      invalid();
  }
  const blocks = clusters
    .flatMap((cluster) =>
      read(cluster.start, cluster.end).flatMap((entry) =>
        entry.id === 0xa0 ? read(entry.start, entry.end) : [entry],
      ),
    )
    .filter((entry) => [0xa3, 0xa1].includes(entry.id));
  if (!blocks.some((block) => block.end - block.start > 4)) invalid();
}
/** Strict supported-container admission. Does not claim the audio can be decoded or is speech. */
export function validateSourceIntakeAudio(original: {
  name: string;
  mimeType: string | null;
  buffer: Buffer;
}) {
  sourceIntakeExternalNameSchema.parse(original.name);
  const extension = original.name.slice(original.name.lastIndexOf(".") + 1).toLowerCase();
  if (!(sourceIntakeAudioExtensions as readonly string[]).includes(extension)) invalid();
  if (!original.buffer.length || original.buffer.length > sourceIntakeExternalLimits.fileBytes)
    throw new StudioError("원본 크기를 확인해 주세요.", 413, "INTAKE_FILE_LIMIT");
  const mimeType = original.mimeType?.trim().toLowerCase() || null;
  const mimes: Record<string, string[]> = {
    mp3: ["audio/mpeg", "audio/mp3"],
    m4a: ["audio/mp4", "audio/x-m4a"],
    wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
    webm: ["audio/webm"],
  };
  if (
    mimeType !== null &&
    mimeType !== "application/octet-stream" &&
    !mimes[extension].includes(mimeType)
  )
    invalid();
  (({ mp3, m4a, wav: wave, webm }) as Record<string, (value: Buffer) => void>)[extension](
    original.buffer,
  );
  return { ...original, mimeType };
}
