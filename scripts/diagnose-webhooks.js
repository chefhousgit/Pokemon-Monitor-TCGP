// Read-only webhook health check. Tests every webhook stored in database.db against
// Discord and reports which are alive, which are dead (404 "Unknown Webhook"), and which
// are unreachable for some other reason.
//
// Nothing is written -- this only ever issues GETs. Run with:
//     node scripts/diagnose-webhooks.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = global.__baseDir || path.join(__dirname, '..');
const RUTA_DB = path.join(RAIZ, 'database.db');

function redactar(url) {
    // Keep enough to tell two webhooks apart, never the full token.
    const m = String(url).match(/webhooks\/(\d+)\/(.+)$/);
    if (!m) return String(url).slice(0, 40);
    return `webhooks/${m[1]}/${m[2].slice(0, 6)}...`;
}

async function estado(url) {
    try {
        const resp = await axios.get(url, { timeout: 8000 });
        return { vivo: true, detalle: `OK (channel ${resp.data?.channel_id || '?'})` };
    } catch (e) {
        const code = e?.response?.status;
        const msg = e?.response?.data?.message || e.message;
        if (code === 404) return { vivo: false, detalle: `DEAD 404 ${msg}` };
        return { vivo: null, detalle: `UNKNOWN ${code || ''} ${msg}` };
    }
}

async function main() {
    if (!fs.existsSync(RUTA_DB)) {
        console.error(`No database.db at ${RUTA_DB}`);
        process.exit(1);
    }
    const db = new DatabaseSync(RUTA_DB);
    const filas = db.prepare(
        `SELECT discord_id, tipo, canal_id, webhook_url FROM configs_canales
         WHERE webhook_url LIKE 'https://discord.com/api/webhooks/%' ORDER BY tipo`
    ).all();

    console.log(`database.db: ${RUTA_DB}`);
    console.log(`${filas.length} stored webhook(s)\n`);

    const muertos = [];
    for (const f of filas) {
        const r = await estado(f.webhook_url);
        const marca = r.vivo === true ? 'ALIVE' : r.vivo === false ? 'DEAD ' : 'ERR  ';
        console.log(`${marca}  ${f.tipo.padEnd(22)} channel=${String(f.canal_id).padEnd(20)} ${redactar(f.webhook_url)}`);
        if (r.vivo !== true) console.log(`        -> ${r.detalle}`);
        if (r.vivo === false) muertos.push(f);
    }

    // Rows the send path would reject outright, separately from dead webhooks.
    const sinWebhook = db.prepare(
        `SELECT tipo FROM configs_canales WHERE webhook_url IN ('N/A','local') OR webhook_url IS NULL ORDER BY tipo`
    ).all().map(r => r.tipo);

    console.log('');
    console.log(`dead: ${muertos.length}`);
    if (muertos.length) console.log(`  ${muertos.map(m => m.tipo).join(', ')}`);
    console.log(`no webhook (N/A or local): ${sinWebhook.length}`);
    if (sinWebhook.length) console.log(`  ${sinWebhook.join(', ')}`);

    // Distinct owners -- a mismatch here means /setup wrote rows under one Discord user
    // while the send path looks them up under another, which reads as "configured but
    // broken" and is invisible from inside Discord.
    const owners = db.prepare(`SELECT DISTINCT discord_id FROM configs_canales WHERE discord_id IS NOT NULL`).all();
    console.log(`\ndistinct discord_id values in configs_canales: ${owners.map(o => o.discord_id).join(', ') || '(none)'}`);

    // Per-owner breakdown. Every lookup in the bot is keyed on discord_id, so config split
    // across two accounts means whichever one you click with sees only its own half -- the
    // other account's rows are invisible to it, which reads as "set up but broken".
    if (owners.length > 1) {
        console.log('\n*** More than one account owns config rows -- this splits your setup. ***');
        for (const o of owners) {
            const filasO = db.prepare(`SELECT tipo, webhook_url FROM configs_canales WHERE discord_id = ?`).all(o.discord_id);
            const conHook = filasO.filter(f => String(f.webhook_url || '').startsWith('https://discord.com/api/webhooks/'));
            console.log(`\n  discord_id ${o.discord_id}: ${filasO.length} rows, ${conHook.length} with a webhook`);
            const trading = filasO.find(f => f.tipo === 'cmd_run_instance');
            console.log(`    cmd_run_instance (Trading): ${trading ? redactar(trading.webhook_url) : 'MISSING'}`);
            if (trading) {
                const r = await estado(trading.webhook_url);
                console.log(`      -> ${r.detalle}`);
            }
        }
        console.log('\n  The account you click with in Discord is the one whose rows get used.');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
