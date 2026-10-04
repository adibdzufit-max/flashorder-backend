'use strict';

// Fail ini berada dalam src/services/, jadi modul src/ dirujuk dengan '../'.
const db = require('../db');
const events = require('../events');
const { ApiError } = require('../errors');
const {
    SERVICE_TYPE_LIST,
    STATUS,
    STATUS_TRANSITIONS,
    PENDING_STATUSES,
    KITCHEN_STATUSES,
    TERMINAL_STATUSES,
    TABLE_DEPOSIT_PER_PAX,
    FOOD_DEPOSIT_RATE,
    MAX_ITEMS_PER_ORDER,
    MAX_NOTE_LENGTH
} = require('../constants');

// ============================================================================
// NORMALISASI & VALIDASI INPUT
// ============================================================================

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
    return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

function cleanText(value, maxLength = 160) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLength);
}

/** Nombor telefon: buang aksara bukan digit, simpan format MySQL DATETIME. */
function normalisePhone(value) {
    const text = cleanText(value, 32);
    if (!text) return null;
    const digits = text.replace(/[^\d+]/g, '');
    return digits || null;
}

/**
 * MySQL menerima 'YYYY-MM-DD HH:MM:SS' atau ISO. Tukar ke format MySQL.
 * Return null bila tidak sah.
 */
