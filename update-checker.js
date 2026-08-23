const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./database.js');

const VERSION_PATH = path.join(__dirname, 'version.json');
const PENDING_UPDATE_PATH = path.join(__dirname, '.pending_update.json');
const UPDATE_FALLO_PATH = path.join(__dirname, 'update_fallo.txt');
const ASSETS_ZIP_TEMP_PATH = path.join(__dirname, 'assets-actualizacion.zip');
// Which repository the auto-updater trusts. Upstream this was hardcoded to the
// original author's repo (AleCast09/Pokemon-Monitor-TCGP), which meant he could push a
// new release at any time and every installation would fetch and execute it. It now
// points at your own fork by default, and can be repointed with UPDATE_REPO=owner/name
// in .env without touching code.
//
// Everything downstream follows from this: the updater reads version.json from this
// repo, and version.json is what carries the downloadUrl/panelDownloadUrl/assetsUrl for
// the binaries. Change this one value (and the URLs inside your version.json) and no
// part of the update path reaches upstream any more.
const UPDATE_REPO = (process.env.UPDATE_REPO || 'chefhousgit/Pokemon-Monitor-TCGP').trim();
const UPDATE_BRANCH = (process.env.UPDATE_BRANCH || 'main').trim();

// In-app updating is OFF by default, because the mirror above is a PRIVATE repo:
// raw.githubusercontent.com, the api.github.com fallback and the release-asset URLs all
// return 404 to an unauthenticated client, so every update path would fail anyway — just
// noisily, with dead buttons and an error toast instead of a clear explanation.
//
// Updating is manual now: git pull, then `npm run build:exe`. See RELEASING.md.
// Set UPDATE_CHECK_ENABLED=true only if the repo is public, or if you have added an
// authenticated fetch for the private case.
const UPDATE_CHECK_ENABLED = /^(true|1|yes)$/i.test(process.env.UPDATE_CHECK_ENABLED || '');
const MENSAJE_UPDATE_MANUAL =
    'ℹ️ In-app updates are disabled — this build tracks a private repo. ' +
    'To update: `git pull` then `npm run build:exe`, and restart from the Control Panel.';
const VERSION_URL_REMOTA = `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/version.json`;
// Respaldo por si raw.githubusercontent.com esta bloqueado por el ISP del
// usuario (reporte real 2026-07-30: varios usuarios, no solo uno, con
// "Check for Updates" fallando siempre por Discord y solo funcionando bajando
// el .exe a mano -- raw.githubusercontent.com tiene historial de bloqueos
// regionales de algunos proveedores en Latinoamerica). Mismo contenido,
// dominio distinto -- si uno esta bloqueado el otro probablemente no.
const VERSION_URL_RESPALDO = `https://api.github.com/repos/${UPDATE_REPO}/contents/version.json?ref=${UPDATE_BRANCH}`;

function obtenerVersionLocal() {
    return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
}

// version.json supplies the URLs that the updater downloads and then RUNS as the new
// .exe, so a version.json that says downloadUrl = "http://evil/x.exe" is remote code
// execution. Upstream fetched whatever URL it was handed. Every download URL must now
// live under the same GitHub repo the version manifest itself came from (UPDATE_REPO),
// over https. Anything else is refused and the update aborts.
function urlDeConfianza(url) {
    if (!url) return false;
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { return false; }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'objects.githubusercontent.com') return false;
    // github.com/<owner>/<repo>/releases/download/... — the owner/repo prefix must match.
    if (parsed.hostname === 'github.com') {
        return parsed.pathname.toLowerCase().startsWith(`/${UPDATE_REPO.toLowerCase()}/`);
    }
    // objects.githubusercontent.com is where github.com release links redirect to; it
    // carries no repo path, so it is only ever reached via a redirect we already vetted.
    return true;
}

function exigirUrlDeConfianza(url, queEs) {
    if (!urlDeConfianza(url)) {
        throw new Error(`Refusing to download the ${queEs}: ${url} is not a release asset of ${UPDATE_REPO}.`);
    }
}

