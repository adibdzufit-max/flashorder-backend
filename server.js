'use strict';

const config = require('./config');
const db = require('./db');
const events = require('./events');
const { createApp } = require('./app');

/**
 * Titik masuk: semak sambungan DB, buka port HTTP, dan tutup dengan selamat
 * bila proses menerima SIGINT/SIGTERM.
 */

let shuttingDown = false;

async function start() {
    try {
        await db.ping();
        console.log(`[db] bersambung ke ${config.db.host}:${config.db.port}/${config.db.database}`);
    } catch (err) {
        console.error('[db] gagal bersambung:', err.message);
        console.error('    Semak .env (DB_HOST/DB_USER/DB_PASSWORD) dan pastikan MySQL hidup.');
        process.exit(1);
    }

    const app = createApp();
    const server = app.listen(config.port, () => {
        console.log(`[http] Hotmas backend berjalan di http://localhost:${config.port}`);
        console.log(`[http] Ujian kesihatan: http://localhost:${config.port}/api/health`);
    });

    // Sambungan SSE perlu hidup lebih lama daripada lalai Express (2 minit).
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 65000;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n[shutdown] menerima ${signal}, menutup dengan selamat...`);

        events.closeAll();
        server.close(async () => {
            try {
                await db.pool.end();
            } catch (err) {
                console.error('[shutdown] ralat menutup pool:', err.message);
            }
            console.log('[shutdown] selesai.');
            process.exit(0);
        });

        // Jangan gantung selamanya jika ada koneksi yang tidak tutup.
        setTimeout(() => {
            console.error('[shutdown] tamat masa, keluar paksa.');
            process.exit(1);
        }, 10000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        console.error('[unhandledRejection]', reason);
    });

    return server;
}

start().catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
});
