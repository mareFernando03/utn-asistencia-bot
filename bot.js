'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { randomUUID }       = require('crypto');
const http                 = require('http');

const utn    = require('./utn');
const store  = require('./store');
const cripto = require('./crypto');
const { crearAuto, ahora, NOMBRE_DIA, aMinutos, DESCUBRIR_CADA_MIN } = require('./auto');

// ─── Constantes ───────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN en variables de entorno');

const BOT_URL = process.env.BOT_URL || '';
const PORT    = process.env.PORT || 3000;

// Lista blanca de chat ids. Es OBLIGATORIA: el bot guarda contraseñas SYSACAD,
// que abren la cuenta académica entera de quien las presta. Sin lista, cualquiera
// que encuentre el bot podría entregarle su credencial, y este es un bot personal
// para un grupo chico, no un servicio. Sin ALLOWED_IDS no se da de alta a nadie.
const ALLOWED = new Set(
  (process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

if (ALLOWED.size === 0) {
  console.warn(
    '[bot] ALLOWED_IDS está vacía: nadie va a poder darse de alta. ' +
    'Cargá los chat ids autorizados, separados por coma.'
  );
}

function autorizado(chatId) {
  return ALLOWED.has(String(chatId));
}

// ─── Estado de conversación (en memoria) ──────────────────────────────────────

const states   = new Map();   // chatId → { step, legajo?, password?, materias?, http? }
const tokensIp = new Map();   // token → { chatId, vence }

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
  if (!autorizado(ctx.chat?.id)) {
    return ctx.reply(
      'Este es un bot privado y no estás en la lista de autorizados.\n\n' +
      'No le mandes tu contraseña de SYSACAD a bots que no controlás.'
    );
  }
  return next();
});

bot.start(ctx =>
  ctx.reply(
    '*UTN FRSFCO — Registro de Asistencia*\n\n' +
    'Marco tu asistencia sola durante la clase, así no se te escapa la ventana ' +
    'de minutos en que el docente la habilita.\n\n' +
    '*Para empezar*\n' +
    '• /registrar — cargá tus datos y marcá\n' +
    '• /guardar\\_ip — una vez, desde el WiFi de la facu\n\n' +
    '*Después*\n' +
    '• /auto — tu estado y el horario que aprendí\n' +
    '• /horarios — las materias que marco solo\n' +
    '• /auto\\_off — pausarme · /auto\\_on — reanudarme\n' +
    '• /olvida — borrar todos tus datos\n' +
    '• /diag — diagnóstico técnico',
    { parse_mode: 'Markdown' }
  )
);

// ─── Alta y registro manual ───────────────────────────────────────────────────

bot.command('registrar', async ctx => {
  const id = String(ctx.chat.id);
  states.delete(id);

  const u = await store.getUsuario(id);
  if (u?.legajo && u?.password) {
    await ctx.reply('⏳ Conectando con UTN...');
    return ejecutarRegistrar(ctx, u.legajo, u.password);
  }

  states.set(id, { step: 'waiting_legajo' });
  ctx.reply('Ingresá tu *legajo* SYSACAD:', { parse_mode: 'Markdown' });
});

bot.on('text', async ctx => {
  const id    = String(ctx.chat.id);
  const state = states.get(id);
  if (!state) return;

  const text = ctx.message.text.trim();

  if (state.step === 'waiting_legajo') {
    states.set(id, { step: 'waiting_password', legajo: text });
    return ctx.reply('Ahora tu *contraseña* SYSACAD:', { parse_mode: 'Markdown' });
  }

  if (state.step === 'waiting_password') {
    states.set(id, { ...state, step: 'waiting_consent', password: text });

    // Consentimiento explícito: quien presta una credencial tiene que saber qué
    // se guarda, quién puede verlo y cuánto dura.
    return ctx.reply(
      '*Antes de guardar, leé esto*\n\n' +
      `• Guardo tu legajo y tu contraseña SYSACAD${cripto.hayClave() ? ', *cifrada*' : ', *sin cifrar*'}.\n` +
      '• Esa contraseña abre toda tu cuenta académica, no solo la asistencia. ' +
      'Si la reusás en otro lado, cambiala por una única.\n' +
      '• Quien administra este bot tiene acceso al servidor donde se guarda.\n' +
      '• El hosting es efímero: un redeploy borra todo y hay que cargarlo de nuevo.\n' +
      '• Marco la asistencia según tu horario de cursada.\n' +
      '• /olvida borra todo lo tuyo cuando quieras.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Acepto, guardá mis datos', 'consent_ok')],
          [Markup.button.callback('Cancelar', 'consent_no')],
        ]),
      }
    );
  }
});

