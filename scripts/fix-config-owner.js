// Consolidates configs_canales / configs_extras onto a single Discord account.
//
// Every lookup in the bot is keyed on discord_id (see obtenerCanalComando in bot.js), so
// if two accounts have both run /setup the config silently splits in half: whichever
// account clicks a button sees only its own rows, and the other half looks like it was
// never configured. This removes the rows that do not belong to the account you actually
// use, so one consistent set is left.
//
// Dry run by default -- prints what WOULD be removed and changes nothing:
//     node scripts/fix-config-owner.js <discord_id_to_keep>
// Add --apply to actually write. A timestamped backup of database.db is taken first.
//     node scripts/fix-config-owner.js <discord_id_to_keep> --apply
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const RAIZ = global.__baseDir || path.join(__dirname, '..');
const RUTA_DB = path.join(RAIZ, 'database.db');

const TABLAS = ['configs_canales', 'configs_extras'];

function main() {
    const keep = (process.argv[2] || '').trim();
    const apply = process.argv.includes('--apply');

    if (!/^\d{17,20}$/.test(keep)) {
        console.error('Usage: node scripts/fix-config-owner.js <discord_id_to_keep> [--apply]');
        console.error('  <discord_id_to_keep> must be a Discord user ID (17-20 digits).');
        process.exit(1);
    }
    if (!fs.existsSync(RUTA_DB)) {
        console.error(`No database.db at ${RUTA_DB}`);
        process.exit(1);
    }

    const db = new DatabaseSync(RUTA_DB);

    // Report first, always -- in both dry-run and apply mode, so the output says what
    // happened rather than just that something did.
    let totalSobra = 0;
    for (const tabla of TABLAS) {
        let filas;
        try {
            filas = db.prepare(`SELECT discord_id, COUNT(*) AS n FROM ${tabla} GROUP BY discord_id`).all();
        } catch (e) {
            console.log(`${tabla}: not present, skipping`);
            continue;
        }
        console.log(`\n${tabla}:`);
        for (const f of filas) {
            const marca = String(f.discord_id) === keep ? 'KEEP  ' : 'REMOVE';
            console.log(`  ${marca}  discord_id=${f.discord_id}  ${f.n} row(s)`);
            if (String(f.discord_id) !== keep) totalSobra += f.n;
        }
    }

    if (totalSobra === 0) {
        console.log(`\nNothing to do -- every row already belongs to ${keep}.`);
        return;
    }

    if (!apply) {
        console.log(`\nDRY RUN: ${totalSobra} row(s) would be removed. Nothing was changed.`);
        console.log('Re-run with --apply to write, after taking a look at the list above.');
        return;
    }

    // Backup before the first write. Restoring is just copying this back over database.db.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(RAIZ, `database.db.backup-${stamp}`);
    fs.copyFileSync(RUTA_DB, backup);
    console.log(`\nBackup written: ${path.basename(backup)}`);

    let borradas = 0;
    for (const tabla of TABLAS) {
        try {
            const r = db.prepare(`DELETE FROM ${tabla} WHERE discord_id IS NOT NULL AND discord_id != ?`).run(keep);
            const n = Number(r.changes || 0);
            borradas += n;
            console.log(`  ${tabla}: removed ${n} row(s)`);
        } catch (e) {
            console.log(`  ${tabla}: skipped (${e.message})`);
        }
    }

    console.log(`\nDone -- ${borradas} row(s) removed. ${keep} is now the only owner.`);
    console.log('Next: restart the bot, then run /setup -> Sync Channels once to refresh the webhooks.');
}

main();
