'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { asyncHandler } = require('../errors');
const config = require('../config');

const menu = require('../services/menu');
const orders = require('../services/orders');
const bookings = require('../services/bookings');
const staffService = require('../services/staff');
const staffAuth = require('../middleware/auth');
const events = require('../events');
const db = require('../db');

const router = express.Router();

/** Had kadar untuk laluan tulis awam (protection daripada penyalahgunaan). */
const publicWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Terlalu banyak permintaan. Sila cuba sebentar lagi.' } }
});

// ============================================================================
// KESIHATAN
// ============================================================================

router.get('/health', asyncHandler(async (_req, res) => {
    let database = 'ok';
    try {
        await db.ping();
    } catch (err) {
        database = `error: ${err.code || err.message}`;
    }

    res.json({
        ok: database === 'ok',
        service: 'hotmas-backend',
        env: config.env,
        time: new Date().toISOString(),
        database,
        stream: events.stats()
    });
}));

// ============================================================================
// MENU & MASTER DATA (awam - semua portal perlukan menu yang sama)
// ============================================================================

router.get('/menu', asyncHandler(async (_req, res) => {
    res.json(await menu.getMenuPayload());
}));

/** Versi KDS: termasuk item yang dinyahaktifkan supaya kaunter boleh semak. */
router.get('/menu/all', staffAuth.requireAuth, asyncHandler(async (_req, res) => {
    res.json(await menu.getMenuPayload({ includeUnavailable: true }));
}));

router.patch('/menu/items/:id/availability',
    staffAuth.requireRole('counter', 'manager', 'admin'),
    asyncHandler(async (req, res) => {
        res.json(await menu.setItemAvailability(req.params.id, req.body?.isAvailable !== false));
    })
);

router.patch('/menu/items/:id/price',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.json(await menu.updateItemPrice(req.params.id, req.body?.price));
    })
);

/** Tambah item menu baharu (admin sahaja). */
router.post('/menu/items',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.status(201).json({ item: await menu.createMenuItem(req.body || {}) });
    })
);

router.get('/payment-methods', asyncHandler(async (_req, res) => {
    res.json({ paymentMethods: await menu.listPaymentMethods() });
}));

router.get('/tables', asyncHandler(async (_req, res) => {
    res.json({ tables: await menu.listTables() });
}));

router.get('/statuses', asyncHandler(async (_req, res) => {
    const statuses = await orders.loadStatuses(true);
    res.json({
        statuses: [...statuses.values()].map((s) => ({
            code: s.code,
            label: s.label,
            stage: s.stage,
            requiresKitchen: Boolean(s.requires_kitchen),
            isPending: Boolean(s.is_pending),
            isTerminal: Boolean(s.is_terminal)
        }))
    });
}));

// ============================================================================
// PESANAN AWAM (portal tempahan + ordering + tracking)
// ============================================================================

/** Cipta pesanan baharu dari portal ordering. */
router.post('/orders', publicWriteLimiter, asyncHandler(async (req, res) => {
    const order = await orders.createOrder(req.body || {}, { source: 'customer_portal' });
    res.status(201).json({ order });
}));

/** Pesanan demo untuk demo KDS (kaunter/manager sahaja). */
router.post('/orders/demo',
    staffAuth.requireRole('counter', 'manager', 'admin'),
    asyncHandler(async (req, res) => {
        const order = await orders.createOrder(req.body || {}, {
            staffId: req.staffId,
            source: 'kds_demo'
        });
        res.status(201).json({ order });
    })
);

/** Tracking awam: pelanggan hanya perlu order_code. */
router.get('/orders/track/:code', asyncHandler(async (req, res) => {
    res.json({ order: await orders.getOrderByCode(req.params.code) });
}));

/** Jejak status satu pesanan (dipakai panel status portal tempahan). */
router.get('/orders/:code/history', asyncHandler(async (req, res) => {
    const order = await orders.getOrderByCode(req.params.code);
    const rows = await db.query(
        `select from_status, to_status, note, changed_at
           from order_status_history
          where order_id = ?
          order by changed_at asc, id asc`,
        [order.id]
    );
    res.json({
        order,
        history: rows.map((r) => ({
            fromStatus: r.from_status,
            toStatus: r.to_status,
            note: r.note,
            at: r.changed_at
        }))
    });
}));

// ============================================================================
// TEMPAHAN AWAM (portal booking)
// ============================================================================

router.post('/bookings', publicWriteLimiter, asyncHandler(async (req, res) => {
    const { booking, order } = await bookings.createBooking(req.body || {});
    res.status(201).json({ booking, order });
}));

/** Semak tempahan ikut kod (+ telefon sebagai pengesahan kedua). */
router.get('/bookings/track/:code', asyncHandler(async (req, res) => {
    const booking = await bookings.getBookingByCode(req.params.code, req.query.phone || null);
    let order = null;
    if (booking.orderId) {
        try {
            order = await orders.getOrderById(booking.orderId);
        } catch {
            order = null;
        }
    }
    res.json({ booking, order });
}));

// ============================================================================
// AUTH STAF
// ============================================================================

const loginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: { code: 'rate_limited', message: 'Terlalu banyak percubaan login. Cuba lagi dalam 10 minit.' }
    }
});

router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const account = await staffService.login(email, password);
    const token = staffAuth.signToken(account);
    res.json({ token, staff: account });
}));

router.get('/auth/me', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    res.json({ staff: req.staff });
}));

router.get('/staff', staffAuth.requireRole('admin', 'manager'), asyncHandler(async (_req, res) => {
    res.json({ staff: await staffService.listStaff() });
}));

