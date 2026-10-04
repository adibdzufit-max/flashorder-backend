'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./errors');

/**
 * Rmajukan aplikasi Express. `server.js` yang bertanggungjawab untuk membuka
 * port dan menutup dengan selamat; fail ini hanya susun atur middleware
 * supaya ujian automatik boleh import aplikasi tanpa membuka port.
 */

function createApp() {
    const app = express();

    // Di belakang reverse proxy (Nginx / hosting Railway), req.ip mesti ikut
    // x-forwarded-for supaya rate limit mengira IP sebenar. Jangan aktifkan
    // secara membuta tulin kerana express-rate-limit akan menolak trust proxy
    // yang terlalu permisif.
    app.set('trust proxy', config.isProduction ? 1 : false);
    app.disable('x-powered-by');

    app.use(helmet({
        // Portal HTML dibuka dari fail/host lain, jadi CSP yang ketat akan
        // menghalang skrip dalaman yang tidak diubah.
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));

    const allowAll = config.corsOrigin === '*';
    app.use(cors({
        origin: allowAll ? true : config.corsOrigin.split(',').map((o) => o.trim()),
        credentials: !allowAll
    }));

    // Body parser hanya membaca body permintaan biasa; sambungan SSE tidak
    // memerlukan ini kerana tiada body dihantar oleh EventSource.
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));

    if (config.logLevel !== 'silent') {
        app.use(morgan(config.logLevel, {
            // Jangan log stream SSE: setiap sambungan tinggal berjam-jam.
            skip: (req) => req.path.startsWith('/api/stream/')
        }));
    }

    app.get('/', (_req, res) => {
        res.json({
            service: 'Hotmas Restaurant Backend',
            version: '1.0.0',
            docs: '/api/health'
        });
    });

    app.use('/api', routes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
