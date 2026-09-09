/* THE RECORD, REACHED FROM DENO, FOR THIS CANARY AND NOTHING ELSE.
 *
 * The repository adapter in workers/core-v2/postgres speaks to a client with
 * exactly two methods: query(sql, params) and transaction(fn). Its own wire
 * client implements them over a raw socket with no TLS and no password,
 * which is right for a throwaway cluster on a unix socket and useless for a
 * hosted database. This file implements the same two methods over
 * jsr:@db/postgres so the SAME repository, the SAME savepoints and the SAME
 * atomic submission run unchanged against SUPABASE_DB_URL.
 *
 * Three things matter and are easy to get wrong:
 *
 *  1. ONE CONNECTION, ONE STATEMENT AT A TIME. The repository opens
 *     transactions and runs savepoints inside them; a pooled client would
 *     scatter those statements across sessions and the savepoint would be
 *     rolled back on a connection that never took it. Every call is queued
 *     behind the one before it, exactly as the wire client queues.
 *
 *  2. EVERY VALUE COMES BACK AS TEXT. The repository's parsers are written
 *     against a client that asked for text format for every column, so a
 *     driver that helpfully turns numerics into numbers and jsonb into
 *     objects would hand it shapes it does not parse. decodeStrategy
 *     "string" turns that off.
 *
 *  3. TRANSACTIONS ARE PLAIN SQL. begin, commit, rollback are issued as
 *     statements rather than through the driver's own transaction object, so
 *     the repository's `savepoint core_v2_submit` and its rollback are the
 *     statements it wrote and not something a wrapper reinterpreted.
 *
 * Nothing here is a Core V2 rule. It is a driver.
 */
import { Client } from "jsr:@db/postgres@^0.19.5";

export type Param = string | number | boolean | null | undefined;
export type Row = Record<string, string | null>;
export type QueryResult = { command: string; rowCount: number; rows: Row[]; fields: string[] };
export type Queryable = { query(sql: string, params?: Param[]): Promise<QueryResult> };

export class CanaryDatabase {
  private client: Client;
  private tail: Promise<unknown> = Promise.resolve();
  private ended = false;

  private constructor(client: Client) {
    this.client = client;
  }

  /* One connection, from the url the platform provides. The password is in
     that url and is never read out of it, logged, or put anywhere else. */
  static async connect(databaseUrl: string, applicationName: string): Promise<CanaryDatabase> {
    const url = new URL(databaseUrl);
    const client = new Client({
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, "") || "postgres",
      applicationName,
      tls: { enabled: true, enforce: false },
      /* Text for everything: the repository parses text. */
      controls: { decodeStrategy: "string" },
      /* One attempt. A driver that reconnects on its own would silently move
         a transaction to a session that never began one. */
      connection: { attempts: 1 },
    });
    await client.connect();
    return new CanaryDatabase(client);
  }

  /* Serialise, so a transaction's statements cannot interleave with anything. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.tail.then(work, work);
    this.tail = mine.then(() => undefined, () => undefined);
    return mine;
  }

  private async run(sql: string, params: Param[] = []): Promise<QueryResult> {
    const args = params.map((p) => (p === undefined ? null : p));
    const result = await this.client.queryObject<Record<string, string | null>>({ text: sql, args });
    return {
      command: String((result as { command?: unknown }).command ?? ""),
      rowCount: Number((result as { rowCount?: unknown }).rowCount ?? result.rows.length),
      rows: result.rows as Row[],
      fields: [],
    };
  }

  query(sql: string, params: Param[] = []): Promise<QueryResult> {
    return this.enqueue(() => this.run(sql, params));
  }

  /* Holds the connection for the whole block, exactly as the wire client
     does: begin, the block's statements on `tx`, commit — or rollback and
     rethrow. Inside the block use `tx`, or the block waits for itself. */
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

  get isClosed(): boolean { return this.ended; }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.enqueue(async () => { await this.client.end(); });
  }
}