function normaliseDateTime(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
               `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    }

    const text = String(value).trim();
    // ISO: 2026-10-01T14:30:00.000Z  -> 2026-10-01 14:30:00
    const iso = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    if (iso) {
        return `${iso[1]} ${iso[2]}:${iso[3] || '00'}`;
    }
    // Nilai tempahan datetime-local dari <input> sudah tepat bentuknya
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
        return text;
    }
    return null;
}

/**
 * Normalkan senarai item troli kepada bentuk kanonik.
 * Bentuk keluar:
 *   [{ itemId, name, basePrice, unitPrice, quantity, addons:[{id,name,price}], note, done }]
 */
function normaliseItems(rawItems) {
    if (!Array.isArray(rawItems)) {
        throw ApiError.badRequest('items mesti senarai (array).');
    }
    if (rawItems.length > MAX_ITEMS_PER_ORDER) {
        throw ApiError.badRequest(`Satu pesanan maksimum ${MAX_ITEMS_PER_ORDER} baris item.`);
    }

    return rawItems.map((raw, index) => {
        if (!raw || typeof raw !== 'object') {
            throw ApiError.badRequest(`items[${index}] mesti objek.`);
        }

        const quantity = toNumber(raw.quantity, 0);
        if (quantity <= 0) {
            throw ApiError.badRequest(`items[${index}].quantity mesti lebih daripada 0.`);
        }
        if (quantity > 99) {
            throw ApiError.badRequest(`items[${index}].quantity maksimum 99.`);
        }

        const basePrice = round2(raw.basePrice ?? raw.unitPrice ?? raw.price ?? 0);
        const unitPrice = round2(raw.unitPrice ?? raw.price ?? basePrice);

        if (unitPrice < 0 || basePrice < 0) {
            throw ApiError.badRequest(`items[${index}] harga tidak boleh negatif.`);
        }

        const addons = Array.isArray(raw.addons)
            ? raw.addons
                  .filter(Boolean)
                  .map((addon) => ({
                      id: cleanText(addon.id, 32),
                      name: cleanText(addon.name, 120) || 'Addon',
                      price: round2(addon.price ?? 0)
                  }))
            : [];

        const name = cleanText(raw.name, 160);
        if (!name) {
            throw ApiError.badRequest(`items[${index}].name wajib diisi.`);
        }

        return {
            itemId: cleanText(raw.itemId ?? raw.item_id ?? raw.id, 32),
            name,
            basePrice,
            unitPrice,
            quantity: round2(quantity),
            addons,
            note: cleanText(raw.note, MAX_NOTE_LENGTH) || '',
            done: Boolean(raw.done)
        };
    });
}

/** Jumlah harga makanan = sum(unitPrice * quantity). */
function sumItems(items) {
    return round2(
        items.reduce((total, item) => total + item.unitPrice * item.quantity, 0)
    );
}

/**
 * Caj deposit mengikut peraturan portal:
 *   dinein_only  -> RM 5.00 x pax
 *   lain         -> 50% daripada jumlah makanan
 */
function calculateDeposit(serviceType, totalFoodPrice, pax) {
    if (serviceType === 'dinein_only') {
        const heads = Math.max(1, toNumber(pax, 1));
        return round2(heads * TABLE_DEPOSIT_PER_PAX);
    }
    return round2(toNumber(totalFoodPrice, 0) * FOOD_DEPOSIT_RATE);
}

function assertServiceType(value) {
    if (!SERVICE_TYPE_LIST.includes(value)) {
        throw ApiError.badRequest(`service_type tidak sah: "${value}"`, {
            allowed: SERVICE_TYPE_LIST
        });
    }
    return value;
}

function assertPax(value) {
    if (value === null || value === undefined || value === '') return null;
    const pax = toNumber(value, 0);
    if (pax <= 0 || pax > 100) {
        throw ApiError.badRequest('pax mesti antara 1 dan 100.');
    }
    return Math.round(pax);
}

/** Jana kod tempahan 'HOTMAS-BK' + 6 digit, cuba sehingga belum guna. */
async function generateOrderCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = `HOTMAS-BK${Math.floor(100000 + Math.random() * 900000)}`;
        const existing = await db.one('select id from orders where order_code = ?', [code]);
        if (!existing) return code;
    }
    // Fallback timestamp sebagai pilihan akhir jika semua 10 cubaan rawak bertindih
    return `HOTMAS-BK${Date.now().toString().slice(-6)}`;
}

// ============================================================================
// PEMETAAN BARIS DB <-> JSON
// ============================================================================

/** MySQL JSON datang sebagai objek/string; pastikan objek. */
function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

/**
 * Baris `orders` -> bentuk yang UI HTML consume.
 * Medan sama seperti JSON asal supaya kod rendering tidak perlu diubah banyak.
 */
function mapOrder(row) {
    if (!row) return null;

    const items = parseJson(row.items, []);

    return {
        id: row.id,
        orderId: row.order_code,
        order_code: row.order_code,
        supabaseId: row.id,          // dikekalkan untuk kesesuaian kod lama
        serviceType: row.service_type,
        tableNumber: row.table_number,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        customerEmail: row.customer_email,
        pax: row.pax,
        scheduledAt: row.scheduled_at,
        notes: row.notes,
        items,
        itemCount: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
        totalFoodPrice: round2(row.total_food_price),
        depositPaid: round2(row.deposit_amount),
        deposit_amount: round2(row.deposit_amount),
        totalPaid: round2(row.total_amount),
        balanceDue: round2(row.balance_due),
        balanceResto: round2(row.balance_due),
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        status: row.status,
        source: row.source,
        acceptedAt: row.accepted_at,
        cookingAt: row.cooking_at,
        readyAt: row.ready_at,
        completedAt: row.completed_at,
        createdTimestamp: row.created_at ? new Date(row.created_at.replace(' ', 'T')).getTime() : Date.now(),
        orderTime: row.created_at ? String(row.created_at).slice(11, 16) : '--:--',
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function mapBooking(row) {
    if (!row) return null;
    return {
        id: row.id,
        bookingId: row.booking_code,
        booking_code: row.booking_code,
        custName: row.customer_name,
        custPhone: row.customer_phone,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        dateTime: row.scheduled_at,
        scheduledAt: row.scheduled_at,
        pax: row.pax,
        notes: row.notes,
        serviceType: row.service_type,
        serviceTypeLabel: serviceLabel(row.service_type),
        items: parseJson(row.items, []),
        totalFoodPrice: round2(row.total_amount),
        total_amount: round2(row.total_amount),
        depositPaid: round2(row.deposit_amount),
        deposit_amount: round2(row.deposit_amount),
        balanceResto: round2(Math.max(round2(row.total_amount) - round2(row.deposit_amount), 0)),
        balanceDue: round2(Math.max(round2(row.total_amount) - round2(row.deposit_amount), 0)),
        paymentBank: row.payment_method || null,
        paymentStatus: row.payment_status,
        orderStatus: row.order_status,
        orderId: row.order_id,
        created_at: row.created_at
    };
}

function serviceLabel(serviceType) {
    if (serviceType === 'dinein_only') return 'Meja Sahaja';
    if (serviceType === 'takeaway') return 'Take Away';
    return 'Meja + Makanan';
}

// ============================================================================
// RUJUKAN STATUS
// ============================================================================

/** Cache status dari DB supaya tidak query setiap kali. */
let statusCache = null;
let statusCacheAt = 0;
const STATUS_CACHE_MS = 60000;

async function loadStatuses(force = false) {
    if (!force && statusCache && Date.now() - statusCacheAt < STATUS_CACHE_MS) {
        return statusCache;
    }
    const rows = await db.query(
        'select code, label, stage, requires_kitchen, is_pending, is_terminal from order_statuses'
    );
    statusCache = new Map(rows.map((r) => [r.code, r]));
    statusCacheAt = Date.now();
    return statusCache;
}

function invalidateStatusCache() {
    statusCache = null;
}

/** Adakah status ini memerlukan pengesahan kaunter? */
async function isPendingStatus(status) {
    if (PENDING_STATUSES.includes(status)) return true;
    const map = await loadStatuses();
    return Boolean(map.get(status)?.is_pending);
}

/** Adakah status ini perlu routed ke dapur? */
async function requiresKitchen(status) {
    const map = await loadStatuses();
    return Boolean(map.get(status)?.requires_kitchen);
}

// ============================================================================
// CRUD PESANAN
// ============================================================================

/**
 * Cipta pesanan. Dipakai oleh:
 *   - POST /api/orders     (customer ordering portal)
 *   - POST /api/bookings   (booking portal, juga cipta row bookings)
 *   - POST /api/orders/demo (KDS injectDemoOrder)
 *
* Semua penciptaan pesanan routed melalui fungsi ini supaya status history,
 * baris items, dan event SSE sentiasa konsisten.
 */
async function createOrder(payload, { staffId = null, source = 'customer_portal' } = {}) {
    const serviceType = assertServiceType(payload.serviceType ?? payload.service_type);
    const items = normaliseItems(payload.items ?? []);
    const pax = assertPax(payload.pax);

    const totalFoodPrice = sumItems(items);
    const depositAmount = calculateDeposit(serviceType, totalFoodPrice, pax);

    // Jumlah yang sudah dibayar. Default: deposit sahaja.
    const totalPaidRaw = payload.totalPaid ?? payload.total_amount;
    const totalAmount = totalPaidRaw === undefined || totalPaidRaw === null
        ? depositAmount
        : round2(totalPaidRaw);

    // Bayar melebihi jumlah makanan - hanya untuk tempahan meja, yang
    // deposit memang boleh sama atau lebih besar (RM5/pax).
    if (serviceType !== 'dinein_only' && totalAmount > totalFoodPrice + 0.001 && !payload.allowOverpay) {
        throw ApiError.badRequest(
            `Jumlah bayar (RM ${totalAmount}) melebihi jumlah makanan (RM ${totalFoodPrice}).`,
            { totalFoodPrice, totalAmount }
        );
    }

    const status = payload.status || STATUS.AWAITING_COUNTER;
    const scheduledAt = normaliseDateTime(payload.scheduledAt ?? payload.scheduled_at);

    const tableNumber = cleanText(payload.tableNumber ?? payload.table_number, 60)
        || defaultTableNumber(serviceType, pax);

    // `??` dan `||` tidak boleh digabung tanpa kurungan - itu ralat sintaks.
    const paymentStatus = (payload.paymentStatus ?? payload.payment_status)
        || (totalAmount >= totalFoodPrice && totalFoodPrice > 0 ? 'paid' : totalAmount > 0 ? 'partial' : 'pending');

    const orderCode = await generateOrderCode();

    // Validasi status wujud
    const statuses = await loadStatuses();
    if (!statuses.has(status)) {
        throw ApiError.badRequest(`Status tidak sah: "${status}"`, { allowed: [...statuses.keys()] });
    }

    // Pesanan + baris item + jejak status mesti masuk bersama-sama; kalau
    // separuh sahaja berjaya, KDS akan nampak pesanan tanpa item.
    let orderId = null;
    for (let attempt = 0; attempt < 3 && orderId === null; attempt++) {
        const code = attempt === 0 ? orderCode : await generateOrderCode();
        try {
            orderId = await db.transaction(async (connection) => {
                const r = db.runner(connection);

                const { insertId } = await r.insert(
                    `insert into orders
                        (order_code, service_type, table_number, customer_name, customer_phone, customer_email,
                         pax, scheduled_at, notes, items, total_food_price, deposit_amount, total_amount,
                         payment_method, payment_status, status, source)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        code,
                        serviceType,
                        tableNumber,
                        cleanText(payload.customerName ?? payload.customer_name, 120),
                        normalisePhone(payload.customerPhone ?? payload.customer_phone),
                        cleanText(payload.customerEmail ?? payload.customer_email, 191),
                        pax,
                        scheduledAt,
                        cleanText(payload.notes, 1000),
                        JSON.stringify(items),
                        totalFoodPrice,
                        depositAmount,
                        totalAmount,
                        cleanText(payload.paymentMethod ?? payload.payment_method, 120) || 'Deposit Online',
                        paymentStatus,
                        status,
                        source
                    ]
                );

                await syncOrderItems(insertId, items, connection);
                await logStatusChange(insertId, null, status, staffId, 'Pesanan dicipta', connection);

                return insertId;
            });
        } catch (err) {
            // Dua peranti boleh Tempahan pada saat yang sama dan terhempas
            // pada order_code yang sama - jana semula kod dan cuba sekali lagi.
            const duplicateCode = err?.code === 'ER_DUP_ENTRY'
                || (Array.isArray(err?.sqlMessage) && err.sqlMessage.includes('uq_order_code'));
            if (!duplicateCode || attempt === 2) throw err;
        }
    }

    const order = await getOrderById(orderId);
    broadcastOrder('order.created', order);
    return order;
}