// Un AggregateError (el "Received one or more errors" generico de la carrera
// IPv4/IPv6 de Node) esconde el motivo real dentro de e.errors -- .message
// solo no alcanza para diagnosticar nada. Esto junta el detalle real de cada
// intento fallido en un solo string legible.
function describirError(e) {
    if (e?.errors?.length) {
        return e.errors.map((x) => x?.code || x?.message || String(x)).join(' | ');
    }
    return e?.code || e?.response?.status || e?.message || String(e);
}

async function obtenerVersionRemota() {
    try {
        const resp = await axios.get(VERSION_URL_REMOTA, { timeout: 8000, headers: { 'Cache-Control': 'no-cache' } });
        return resp.data;
    } catch (e) {
        const resp = await axios.get(VERSION_URL_RESPALDO, {
            timeout: 8000,
            headers: { 'Cache-Control': 'no-cache', 'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'MonitorPokemon' }
        });
        return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    }
}

function esVersionMasNueva(remota, local) {
    const a = String(remota).split('.').map(Number);
    const b = String(local).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
}

// version.json acumula las notas de TODAS las versiones anteriores (nunca se
// borran) - a esta altura ya suman miles de caracteres, muy por encima del
// limite de 4096 de la descripcion de un embed de Discord, lo que rompia esta
// respuesta con un error cada vez que SI habia una actualizacion real (bug
// real 2026-07-30, solo se notaba en ese caso porque "ya estas actualizado"
// no arma este embed). Se muestran solo las notas mas nuevas que entren.
//
// notesCount (bug real 2026-07-31): el corte por caracteres solo evitaba el
// error de Discord, pero igual mostraba notas de varias versiones viejas
// mezcladas con las de la version actual -- confuso, el usuario esperaba ver
// solo "lo nuevo de esta version". version.json ahora guarda cuantas de las
// notas (las primeras, mas nuevas) pertenecen a la version actual; si viene,
// se usa ese numero en vez de rellenar hasta el limite de caracteres.
function notasParaEmbed(notes, notesCount) {
    const lista = (notesCount && notesCount > 0) ? (notes || []).slice(0, notesCount) : (notes || []);
    const limite = 3500;
    let acumulado = '';
    let incluidas = 0;
    for (const nota of lista) {
        const linea = `• ${nota}\n`;
        if (acumulado.length + linea.length > limite) break;
        acumulado += linea;
        incluidas++;
    }
    if (incluidas < lista.length) {
        acumulado += `_...and ${lista.length - incluidas} more change${lista.length - incluidas === 1 ? '' : 's'} - see the full history on GitHub._`;
    }
    return acumulado.trim();
}

function construirPayloadActualizacion(local, remota) {
    const embed = new EmbedBuilder()
        .setTitle('🔔 An update is available')
        .setColor(0xF0A93A)
        .setDescription(
            `**${local.version}** → **${remota.version}**\n\n` +
            `**What's new:**\n` +
            notasParaEmbed(remota.notes, remota.notesCount)
        );
    const fila = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('actualizacion_ahora').setLabel('Update now').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('actualizacion_luego').setLabel('Later').setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed.toJSON()], components: [fila.toJSON()] };
}

async function obtenerDestinoNotificacion(client) {
    // Se busca el ID del dueño SIEMPRE (no solo cuando no hay webhook) -- a
    // pedido explicito del usuario 2026-07-30: un embed sin mencion en el
    // canal de Updates pasa desapercibido facil (nadie vuelve a mirar el bot
    // una vez que ya lo dejo corriendo). Con el ID, el aviso por webhook
    // tambien puede hacerle "@mencion" directa, no solo quedar ahi mudo.
    let ownerId = null;
    try {
        const app = await client.application.fetch();
        ownerId = app.owner?.id || app.owner?.ownerId || null;
    } catch (e) { /* sin dueño detectable */ }

    const filaWebhook = await db.get(
        `SELECT webhook_url FROM configs_canales WHERE tipo = 'actualizaciones' AND webhook_url LIKE 'https://discord.com/api/webhooks/%' ORDER BY rowid DESC LIMIT 1`
    );
    if (filaWebhook?.webhook_url) return { tipo: 'webhook', webhookUrl: filaWebhook.webhook_url, ownerId };

    if (ownerId) return { tipo: 'dm', userId: ownerId };
    return null;
}

