'use strict';

const { ApiError } = require('./errors');

/**
 * Pusatyhub Server-Sent Events.
 *
 * Dua jenis pendengar:
 *   - 'staff'  : KDS / Kaunter. Terima semua perubahan pesanan.
 *   - 'public' : Pelanggan. Terima hanya perubahan satu order_code yang
 *                dia minta (order code = token akses).
 *
 * SSE dipilih (bukan WebSocket) sebab ia satu hala (server -> browser)
 * sahaja, boleh tembus proxy biasa, dan auto-reconnect dalam EventSource.
 */

const CHANNEL = {
    STAFF: 'staff',
    PUBLIC: 'public'
};

const listeners = new Map(); // id -> { res, channel, orderCode, staffId }
let nextId = 1;
let heartbeat = null;

/** Berapa lama heartbeat (ms). Menoaskan proxy dari menutup koneksi. */
const HEARTBEAT_MS = 25000;

function ensureHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
        for (const [, client] of listeners) {
            try {
                client.res.write(': ping\n\n');
            } catch {
                removeClient(client.id);
            }
        }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
}

function ensureStopped() {
    if (listeners.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}

/** Daftarkan connection SSE baharu. */
function subscribe(req, res, { channel, orderCode = null, staffId = null }) {
    if (channel !== CHANNEL.STAFF && channel !== CHANNEL.PUBLIC) {
        throw ApiError.badRequest('Channel tidak sah. Guna "staff" atau "public".');
    }
    if (channel === CHANNEL.PUBLIC && !orderCode) {
        throw ApiError.badRequest('Channel public memerlukan order_code.');
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Buffering oleh Nginx akan pecahkan SSE
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const id = nextId++;
    const client = { id, res, channel, orderCode, staffId };
    listeners.set(id, client);
    ensureHeartbeat();

    // Tulis handshake supaya EventSource tahu connection hidup
    write(client, 'connected', { channel, orderCode });

    // Bersihkan bila pelanggan tutup tab
    req.on('close', () => removeClient(id));
    req.on('error', () => removeClient(id));
    res.on('error', () => removeClient(id));

    return id;
}

function write(client, event, data) {
    try {
        client.res.write(`event: ${event}\n`);
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
        removeClient(client.id);
    }
}

function removeClient(id) {
    if (listeners.delete(id)) {
        ensureStopped();
    }
}

/**
 * Hantar event kepada pendengar yang ReplyOn.
 * @param {string} event  nama event, mis. 'order.created'
 * @param {object} data   payload (JSON-serializable)
 * @param {object} opts   { orderCode } - hanya hantar ke public channel pendengar
 *                             yang subscribe kod tersebut, dan ke semua staff.
 */
function emit(event, data, { orderCode = null } = {}) {
    for (const [, client] of listeners) {
        if (client.channel === CHANNEL.STAFF) {
            write(client, event, data);
        } else if (client.channel === CHANNEL.PUBLIC) {
            if (!orderCode || client.orderCode === orderCode) {
                write(client, event, data);
            }
        }
    }
}

/** Bilangan pendengar aktif (untuk /api/health). */
function stats() {
    let staff = 0;
    let publicClients = 0;
    for (const [, client] of listeners) {
        if (client.channel === CHANNEL.STAFF) staff++;
        else publicClients++;
    }
    return { total: listeners.size, staff, public: publicClients };
}

/** Tutup semua koneksi (untuk graceful shutdown). */
function closeAll() {
    for (const [id, client] of listeners) {
        try {
            client.res.end();
        } catch {
            /* abaikan */
        }
        listeners.delete(id);
    }
    ensureStopped();
}

module.exports = { CHANNEL, subscribe, emit, stats, closeAll, removeClient };
