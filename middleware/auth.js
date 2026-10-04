'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { ApiError } = require('../errors');

/**
 * Auth JWT untuk KDS / Kaunter.
 *
 * Pelanggan (tempahan, ordering, tracking) tidak perlukan token. Mereka
 * dikesan dengan order_code yang dijana server, jadi token tidak bocor.
 */

const ROLES = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    COUNTER: 'counter',
    KITCHEN: 'kitchen'
};

const STAFF_ROLES = Object.values(ROLES);

/** Peranan yang boleh capai papan dapur. */
const KITCHEN_ROLES = [ROLES.KITCHEN, ROLES.MANAGER, ROLES.ADMIN];

function signToken(staff) {
    return jwt.sign(
        {
            sub: staff.id,
            email: staff.email,
            name: staff.full_name,
            role: staff.role
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
    );
}

/**
 * Baca token daripada header Authorization atau query ?token=.
 * EventSource tidak boleh menghantar header, jadi SSE guna bentuk query.
 */
function extractToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    if (typeof req.query?.token === 'string' && req.query.token) return req.query.token;
    return null;
}

function verifyToken(token) {
    try {
        return jwt.verify(token, config.jwt.secret);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw ApiError.unauthorized('Sesi tamat. Sila log masuk semula.');
        }
        throw ApiError.unauthorized('Token tidak sah.');
    }
}

/** Semak token dan muat data staf ke req.staff. */
async function loadStaff(req) {
    const staff = await db.one(
        'select id, email, full_name, role, is_active from staff where id = ?',
        [req.tokenPayload.sub]
    );
    if (!staff) throw ApiError.unauthorized('Akaun tidak dijumpai.');
    if (!staff.is_active) throw ApiError.forbidden('Akaun dinyahaktifkan.');
    return staff;
}

/** Wajib ada staf yang log masuk. */
async function requireAuth(req, _res, next) {
    try {
        const token = extractToken(req);
        if (!token) throw ApiError.unauthorized('Tiada token. Sila log masuk.');

        req.tokenPayload = verifyToken(token);
        // Akaun boleh dinyahaktifkan atau kata laluan ditukar tanpa perlu
        // menunggu token lama tamat tempoh, jadi semak semula ke DB.
        req.staff = await loadStaff(req);
        req.staffId = req.staff.id;
        req.staffRole = req.staff.role;
        next();
    } catch (err) {
        next(err);
    }
}

/** Token sah tetapi opsyonal - untuk laluan yang boleh jadi awam atau staf. */
async function optionalAuth(req, _res, next) {
    const token = extractToken(req);
    if (!token) return next();
    try {
        req.tokenPayload = verifyToken(token);
        req.staff = await loadStaff(req);
        req.staffId = req.staff.id;
        req.staffRole = req.staff.role;
    } catch {
        // token rosak atau tamat tempoh - teruskan sebagai pelawat biasa
    }
    next();
}

/**
 * Wajib ada staf yang log masuk DAN per-role yang dibenarkan.
 * Menyertakan requireAuth supaya laluan tidak tersilup lupa semak token.
 */
function requireRole(...roles) {
    const allowed = roles.flat();

    return (req, res, next) => {
        requireAuth(req, res, (err) => {
            if (err) return next(err);
            if (!allowed.includes(req.staff.role)) {
                return next(ApiError.forbidden(
                    `Peranan ${allowed.join(', ')} sahaja boleh guna laluan ini.`
                ));
            }
            next();
        });
    };
}

module.exports = {
    ROLES,
    STAFF_ROLES,
    KITCHEN_ROLES,
    signToken,
    verifyToken,
    extractToken,
    requireAuth,
    optionalAuth,
    requireRole
};