async function chequearActualizaciones(client) {
    // Disabled by default -- see UPDATE_CHECK_ENABLED. Returning early keeps the periodic
    // background check from firing a request every few hours that can only ever 404.
    if (!UPDATE_CHECK_ENABLED) return;
    try {
        const local = obtenerVersionLocal();
        const remota = await obtenerVersionRemota();
        if (!esVersionMasNueva(remota.version, local.version)) return;

        // Este chequeo ahora se repite cada varias horas (para que alguien que
        // deja el bot prendido sin reiniciar igual se entere) — sin esto,
        // volvería a mandar el mismo aviso de la misma versión en cada
        // repetición mientras el usuario no actualice, en vez de avisar una
        // sola vez por versión nueva.
        const filaAvisado = await db.get(`SELECT status FROM estados_modulos WHERE nombre = 'version_avisada'`);
        if (filaAvisado?.status === remota.version) return;

        const destino = await obtenerDestinoNotificacion(client);
        if (!destino) return;

        await db.run(`INSERT INTO estados_modulos (nombre, status) VALUES ('version_avisada', ?) ON CONFLICT(nombre) DO UPDATE SET status = excluded.status`, [remota.version]);

        const payload = construirPayloadActualizacion(local, remota);

        if (destino.tipo === 'webhook') {
            // @mencion directa al dueño del bot (a pedido explicito del usuario
            // 2026-07-30): un embed mudo en el canal de Updates se ignora facil
            // una vez que el bot ya esta corriendo y nadie vuelve a mirarlo.
            const contenido = destino.ownerId ? `<@${destino.ownerId}>` : undefined;
            await axios.post(`${destino.webhookUrl}?wait=true`, { ...payload, content: contenido }, { timeout: 15000 });
        } else {
            const usuario = await client.users.fetch(destino.userId);
            await usuario.send(payload);
        }
    } catch (e) {
        console.error('DEBUG: error chequeando actualizaciones:', describirError(e));
    }
}

