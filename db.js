'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

/**
 * Connection pool. Semua query backend guna `db` (execute) atau `db.one`
 * (dengan penapis). Jangan pernah panggil mysql.createConnection langsung
 * di luar fail ini.
 */

const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: config.db.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'local',
    // Nyahcas DATE/DATETIME sebagai string 'YYYY-MM-DD HH:MM:SS' supaya
    // tidak jadi objek Date yang hilang zon masa bila dihantar ke browser.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    namedPlaceholders: false
});

/** Jalankan query, pulangkan rows. */
async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

/**
 * Jalankan INSERT/UPDATE/DELETE, pulangkan ResultSetHeader.
 * WAJIB guna ini (bukan `query`) untuk statement yang tidak mengembalikan rows,
 * kerana `pool.execute` pulangkan object header (bukan array) untuk statement
 * tersebut - `query()` akan throw kerana header tiada property `.length`.
 */
async function execute(sql, params = []) {
    const [result] = await pool.execute(sql, params);
    return result;
}

/** Jalankan query, pulangkan baris pertama atau null. */
async function one(sql, params = []) {
    const rows = await query(sql, params);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Jalankan query, pulangkan baris pertama. Lemak jika tiada rekod. */
async function oneOrFail(sql, params = [], message = 'Rekod tidak dijumpai') {
    const row = await one(sql, params);
    if (!row) {
        const err = new Error(message);
        err.status = 404;
        throw err;
    }
    return row;
}

/** Jalankan dalam transaksi. `fn` menerima connection. */
async function transaction(fn) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await fn(connection);
        await connection.commit();
        return result;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

/** Jalankan INSERT dan pulangkan insertId. */
async function insert(sql, params = []) {
    const result = await execute(sql, params);
    return { insertId: result.insertId, affectedRows: result.affectedRows };
}

/** Sambungan DB hidup? */
async function ping() {
    const row = await one('select 1 as ok');
    return row?.ok === 1;
}

/**
 * Penyesuaian API: `db.query` pulangkan rows, tetapi `connection.query` pulangkan
 * tuple `[rows, fields]`. Fungsi ini menormalkan supaya kod yang sama boleh
 * dijalankan dengan atau tanpa transaksi.
 *
 *     const r = db.runner(connection);   // connection optional
 *     await r.query(sql, params);
 *     const { insertId } = await r.insert(sql, params);
 */
function runner(connection = null) {
    if (!connection) {
        return { query, execute, insert };
    }
    return {
        async query(sql, params = []) {
            const [rows] = await connection.query(sql, params);
            return rows;
        },
        async execute(sql, params = []) {
            const [result] = await connection.execute(sql, params);
            return result;
        },
        async insert(sql, params = []) {
            const result = await this.execute(sql, params);
            return { insertId: result.insertId, affectedRows: result.affectedRows };
        }
    };
}

module.exports = { pool, query, execute, insert, one, oneOrFail, transaction, ping, runner };
