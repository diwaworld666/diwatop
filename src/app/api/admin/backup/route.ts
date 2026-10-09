import { db } from "@/db";
import * as schema from "@/db/schema";
import { json, requirePerm, checkOrigin } from "@/lib/api";
import { sql, getTableColumns } from "drizzle-orm";

/**
 * Full application database backup/restore.
 *
 * The list intentionally mirrors every table exported by src/db/schema.ts.
 * Keep this list in dependency order: parents first, children later.
 * Restore happens inside ONE transaction so a failed import cannot leave a
 * half-restored database.
 *
 * ---------------------------------------------------------------------------
 * Why restore is written the way it is (read this before changing anything):
 *
 * A backup is a JSON file. JSON has exactly six value types (string, number,
 * boolean, null, array, object) — it has no "Date" type and no concept of
 * "this table has no primary key." Every bug this route has had came from
 * treating the parsed JSON as if it already matched what Postgres/Drizzle
 * expects, instead of explicitly reconciling the two. So instead of
 * hardcoding per-table special cases (which is how the previous version
 * broke one table at a time — first `users`' timestamp, then the join
 * tables' missing `id`), everything below is driven off the actual schema
 * via `getTableColumns()`, so it's automatically correct for every current
 * and future table without needing a matching fix each time the schema
 * changes:
 *
 *   1. Rows are filtered down to columns that still exist on the table.
 *      An export taken from an older/newer version of the app may contain
 *      columns that have since been renamed or removed — inserting those
 *      would fail with "column does not exist." Columns present in the
 *      schema but absent from an old export are simply left out of the
 *      INSERT, so Postgres applies that column's own DEFAULT — exactly the
 *      right behavior, no special-casing needed.
 *   2. Any column Drizzle reports as `dataType === "date"` gets its string
 *      value (however it survived JSON.parse) converted back into a real
 *      `Date`, since the driver requires an actual Date for those.
 *   3. The post-restore sequence repair only runs for tables that actually
 *      have an `id` column — join tables (`game_tags`, `post_tags`) and the
 *      key/value `settings` table don't, and asking Postgres for a
 *      nonexistent column's sequence throws.
 * ---------------------------------------------------------------------------
 */
const TABLES = [
  "users", "categories", "games", "downloadLinks", "tags", "gameTags",
  "posts", "postTags", "reviews", "pages", "settings", "redirects",
  "notFoundLogs", "newsletterSubs", "gameRequests", "reports",
  "contactMessages", "auditLogs",
] as const;

type TableKey = (typeof TABLES)[number];

const DB_TABLE_NAMES: Record<TableKey, string> = {
  users: "users",
  categories: "categories",
  games: "games",
  downloadLinks: "download_links",
  tags: "tags",
  gameTags: "game_tags",
  posts: "posts",
  postTags: "post_tags",
  reviews: "reviews",
  pages: "pages",
  settings: "settings",
  redirects: "redirects",
  notFoundLogs: "not_found_logs",
  newsletterSubs: "newsletter_subs",
  gameRequests: "game_requests",
  reports: "reports",
  contactMessages: "contact_messages",
  auditLogs: "audit_logs",
};

const SCHEMA_TABLES = schema as unknown as Record<TableKey, any>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full-database restore can take longer than the platform's default
// function timeout once there are more than a few hundred rows (Supabase's
// pooler + many chunked inserts inside one transaction adds up). Vercel
// honors this per-route on Pro/Enterprise plans (capped at 300s here to
// stay within the platform ceiling on every plan tier); on Hobby it is
// capped at 60s regardless of this value. Self-hosted/Node deployments
// ignore it entirely.
export const maxDuration = 300;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/* ---------------------------- Schema introspection ----------------------- *
 * One lookup per table, cached, driven entirely off the live Drizzle schema
 * — never a hand-maintained list — so it can't drift out of sync with
 * src/db/schema.ts the way separate per-table logic did before.
 */
type ColumnInfo = { key: string; isDate: boolean };

const tableInfoCache = new Map<TableKey, { columns: ColumnInfo[]; hasId: boolean }>();

function tableInfo(key: TableKey): { columns: ColumnInfo[]; hasId: boolean } {
  let info = tableInfoCache.get(key);
  if (!info) {
    const cols = getTableColumns(SCHEMA_TABLES[key]) as Record<string, { dataType?: string }>;
    const columns = Object.entries(cols).map(([field, col]) => ({
      key: field,
      isDate: col.dataType === "date",
    }));
    info = { columns, hasId: "id" in cols };
    tableInfoCache.set(key, info);
  }
  return info;
}

/**
 * Reconciles one exported row against the table's actual current columns:
 * drops any key the schema no longer has, and turns date-typed columns
 * back into real `Date` objects. See the file header comment for why.
 */
