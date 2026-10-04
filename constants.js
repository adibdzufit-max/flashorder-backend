'use strict';

/**
 * Konstanta domain yang dikongsi antara backend dan ketiga-tiga portal.
 *
 * NILAI `status` MESTI sama dengan yang dihantar oleh HTML asal, kerana
 * `order_statuses.code` di database menggunakan foreign key kepada teks ini.
 */

const SERVICE_TYPES = {
    DINEIN_FOOD: 'dinein_food',
    TAKEAWAY: 'takeaway',
    DINEIN_ONLY: 'dinein_only'
};

const SERVICE_TYPE_LIST = Object.values(SERVICE_TYPES);

const STATUS = {
    AWAITING_COUNTER: 'Pembayaran Berjaya - Menunggu Pengesahan Kaunter',
    DEPOSIT_CONFIRMED: 'Deposit Disahkan (Menunggu Kaunter)',
    AWAITING_PAYMENT: 'Menunggu Pengesahan Bayaran (Simulasi)',
    ACCEPTED: 'Diterima oleh Kaunter',
    TABLE_ONLY: 'Meja Disahkan (Hanya Kaunter)',
    COOKING: 'Sedang Disediakan',
    READY: 'Pesanan Siap',
    COMPLETED: 'Selesai',
    PENDING: 'pending'
};

const STATUS_LIST = Object.values(STATUS);

/** Status yang perlu pengesahan kaunter (tab "Menunggu Kaunter"). */
const PENDING_STATUSES = [
    STATUS.AWAITING_COUNTER,
    STATUS.DEPOSIT_CONFIRMED,
    STATUS.AWAITING_PAYMENT
];

/** Status di mana pesanan ada di dapur. */
const KITCHEN_STATUSES = [STATUS.ACCEPTED, STATUS.COOKING, STATUS.READY];

/** Status akhir - pesanan tidak boleh dihantar semula ke dapur. */
const TERMINAL_STATUSES = [STATUS.COMPLETED];

/** Peta status -> status seterusnya yang dibenarkan (untuk butang KDS). */
const STATUS_TRANSITIONS = {
    [STATUS.AWAITING_COUNTER]: [STATUS.ACCEPTED, STATUS.TABLE_ONLY],
    [STATUS.DEPOSIT_CONFIRMED]: [STATUS.ACCEPTED, STATUS.TABLE_ONLY],
    [STATUS.AWAITING_PAYMENT]: [STATUS.ACCEPTED, STATUS.TABLE_ONLY],
    [STATUS.ACCEPTED]: [STATUS.COOKING, STATUS.READY],
    [STATUS.TABLE_ONLY]: [STATUS.COMPLETED],
    [STATUS.COOKING]: [STATUS.READY],
    [STATUS.READY]: [STATUS.COMPLETED],
    [STATUS.COMPLETED]: [],
    [STATUS.PENDING]: [STATUS.ACCEPTED, STATUS.TABLE_ONLY]
};

/** Deposit meja: RM 5.00 seorang. */
const TABLE_DEPOSIT_PER_PAX = 5.0;

/** Deposit makanan / bungkus: 50% daripada jumlah makanan. */
const FOOD_DEPOSIT_RATE = 0.5;

/** Had maksimum item satu pesanan (cegah payload gila). */
const MAX_ITEMS_PER_ORDER = 60;

/** Had panjang nota. */
const MAX_NOTE_LENGTH = 255;

module.exports = {
    SERVICE_TYPES,
    SERVICE_TYPE_LIST,
    STATUS,
    STATUS_LIST,
    PENDING_STATUSES,
    KITCHEN_STATUSES,
    TERMINAL_STATUSES,
    STATUS_TRANSITIONS,
    TABLE_DEPOSIT_PER_PAX,
    FOOD_DEPOSIT_RATE,
    MAX_ITEMS_PER_ORDER,
    MAX_NOTE_LENGTH
};
