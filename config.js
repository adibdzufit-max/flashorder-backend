'use strict';

/**
 * Konfigurasi dibaca daripada .env. Gagal awal dengan mesej jelas supaya
 * salah konfigurator tidak RuntimeError yang mengelirukan nanti.
 */

require('dotenv').config();

const required = (key, fallback) => {
    const value = process.env[key] ?? fallback;
    if (value === undefined || value === null || value === '') {
        throw new Error(`Konfigurasi environment "${key}" tiada dalam .env`);
    }
    return value;
};

const int = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
    const secret = process.env.JWT_SECRET || '';
    if (!secret || secret.includes('ganti-dengan')) {
        throw new Error('JWT_SECRET wajib ditetapkan dalam .env untuk NODE_ENV=production');
    }
    if (secret.length < 32) {
        throw new Error('JWT_SECRET mesti sekurang-kurangnya 32 aksara');
    }
}

module.exports = {
    env: process.env.NODE_ENV || 'development',
    isProduction,
    port: int(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    logLevel: process.env.LOG_LEVEL || (isProduction ? 'combined' : 'dev'),

    db: {
        host: required('DB_HOST', '127.0.0.1'),
        port: int(process.env.DB_PORT, 3306),
        user: required('DB_USER', 'root'),
        password: process.env.DB_PASSWORD ?? '',
        database: required('DB_NAME', 'hotmas'),
        connectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10)
    },

    jwt: {
        secret: required('JWT_SECRET', 'dev-secret-ganti-ini'),
        expiresIn: process.env.JWT_EXPIRES_IN || '12h'
    },

    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10)
};
