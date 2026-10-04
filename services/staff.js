'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { ApiError } = require('../errors');
const { STAFF_ROLES } = require('../middleware/auth');

/** Login staf -> token JWT. */
async function login(email, password) {
    const account = await db.one('select * from staff where email = ?', [String(email || '').trim().toLowerCase()]);

    // Mesej sama untuk email salah dan password salah supaya penyerang tidak
    // boleh teka akaun mana yang wujud.
    if (!account) {
        throw ApiError.unauthorized('Email atau kata laluan salah.');
    }
    if (!account.is_active) {
        throw ApiError.forbidden('Akaun ini dinyahaktifkan. Sila hubungi admin.');
    }

    const ok = await bcrypt.compare(String(password || ''), account.password_hash);
    if (!ok) {
        throw ApiError.unauthorized('Email atau kata laluan salah.');
    }

    await db.execute('update staff set last_login_at = now() where id = ?', [account.id]);

    return {
        id: account.id,
        email: account.email,
        fullName: account.full_name,
        role: account.role,
        lastLoginAt: account.last_login_at
    };
}

/** Senarai staf (admin/manager sahaja). */
async function listStaff() {
    const rows = await db.query(
        `select id, email, full_name, role, is_active, last_login_at, created_at
           from staff order by role, full_name`
    );
    return rows.map((row) => ({
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        isActive: Boolean(row.is_active),
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at
    }));
}

/** Cari staf berdasarkan emel (untuk semak duplicat). */
async function findByEmail(email) {
    const row = await db.one('select id, email from staff where email = ?', [
        String(email || '').trim().toLowerCase()
    ]);
    return row || null;
}

/** Jana akaun staf baharu. */
async function createStaff({ email, password, fullName, role = 'counter' }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw ApiError.badRequest('Email tidak sah.');
    }
    if (!STAFF_ROLES.includes(role)) {
        throw ApiError.badRequest(`Role tidak sah: "${role}"`, { allowed: STAFF_ROLES });
    }
    if (String(password || '').length < 8) {
        throw ApiError.badRequest('Kata laluan mesti sekurang-kurangnya 8 aksara.');
    }
    if (await findByEmail(cleanEmail)) {
        throw ApiError.conflict(`Email ${cleanEmail} sudah digunakan.`);
    }

    const hash = await bcrypt.hash(String(password), config.bcryptRounds);
    const { insertId } = await db.insert(
        'insert into staff (email, password_hash, full_name, role) values (?, ?, ?, ?)',
        [cleanEmail, hash, String(fullName || '').trim() || cleanEmail, role]
    );

    return { id: insertId, email: cleanEmail, fullName: fullName || cleanEmail, role };
}

/** Kemas kini peranan / status aktif (password tak boleh ditukar di sini). */
async function updateStaff(id, { role, isActive, fullName }) {
    const staff = await db.one('select * from staff where id = ?', [id]);
    if (!staff) throw ApiError.notFound(`Staf ID ${id} tidak dijumpai.`);

    const sets = [];
    const params = [];

    if (role !== undefined) {
        if (!STAFF_ROLES.includes(role)) {
            throw ApiError.badRequest(`Role tidak sah: "${role}"`, { allowed: STAFF_ROLES });
        }
        sets.push('role = ?');
        params.push(role);
    }
    if (isActive !== undefined) {
        sets.push('is_active = ?');
        params.push(isActive ? 1 : 0);
    }
    if (fullName !== undefined && String(fullName).trim()) {
        sets.push('full_name = ?');
        params.push(String(fullName).trim());
    }
    if (sets.length === 0) {
        throw ApiError.badRequest('Tiada medan untuk dikemas kini.');
    }

    params.push(id);
    await db.execute(`update staff set ${sets.join(', ')} where id = ?`, params);
    return { id: Number(id), updated: true };
}

/** Tukar kata laluan staf. */
async function changePassword(id, newPassword) {
    if (String(newPassword || '').length < 8) {
        throw ApiError.badRequest('Kata laluan mesti sekurang-kurangnya 8 aksara.');
    }
    const staff = await db.one('select id from staff where id = ?', [id]);
    if (!staff) throw ApiError.notFound(`Staf ID ${id} tidak dijumpai.`);

    const hash = await bcrypt.hash(String(newPassword), config.bcryptRounds);
    await db.execute('update staff set password_hash = ? where id = ?', [hash, id]);
    return { id: Number(id), passwordChanged: true };
}

module.exports = {
    login,
    listStaff,
    findByEmail,
    createStaff,
    updateStaff,
    changePassword
};
