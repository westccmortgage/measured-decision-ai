/* A POSTGRESQL WIRE-PROTOCOL CLIENT WITH NOTHING UNDERNEATH IT.
 *
 * Protocol version 3, over a unix socket or TCP, speaking trust
 * authentication only: the record lives beside the worker, and a password
 * never travels through this file. It knows the messages the adapter needs
 * — startup, simple query, the extended Parse/Bind/Describe/Execute/Sync
 * cycle with text parameters and text results — and decodes errors and
 * notices into their SQLSTATE, message, detail, hint and constraint name.
 *
 * One socket, one request in flight. Every call is queued behind the one
 * before it, and `transaction(fn)` holds the queue for the whole block, so
 * the statements of one transaction cannot interleave with anybody else's.
 *
 * `node:net` is the only module imported. No pool, no TLS, no password.
 */
import { createConnection } from "node:net";
import type { Socket } from "node:net";

export type Row = Record<string, string | null>;
export type Param = string | number | boolean | null | undefined;
export type QueryResult = { command: string; rowCount: number; rows: Row[]; fields: string[] };
export type Queryable = { query(sql: string, params?: Param[]): Promise<QueryResult> };
export type ConnectOptions = {
  socketPath?: string;
  host?: string;
  port?: number;
  user: string;
  database: string;
  applicationName?: string;
};
export type NoticeFields = { severity: string; code: string; message: string; detail: string | null; hint: string | null };

const PROTOCOL_VERSION = 196608; /* 3.0 */

const ERROR_FIELD: Record<string, string> = {
  S: "severity", V: "severityCode", C: "code", M: "message", D: "detail", H: "hint", P: "position",
  p: "internalPosition", q: "internalQuery", W: "where", s: "schema", t: "table", c: "column",
  d: "dataType", n: "constraint", F: "file", L: "line", R: "routine",
};

export class PostgresError extends Error {
  severity: string;
  code: string;
  detail: string | null;
  hint: string | null;
  position: string | null;
  where: string | null;
  schema: string | null;
  table: string | null;
  column: string | null;
  constraint: string | null;
  routine: string | null;
  constructor(fields: Record<string, string>) {
    super(fields.message ?? "postgres: an error without a message");
    this.name = "PostgresError";
    this.severity = fields.severity ?? "ERROR";
    this.code = fields.code ?? "XX000";
    this.detail = fields.detail ?? null;
    this.hint = fields.hint ?? null;
    this.position = fields.position ?? null;
    this.where = fields.where ?? null;
    this.schema = fields.schema ?? null;
    this.table = fields.table ?? null;
    this.column = fields.column ?? null;
    this.constraint = fields.constraint ?? null;
    this.routine = fields.routine ?? null;
  }
}

export function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof PostgresError;
}

/* ───────────────────────────────────────────────────────── encoding */

class Writer {
  private parts: Buffer[] = [];
  byte(value: number): this { this.parts.push(Buffer.from([value & 0xff])); return this; }
  int16(value: number): this { const b = Buffer.alloc(2); b.writeInt16BE(value, 0); this.parts.push(b); return this; }
  int32(value: number): this { const b = Buffer.alloc(4); b.writeInt32BE(value, 0); this.parts.push(b); return this; }
  cstring(value: string): this { this.parts.push(Buffer.from(value, "utf8"), Buffer.from([0])); return this; }
  bytes(value: Buffer): this { this.parts.push(value); return this; }
  /* A framed message: the type byte (absent for startup), then the length
     counting itself, then the payload. */
  frame(type: string | null): Buffer {
    const payload = Buffer.concat(this.parts);
    const head = Buffer.alloc(type === null ? 4 : 5);
    let offset = 0;
    if (type !== null) { head.writeUInt8(type.charCodeAt(0), 0); offset = 1; }
    head.writeInt32BE(payload.length + 4, offset);
    return Buffer.concat([head, payload]);
  }
}

function encodeParam(value: Param): Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("postgres: a parameter must be a finite number");
    return Buffer.from(String(value), "utf8");
  }
  return Buffer.from(value ? "true" : "false", "utf8");
}

function startupMessage(options: ConnectOptions): Buffer {
  const w = new Writer().int32(PROTOCOL_VERSION)
    .cstring("user").cstring(options.user)
    .cstring("database").cstring(options.database)
    .cstring("client_encoding").cstring("UTF8");
  if (options.applicationName) w.cstring("application_name").cstring(options.applicationName);
  return w.byte(0).frame(null);
}

function simpleQueryMessage(sql: string): Buffer {
  return new Writer().cstring(sql).frame("Q");
}

/* Parse (unnamed statement), Bind (unnamed portal, every parameter and every
   result in text), Describe the portal, Execute without a row limit, Sync. */
