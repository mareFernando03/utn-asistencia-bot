'use strict';
require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { Agent, fetch }     = require('undici');
const fs   = require('fs');
const path = require('path');

// ─── Constantes ───────────────────────────────────────────────────────────────

const BOT_TOKEN  = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN en variables de entorno');

const BASE       = 'https://asistencia.frsfco.utn.edu.ar:4443';
const USERS_PATH = path.join(__dirname, 'users.json');

// Ignora certificado autofirmado del servidor UTN (igual que el .exe)
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

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
// Map<chatId, { step, legajo?, http?, materias? }>

const states = new Map();

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function makeHttpSession() {
  const cookies = {};

  function saveCookies(headers) {
    for (const c of (headers.getSetCookie?.() ?? [])) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async function get(p) {
    const res = await fetch(`${BASE}${p}`, {
      dispatcher,
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookieHeader() },
    });
    saveCookies(res.headers);
    return res.text();
  }

  async function post(p, body) {
    const res = await fetch(`${BASE}${p}`, {
      method: 'POST',
      dispatcher,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(),
        Origin: BASE,
        Referer: `${BASE}${p}`,
      },
      body: new URLSearchParams(body).toString(),
    });
    saveCookies(res.headers);
    return res.text();
  }

  return { get, post };
}

// ─── Parser HTML ──────────────────────────────────────────────────────────────

function attr(tag, name) {
  const m = new RegExp(`data-${name}="([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : '';
}

function parseMaterias(html) {
  const start = html.indexOf('<select');
  const end   = html.indexOf('</select>') + 9;
  if (start === -1 || end < 9) return [];
  const block = html.slice(start, end);
  const out   = [];
  const re    = /<option([^>]+)>\s*([^<]+)/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const tag = m[1];
    if (tag.includes('disabled')) continue;
    const valM = /value="(\d+)"/.exec(tag);
    if (!valM) continue;
    out.push({
      id:           valM[1],
      nombre:       m[2].trim(),
      anio:         attr(tag, 'anio'),
      especialidad: attr(tag, 'especialidad'),
      plan:         attr(tag, 'plan'),
      comision:     attr(tag, 'comision'),
      condicional:  attr(tag, 'condicional'),
      habilitada:   attr(tag, 'habilitada'),
    });
  }
  return out;
}

function parseMensajes(html) {
  const alerts = [...html.matchAll(/alert\('([^']+)'/g)].map(m => m[1]);
  const divs   = [...html.matchAll(/innerHTML\s*=\s*'([^']+)'/g)].map(m => m[1]);
  return [...alerts, ...divs].filter(Boolean);
}

// ─── Lógica UTN ───────────────────────────────────────────────────────────────

async function loginYObtenerMaterias(legajo, password) {
  const http = makeHttpSession();

  await http.get('/index.php');
  const loginHtml = await http.post('/index.php', {
    legajo,
    password,
    ingreso: 'Ingresar',
  });

  if (!loginHtml.includes('apply-leave.php')) {
    throw new Error('LOGIN_FAILED');
  }

  // Bypass de IP: el backend acepta cualquier IP en el body
  await http.post('/verificar_ip.php', { ip: '10.0.0.1' });

  const applyHtml = await http.get('/apply-leave.php');
  return { http, materias: parseMaterias(applyHtml) };
}

async function registrarAsistencia(http, materia) {
  const html = await http.post('/apply-leave.php', {
    id_materia:      materia.id,
    anio_academico:  materia.anio,
    id_especialidad: materia.especialidad,
    id_plan:         materia.plan,
    comision:        materia.comision,
    signin:          '',
  });
  return parseMensajes(html);
}

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
    'Comandos:\n' +
    '• /registrar — Marcar asistencia de hoy\n' +
    '• /olvida — Borrar credenciales guardadas',
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

  if (users[id]) {
    await ctx.reply('⏳ Conectando con UTN...');
    await ejecutarRegistrar(ctx, users[id].legajo, users[id].password);
  } else {
    states.set(id, { step: 'waiting_legajo' });
    ctx.reply('Ingresá tu *legajo* SYSACAD:', { parse_mode: 'Markdown' });
  }
});

// Flujo principal
async function ejecutarRegistrar(ctx, legajo, password) {
  const id = String(ctx.chat.id);
  let http, materias;

  try {
    ({ http, materias } = await loginYObtenerMaterias(legajo, password));
  } catch (e) {
    if (e.message === 'LOGIN_FAILED') {
      const users = loadUsers();
      delete users[id];
      saveUsers(users);
      return ctx.reply(
        '❌ Login fallido. Revisá legajo y contraseña.\n\nUsá /registrar para intentar de nuevo.'
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
    const mensajes = await registrarAsistencia(state.http, materia);
    states.delete(id);

    if (mensajes.some(m => /exitosa|registrada|success|marcada/i.test(m))) {
      ctx.editMessageText(
        `✅ *¡Asistencia registrada!*\n${materia.nombre}`,
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

// Texto libre → flujo de credenciales
bot.on('text', async ctx => {
  const id    = String(ctx.chat.id);
  const state = states.get(id);
  if (!state) return;

  const text = ctx.message.text.trim();

  if (state.step === 'waiting_legajo') {
    states.set(id, { step: 'waiting_password', legajo: text });
    ctx.reply(
      'Ahora ingresá tu *contraseña* SYSACAD:',
      { parse_mode: 'Markdown' }
    );

  } else if (state.step === 'waiting_password') {
    const { legajo } = state;
    states.delete(id);

    const users = loadUsers();
    users[id] = { legajo, password: text };
    saveUsers(users);

    await ctx.reply('✅ Credenciales guardadas. Conectando con UTN...');
    await ejecutarRegistrar(ctx, legajo, text);
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

bot.launch();
console.log('Bot UTN iniciado.');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
