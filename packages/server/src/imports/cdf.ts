import { inflateSync } from 'node:zlib';
import { HttpError } from '../util/fs.js';
export const CDF_MAGIC = 0x20111127;
const fail = (message: string): never => { throw new HttpError(400, 'lemon_import', message); };

class Stream {
  at = 0;
  private entries = 0;
  constructor(readonly data: Buffer) {}
  bytes(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.at) return fail('Truncated or unsupported legacy CDF layout. Re-save it as JSON in LemonLime.');
    const value = this.data.subarray(this.at, this.at + length); this.at += length; return value;
  }
  int() { return this.bytes(4).readInt32BE(); }
  uint() { return this.bytes(4).readUInt32BE(); }
  bool() { const value = this.bytes(1)[0]; if (value > 1) fail('Invalid legacy CDF boolean.'); return !!value; }
  length() {
    const n = this.uint();
    if (n === 0xffffffff) return 0;
    if (n !== 0xfffffffe) return n;
    const wide = this.bytes(8).readBigUInt64BE(); if (wide > BigInt(this.data.length)) return fail('Legacy CDF field is too large.'); return Number(wide);
  }
  string() { const bytes = this.length(); if (bytes % 2) return fail('Invalid legacy CDF string.'); return Buffer.from(this.bytes(bytes)).swap16().toString('utf16le'); }
  list<T>(read: () => T, explicit = false): T[] {
    const length = explicit ? this.int() : this.length();
    if (length < 0 || length > 100000 || (this.entries += length) > 1000000) return fail('Legacy CDF list exceeds the import limit.');
    return Array.from({ length }, read);
  }
  strings() { return this.list(() => this.string()); }
}

function legacy(bytes: Buffer): Record<string, any> {
  if (bytes.length < 14) return fail('Truncated legacy CDF.');
  const length = bytes.readInt32BE(6);
  if (length < 4 || length !== bytes.length - 10) return fail('Unsupported legacy CDF length layout. Re-save it as JSON in LemonLime.');
  const compressed = bytes.subarray(10);
  let crc = 0xffff;
  for (const byte of compressed) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x8408 : 0); }
  if (((~crc) & 0xffff) !== bytes.readUInt16BE(4)) return fail('Legacy CDF checksum mismatch.');
  let data: Buffer;
  try { data = inflateSync(compressed.subarray(4), { maxOutputLength: 64 * 1024 * 1024 }); } catch { return fail('Invalid or oversized compressed CDF.'); }
  const stream = new Stream(data), contestTitle = stream.string();
  const tasks = stream.list(() => {
    const task: Record<string, any> = {};
    for (const key of ['problemTitle', 'sourceFileName', 'inputFileName', 'outputFileName']) task[key] = stream.string();
    task.standardInputCheck = stream.bool(); task.standardOutputCheck = stream.bool();
    const packed = stream.int(); task.taskType = packed & 255; task.subFolderCheck = !!(packed >> 8);
    task.comparisonMode = stream.int(); task.diffArguments = stream.string(); task.realPrecision = stream.int(); task.specialJudge = stream.string();
    if (task.taskType === 2) for (const key of ['interactor', 'grader', 'interactorName']) task[key] = stream.string();
    if ([3, 4].includes(task.taskType)) for (const group of ['source', 'grader']) {
      const entries = stream.list(() => [stream.string(), stream.string()], true);
      task[`${group}FilesPath`] = entries.map(entry => entry[0]); task[`${group}FilesName`] = entries.map(entry => entry[1]);
    }
    task.compilerConfiguration = Object.fromEntries(stream.list(() => [stream.string(), stream.string()]));
    task.answerFileExtension = stream.string();
    task.testCases = stream.list(() => ({ fullScore: stream.int(), timeLimit: stream.int(), memoryLimit: stream.int(), inputFiles: stream.strings(), outputFiles: stream.strings() }), true);
    return task;
  }, true);
  stream.list(() => {
    stream.string(); stream.list(() => stream.bool()); stream.strings(); stream.strings();
    for (let i = 0; i < 2; i++) stream.list(() => stream.list(() => stream.strings()));
    for (let i = 0; i < 3; i++) stream.list(() => stream.list(() => stream.list(() => stream.int())));
    stream.uint(); stream.uint(); stream.bytes(1);
    stream.list(() => stream.int(), true);
    stream.list(() => stream.list(() => stream.list(() => stream.int(), true), true), true);
  }, true);
  if (stream.at !== data.length) return fail('Unsupported trailing legacy CDF layout. Re-save it as JSON in LemonLime.');
  return { version: '1.0', contestTitle, tasks };
}

export function readCdf(bytes: Buffer): Record<string, any> {
  if (bytes.length > 64 * 1024 * 1024) return fail('CDF descriptor exceeds 64 MiB.');
  let value: Record<string, any>;
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === CDF_MAGIC) value = legacy(bytes);
  else {
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').trim()); }
    catch { return fail('Invalid LemonLime CDF. Choose a JSON or supported legacy binary CDF package.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tasks) || value.tasks.length > 1000) return fail('CDF must contain a tasks array (maximum 1000 tasks).');
  if (value.version !== undefined && value.version !== '1.0') return fail(`Unsupported CDF version: ${value.version}`);
  return value;
}