function extendedQueryMessage(sql: string, params: Param[]): Buffer {
  const parse = new Writer().cstring("").cstring(sql).int16(0).frame("P");
  const bind = new Writer().cstring("").cstring("").int16(0).int16(params.length);
  for (const p of params) {
    const encoded = encodeParam(p);
    if (encoded === null) bind.int32(-1);
    else bind.int32(encoded.length).bytes(encoded);
  }
  bind.int16(0);
  const describe = new Writer().byte("P".charCodeAt(0)).cstring("").frame("D");
  const execute = new Writer().cstring("").int32(0).frame("E");
  const sync = new Writer().frame("S");
  return Buffer.concat([parse, bind.frame("B"), describe, execute, sync]);
}

/* ───────────────────────────────────────────────────────── decoding */

type Frame = { type: string; body: Buffer };

function readCString(body: Buffer, offset: number): { text: string; next: number } {
  const end = body.indexOf(0, offset);
  if (end < 0) throw new Error("postgres: an unterminated string in a message from the server");
  return { text: body.toString("utf8", offset, end), next: end + 1 };
}

function decodeErrorFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const type = body.readUInt8(offset);
    if (type === 0) break;
    const { text, next } = readCString(body, offset + 1);
    fields[ERROR_FIELD[String.fromCharCode(type)] ?? String.fromCharCode(type)] = text;
    offset = next;
  }
  return fields;
}

function decodeRowDescription(body: Buffer): string[] {
  const count = body.readInt16BE(0);
  const names: string[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const { text, next } = readCString(body, offset);
    names.push(text);
    /* table oid (4), attribute number (2), type oid (4), type size (2),
       type modifier (4), format code (2) */
    offset = next + 18;
  }
  return names;
}

function decodeDataRow(body: Buffer, fields: string[]): Row {
  const count = body.readInt16BE(0);
  const row: Row = {};
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const length = body.readInt32BE(offset);
    offset += 4;
    const name = fields[i] ?? `column${i}`;
    if (length < 0) { row[name] = null; continue; }
    row[name] = body.toString("utf8", offset, offset + length);
    offset += length;
  }
  return row;
}

function decodeCommandComplete(body: Buffer): { command: string; rowCount: number } {
  const tag = readCString(body, 0).text;
  const words = tag.split(" ");
  const last = words[words.length - 1];
  const rowCount = words.length > 1 && /^\d+$/.test(last) ? Number(last) : 0;
  return { command: words[0], rowCount };
}

/* Everything one request produces, gathered until ReadyForQuery. */
class Exchange {
  results: QueryResult[] = [];
  private current: QueryResult | null = null;
  error: PostgresError | null = null;
  readonly resolve: (results: QueryResult[]) => void;
  readonly reject: (error: Error) => void;
  constructor(resolve: (results: QueryResult[]) => void, reject: (error: Error) => void) {
    this.resolve = resolve;
    this.reject = reject;
  }
  frame(f: Frame): boolean {
    switch (f.type) {
      case "T": this.current = { command: "", rowCount: 0, rows: [], fields: decodeRowDescription(f.body) }; return false;
      case "n": this.current = { command: "", rowCount: 0, rows: [], fields: [] }; return false;
      case "D": {
        if (!this.current) this.current = { command: "", rowCount: 0, rows: [], fields: [] };
        this.current.rows.push(decodeDataRow(f.body, this.current.fields));
        return false;
      }
      case "C": {
        const { command, rowCount } = decodeCommandComplete(f.body);
        const result = this.current ?? { command: "", rowCount: 0, rows: [], fields: [] };
        result.command = command;
        result.rowCount = command === "SELECT" || rowCount === 0 ? Math.max(rowCount, result.rows.length) : rowCount;
        this.results.push(result);
        this.current = null;
        return false;
      }
      case "I": this.results.push({ command: "", rowCount: 0, rows: [], fields: [] }); this.current = null; return false;
      case "E": this.error = new PostgresError(decodeErrorFields(f.body)); return false;
      case "Z": return true;
      /* ParseComplete, BindComplete, CloseComplete, PortalSuspended: nothing to keep. */
      case "1": case "2": case "3": case "s": return false;
      default: return false;
    }
  }
}

/* ───────────────────────────────────────────────────────── the client */