router.post('/staff',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.status(201).json({ staff: await staffService.createStaff(req.body || {}) });
    })
);

router.patch('/staff/:id',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.json({
            staff: await staffService.updateStaff(req.params.id, {
                role: req.body?.role,
                isActive: req.body?.isActive,
                fullName: req.body?.fullName
            })
        });
    })
);

router.post('/staff/:id/password',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.json({
            staff: await staffService.changePassword(req.params.id, req.body?.password)
        });
    })
);

// ============================================================================
// OPERASI STAF: SENARAI PESANAN, STATUS, ITEM, BAYARAN
// ============================================================================

router.get('/orders', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    const list = await orders.listOrders({
        tab: req.query.tab || 'all',
        search: req.query.search || '',
        limit: req.query.limit || 200,
        serviceType: req.query.serviceType || null,
        status: req.query.status || null
    });
    res.json({ orders: list, count: list.length });
}));

router.get('/orders/id/:id', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    res.json({ order: await orders.getOrderById(req.params.id) });
}));

router.patch('/orders/:id/status',
    staffAuth.requireAuth,
    asyncHandler(async (req, res) => {
        const nextStatus = req.body?.status;
        if (!nextStatus) {
            res.status(400).json({ error: { code: 'bad_request', message: 'Medan "status" wajib dihantar.' } });
            return;
        }
        const order = await orders.updateOrderStatus(req.params.id, nextStatus, {
            staffId: req.staffId,
            staffRole: req.staffRole,
            note: req.body?.note || null
        });
        res.json({ order });
    })
);

router.patch('/orders/:id/items/:lineNo',
    staffAuth.requireRole('kitchen', 'counter', 'manager', 'admin'),
    asyncHandler(async (req, res) => {
        const order = await orders.toggleOrderItem(req.params.id, req.params.lineNo, {
            staffId: req.staffId
        });
        res.json({ order });
    })
);

router.post('/orders/:id/payments', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    const order = await orders.recordPayment(req.params.id, {
        kind: req.body?.kind || 'balance',
        method: req.body?.method || 'cash',
        methodLabel: req.body?.methodLabel || null,
        amount: req.body?.amount,
        reference: req.body?.reference || null,
        status: req.body?.status || 'paid',
        isSimulated: req.body?.isSimulated !== false,
        staffId: req.staffId
    });
    res.json({ order });
}));

router.delete('/orders/:id',
    staffAuth.requireRole('admin'),
    asyncHandler(async (req, res) => {
        res.json(await orders.deleteOrder(req.params.id));
    })
);

// ============================================================================
// TEMPAHAN STAF
// ============================================================================

router.get('/bookings', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    const list = await bookings.listBookings({
        status: req.query.status || null,
        serviceType: req.query.serviceType || null,
        search: req.query.search || '',
        limit: req.query.limit || 100
    });
    res.json({ bookings: list, count: list.length });
}));

router.post('/bookings/:id/cancel',
    staffAuth.requireRole('counter', 'manager', 'admin'),
    asyncHandler(async (req, res) => {
        const booking = await bookings.cancelBooking(req.params.id, {
            staffId: req.staffId,
            reason: req.body?.reason || null
        });
        res.json({ booking });
    })
);

router.patch('/bookings/:id/note', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    res.json({ booking: await bookings.addBookingNote(req.params.id, req.body?.notes) });
}));

// ============================================================================
// METRIK KDS & LAPORAN
// ============================================================================

router.get('/kds/metrics', staffAuth.requireAuth, asyncHandler(async (_req, res) => {
    res.json({ metrics: await orders.getKdsMetrics() });
}));

/** Papan dapur: satu baris setiap item, dengan minit berlalu. */
router.get('/kds/board', staffAuth.requireRole('kitchen', 'counter', 'manager', 'admin'),
    asyncHandler(async (_req, res) => {
        const rows = await db.query('select * from v_kitchen_board order by created_at asc, line_no asc');
        res.json({
            board: rows.map((r) => ({
                orderId: r.id,
                orderCode: r.order_code,
                tableNumber: r.table_number,
                status: r.status,
                elapsedMinutes: r.elapsed_minutes,
                lineNo: r.line_no,
                itemName: r.item_name,
                quantity: r.quantity,
                unitPrice: Number(r.unit_price),
                lineTotal: Number(r.line_total),
                note: r.note,
                isDone: Boolean(r.is_done)
            }))
        });
    })
);

router.get('/reports/daily-sales', staffAuth.requireRole('counter', 'manager', 'admin'),
    asyncHandler(async (req, res) => {
        const rows = await orders.getDailySales(req.query.days || 7);
        res.json({
            dailySales: rows.map((r) => ({
                date: r.sale_date,
                completedOrders: Number(r.completed_orders),
                openOrders: Number(r.open_orders),
                grossRevenue: Number(r.gross_revenue),
                collectedAmount: Number(r.collected_amount),
                outstandingAmount: Number(r.outstanding_amount)
            }))
        });
    })
);

// ============================================================================
// STREAM SSE - kemas kini langsung antara peranti
// ============================================================================

/** KDS / kaunter: terima semua perubahan pesanan. */
router.get('/stream/staff', staffAuth.requireAuth, asyncHandler(async (req, res) => {
    events.subscribe(req, res, { channel: events.CHANNEL.STAFF, staffId: req.staffId });
}));

/** Pelanggan: hanya perubahan satu order_code. */
router.get('/stream/order/:code', asyncHandler(async (req, res) => {
    const order = await orders.getOrderByCode(req.params.code);
    events.subscribe(req, res, {
        channel: events.CHANNEL.PUBLIC,
        orderCode: order.order_code
    });
}));

module.exports = router;
