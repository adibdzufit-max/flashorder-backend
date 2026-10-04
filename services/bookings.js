'use strict';

const db = require('../db');
const events = require('../events');
const { ApiError } = require('../errors');
const orders = require('./orders');
const {
    SERVICE_TYPE_LIST,
    STATUS,
    TABLE_DEPOSIT_PER_PAX,
    FOOD_DEPOSIT_RATE,
    MAX_NOTE_LENGTH
} = require('../constants');

/**
 * Tempahan (portal booking).
 *
 * Setiap tempahan menghasilkan DUA baris:
 *   - bookings  : rekod tempahan seperti yang dihantar portal
 *   - orders    : baris yang dibaca KDS dan kaunter
 *
 * Kedua-duanya ditulis dalam satu transaksi supaya KDS tidak pernah nampak
 * pesanan yang tiada tempahan, atau sebaliknya.
 */

const round2 = orders.round2;
const toNumber = orders.toNumber;
const cleanText = orders.cleanText;
const normalisePhone = orders.normalisePhone;
const normaliseDateTime = orders.normaliseDateTime;
const mapBooking = orders.mapBooking;

/** Jana kod tempahan yang pendek dan sukar diteka, contoh BKG-7F3K92. */
async function generateBookingCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 10; attempt++) {
        let suffix = '';
        for (let i = 0; i < 6; i++) {
            suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        const code = `BKG-${suffix}`;
        const existing = await db.one('select id from bookings where booking_code = ?', [code]);
        if (!existing) return code;
    }
    return `BKG-${Date.now().toString(36).toUpperCase()}`;
}

/** Deposit mengikut peraturan portal tempahan. */
function calculateBookingDeposit(serviceType, totalFoodPrice, pax) {
    if (serviceType === 'dinein_only') {
        return round2(Math.max(1, toNumber(pax, 1)) * TABLE_DEPOSIT_PER_PAX);
    }
    return round2(toNumber(totalFoodPrice, 0) * FOOD_DEPOSIT_RATE);
}

function assertBookingServiceType(value) {
    if (!SERVICE_TYPE_LIST.includes(value)) {
        throw ApiError.badRequest(`service_type tidak sah: "${value}"`, { allowed: SERVICE_TYPE_LIST });
    }
    return value;
}

/**
 * Status mula untuk pesanan yang dijana daripada tempahan.
 * Semua tempahan baharu perlu pengesahan kaunter dahulu; kaunter yang menekan
 * "Terima" akan menukar tempahan meja sahaja kepada status TABLE_ONLY.
 */
function initialOrderStatus(paymentStatus) {
    return paymentStatus === 'pending' ? STATUS.AWAITING_PAYMENT : STATUS.AWAITING_COUNTER;
}

/**
 * Cipta tempahan dan pesanan serentak.
 * @returns {{booking: object, order: object}}
 */