function sanitizeRow(key: TableKey, row: Record<string, unknown>): Record<string, unknown> {
  const { columns } = tableInfo(key);
  const clean: Record<string, unknown> = {};
  for (const { key: col, isDate } of columns) {
    if (!(col in row)) continue; // let Postgres apply the column's own DEFAULT
    const v = row[col];
    clean[col] = isDate && typeof v === "string" && v ? new Date(v) : v;
  }
  return clean;
}

function sanitizeRows(key: TableKey, rows: unknown[]): Record<string, unknown>[] {
  return rows.filter(isPlainObject).map((row) => sanitizeRow(key, row));
}

export async function GET() {
  const auth = await requirePerm("*");
  if (auth instanceof Response) return auth;

  try {
    const dump: Record<string, unknown[]> = {};
    for (const key of TABLES) {
      dump[key] = await db.select().from(SCHEMA_TABLES[key]);
    }

    const payload = {
      app: "YonoDiwaGames",
      format: "full-database-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      tables: TABLES,
      data: dump,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, private",
        "content-disposition": `attachment; filename="yonodiwagames-backup-${Date.now()}.json"`,
      },
    });
  } catch (err) {
    console.error("[admin/backup] export failed:", err);
    return json({ error: "Database backup export failed. Check the server logs." }, 500);
  }
}

export async function POST(req: Request) {
  const auth = await requirePerm("*");
  if (auth instanceof Response) return auth;
  if (!checkOrigin(req)) return json({ error: "Bad origin" }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "That file isn't valid JSON." }, 400);
  }
  if (!isPlainObject(body)) return json({ error: "Invalid backup JSON" }, 400);

  const data = body.data;
  if (!isPlainObject(data)) return json({ error: "Invalid backup file: missing data object" }, 400);

  // Only accept backups produced by this application shape. Requiring a
  // non-empty users table prevents an accidental empty JSON object from
  // becoming a destructive "restore everything" operation.
  if (!Array.isArray(data.users) || data.users.length === 0) {
    return json({
      error: "Backup file looks empty or invalid — users table is missing or empty. Existing data was not changed.",
    }, 400);
  }

  for (const key of TABLES) {
    const rows = data[key];
    if (rows !== undefined && !Array.isArray(rows)) {
      return json({ error: `Invalid backup file: table '${key}' must be an array.` }, 400);
    }
  }

  // Transaction = all-or-nothing restore. If any table fails validation or
  // insertion, PostgreSQL rolls the entire restore back automatically.
  // `step` tracks exactly where we were when a failure happens, since a
  // bare "transaction rolled back" message gives an admin nothing to act
  // on — this lets the error response say precisely which table and
  // operation failed, and what Postgres actually said.
  let step = "truncating tables";
  try {
    await db.transaction(async (tx) => {
      const tableNames = TABLES.map((key) => DB_TABLE_NAMES[key]).join(", ");
      await tx.execute(sql.raw(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`));

      for (const key of TABLES) {
        const rawRows = data[key];
        if (!Array.isArray(rawRows) || rawRows.length === 0) continue;

        const rows = sanitizeRows(key, rawRows);
        const table = SCHEMA_TABLES[key];
        const chunkSize = 100;
        for (let i = 0; i < rows.length; i += chunkSize) {
          step = `inserting into '${key}' (rows ${i + 1}-${Math.min(i + chunkSize, rows.length)} of ${rows.length})`;
          await tx.insert(table).values(rows.slice(i, i + chunkSize) as any[]);
        }
      }

      // RESTART IDENTITY already resets every sequence to 1. This extra
      // repair makes each sequence continue from MAX(id)+1 for tables whose
      // backup rows carried explicit ids, so the very next insert through
      // the app doesn't collide with a restored row. Tables with no `id`
      // column (join tables, the settings key/value store) are skipped —
      // there's no sequence to repair, and asking Postgres for one on a
      // nonexistent column throws.
      for (const key of TABLES) {
        if (!tableInfo(key).hasId) continue;
        const name = DB_TABLE_NAMES[key];
        step = `repairing sequence for '${key}'`;
        await tx.execute(sql.raw(`
          SELECT CASE
            WHEN pg_get_serial_sequence('${name}', 'id') IS NOT NULL THEN
              setval(
                pg_get_serial_sequence('${name}', 'id'),
                COALESCE((SELECT MAX(id) FROM ${name}), 1),
                (SELECT COUNT(*) > 0 FROM ${name})
              )
            ELSE NULL
          END
        `));
      }
    });
  } catch (txErr) {
    // The endpoint is super-admin-only (requirePerm("*")), so it's safe —
    // and far more useful than hiding it — to surface the real Postgres
    // error alongside exactly which step produced it.
    console.error(`[admin/backup] restore failed while ${step}:`, txErr);
    const detail = txErr instanceof Error ? txErr.message : String(txErr);
    return json({
      error: `Backup restore failed while ${step} — the database transaction was rolled back, so existing data was not changed. ${detail}`,
    }, 400);
  }

  return json({ ok: true, restoredTables: TABLES.length });
}
