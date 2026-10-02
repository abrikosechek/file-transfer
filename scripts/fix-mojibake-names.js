'use strict';

/**
 * One-off: repair UTF-8-as-latin1 mojibake in title / original_name / relative_path.
 * Safe: only updates when latin1→utf8 decode yields different valid text
 * with non-latin1 codepoints (e.g. Cyrillic), never deletes rows.
 */
require('dotenv').config();
const { fixUtf8Filename } = require('../lib/paths');
const { getPool } = require('../lib/db');

function shouldFix(s) {
  if (typeof s !== 'string' || !s) return false;
  const fixed = fixUtf8Filename(s);
  return fixed !== s;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  let items = 0;
  let files = 0;
  try {
    await client.query('BEGIN');

    const { rows: itemRows } = await client.query(
      `SELECT id, title, original_name FROM items`
    );
    for (const row of itemRows) {
      const title = shouldFix(row.title) ? fixUtf8Filename(row.title) : row.title;
      const original_name =
        row.original_name != null && shouldFix(row.original_name)
          ? fixUtf8Filename(row.original_name)
          : row.original_name;
      if (title !== row.title || original_name !== row.original_name) {
        await client.query(
          `UPDATE items SET title = $1, original_name = $2 WHERE id = $3`,
          [title, original_name, row.id]
        );
        items++;
        console.log('item', row.id, JSON.stringify(row.title), '->', JSON.stringify(title));
      }
    }

    const { rows: fileRows } = await client.query(
      `SELECT id, item_id, relative_path FROM item_files`
    );
    for (const row of fileRows) {
      if (!shouldFix(row.relative_path)) continue;
      const relative_path = fixUtf8Filename(row.relative_path);
      const clash = await client.query(
        `SELECT 1 FROM item_files WHERE item_id = $1 AND relative_path = $2 AND id <> $3`,
        [row.item_id, relative_path, row.id]
      );
      if (clash.rowCount) {
        console.warn('skip clash', row.id, relative_path);
        continue;
      }
      await client.query(`UPDATE item_files SET relative_path = $1 WHERE id = $2`, [
        relative_path,
        row.id,
      ]);
      files++;
      console.log('file', row.id, JSON.stringify(row.relative_path), '->', JSON.stringify(relative_path));
    }

    const { rows: upRows } = await client.query(`SELECT id, title FROM uploads`);
    for (const row of upRows) {
      if (!shouldFix(row.title)) continue;
      const title = fixUtf8Filename(row.title);
      await client.query(`UPDATE uploads SET title = $1 WHERE id = $2`, [title, row.id]);
      console.log('upload', row.id, 'title fixed');
    }
    const { rows: ufRows } = await client.query(
      `SELECT id, upload_id, relative_path FROM upload_files`
    );
    for (const row of ufRows) {
      if (!shouldFix(row.relative_path)) continue;
      const relative_path = fixUtf8Filename(row.relative_path);
      await client.query(`UPDATE upload_files SET relative_path = $1 WHERE id = $2`, [
        relative_path,
        row.id,
      ]);
      console.log('upload_file', row.id, 'path fixed');
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, itemsFixed: items, filesFixed: files }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
