/**
 * Rows read, counted per request. D1 bills and limits by rows read, and on 15 September 2026 the
 * free daily limit was 76% spent by page renders nobody could see the cost of. Every response now
 * says what it read in an x-d1-rows-read header, so a regression shows up in one curl.
 */

type Meta = { rows_read?: number } | undefined;

export function meter(db: D1Database): { db: D1Database; rows: () => number; heaviest: () => string } {
	let rows = 0;
	const each: { sql: string; rows: number }[] = [];
	const add = (meta: Meta, sql = 'batch') => {
		const n = Number(meta?.rows_read ?? 0);
		rows += n;
		each.push({ sql, rows: n });
	};
	const wrap = (stmt: D1PreparedStatement, sql = ''): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql),
			all: async () => {
				const result = await stmt.all();
				add(result.meta as Meta, sql);
				return result;
			},
			run: async () => {
				const result = await stmt.run();
				add(result.meta as Meta, sql);
				return result;
			},
			raw: (options?: { columnNames?: boolean }) => stmt.raw(options as { columnNames: true }),
			// first() returns no meta, so it is answered from all(): the same query, counted.
			first: async (column?: string) => {
				const result = await stmt.all<Record<string, unknown>>();
				add(result.meta as Meta, sql);
				const row = result.results[0] ?? null;
				return column ? (row ? row[column] : null) : row;
			},
			inner: stmt,
		};
		return wrapped as unknown as D1PreparedStatement;
	};
	const proxy = {
		prepare: (query: string) => wrap(db.prepare(query), query.replace(/\s+/g, ' ').trim().slice(0, 60)),
		batch: async (statements: D1PreparedStatement[]) => {
			const results = await db.batch(statements.map((s) => (s as unknown as { inner?: D1PreparedStatement }).inner ?? s));
			for (const result of results) add(result.meta as Meta);
			return results;
		},
		exec: (query: string) => db.exec(query),
	};
	return {
		db: proxy as unknown as D1Database,
		rows: () => rows,
		// The three statements that read most, for a header: where to look first.
		heaviest: () => [...each].sort((a, b) => b.rows - a.rows).slice(0, 40).map((e) => `${e.rows} ${e.sql.replace(/[^\x20-\x7e]/g, '')}`).join(' | '),
	};
}