function defaultTableNumber(serviceType, pax) {
    if (serviceType === 'takeaway') return 'TAKEAWAY (Bungkus)';
    return `MEJA (${pax || 1} Pax)`;
}

/** Baca satu pesanan dengan baris items. */
async function getOrderById(id) {
    const row = await db.one('select * from orders where id = ?', [id]);
    return mapOrder(row);
}

/**
 * Baca pesanan mengikut order_code (digunakan tracking awam). Menerima juga
 * booking_code supaya portal tempahan boleh subscribe dengan kod yang dipapar
 * kepada pelanggan (contohnya BKG-XXXXXX).
 */
async function getOrderByCode(code) {
    const value = String(code || '').trim().toUpperCase();
    let row = await db.one('select * from orders where order_code = ?', [value]);

    if (!row && value.startsWith('BKG-')) {
        row = await db.one(
            `select o.* from orders o
             join bookings b on b.order_id = o.id
             where b.booking_code = ?`,
            [value]
        );
    }

    if (!row) throw ApiError.notFound(`Pesanan "${code}" tidak dijumpai. Sila semak kod anda.`);
    return mapOrder(row);
}

/** Senarai pesanan dengan penapis (untuk KDS). */
async function listOrders({ tab = 'all', search = '', limit = 200, serviceType = null, status = null } = {}) {
    const where = [];
    const params = [];

    if (status) {
        where.push('o.status = ?');
        params.push(status);
    }

    if (serviceType) {
        where.push('o.service_type = ?');
        params.push(serviceType);
    }

    switch (tab) {
        case 'counter':
            // Semua pesanan menunggu pengesahan kaunter
            where.push(`o.status in (${PENDING_STATUSES.map(() => '?').join(',')})`);
            params.push(...PENDING_STATUSES);
            break;
        case 'kitchen':
            where.push(`o.status in (${KITCHEN_STATUSES.map(() => '?').join(',')})`);
            params.push(...KITCHEN_STATUSES);
            where.push("o.service_type <> 'dinein_only'");
            where.push('json_length(o.items) > 0');
            break;
        case 'table_only':
            where.push("o.service_type = 'dinein_only'");
            break;
        case 'ready':
            where.push('o.status = ?');
            params.push(STATUS.READY);
            break;
        case 'completed':
            where.push('o.status = ?');
            params.push(STATUS.COMPLETED);
            break;
        case 'all':
        default:
            break;
    }

    if (search) {
        where.push('(o.order_code like ? or o.table_number like ? or o.customer_name like ?)');
        const like = `%${search}%`;
        params.push(like, like, like);
    }

    const clause = where.length ? `where ${where.join(' and ')}` : '';
    // Alias `o` mesti dinyatakan, jika tidak MySQL tidak kenal lajur `o.status`.
    const rows = await db.query(
        `select o.* from orders o ${clause} order by o.created_at desc limit ?`,
        [...params, Math.min(Number(limit) || 200, 500)]
    );

    return rows.map(mapOrder);
}

