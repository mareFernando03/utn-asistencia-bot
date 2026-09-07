'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');

const utn          = require('./utn');
const { crearAuto } = require('./auto');

// ─── Constantes ───────────────────────────────────────────────────────────────

const BOT_TOKEN  = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN en variables de entorno');

const USERS_PATH = path.join(__dirname, 'users.json');

// IDs de Telegram autorizados (opcional). Ej: ALLOWED_IDS=123,456
const ALLOWED = process.env.ALLOWED_IDS
  ? new Set(process.env.ALLOWED_IDS.split(',').map(s => s.trim()))
  : null;

// ─── Persistencia de credenciales ─────────────────────────────────────────────

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveUsers(u) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2));
}

// ─── Estado de conversación (en memoria) ──────────────────────────────────────
// Map<chatId, { step, legajo?, password?, http?, materias? }>

const states = new Map();

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// Guard de acceso
bot.use((ctx, next) => {
  if (ALLOWED && !ALLOWED.has(String(ctx.from?.id))) {
    return ctx.reply('No autorizado.');
  }
  return next();
});

// /start
bot.start(ctx =>
  ctx.reply(
    '*UTN FRSFCO — Registro de Asistencia*\n\n' +
    'Manual:\n' +
    '• /registrar — Marcar asistencia de hoy\n' +
    '• /olvida — Borrar credenciales guardadas\n\n' +
    'Automático:\n' +
    '• /auto — Estado del modo automático y franjas configuradas\n' +
    '• /auto\\_on — Reanudarlo\n' +
    '• /auto\\_off — Pausarlo\n' +
    '• /materias\\_hoy — Qué devuelve el sistema ahora mismo',
    { parse_mode: 'Markdown' }
  )
);

// /olvida
bot.command('olvida', ctx => {
  const id    = String(ctx.chat.id);
  const users = loadUsers();
  states.delete(id);
  if (users[id]) {
    delete users[id];
    saveUsers(users);
    return ctx.reply('✅ Credenciales eliminadas. Usá /registrar para ingresar nuevas.');
  }
  ctx.reply('No tenés credenciales guardadas.');
});

// /registrar
bot.command('registrar', async ctx => {
  const id    = String(ctx.chat.id);
  const users = loadUsers();
  states.delete(id);

  if (users[id]?.legajo && users[id]?.password && users[id]?.ip) {
    await ctx.reply('⏳ Conectando con UTN...');
    await ejecutarRegistrar(ctx, users[id].legajo, users[id].password, users[id].ip);
  } else {
    states.set(id, { step: 'waiting_legajo' });
    ctx.reply('Ingresá tu *legajo* SYSACAD:', { parse_mode: 'Markdown' });
  }
});

