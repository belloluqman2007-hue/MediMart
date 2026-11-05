export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;
export interface SqlExecutor {
  run(sql: string, values?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T extends SqlRow = SqlRow>(sql: string, values?: readonly SqlValue[]): Promise<T[]>;
}
export interface SqlDriver extends SqlExecutor {
  close(): Promise<void>;
}
export interface Database extends SqlExecutor {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/**
 * Serialize the entire transaction, including awaits. Without this gate another request
 * could accidentally execute inside a transaction on the same SQLite connection.
 * Inside a transaction use only `tx`, never the outer connection (which would deadlock).
 */
export class SerializedDatabase implements Database {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly driver: SqlDriver) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => {
      if (this.closed) throw new Error('Database is closed.');
      return work();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  run(sql: string, values?: readonly SqlValue[]) {
    return this.exclusive(() => this.driver.run(sql, values));
  }
  all<T extends SqlRow = SqlRow>(sql: string, values?: readonly SqlValue[]) {
    return this.exclusive(() => this.driver.all<T>(sql, values));
  }
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.driver.run('BEGIN IMMEDIATE');
      try {
        const value = await work(this.driver);
        await this.driver.run('COMMIT');
        return value;
      } catch (error) {
        try {
          await this.driver.run('ROLLBACK');
        } catch (rollbackError) {
          // A connection with unknown transaction state must never accept another write.
          this.closed = true;
          await this.driver.close().catch(() => undefined);
          throw new AggregateError(
            [error, rollbackError],
            'Transaction rollback failed; the database connection was closed.',
            { cause: rollbackError },
          );
        }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closing ??= this.exclusive(async () => {
      this.closed = true;
      await this.driver.close();
    });
    return this.closing;
  }
}
