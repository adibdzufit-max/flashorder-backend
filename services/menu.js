'use strict';

const db = require('../db');
const { ApiError } = require('../errors');

/**
 * Baca menu daripada database supaya semua peranti nampak menu yang sama.
 * Bentuk jawapan sengaja sama dengan bentuk `MENU_DATABASE` dalam HTML:
 * kategori -> item -> addons, supaya kod rendering portal tidak perlu diubah.
 */

async function listCategories() {
    return db.query(
        'select id, name, sort_order from menu_categories where is_active = 1 order by sort_order, name'
    );
}

async function listAddons() {
    // Jadual `addons` tidak ada lajur sort_order - urutan ikut nama.
    return db.query(
        'select id, name, price from addons where is_active = 1 order by name'
    );
}

/** Kumpulan addon mengikut item, supaya portal tidak perlu query dua kali. */
async function addonMap() {
    const rows = await db.query(
        `select mia.menu_item_id, a.id, a.name, mia.price, mia.sort_order
           from menu_item_addons mia
           join addons a on a.id = mia.addon_id
          where a.is_active = 1
          order by mia.sort_order, a.name`
    );

    const map = new Map();
    for (const row of rows) {
        if (!map.has(row.menu_item_id)) map.set(row.menu_item_id, []);
        map.get(row.menu_item_id).push({ id: row.id, name: row.name, price: Number(row.price) });
    }
    return map;
}

/**
 * Senarai item menu.
 * @param {boolean} includeUnavailable true untuk KDS (perlu lihat item habis)
 */
async function listMenuItems({ includeUnavailable = false, categoryId = null } = {}) {
    const where = [];
    const params = [];

    if (!includeUnavailable) where.push('mi.is_available = 1');
    if (categoryId) {
        where.push('mi.category_id = ?');
        params.push(categoryId);
    }

    const clause = where.length ? `where ${where.join(' and ')}` : '';
    return db.query(
        `select mi.id, mi.name, mi.category_id, mi.price, mi.description, mi.image_url,
                mi.is_popular, mi.is_available, mi.prep_minutes, mc.name as category_name
           from menu_items mi
           join menu_categories mc on mc.id = mi.category_id and mc.is_active = 1
           ${clause}
          order by mc.sort_order, mi.name`,
        params
    );
}

/** Satu payload lengkap: { categories, items, addons } untuk portal pelanggan. */
async function getMenuPayload({ includeUnavailable = false } = {}) {
    const [categories, items, addons, perItem] = await Promise.all([
        listCategories(),
        listMenuItems({ includeUnavailable }),
        listAddons(),
        addonMap()
    ]);

    return {
        categories: categories.map((c) => ({
            id: c.id,
            name: c.name,
            sortOrder: c.sort_order
        })),
        items: items.map((i) => ({
            id: i.id,
            name: i.name,
            categoryId: i.category_id,
            categoryName: i.category_name,
            price: Number(i.price),
            description: i.description,
            image: i.image_url,
            isPopular: Boolean(i.is_popular),
            isAvailable: Boolean(i.is_available),
            prepMinutes: i.prep_minutes,
            addons: perItem.get(i.id) || []
        })),
        addons: addons.map((a) => ({
            id: a.id,
            name: a.name,
            price: Number(a.price)
        })),
        updatedAt: new Date().toISOString()
    };
}

/** Kaedah bayaran aktif (FPX / eWallet / tunai). */
async function listPaymentMethods() {
    const rows = await db.query(
        `select id, name, channel, provider, sort_order
           from payment_methods where is_active = 1 order by sort_order, name`
    );
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        channel: r.channel,
        provider: r.provider
    }));
}

/** Meja restoran yang aktif. */
async function listTables() {
    const rows = await db.query(
        `select id, table_number, capacity, location
           from restaurant_tables where is_active = 1 order by table_number`
    );
    return rows.map((r) => ({
        id: r.id,
        tableNumber: r.table_number,
        capacity: r.capacity,
        location: r.location
    }));
}

/** Toggle kesediaan item (KDS). */
async function setItemAvailability(itemId, isAvailable) {
    const result = await db.execute(
        'update menu_items set is_available = ? where id = ?',
        [isAvailable ? 1 : 0, itemId]
    );
    return { id: itemId, isAvailable: Boolean(isAvailable), changed: result.affectedRows > 0 };
}

/** Buang aksara bukan huruf/nombor dan kecilkan huruf untuk jadikan id ringkas. */
function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
}

/**
 * Tambah item menu baharu. Id dijana automatik daripada nama
 * (contohnya "Mee Goreng Pedas" -> "mee-goreng-pedas") dan menambah
 * akhiran angka jika id itu sudah dipakai.
 */
async function createMenuItem({
    name,
    categoryId,
    price,
    description = null,
    image = null,
    isPopular = false,
    prepMinutes = 10,
    isAvailable = true
} = {}) {
    const itemName = String(name || '').trim().slice(0, 160);
    if (!itemName) throw ApiError.badRequest('Nama menu wajib diisi.');

    const category = await db.one(
        'select id, name from menu_categories where id = ? and is_active = 1',
        [String(categoryId || '').trim()]
    );
    if (!category) throw ApiError.badRequest('Kategori tidak sah atau tidak aktif.');

    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) {
        throw ApiError.badRequest('Harga tidak sah. Masukkan nombor 0 atau lebih.');
    }

    // Id unik: cuba slug asas, kemudian tambah -2, -3, dan seterusnya.
    const base = slugify(itemName) || 'item';
    let itemId = base;
    let suffix = 1;
    /* eslint-disable no-await-in-loop */
    while (await db.one('select id from menu_items where id = ?', [itemId])) {
        suffix += 1;
        itemId = `${base}-${suffix}`;
    }
    /* eslint-enable no-await-in-loop */

    await db.execute(
        `insert into menu_items
            (id, name, category_id, price, description, image_url, is_popular, is_available, prep_minutes)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            itemId,
            itemName,
            category.id,
            value.toFixed(2),
            description ? String(description).trim().slice(0, 1000) : null,
            image ? String(image).trim().slice(0, 500) : null,
            isPopular ? 1 : 0,
            isAvailable ? 1 : 0,
            Math.max(0, Math.min(240, parseInt(prepMinutes, 10) || 10))
        ]
    );

    return {
        id: itemId,
        name: itemName,
        categoryId: category.id,
        categoryName: category.name,
        price: Number(value.toFixed(2)),
        description: description ? String(description).trim().slice(0, 1000) : null,
        image: image ? String(image).trim().slice(0, 500) : null,
        isPopular: Boolean(isPopular),
        isAvailable: Boolean(isAvailable),
        prepMinutes: Math.max(0, Math.min(240, parseInt(prepMinutes, 10) || 10)),
        addons: []
    };
}

/** Kemas kini harga item (admin sahaja). */
async function updateItemPrice(itemId, price) {
    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) {
        throw ApiError.badRequest('Harga tidak sah.');
    }
    await db.execute('update menu_items set price = ? where id = ?', [value.toFixed(2), itemId]);
    return { id: itemId, price: Number(value.toFixed(2)) };
}

module.exports = {
    listCategories,
    listAddons,
    addonMap,
    listMenuItems,
    getMenuPayload,
    listPaymentMethods,
    listTables,
    setItemAvailability,
    createMenuItem,
    updateItemPrice
};
