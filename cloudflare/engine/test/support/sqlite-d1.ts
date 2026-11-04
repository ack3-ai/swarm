import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** Execute production D1 SQL against SQLite, including atomic batches. */
export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:')
  let afterRun: ((sql: string) => void) | undefined
  const prepare = (sql: string, values: SQLInputValue[] = []) => {
    const named = /\?\d+/.test(sql)
      ? Object.fromEntries(values.map((value, i) => [`?${i + 1}`, value])) : null
    const execute = () => {
      const statement = sqlite.prepare(sql)
      const result = named === null ? statement.run(...values) : statement.run(named)
      afterRun?.(sql)
      return { success: true, meta: { changes: Number(result.changes) } }
    }
    return {
      execute,
      bind: (...bound: SQLInputValue[]) => prepare(sql, bound),
      async run() { return execute() },
      async first() {
        const statement = sqlite.prepare(sql)
        return (named === null ? statement.get(...values) : statement.get(named)) ?? null
      },
      async all() {
        const statement = sqlite.prepare(sql)
        return { success: true, results: named === null ? statement.all(...values) : statement.all(named) }
      },
    }
  }
  return { sqlite, onAfterRun: (callback?: (sql: string) => void) => { afterRun = callback },
    d1: { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        // D1 executes each batch atomically. Do not yield inside SQLite's
        // transaction and let a concurrent request start a nested transaction.
        const results = statements.map(statement => statement.execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    } } as unknown as D1Database,
  }
}