export class WireClient {
  private socket: Socket;
  private buffered: Buffer = Buffer.alloc(0);
  private exchange: Exchange | null = null;
  private startup: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed: Error | null = null;
  private closing = false;
  readonly parameters: Record<string, string> = {};
  readonly notices: NoticeFields[] = [];
  onNotice: ((notice: NoticeFields) => void) | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("postgres: the connection closed")));
  }

  /* Connect and complete the startup handshake. Anything but trust
     authentication is refused here with a plain message. */
  static connect(options: ConnectOptions): Promise<WireClient> {
    if (!options.socketPath && !(options.host && options.port)) {
      return Promise.reject(new Error("postgres: connect needs a socket path, or a host and a port"));
    }
    return new Promise((resolve, reject) => {
      const socket = options.socketPath
        ? createConnection({ path: options.socketPath })
        : createConnection({ host: options.host, port: options.port });
      socket.setNoDelay(true);
      const client = new WireClient(socket);
      client.startup = { resolve: () => resolve(client), reject };
      socket.once("connect", () => { socket.write(startupMessage(options)); });
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = this.closing ? new Error("postgres: the connection is closed") : error;
    if (this.startup) { const s = this.startup; this.startup = null; if (!this.closing) s.reject(error); }
    if (this.exchange) { const e = this.exchange; this.exchange = null; e.reject(error); }
  }

  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (this.buffered.length >= 5) {
      const length = this.buffered.readInt32BE(1);
      if (this.buffered.length < length + 1) break;
      const frame: Frame = { type: String.fromCharCode(this.buffered.readUInt8(0)), body: this.buffered.subarray(5, length + 1) };
      this.buffered = this.buffered.subarray(length + 1);
      this.dispatch(frame);
    }
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case "S": {
        const name = readCString(frame.body, 0);
        this.parameters[name.text] = readCString(frame.body, name.next).text;
        return;
      }
      case "K": return; /* BackendKeyData: cancellation is not something this client does. */
      case "N": {
        const f = decodeErrorFields(frame.body);
        const notice: NoticeFields = { severity: f.severity ?? "NOTICE", code: f.code ?? "00000", message: f.message ?? "", detail: f.detail ?? null, hint: f.hint ?? null };
        this.notices.push(notice);
        if (this.onNotice) this.onNotice(notice);
        return;
      }
      case "A": return; /* NotificationResponse: nobody listens here. */
    }
    if (this.startup) {
      if (frame.type === "R") {
        const method = frame.body.readInt32BE(0);
        if (method === 0) return;
        const s = this.startup; this.startup = null;
        s.reject(new Error(`postgres: the server asked for authentication method ${method}; this client speaks trust authentication only`));
        this.socket.destroy();
        return;
      }
      if (frame.type === "E") {
        const s = this.startup; this.startup = null;
        s.reject(new PostgresError(decodeErrorFields(frame.body)));
        this.socket.destroy();
        return;
      }
      if (frame.type === "Z") { const s = this.startup; this.startup = null; s.resolve(); return; }
      return;
    }
    if (!this.exchange) return;
    if (this.exchange.frame(frame)) {
      const e = this.exchange; this.exchange = null;
      if (e.error) e.reject(e.error); else e.resolve(e.results);
    }
  }

  private send(message: Buffer): Promise<QueryResult[]> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.exchange) return Promise.reject(new Error("postgres: a request is already in flight on this connection"));
    return new Promise((resolve, reject) => {
      this.exchange = new Exchange(resolve, reject);
      this.socket.write(message);
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async run(sql: string, params: Param[]): Promise<QueryResult> {
    const results = await this.send(extendedQueryMessage(sql, params));
    return results[results.length - 1] ?? { command: "", rowCount: 0, rows: [], fields: [] };
  }

  /* One statement, parameters as text, results as text. */
  query(sql: string, params: Param[] = []): Promise<QueryResult> {
    return this.enqueue(() => this.run(sql, params));
  }

  /* The simple query protocol: several statements in one string, run as one
     implicit transaction unless the text says otherwise. One result per
     statement that produced one. */
  simple(sql: string): Promise<QueryResult[]> {
    return this.enqueue(() => this.send(simpleQueryMessage(sql)));
  }

  begin(): Promise<void> { return this.query("begin").then(() => undefined); }
  commit(): Promise<void> { return this.query("commit").then(() => undefined); }
  rollback(): Promise<void> { return this.query("rollback").then(() => undefined); }

  /* Holds the connection for the whole block: begin, the block's statements
     on `tx`, commit — or rollback and rethrow when the block throws. Inside
     the block use `tx`, not the client, or the block waits for itself. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.run("begin", []);
      const tx: Queryable = { query: (sql, params = []) => this.run(sql, params) };
      try {
        const out = await fn(tx);
        await this.run("commit", []);
        return out;
      } catch (error) {
        try { await this.run("rollback", []); } catch { /* the connection is gone; the cause is thrown below */ }
        throw error;
      }
    });
  }

  get isClosed(): boolean { return this.closed !== null; }

  /* Terminate, then wait for the socket to close. */
  end(): Promise<void> {
    return this.enqueue(() => new Promise<void>((resolve) => {
      if (this.closed) { resolve(); return; }
      this.closing = true;
      this.socket.once("close", () => resolve());
      this.socket.write(new Writer().frame("X"));
      this.socket.end();
    }));
  }
}