/**
 * Tulis semula order_items + order_item_addons daripada JSON items.
 * `connection` optional - hantar connection bila perlu dalam transaksi.
 */
async function syncOrderItems(orderId, items, connection = null) {
    const r = db.runner(connection);

    const existing = await r.query('select id from order_items where order_id = ?', [orderId]);
    if (existing.length > 0) {
        await r.execute(
            `delete from order_item_addons where order_item_id in (${existing.map(() => '?').join(',')})`,
            existing.map((row) => row.id)
        );
        await r.execute('delete from order_items where order_id = ?', [orderId]);
    }

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const { insertId: orderItemId } = await r.insert(
            `insert into order_items
                (order_id, line_no, menu_item_id, item_name, base_price, unit_price, quantity, note, is_done)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderId,
                i,
                item.itemId || null,
                item.name,
                item.basePrice ?? 0,
                item.unitPrice ?? 0,
                item.quantity ?? 1,
                item.note || null,
                item.done ? 1 : 0
            ]
        );

        for (const addon of item.addons || []) {
            await r.execute(
                `insert into order_item_addons (order_item_id, addon_id, addon_name, price)
                 values (?, ?, ?, ?)`,
                [orderItemId, addon.id || null, addon.name, addon.price ?? 0]
            );
        }
    }
}

async function logStatusChange(orderId, fromStatus, toStatus, staffId, note, connection = null) {
    await db.runner(connection).execute(
        `insert into order_status_history (order_id, from_status, to_status, changed_by, note)
         values (?, ?, ?, ?, ?)`,
        [orderId, fromStatus, toStatus, staffId || null, note ? String(note).slice(0, 255) : null]
    );
}

/**
 * Kemas kini status pesanan.
 *
 * Automatik (ikut logik asal KDS portal):
 *   - dinein_only + 'Diterima oleh Kaunter' -> 'Meja Disahkan (Hanya Kaunter)'
 *   - status -> 'Pesanan Siap'               -> tandakan semua item done
 *
 * Tahap status dipetakan ke timestamp accepted / cooking / ready / completed.
 */
async function updateOrderStatus(orderId, nextStatus, { staffId = null, staffRole = null, note = null } = {}) {
    const order = await db.one('select * from orders where id = ?', [orderId]);
    if (!order) throw ApiError.notFound(`Pesanan ID ${orderId} tidak dijumpai.`);

    const statuses = await loadStatuses();
    if (!statuses.has(nextStatus)) {
        throw ApiError.badRequest(`Status tidak sah: "${nextStatus}"`, { allowed: [...statuses.keys()] });
    }

    if (order.status === nextStatus) {
        return mapOrder(order); // idempoten
    }

    // ---- Kawalan workflow ----
    const allowed = STATUS_TRANSITIONS[order.status] || [];
    if (allowed.length > 0 && !allowed.includes(nextStatus)) {
        // staf admin boleh melompat ke status mana-mana
        if (staffRole !== 'admin') {
            throw ApiError.conflict(
                `Tidak boleh pindah dari "${order.status}" ke "${nextStatus}".`,
                { current: order.status, allowed }
            );
        }
    }

    if (TERMINAL_STATUSES.includes(order.status) && staffRole !== 'admin') {
        throw ApiError.conflict('Pesanan yang sudah selesai tidak boleh diubah status.');
    }

    // ---- Transformasi automatik ----
    let effectiveStatus = nextStatus;
    const items = parseJson(order.items, []);

    // Tempahan meja hanya: tidak pernah dihantar ke dapur
    if (order.service_type === 'dinein_only' && nextStatus === STATUS.ACCEPTED) {
        effectiveStatus = STATUS.TABLE_ONLY;
    }

    let updatedItems = items;
    if (effectiveStatus === STATUS.READY && items.length > 0) {
        updatedItems = items.map((item) => ({ ...item, done: true }));
    }

    // ---- Timestamp Ranking ----
    const stamps = {};
    if (effectiveStatus === STATUS.ACCEPTED || effectiveStatus === STATUS.TABLE_ONLY) {
        stamps.accepted_at = order.accepted_at || new Date();
    }
    if (effectiveStatus === STATUS.COOKING) {
        stamps.cooking_at = order.cooking_at || new Date();
    }
    if (effectiveStatus === STATUS.READY) {
        stamps.ready_at = order.ready_at || new Date();
    }
    if (effectiveStatus === STATUS.COMPLETED) {
        stamps.completed_at = order.completed_at || new Date();
        stamps.accepted_at = order.accepted_at || new Date();
    }

    const sets = ['status = ?'];
    const params = [effectiveStatus];

    if (JSON.stringify(updatedItems) !== JSON.stringify(items)) {
        sets.push('items = ?');
        params.push(JSON.stringify(updatedItems));
    }
    for (const [column, value] of Object.entries(stamps)) {
        sets.push(`${column} = ?`);
        params.push(toMysqlDateTime(value));
    }

    params.push(orderId);

    // Status + item snapshot + jejak dalam satu transaksi, supaya history
    // tidak pernah bercanggah dengan status semasa.
    await db.transaction(async (connection) => {
        await db.runner(connection).execute(
            `update orders set ${sets.join(', ')} where id = ?`,
            params
        );

        if (JSON.stringify(updatedItems) !== JSON.stringify(items)) {
            await syncOrderItems(orderId, updatedItems, connection);
        }

        await logStatusChange(orderId, order.status, effectiveStatus, staffId, note, connection);
    });

    const updated = await getOrderById(orderId);
    broadcastOrder('order.status', updated, { previousStatus: order.status });
    return updated;
}

function toMysqlDateTime(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Tandakan satu item sebagai siap / belum siap.
 * Jika semua item siap, status automatik ke 'Pesanan Siap' (ikut logik asal).
 */
async function toggleOrderItem(orderId, lineNo, { staffId = null } = {}) {
    const order = await db.one('select * from orders where id = ?', [orderId]);
    if (!order) throw ApiError.notFound(`Pesanan ID ${orderId} tidak dijumpai.`);

    const items = parseJson(order.items, []);
    const index = Number(lineNo);

    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        throw ApiError.badRequest(`line_no ${lineNo} di luar julat (0 - ${items.length - 1}).`);
    }

    if (TERMINAL_STATUSES.includes(order.status)) {
        throw ApiError.conflict('Pesanan selesai tidak boleh diubah.');
    }

    // Dapur hanya boleh tandakan item bila pesanan sudah Accepted / Cooking / Ready
    if (!KITCHEN_STATUSES.includes(order.status)) {
        throw ApiError.conflict(
            `Item hanya boleh ditanda untuk pesanan di dapur. Status semasa: "${order.status}".`
        );
    }

    const updatedItems = items.map((item, i) =>
        i === index ? { ...item, done: !item.done } : item
    );

    const allDone = updatedItems.length > 0 && updatedItems.every((item) => item.done);
    const shouldBecomeReady = allDone && order.status !== STATUS.READY && order.status !== STATUS.COMPLETED;

    const nextStatus = shouldBecomeReady ? STATUS.READY : order.status;

    const sets = ['items = ?', 'status = ?'];
    const params = [JSON.stringify(updatedItems), nextStatus];

    if (shouldBecomeReady) {
        sets.push('ready_at = ?');
        params.push(toMysqlDateTime(new Date()));
    }
    params.push(orderId);

    await db.transaction(async (connection) => {
        const r = db.runner(connection);
        await r.execute(`update orders set ${sets.join(', ')} where id = ?`, params);
        await syncOrderItems(orderId, updatedItems, connection);

        if (shouldBecomeReady) {
            await logStatusChange(orderId, order.status, nextStatus, staffId,
                'Semua item ditanda siap secara automatik', connection);
        }
    });

    const updated = await getOrderById(orderId);
    broadcastOrder('order.items', updated);
    return updated;
}

/** Rekod pembayaran (deposit atau baki). Kemas kini total_amount. */
async function recordPayment(orderId, { kind = 'deposit', method = null, methodLabel = null, amount, reference = null, status = 'paid', isSimulated = true, staffId = null } = {}) {
    const order = await db.one('select * from orders where id = ?', [orderId]);
    if (!order) throw ApiError.notFound(`Pesanan ID ${orderId} tidak dijumpai.`);

    const paid = round2(amount ?? order.balance_due);
    if (paid <= 0) {
        throw ApiError.badRequest('Amaun bayaran mesti lebih daripada 0.');
    }

    const newTotal = round2(round2(order.total_amount) + paid);
    const fullyPaid = newTotal + 0.001 >= round2(order.total_food_price);
    const payloadIsSimulated = isSimulated !== false;

    await db.transaction(async (connection) => {
        const r = db.runner(connection);

        await r.execute(
            `insert into payments
                (order_id, kind, method, method_label, amount, reference, status, is_simulated, paid_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderId, kind, method || null, methodLabel, paid, reference, status,
                payloadIsSimulated ? 1 : 0,
                status === 'paid' ? toMysqlDateTime(new Date()) : null]
        );

        await r.execute(
            `update orders
                set total_amount = ?,
                    payment_status = ?,
                    payment_method = coalesce(?, payment_method)
              where id = ?`,
            [newTotal, fullyPaid ? 'paid' : 'partial', methodLabel, orderId]
        );
    });

    const updated = await getOrderById(orderId);
    broadcastOrder('order.updated', updated);
    return updated;
}

