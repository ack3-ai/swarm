import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'

/** Execute production D1 SQL against SQLite, including atomic batches. */
export function sqliteD1(sqlite = new DatabaseSync(':memory:')) {
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

type SchemaEntry = { type: string; name: string; tbl_name: string; sql: string | null }
type TableRows = { table: string; columns: string[]; values: SQLOutputValue[][] }
/** Everything an SQLite database holds: its schema entries in creation order, every row with its
 * rowid and storage class (INTEGER is read as BigInt, REAL as number), and its stored pragmas.
 * Two databases with equal contents differ at most in page layout. */
export interface SqliteContent {
  schema: SchemaEntry[]
  rows: TableRows[]
  pragmas: { user_version: SQLOutputValue; application_id: SQLOutputValue; foreign_keys: SQLOutputValue }
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Read the content of a database, or refuse a shape that `restoreSqlite` cannot copy exactly. */
export function sqliteContent(sqlite: DatabaseSync): SqliteContent {
  const schema = sqlite.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid').all() as SchemaEntry[]
  const temporary = sqlite.prepare('SELECT count(*) AS n FROM sqlite_temp_master').get()!.n
  if (temporary !== 0 || schema.some(entry => !['table', 'index', 'trigger', 'view'].includes(entry.type))) throw new Error('unsupported SQLite schema entry')
  const rows = schema.filter(entry => entry.type === 'table').map(({ name }) => {
    const info = sqlite.prepare('SELECT wr, type FROM pragma_table_list(?)').get(name)!
    const columns = sqlite.prepare('SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(name)
    // Refuse what an INSERT cannot reproduce: internal tables (sqlite_sequence, statistics),
    // WITHOUT ROWID or virtual tables, generated columns. An INTEGER PRIMARY KEY column is the
    // rowid itself; inserting both sets it once, as they come from the same row.
    if (name.startsWith('sqlite_') || info.wr !== 0 || info.type !== 'table' || columns.some(column => column.hidden !== 0)) {
      throw new Error(`SQLite table ${name} cannot be copied exactly`)
    }
    const names = columns.map(column => String(column.name))
    // Numbered aliases keep the column order whatever the names are.
    const select = sqlite.prepare(`SELECT rowid AS "0", ${names.map((column, i) => `${quoted(column)} AS "${i + 1}"`).join(', ')}
      FROM ${quoted(name)} ORDER BY rowid`)
    select.setReadBigInts(true)
    return { table: name, columns: names, values: select.all().map(row => Object.values(row)) }
  })
  const pragma = (name: string) => sqlite.prepare(`PRAGMA ${name}`).get()![name]!
  return { schema, rows, pragmas: { user_version: pragma('user_version'), application_id: pragma('application_id'), foreign_keys: pragma('foreign_keys') } }
}

/** A new in-memory database with exactly `content`: the schema replayed in creation order, and
 * each table's rows (same rowids and storage classes) copied before any trigger exists to fire. */
export function restoreSqlite(content: SqliteContent): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:'), created: TableRows[] = []
  const copyRows = () => {
    for (const { table, columns, values } of created.splice(0)) {
      const insert = sqlite.prepare(`INSERT INTO ${quoted(table)} (rowid, ${columns.map(quoted).join(', ')})
        VALUES (${['?', ...columns.map(() => '?')].join(', ')})`)
      for (const row of values) insert.run(...row)
    }
  }
  sqlite.exec('BEGIN')
  try {
    sqlite.exec('PRAGMA defer_foreign_keys = ON')
    for (const entry of content.schema) {
      if (entry.type === 'trigger') copyRows()
      // Automatic indexes (no SQL) come with their tables, in the same order.
      if (entry.sql !== null) sqlite.exec(entry.sql)
      if (entry.type === 'table') created.push(content.rows.find(rows => rows.table === entry.name)!)
    }
    copyRows()
    sqlite.exec(`PRAGMA user_version = ${Number(content.pragmas.user_version)}`)
    sqlite.exec(`PRAGMA application_id = ${Number(content.pragmas.application_id)}`)
    sqlite.exec('COMMIT')
  } catch (error) { sqlite.close(); throw error }
  sqlite.exec(`PRAGMA foreign_keys = ${Number(content.pragmas.foreign_keys)}`)
  return sqlite
}