// Aviso de "recien actualizado" -- a pedido explicito del usuario 2026-07-27:
// que al aplicar una actualizacion, el bot avise que cosas nuevas trae y que
// pasos manuales hacen falta (ej. correr Sync Channels para un canal nuevo).
// Corre UNA vez por version, apenas el bot arranca ya en la version nueva (no
// depende de que nadie apriete "Update now" -- tambien cubre actualizar el
// .exe a mano, como hizo katrick). En la primerisima corrida de siempre (sin
// fila guardada todavia, instalacion nueva) no avisa nada -- no hubo ninguna
// "actualizacion" real que contar, solo se guarda la version actual como
// punto de partida.
async function avisarActualizacionAplicadaSiHaceFalta(client) {
    try {
        const local = obtenerVersionLocal();
        const fila = await db.get(`SELECT status FROM estados_modulos WHERE nombre = 'version_aplicada_avisada'`);

        if (!fila) {
            await db.run(`INSERT INTO estados_modulos (nombre, status) VALUES ('version_aplicada_avisada', ?) ON CONFLICT(nombre) DO UPDATE SET status = excluded.status`, [local.version]);
            return;
        }
        if (fila.status === local.version) return;

        await db.run(`INSERT INTO estados_modulos (nombre, status) VALUES ('version_aplicada_avisada', ?) ON CONFLICT(nombre) DO UPDATE SET status = excluded.status`, [local.version]);

        const destino = await obtenerDestinoNotificacion(client);
        if (!destino) return;

        const notas = notasParaEmbed(local.notes, local.notesCount);
        const acciones = (local.actionsNeeded || []).map(a => `• ${a}`).join('\n');
        const embed = {
            title: `🎉 Updated to v${local.version}`,
            color: 0x2ECC71,
            description: `**What's new:**\n${notas || '_No notes for this version._'}`
                + (acciones ? `\n\n**What you might need to do:**\n${acciones}` : '')
        };

        if (destino.tipo === 'webhook') {
            await axios.post(`${destino.webhookUrl}?wait=true`, { embeds: [embed] }, { timeout: 15000 });
        } else {
            const usuario = await client.users.fetch(destino.userId);
            await usuario.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('DEBUG: error avisando actualizacion aplicada:', describirError(e));
    }
}

// Aviso de "el reemplazo del .exe fallo" (2026-08-08, a pedido explicito del usuario:
// "como le avisariamos al usuario que hubo falla al actualizar" -- hasta ahora
// launcher.js dejaba escrito update_fallo.txt en la carpeta cuando el .exe viejo se
// quedaba bloqueado mas de un minuto (ej. un antivirus escaneandolo), pero nadie lo iba
// a ver ahi -- el bot seguia arrancando en la version VIEJA sin ningun aviso en Discord,
// como si la actualizacion nunca se hubiera intentado. launcher.js no tiene cliente de
// discord.js propio (por eso escribe el .txt en vez de avisar el mismo), asi que el aviso
// real se manda aca, en el primer arranque de bot.js despues del intento fallido -- mismo
// destino/mencion que ya usa avisarActualizacionAplicadaSiHaceFalta. Se borra el .txt
// despues de avisar para no repetir el mismo aviso en cada reinicio siguiente.
async function avisarActualizacionFallidaSiHaceFalta(client) {
    try {
        if (!fs.existsSync(UPDATE_FALLO_PATH)) return;
        const motivo = fs.readFileSync(UPDATE_FALLO_PATH, 'utf8').trim();
        fs.unlinkSync(UPDATE_FALLO_PATH);

        const destino = await obtenerDestinoNotificacion(client);
        if (!destino) return;

        const local = obtenerVersionLocal();
        const embed = {
            title: '⚠️ Update failed to apply',
            color: 0xE67E22,
            description: `${motivo}\n\nStill running on **v${local.version}** (the update was never applied) — nothing is broken, but you'll want to close any antivirus scan on this folder and press **Update Now** again in \`/setup\` or the Control Panel.`
        };

        if (destino.tipo === 'webhook') {
            const contenido = destino.ownerId ? `<@${destino.ownerId}>` : undefined;
            await axios.post(`${destino.webhookUrl}?wait=true`, { embeds: [embed], content: contenido }, { timeout: 15000 });
        } else {
            const usuario = await client.users.fetch(destino.userId);
            await usuario.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('DEBUG: error avisando actualizacion fallida:', describirError(e));
    }
}

// A diferencia del .exe (bloqueado por Windows mientras el proceso corre y
// por eso necesita el paso de _actualizar.bat en launcher.js), la carpeta
// assets/ no está en uso exclusivo — se puede sobrescribir en caliente, sin
// esperar a que el programa se reinicie. Si falla (sin assetsUrl en una
// versión vieja, sin internet, etc.) se ignora en silencio: el .exe se sigue
// actualizando igual, y assets/ se queda como estaba.
async function descargarYExtraerAssets(remota) {
    if (!remota.assetsUrl) return;
    try {
        exigirUrlDeConfianza(remota.assetsUrl, 'assets bundle');
        const respuesta = await axios.get(remota.assetsUrl, { responseType: 'stream', timeout: 120000 });
        await new Promise((resolve, reject) => {
            const archivo = fs.createWriteStream(ASSETS_ZIP_TEMP_PATH);
            respuesta.data.pipe(archivo);
            archivo.on('finish', resolve);
            archivo.on('error', reject);
            respuesta.data.on('error', reject);
        });

        // Defensa en profundidad contra zip-slip: si el pipeline de releases se
        // viera comprometido alguna vez, un zip malicioso podría intentar
        // escribir fuera de la carpeta (ej. "../../../algo") — se valida que
        // ningún nombre de entrada intente escapar antes de descomprimir nada.
        const scriptValidar = [
            `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
            `$zip = [System.IO.Compression.ZipFile]::OpenRead('${ASSETS_ZIP_TEMP_PATH}')`,
            `$malos = $zip.Entries | Where-Object { $_.FullName -match '\\.\\.' -or $_.FullName -match '^[/\\\\]' -or $_.FullName -match '^[A-Za-z]:' }`,
            `$zip.Dispose()`,
            `if ($malos) { 'UNSAFE' } else { 'SAFE' }`
        ].join('; ');
        const resultadoValidacion = execSync(`powershell -NoProfile -Command "${scriptValidar}"`, { encoding: 'utf8' }).trim();
        if (resultadoValidacion !== 'SAFE') {
            console.error('DEBUG: assets.zip contiene rutas sospechosas, se aborta la extracción por seguridad.');
            return;
        }

        // Expand-Archive sobrescribe los archivos que ya existen y agrega los
        // nuevos, pero no borra los que ya no vienen en el zip — alcanza para
        // el caso de uso real (sumar assets nuevos), no hace falta más.
        const script = `Expand-Archive -Path '${ASSETS_ZIP_TEMP_PATH}' -DestinationPath '${__dirname}' -Force`;
        execSync(`powershell -NoProfile -Command "${script}"`, { stdio: 'ignore' });
    } catch (e) {
        console.error('DEBUG: error actualizando assets/:', describirError(e));
    } finally {
        try { fs.unlinkSync(ASSETS_ZIP_TEMP_PATH); } catch (e) { /* nada que limpiar */ }
    }
}

// El panel (MonitorPokemonPanel.exe) no es hijo de launcher.js y no se puede
// reemplazar a si mismo mientras corre — a diferencia del bot, cuyo swap ya
// resuelve launcher.js con MonitorPokemon.new.exe. Se baja igual acá (si la
// versión remota lo ofrece — versiones viejas de version.json no tienen este
// campo, se ignora en silencio) y queda en disco como
// "MonitorPokemonPanel.new.exe"; el propio panel (ControlPanel.cs,
// EjecutarSwapPanelSiExiste) es quien detecta ese archivo y hace el
// reemplazo real, tanto al arrancar como justo después de bajarlo.
async function descargarActualizacionPanel(remota) {
    if (!remota.panelDownloadUrl) return;
    try {
        exigirUrlDeConfianza(remota.panelDownloadUrl, 'control panel');
        const rutaNueva = path.join(__dirname, 'MonitorPokemonPanel.new.exe');
        const respuesta = await axios.get(remota.panelDownloadUrl, { responseType: 'stream', timeout: 60000 });
        await new Promise((resolve, reject) => {
            const archivo = fs.createWriteStream(rutaNueva);
            respuesta.data.pipe(archivo);
            archivo.on('finish', resolve);
            archivo.on('error', reject);
            respuesta.data.on('error', reject);
        });
    } catch (e) {
        console.error('DEBUG: error descargando la actualización del panel:', describirError(e));
    }
}

// Progreso emitido a stdout como "PROGRESS:<0-100>\n" (2026-08-21, a pedido explicito del
// usuario: "Download Now" se quedaba con el texto pelado "Downloading..." sin ningun avance
// real -- ella misma dijo que hasta a ELLA le daba desconfianza y ganas de cerrarlo, sin
// hablar de un usuario nuevo que no sabe si esta trabado o no). Solo se trackea la descarga
// del .exe principal (con much0 el archivo mas pesado de las 3 descargas de esta funcion,
// ~100MB) -- el panel y los assets son rapidos en comparacion, no vale la pena la
// complejidad extra de un progreso combinado ponderado por tamaño para esa ganancia chica.
// ControlPanel.cs (DescargarActualizacionDesdePanel) lee esta salida linea por linea y
// actualiza una barra de progreso real con esto.
// Aviso centralizado de "pasos manuales tras actualizar" (2026-08-22, a pedido explicito del
// usuario: el aviso de Sync Channels + re-guardar Main Path solo salia si se actualizaba con
// el boton "Update now" DE DISCORD -- descargarActualizacion() tambien la usan "Download Now"
// del Panel (via apply-update.js) y, antes de esto, NINGUNA de las dos avisaba nada). Vive
// aca (no en bot.js) porque descargarActualizacion() ya es el punto en comun real de los dos
// caminos -- asi no hay que acordarse de repetir el aviso en cada lugar nuevo que dispare una
// descarga. Consulta la DB directo (sin discord.js completo) para no depender de un cliente
// de Discord ya conectado -- funciona igual desde bot.js (con cliente vivo) que desde
// apply-update.js (proceso hijo sin cliente, corriendo por su cuenta).
async function avisarPasosManualesTrasDescarga(remota) {
    try {
        const fila = await db.get(`SELECT webhook_url FROM configs_canales WHERE tipo = 'actualizaciones' AND webhook_url NOT IN ('N/A', 'local') ORDER BY rowid DESC LIMIT 1`);
        if (!fila?.webhook_url) return;
        const mencion = process.env.DISCORD_USER_ID ? `<@${process.env.DISCORD_USER_ID}> ` : '';
        await axios.post(`${fila.webhook_url}?wait=true`, {
            content: `${mencion}✅ The download for **${remota.version}** finished 100%. Please press **Sync Channels** and re-save your **Main Path** in \`/setup\` once it restarts, so nothing breaks.`
        }, { timeout: 15000 });
    } catch (e) {
        console.error('DEBUG: no se pudo avisar en el canal de Updates que la descarga termino:', e?.response?.data || e?.message || e);
    }
}

async function descargarActualizacion(remota) {
    exigirUrlDeConfianza(remota.downloadUrl, 'main executable');
    const rutaNueva = path.join(__dirname, 'MonitorPokemon.new.exe');
    const respuesta = await axios.get(remota.downloadUrl, { responseType: 'stream', timeout: 120000 });

    const totalBytes = Number(respuesta.headers['content-length']) || 0;
    let bytesRecibidos = 0;
    let ultimoPorcentajeEmitido = -1;

    await new Promise((resolve, reject) => {
        const archivo = fs.createWriteStream(rutaNueva);
        if (totalBytes > 0) {
            respuesta.data.on('data', (chunk) => {
                bytesRecibidos += chunk.length;
                const porcentaje = Math.min(99, Math.floor((bytesRecibidos / totalBytes) * 100));
                if (porcentaje !== ultimoPorcentajeEmitido) {
                    ultimoPorcentajeEmitido = porcentaje;
                    process.stdout.write(`PROGRESS:${porcentaje}\n`);
                }
            });
        }
        respuesta.data.pipe(archivo);
        archivo.on('finish', resolve);
        archivo.on('error', reject);
        respuesta.data.on('error', reject);
    });

    process.stdout.write('PROGRESS:99\n');
    await descargarActualizacionPanel(remota);
    await descargarYExtraerAssets(remota);
    await avisarPasosManualesTrasDescarga(remota);

    // Sin esto, version.json local nunca cambia y el bot cree para siempre que
    // sigue en la versión vieja, avisando de la "misma" actualización sin parar
    // aunque el .exe ya se haya reemplazado correctamente.
    fs.writeFileSync(VERSION_PATH, JSON.stringify(remota, null, 2));

    fs.writeFileSync(PENDING_UPDATE_PATH, JSON.stringify({ version: remota.version, listoEn: Date.now() }));
}

module.exports = {
    UPDATE_CHECK_ENABLED,
    MENSAJE_UPDATE_MANUAL,
    chequearActualizaciones,
    avisarActualizacionAplicadaSiHaceFalta,
    avisarActualizacionFallidaSiHaceFalta,
    descargarActualizacion,
    avisarPasosManualesTrasDescarga,
    obtenerVersionLocal,
    obtenerVersionRemota,
    esVersionMasNueva,
    describirError,
    notasParaEmbed,
    obtenerDestinoNotificacion,
    PENDING_UPDATE_PATH
};
