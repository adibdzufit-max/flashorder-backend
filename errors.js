'use strict';

const http = require('http');
const { STATUS_LIST } = require('./constants');

/**
 * Error domain: setiap ralat membawa `status` HTTP supaya handler
 * tidak perlu meneka.
 */
class ApiError extends Error {
    constructor(status, message, code = null, details = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    static badRequest(message, details = null) {
        return new ApiError(400, message, 'bad_request', details);
    }

    static unauthorized(message = 'Sila log masuk semula.') {
        return new ApiError(401, message, 'unauthorized');
    }

    static forbidden(message = 'Anda tidak mempunyai kebenaran untuk tindakan ini.') {
        return new ApiError(403, message, 'forbidden');
    }

    static notFound(message = 'Rekod tidak dijumpai.') {
        return new ApiError(404, message, 'not_found');
    }

    static conflict(message, details = null) {
        return new ApiError(409, message, 'conflict', details);
    }
}

/** 404 untuk laluan API yang tidak wujud. */
function notFoundHandler(req, res) {
    res.status(404).json({
        error: { code: 'not_found', message: `Laluan tidak wujud: ${req.method} ${req.originalUrl}` }
    });
}

/**
 * Handler ralat tunggal. Log ralat 5xx ke stderr, yang lain sekadar balas.
 */
function errorHandler(err, req, res, _next) {
    const status = err.status || 500;

    if (status >= 500) {
        console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    }

    const body = {
        error: {
            code: err.code || (status >= 500 ? 'internal_error' : 'request_error'),
            message: status >= 500 ? 'Ralat pelayan. Sila cuba lagi.' : err.message
        }
    };

    if (err.details) body.error.details = err.details;
    if (status >= 500 && !err.expose) body.error.requestId = req.id || null;

    res.status(status).json(body);
}

/** Bungkus async handler supaya rejection sampai ke errorHandler. */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/** Validasi nilai status pesanan. */
function assertValidStatus(status) {
    if (!STATUS_LIST.includes(status)) {
        throw ApiError.badRequest(`Status tidak sah: "${status}"`, {
            allowed: STATUS_LIST
        });
    }
}

/** Muat turun RSS dengan feed response.text() untuk ralat HTML yang useful. */
async function readFeed(response) {
    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ApiError(
            response.status,
            `Backend balas dengan JSON tidak sah (HTTP ${response.status}).`,
            'bad_gateway',
            text.slice(0, 300)
        );
    }
    if (!response.ok) {
        throw new ApiError(response.status, parsed?.error?.message || `HTTP ${response.status}`);
    }
    return parsed;
}

module.exports = {
    ApiError,
    notFoundHandler,
    errorHandler,
    asyncHandler,
    assertValidStatus,
    readFeed,
    http
};