/** Padam pesanan (admin sahaja, untuk reset demo). */
async function deleteOrder(orderId) {
    const row = await db.one('select order_code from orders where id = ?', [orderId]);
    if (!row) throw ApiError.notFound(`Pesanan ID ${orderId} tidak dijumpai.`);

    await db.execute('delete from orders where id = ?', [orderId]);
    events.emit('order.deleted', { id: orderId, order_code: row.order_code }, { orderCode: row.order_code });
    return { deleted: true, id: Number(orderId) };
}

// ============================================================================
// METRIK & STATISTIK
// ============================================================================

/**
 * Empat metrik kad KDS + kiraan setiap tab.
 * Dikira dalam SQL supaya frontend tidak perlu memuat semua pesanan.
 */
async function getKdsMetrics() {
    // Urutan placeholder mesti sama dengan urutan dalam SQL di atas:
    //   1-3  pending_counter   -> PENDING_STATUSES
    //   4-6  cooking           -> KITCHEN_STATUSES
    //   7    table_only        -> bukan 'Selesai'
    //   8    ready             -> STATUS.READY
    //   9    completed         -> STATUS.COMPLETED
    //   10   total_revenue     -> STATUS.COMPLETED
    const row = await db.one(
        `select
            count(*)                                                          as total,
            coalesce(sum(o.status in (?, ?, ?)), 0)                            as pending_counter,
            coalesce(sum(o.status in (?, ?, ?)
                and o.service_type <> 'dinein_only'
                and json_length(o.items) > 0), 0)                             as cooking,
            coalesce(sum(o.service_type = 'dinein_only' and o.status <> ?), 0) as table_only,
            coalesce(sum(o.status = ?), 0)                                     as ready,
            coalesce(sum(o.status = ?), 0)                                     as completed,
            coalesce(sum(case when o.status = ? then o.total_food_price end), 0) as total_revenue
         from orders o`,
        [
            ...PENDING_STATUSES,
            ...KITCHEN_STATUSES,
            STATUS.COMPLETED,
            STATUS.READY,
            STATUS.COMPLETED,
            STATUS.COMPLETED
        ]
    );

    return {
        total: Number(row?.total || 0),
        pendingCounter: Number(row?.pending_counter || 0),
        cooking: Number(row?.cooking || 0),
        tableOnly: Number(row?.table_only || 0),
        ready: Number(row?.ready || 0),
        completed: Number(row?.completed || 0),
        totalRevenue: round2(row?.total_revenue || 0)
    };
}