async function createBooking(payload) {
    const serviceType = assertBookingServiceType(payload.serviceType ?? payload.service_type);
    const pax = Math.max(1, Math.round(toNumber(payload.pax, 1)) || 1);

    if (pax > 100) {
        throw ApiError.badRequest('pax mesti antara 1 dan 100.');
    }

    // Tempahan meja sahaja tidak pernah ada makanan, jadi item diabaikan.
    const items = serviceType === 'dinein_only' ? [] : orders.normaliseItems(payload.items ?? []);
    const totalFoodPrice = orders.sumItems(items);
    const depositAmount = calculateBookingDeposit(serviceType, totalFoodPrice, pax);

    // Jumlah yang sudah dibayar: portal hantar deposit sahaja atau deposit + baki.
    const paidRaw = payload.totalPaid ?? payload.depositAmount ?? payload.deposit_amount;
    const totalPaid = paidRaw === undefined || paidRaw === null
        ? depositAmount
        : round2(paidRaw);

    if (totalPaid < 0) {
        throw ApiError.badRequest('Jumlah bayaran tidak boleh negatif.');
    }

    const fullyPaid = totalPaid + 0.001 >= totalFoodPrice;
    // `??` dan `||` tidak boleh digabung tanpa kurungan - itu ralat sintaks.
    const paymentStatus = (payload.paymentStatus ?? payload.payment_status)
        || (fullyPaid ? 'paid' : totalPaid > 0 ? 'partial' : 'pending');

    const scheduledAt = normaliseDateTime(payload.scheduledAt ?? payload.scheduled_at);
    const customerName = cleanText(payload.customerName ?? payload.customer_name, 120);
    const customerPhone = normalisePhone(payload.customerPhone ?? payload.customer_phone);

    if (!customerName) {
        throw ApiError.badRequest('Nama pelanggan wajib diisi.');
    }

    const bookingCode = await generateBookingCode();
    const balanceDue = round2(Math.max(totalFoodPrice - totalPaid, 0));
    const orderStatus = initialOrderStatus(paymentStatus);
    const paymentMethod = cleanText(payload.paymentMethod ?? payload.payment_method, 120) || 'Deposit Online';

    // Semak status wujud sebelum tulis (foreign key ke order_statuses).
    const statuses = await orders.loadStatuses();
    if (!statuses.has(orderStatus)) {
        throw ApiError.badRequest(`Status tidak sah: "${orderStatus}"`, { allowed: [...statuses.keys()] });
    }

    const { bookingId, orderId } = await db.transaction(async (connection) => {
        const r = db.runner(connection);

        const { insertId: newBookingId } = await r.insert(
            `insert into bookings
                (booking_code, customer_name, customer_phone, service_type, scheduled_at, pax,
                 notes, items, total_amount, deposit_amount, payment_status, order_status)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                bookingCode,
                customerName,
                customerPhone,
                serviceType,
                scheduledAt,
                pax,
                cleanText(payload.notes, 1000),
                JSON.stringify(items),
                totalFoodPrice,
                totalPaid,
                paymentStatus,
                orderStatus
            ]
        );

        const orderCode = await orders.generateOrderCode();
        const tableNumber = serviceType === 'takeaway'
            ? 'TAKEAWAY (Bungkus)'
            : `MEJA #${String((newBookingId % 15) + 1).padStart(2, '0')} (${pax} Pax)`;

        const { insertId: newOrderId } = await r.insert(
            `insert into orders
                (order_code, service_type, table_number, customer_name, customer_phone,
                 pax, scheduled_at, notes, items, total_food_price, deposit_amount,
                 total_amount, payment_method, payment_status, status, source)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderCode,
                serviceType,
                tableNumber,
                customerName,
                customerPhone,
                pax,
                scheduledAt,
                cleanText(payload.notes, 1000),
                JSON.stringify(items),
                totalFoodPrice,
                depositAmount,
                totalPaid,
                paymentMethod,
                paymentStatus,
                orderStatus,
                'booking_portal'
            ]
        );

        await orders.syncOrderItems(newOrderId, items, connection);
        await orders.logStatusChange(
            newOrderId, null, orderStatus, null, 'Tempahan diterima', connection
        );

        // Sambungkan bookings ke orders supaya status boleh disinkron kemudian.
        await r.execute('update bookings set order_id = ? where id = ?', [newOrderId, newBookingId]);

        return { bookingId: newBookingId, orderId: newOrderId };
    });

    const booking = await getBookingById(bookingId);
    const order = await orders.getOrderById(orderId);

    events.emit('order.created', { order }, { orderCode: order.order_code });
    events.emit('booking.created', { booking }, { orderCode: order.order_code });

    return { booking, order };
}

/** Baca satu tempahan ikut ID dalaman. */
async function getBookingById(id) {
    const row = await db.one('select * from bookings where id = ?', [id]);
    if (!row) throw ApiError.notFound(`Tempahan ID ${id} tidak dijumpai.`);
    return mapBooking(row);
}

/**
 * Baca tempahan ikut booking_code. Kode itu sendiri menjadi token akses,
 * jadi kalau telefon dihantar, ia mesti sama dengan rekod dalam database.
 */
async function getBookingByCode(code, phone = null) {
    const row = await db.one('select * from bookings where booking_code = ?', [
        String(code || '').trim().toUpperCase()
    ]);
    if (!row) {
        throw ApiError.notFound(`Tempahan "${code}" tidak dijumpai. Sila semak kod anda.`);
    }

    if (phone && row.customer_phone) {
        const same = String(row.customer_phone).replace(/\D/g, '') === String(phone).replace(/\D/g, '');
        if (!same) {
            throw ApiError.forbidden('Nombor telefon tidak sepadan dengan tempahan ini.');
        }
    }

    return mapBooking(row);
}

/** Senarai tempahan dengan penapis (panel pengurusan). */
async function listBookings({ status = null, serviceType = null, search = '', limit = 100 } = {}) {
    const where = [];
    const params = [];

    if (status) {
        where.push('order_status = ?');
        params.push(status);
    }
    if (serviceType) {
        where.push('service_type = ?');
        params.push(serviceType);
    }
    if (search) {
        where.push('(booking_code like ? or customer_name like ? or customer_phone like ?)');
        const like = `%${search}%`;
        params.push(like, like, like);
    }

    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const rows = await db.query(
        `select * from bookings ${clause} order by created_at desc limit ?`,
        [...params, Math.min(Number(limit) || 100, 500)]
    );
    return rows.map(mapBooking);
}

/** Batal tempahan oleh kaunter. Pesanan berkaitan ditutup sebagai selesai. */
async function cancelBooking(bookingId, { staffId = null, reason = null } = {}) {
    const booking = await db.one('select * from bookings where id = ?', [bookingId]);
    if (!booking) throw ApiError.notFound(`Tempahan ID ${bookingId} tidak dijumpai.`);

    if (booking.order_status === STATUS.COMPLETED) {
        throw ApiError.conflict('Tempahan yang sudah selesai tidak boleh dibatalkan.');
    }

    await db.transaction(async (connection) => {
        const r = db.runner(connection);
        await r.execute('update bookings set order_status = ? where id = ?', [
            STATUS.COMPLETED,
            bookingId
        ]);

        if (booking.order_id) {
            await r.execute(
                'update orders set status = ?, completed_at = coalesce(completed_at, now()) where id = ?',
                [STATUS.COMPLETED, booking.order_id]
            );
            await orders.logStatusChange(
                booking.order_id,
                booking.order_status,
                STATUS.COMPLETED,
                staffId,
                `Tempahan dibatalkan: ${reason || 'tidak dinyatakan'}`,
                connection
            );
        }
    });

    const updated = await getBookingById(bookingId);

    // Beritahu pelanggan yang sedang mengikuti pesanan ini.
    if (booking.order_id) {
        const order = await orders.getOrderById(booking.order_id);
        if (order) {
            events.emit('order.status', { order, previousStatus: booking.order_status },
                { orderCode: order.order_code });
        }
    }
    events.emit('booking.cancelled', { booking: updated });

    return updated;
}

/** Gantikan nota tempahan (dikemas kini oleh kaunter). */
async function addBookingNote(bookingId, note) {
    const text = cleanText(note, MAX_NOTE_LENGTH);
    if (!text) throw ApiError.badRequest('Nota tidak boleh kosong.');

    const booking = await db.one('select id from bookings where id = ?', [bookingId]);
    if (!booking) throw ApiError.notFound(`Tempahan ID ${bookingId} tidak dijumpai.`);

    await db.execute('update bookings set notes = ? where id = ?', [text, bookingId]);
    return getBookingById(bookingId);
}

module.exports = {
    generateBookingCode,
    calculateBookingDeposit,
    initialOrderStatus,
    createBooking,
    getBookingById,
    getBookingByCode,
    listBookings,
    cancelBooking,
    addBookingNote
};