bot.action('consent_no', async ctx => {
  states.delete(String(ctx.chat.id));
  await ctx.answerCbQuery();
  ctx.editMessageText('Cancelado. No guardé nada.');
});

bot.action('consent_ok', async ctx => {
  const id    = String(ctx.chat.id);
  const state = states.get(id);
  await ctx.answerCbQuery();

  if (!state || state.step !== 'waiting_consent') {
    return ctx.editMessageText('Sesión expirada. Usá /registrar de nuevo.');
  }

  await store.setUsuario(id, {
    legajo:   state.legajo,
    password: state.password,
    auto:     true,
    franjas:  [],
    creado:   new Date().toISOString(),
  });
  states.delete(id);

  await ctx.editMessageText('✅ Datos guardados. Modo automático activo.');

  if (!(await store.getIp())) {
    return ctx.reply(
      '📶 Falta un paso: no tengo la IP de la red de UTN, y sin eso el sistema me ' +
      'rechaza.\n\nUsá /guardar\\_ip *conectado al WiFi de la facu*.',
      { parse_mode: 'Markdown' }
    );
  }
  await ctx.reply('⏳ Probando la conexión con UTN...');
  await ejecutarRegistrar(ctx, state.legajo, state.password);
});

async function ejecutarRegistrar(ctx, legajo, password) {
  const id = String(ctx.chat.id);
  const ip = await store.getIp();

  if (!ip) {
    return ctx.reply(
      '📶 No tengo la IP de la red de UTN. Usá /guardar\\_ip desde el WiFi de la facu.',
      { parse_mode: 'Markdown' }
    );
  }

  let sesion, materias;
  try {
    ({ http: sesion, materias } = await utn.loginYObtenerMaterias(legajo, password, ip));
  } catch (e) {
    if (e.message === 'LOGIN_FAILED') {
      return ctx.reply(
        '❌ Login rechazado. Revisá legajo y contraseña.\n\nUsá /olvida y volvé a cargarlos.'
      );
    }
    if (e.message === 'IP_DENEGADA') {
      return ctx.reply(
        `🚫 UTN rechazó la IP \`${ip}\`.\n\nActualizala con /guardar\\_ip desde el WiFi de la facu.`,
        { parse_mode: 'Markdown' }
      );
    }
    return ctx.reply(`❌ Error de conexión: ${e.message}`);
  }

  if (materias.length === 0) {
    return ctx.reply(
      '📭 *Sin materias ahora.*\n\nEl sistema solo muestra materias con clase en este ' +
      'día y horario, así que fuera de clase esto es lo normal.',
      { parse_mode: 'Markdown' }
    );
  }

  // Toda materia listada implica clase ahora: se anota como horario.
  const t = ahora();
  for (const m of materias) await store.registrarObservacion(id, t.dia, m, t.minutos);

  states.set(id, { step: 'selecting', materias, http: sesion });

  const buttons = materias.map((m, i) => {
    const hab  = m.habilitada  === 'S' ? '🟢' : '🔴';
    const cond = m.condicional === 'S' ? ' ⚠️' : '';
    return [Markup.button.callback(`${hab} ${m.nombre}${cond}`, `mat_${i}`)];
  });
  buttons.push([Markup.button.callback('❌ Cancelar', 'cancelar')]);

  await ctx.reply(
    `📋 *Materias con clase ahora* (${materias.length})\n` +
    '🟢 el docente habilitó  |  🔴 todavía no\n\n' +
    '_Las anoté como tu horario: de acá en más las marco solo._',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

bot.action(/^mat_(\d+)$/, async ctx => {
  const id    = String(ctx.chat.id);
  const state = states.get(id);
  await ctx.answerCbQuery();

  if (!state || state.step !== 'selecting') {
    return ctx.editMessageText('Sesión expirada. Usá /registrar de nuevo.');
  }

  const materia = state.materias[parseInt(ctx.match[1], 10)];
  if (!materia) return ctx.editMessageText('Opción inválida.');

  const nota = materia.habilitada === 'N'
    ? '\n\n⚠️ _El docente todavía no la habilitó; puede rechazarla._'
    : '';

  await ctx.editMessageText(
    `Registrando:\n*${materia.nombre}*${nota}\n\n⏳ Enviando...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const mensajes = await utn.registrarAsistencia(state.http, materia);
    const clase    = utn.clasificarMensajes(mensajes);
    states.delete(id);

    if (clase === 'ok') {
      const t = ahora();
      await store.marcarEstado(`${t.fecha}|${id}|${t.dia}-${materia.id}`,
        { resultado: 'ok', intentos: 1 });
      return ctx.editMessageText(
        `✅ *¡Asistencia registrada!*\n${materia.nombre}`, { parse_mode: 'Markdown' });
    }
    if (clase === 'duplicada') {
      return ctx.editMessageText(
        `ℹ️ *${materia.nombre}*\nYa la tenías registrada.`, { parse_mode: 'Markdown' });
    }
    if (mensajes.length > 0) {
      return ctx.editMessageText(`⚠️ Respuesta del servidor:\n${mensajes.join('\n')}`);
    }
    ctx.editMessageText('❓ Sin confirmación del servidor. Verificá en el sistema web.');
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

// ─── IP de UTN ────────────────────────────────────────────────────────────────
// El bot corre en Render, así que no puede ver la IP de UTN por sí solo: alguien
// tiene que abrir un link estando en el campus. Ese request trae la IP pública de
// la red, que es la misma para todos.

bot.command('guardar_ip', async ctx => {
  if (!BOT_URL) {
    return ctx.reply('⚠️ Falta configurar BOT_URL en el servidor, no puedo generar el link.');
  }
  const token = randomUUID();
  tokensIp.set(token, { chatId: String(ctx.chat.id), vence: Date.now() + 15 * 60 * 1000 });

  await ctx.reply(
    '📶 *Conectate al WiFi de UTN* y abrí este link:\n\n' +
    `${BOT_URL.replace(/\/$/, '')}/ip/${token}\n\n` +
    '_Vale 15 minutos. Solo lee la IP pública de la red._',
    { parse_mode: 'Markdown' }
  );
});

// ─── Modo automático (por usuario) ────────────────────────────────────────────

const auto = crearAuto(bot);

bot.command('auto', async ctx =>
  ctx.reply(await auto.estadoTexto(String(ctx.chat.id)), { parse_mode: 'Markdown' })
);

bot.command('auto_on', async ctx => {
  const id = String(ctx.chat.id);
  if (!(await store.getUsuario(id))) return ctx.reply('No estás registrado. Usá /registrar.');
  await store.setUsuario(id, { auto: true });
  await ctx.reply('🟢 Te marco la asistencia sola de nuevo.');
});

bot.command('auto_off', async ctx => {
  const id = String(ctx.chat.id);
  if (!(await store.getUsuario(id))) return ctx.reply('No estás registrado. Usá /registrar.');
  await store.setUsuario(id, { auto: false });
  await ctx.reply('⚪ Pausado. Reanudalo con /auto\\_on.', { parse_mode: 'Markdown' });
});

bot.command('horarios', async ctx => {
  const id = String(ctx.chat.id);
  if (!(await store.getUsuario(id))) return ctx.reply('No estás registrado. Usá /registrar.');

  const franjas = await auto.franjasDe(id);
  if (franjas.length === 0) {
    return ctx.reply(
      '_Todavía no aprendí ninguna materia._\n\n' +
      `Consulto el sistema cada ${DESCUBRIR_CADA_MIN} minutos y, en cuanto te vea una ` +
      'clase, la aprendo sola. También podés forzarlo con /registrar durante una clase.',
      { parse_mode: 'Markdown' }
    );
  }

  const orden = [...franjas].sort((a, b) => a.dia - b.dia || aMinutos(a.desde) - aMinutos(b.desde));
  const lineas = orden.map(f =>
    `• *${NOMBRE_DIA[f.dia]}* ${f.desde}–${f.hasta}\n  ${f.materia}` +
    (f.vistas ? ` _(visto ${f.vistas}×)_` : '')
  );

  await ctx.reply(
    `📅 *Tu horario aprendido*\n\n${lineas.join('\n')}\n\n` +
    '_La ventana se ajusta sola a medida que te veo en más clases._',
    { parse_mode: 'Markdown' }
  );
});

bot.command('olvida', async ctx => {
  const id = String(ctx.chat.id);
  states.delete(id);
  const habia = await store.borrarUsuario(id);
  ctx.reply(habia
    ? '✅ Borré tus credenciales, tu horario y tu estado. Usá /registrar para volver.'
    : 'No tenías nada guardado.');
});

// Diagnóstico: reemplaza tener que mirar el dashboard del hosting.
bot.command('diag', async ctx => {
  const id  = String(ctx.chat.id);
  const t   = ahora();
  const ipi = await store.getIpInfo();
  const u   = await store.getUsuarioCrudo(id);
  const ult = auto.ultimoTick();

  await ctx.reply(
    '*Diagnóstico*\n' +
    `Hora del server: ${NOMBRE_DIA[t.dia]} ${t.hhmm}\n` +
    `Scheduler: ${auto.habilitado ? '🟢' : '⚪'} · último tick: ${ult ? ult.hhmm : 'ninguno'}\n` +
    `Autorizados: ${ALLOWED.size} · registrados: ${await store.contarUsuarios()}\n` +
    `IP de UTN: ${ipi?.ip ? `\`${ipi.ip}\` (${(ipi.ts || '').slice(0, 16) || '?'})` : '❌ ninguna'}\n` +
    `BOT_URL: ${BOT_URL ? '✅' : '❌ sin configurar'}\n` +
    `Cifrado en reposo: ${cripto.hayClave() ? '✅ STORE_KEY presente' : '⚠️ sin STORE_KEY'}\n` +
    '\n*Tus datos*\n' +
    `Registrado: ${u ? '✅' : '❌'}\n` +
    (u
      ? `Legajo: \`${u.legajo}\`\n` +
        `Contraseña: ${cripto.estaCifrado(u.password) ? '✅ cifrada' : '⚠️ en claro'}\n` +
        `Auto: ${u.auto ? '🟢' : '⚪'}\n` +
        `Materias aprendidas: ${(await auto.franjasDe(id)).length}`
      : ''),
    { parse_mode: 'Markdown' }
  );
});

// ─── Servidor HTTP: health check + captura de IP ──────────────────────────────

http.createServer((req, res) => {
  const m = /^\/ip\/([0-9a-f-]{36})$/i.exec(req.url || '');
  if (!m) { res.writeHead(200); return res.end('OK'); }

  const entry = tokensIp.get(m[1]);
  if (!entry || entry.vence < Date.now()) {
    tokensIp.delete(m[1]);
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h2>Link vencido</h2><p>Pedí uno nuevo con /guardar_ip.</p>');
  }
  tokensIp.delete(m[1]);

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || '';

  store.setIp(ip, entry.chatId)
    .then(() => {
      console.log(`[ip] ${ip} cargada por ${entry.chatId}`);
      return bot.telegram.sendMessage(entry.chatId,
        `✅ IP de UTN cargada: \`${ip}\`\n\nYa puedo registrar asistencias.`,
        { parse_mode: 'Markdown' });
    })
    .catch(e => console.error('[ip]', e.message));

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h2>Listo</h2><p>IP registrada: <code>${ip}</code></p><p>Volvé a Telegram.</p>`);
}).listen(PORT, () => console.log(`HTTP escuchando en ${PORT}`));

// Render free duerme el servicio tras ~15 min sin tráfico.
if (BOT_URL) {
  setInterval(() => { fetch(BOT_URL).catch(() => {}); }, 10 * 60 * 1000).unref?.();
}

// ─── Arranque ─────────────────────────────────────────────────────────────────

bot.launch();
auto.iniciar();
console.log('Bot UTN iniciado.');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