async function getDailySales(days = 7) {
    // Nilai integer disahkan dan dimasukkan terus ke SQL: MySQL tidak
    // menerima placeholder pada unit INTERVAL dalam prepared statement.
    const safeDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 7, 90));
    return db.query(
        `select
            date(created_at)                                  as sale_date,
            coalesce(sum(status = 'Selesai'), 0)              as completed_orders,
            coalesce(sum(status <> 'Selesai'), 0)             as open_orders,
            coalesce(sum(case when status = 'Selesai' then total_food_price end), 0) as gross_revenue,
            coalesce(sum(case when status = 'Selesai' then total_amount end), 0)      as collected_amount,
            coalesce(sum(case when status = 'Selesai' then balance_due end), 0)       as outstanding_amount
         from orders
         where created_at >= date_sub(curdate(), interval ${safeDays} day)
         group by date(created_at)
         order by sale_date desc`
    );
}

// ============================================================================
// BROADCAST
// ============================================================================

function broadcastOrder(event, order, extra = {}) {
    events.emit(event, { order, ...extra }, { orderCode: order?.orderId });
}

module.exports = {
    // normalisasi (dieksport untuk diuji)
    normaliseItems,
    normalisePhone,
    normaliseDateTime,
    calculateDeposit,
    sumItems,
    generateOrderCode,
    mapOrder,
    mapBooking,
    serviceLabel,
    cleanText,
    round2,
    toNumber,

    // operasi
    createOrder,
    getOrderById,
    getOrderByCode,
    listOrders,
    updateOrderStatus,
    toggleOrderItem,
    recordPayment,
    deleteOrder,
    syncOrderItems,
    logStatusChange,

    // laporan
    getKdsMetrics,
    getDailySales,

    // status
    loadStatuses,
    invalidateStatusCache,
    isPendingStatus,
    requiresKitchen,

    // konstanta
    parseJson
};