// Flujo principal
async function ejecutarRegistrar(ctx, legajo, password, ip) {
  const id = String(ctx.chat.id);
  let http, materias;

  try {
    ({ http, materias } = await utn.loginYObtenerMaterias(legajo, password, ip));
  } catch (e) {
    if (e.message === 'LOGIN_FAILED') {
      const users = loadUsers();
      delete users[id];
      saveUsers(users);
      return ctx.reply(
        '❌ Login fallido. Revisá legajo y contraseña.\n\nUsá /registrar para intentar de nuevo.'
      );
    }
    if (e.message === 'IP_DENEGADA') {
      return ctx.reply(
        '🚫 *IP no autorizada por UTN.*\n\n' +
        'Tenés que ingresar la IP pública de la red WiFi de UTN.\n' +
        'Usá /olvida y volvé a registrarte con la IP correcta.',
        { parse_mode: 'Markdown' }
      );
    }
    return ctx.reply(`❌ Error de conexión: ${e.message}`);
  }

  if (materias.length === 0) {
    return ctx.reply(
      '📭 *Sin materias disponibles ahora.*\n\n' +
      'El servidor solo muestra materias con clase en el día y horario actual.',
      { parse_mode: 'Markdown' }
    );
  }

  // Guardar estado (sesión HTTP vive en memoria)
  states.set(id, { step: 'selecting', materias, http });

  const buttons = materias.map((m, i) => {
    const hab  = m.habilitada   === 'S' ? '🟢' : '🔴';
    const cond = m.condicional  === 'S' ? ' ⚠️' : '';
    return [Markup.button.callback(`${hab} ${m.nombre}${cond}`, `mat_${i}`)];
  });
  buttons.push([Markup.button.callback('❌ Cancelar', 'cancelar')]);

  ctx.reply(
    `📋 *Materias disponibles hoy* (${materias.length})\n🟢 habilitada  |  🔴 no habilitada`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

// Selección de materia (inline button)
bot.action(/^mat_(\d+)$/, async ctx => {
  const id    = String(ctx.chat.id);
  const idx   = parseInt(ctx.match[1], 10);
  const state = states.get(id);

  await ctx.answerCbQuery();

  if (!state || state.step !== 'selecting') {
    return ctx.editMessageText('Sesión expirada. Usá /registrar de nuevo.');
  }

  const materia = state.materias[idx];
  if (!materia) return ctx.editMessageText('Opción inválida.');

  const nota = materia.habilitada === 'N'
    ? '\n\n⚠️ _Esta materia no está habilitada por el docente._'
    : '';

  await ctx.editMessageText(
    `Registrando asistencia para:\n*${materia.nombre}*${nota}\n\n⏳ Enviando...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const mensajes = await utn.registrarAsistencia(state.http, materia);
    states.delete(id);

    const clase = utn.clasificarMensajes(mensajes);

    if (clase === 'ok') {
      ctx.editMessageText(
        `✅ *¡Asistencia registrada!*\n${materia.nombre}`,
        { parse_mode: 'Markdown' }
      );
    } else if (clase === 'duplicada') {
      ctx.editMessageText(
        `ℹ️ *${materia.nombre}*\nYa tenías la asistencia registrada.`,
        { parse_mode: 'Markdown' }
      );
    } else if (mensajes.length > 0) {
      ctx.editMessageText(`⚠️ Respuesta del servidor:\n${mensajes.join('\n')}`);
    } else {
      ctx.editMessageText('❓ Sin confirmación del servidor. Verificá en el sistema web.');
    }
  } catch (e) {
    states.delete(id);
    ctx.editMessageText(`❌ Error al registrar: ${e.message}`);
  }
});

bot.action('cancelar', async ctx => {
  states.delete(String(ctx.chat.id));
  await ctx.answerCbQuery();
  ctx.editMessageText('Cancelado.');
});

// ─── Modo automático ──────────────────────────────────────────────────────────

const auto = crearAuto(bot);

// Estos comandos operan sobre la cuenta SYSACAD del dueño (pausan su asistencia,
// disparan logins con sus credenciales, listan sus materias). ALLOWED_IDS es
// opcional, así que sin esta guarda cualquiera que encuentre el bot podría usarlos.
const DUENIO = process.env.AUTO_CHAT_ID;

function soloDuenio(handler) {
  return async ctx => {
    if (DUENIO && String(ctx.chat.id) !== String(DUENIO)) {
      return ctx.reply('Este comando es solo para el dueño del bot.');
    }
    return handler(ctx);
  };
}

bot.command('auto', soloDuenio(ctx =>
  ctx.reply(auto.estadoTexto(), { parse_mode: 'Markdown' })
));

bot.command('auto_on', soloDuenio(async ctx => {
  const n = auto.recargarHorarios();
  if (!auto.configurado()) {
    return ctx.reply(
      '⚠️ No puedo activarlo: faltan variables AUTO_LEGAJO / AUTO_PASSWORD / AUTO_IP / AUTO_CHAT_ID.'
    );
  }
  auto.habilitado = true;
  await ctx.reply(`🟢 Modo automático activo — ${n} franjas cargadas.`);
}));

bot.command('auto_off', soloDuenio(async ctx => {
  auto.habilitado = false;
  await ctx.reply('⚪ Modo automático pausado. Reanudalo con /auto\\_on.', { parse_mode: 'Markdown' });
}));

// Diagnóstico: muestra los nombres exactos que devuelve SYSACAD, para ajustar
// los 'match' de horarios.json.
// Texto plano a propósito: los nombres vienen del servidor y un '_' o un '*'
// rompen el parseo de Markdown (Telegram responde 400 y tira la promesa).
bot.command('materias_hoy', soloDuenio(async ctx => {
  await ctx.reply('⏳ Consultando el sistema UTN...');
  try {
    const materias = await auto.materiasAhora();
    if (materias.length === 0) {
      return await ctx.reply('📭 El servidor no ofrece ninguna materia en este momento.');
    }
    const lineas = materias.map(m =>
      `${m.habilitada === 'S' ? '🟢' : '🔴'} ${m.nombre}\n` +
      `   id=${m.id} comision=${m.comision} plan=${m.plan}`
    );
    const cuerpo = `📋 Materias que devuelve el sistema ahora\n\n${lineas.join('\n')}`;
    await ctx.reply(cuerpo.length > 3900 ? cuerpo.slice(0, 3900) + '\n…' : cuerpo);
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
}));

// Texto libre → flujo de credenciales
bot.on('text', async ctx => {
  const id    = String(ctx.chat.id);
  const state = states.get(id);
  if (!state) return;

  const text = ctx.message.text.trim();

  if (state.step === 'waiting_legajo') {
    states.set(id, { step: 'waiting_password', legajo: text });
    ctx.reply('Ahora ingresá tu *contraseña* SYSACAD:', { parse_mode: 'Markdown' });

  } else if (state.step === 'waiting_password') {
    states.set(id, { step: 'waiting_ip', legajo: state.legajo, password: text });
    ctx.reply(
      '📶 Ingresá tu *IP pública* de la red UTN\\.\n\n' +
      'Para verla, conectate al WiFi de UTN y abrí:\n' +
      'https://api\\.ipify\\.org\n\n' +
      '_Copiá el número que aparece y pegalo acá\\._',
      { parse_mode: 'MarkdownV2' }
    );

  } else if (state.step === 'waiting_ip') {
    // Validación básica de formato IPv4
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
      return ctx.reply('❌ Eso no parece una IP válida. Ingresá una dirección IPv4, por ejemplo: `190.16.182.88`', { parse_mode: 'Markdown' });
    }

    const { legajo, password } = state;
    states.delete(id);

    const users = loadUsers();
    users[id] = { legajo, password, ip: text };
    saveUsers(users);

    await ctx.reply('✅ Credenciales guardadas. Conectando con UTN...');
    await ejecutarRegistrar(ctx, legajo, password, text);
  }
});

// ─── Servidor HTTP (keepalive para Render) ────────────────────────────────────

const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`Health check escuchando en puerto ${PORT}`));

// ─── Arranque ─────────────────────────────────────────────────────────────────

// Render free tier duerme el servicio tras ~15 min sin tráfico: auto-ping para
// llegar despierto a la franja de cursada. Un cron externo es más confiable.
if (process.env.BOT_URL) {
  setInterval(() => { fetch(process.env.BOT_URL).catch(() => {}); }, 10 * 60 * 1000).unref?.();
}

bot.launch();
auto.iniciar();
console.log('Bot UTN iniciado.');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
