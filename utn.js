'use strict';

// Cliente HTTP del sistema de asistencias de UTN FRSFCO.
// Replica el flujo del frontend: login → verificar IP → listar materias → registrar.

const { Agent, fetch } = require('undici');
const { randomUUID }   = require('crypto');

const BASE = 'https://asistencia.frsfco.utn.edu.ar:4443';

// Ignora certificado autofirmado del servidor UTN (igual que el .exe)
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

// ─── Sesión HTTP ──────────────────────────────────────────────────────────────

function makeHttpSession() {
  const cookies = { deviceFingerprint: randomUUID() };

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

// Clasifica la respuesta del servidor tras un POST de registro.
// 'ok' → quedó registrada · 'duplicada' → ya estaba · 'rechazada' → no se registró
//
// El orden importa: "ya se registró" gana sobre la negación (un mensaje de
// duplicado suele traer un "no puede registrarla de nuevo"), y la negación gana
// sobre el éxito, porque "la asistencia NO fue registrada" contiene 'registrada'
// y clasificarlo como 'ok' haría que el scheduler deje de reintentar.
const RE_DUPLICADA = /ya\s+(se\s+)?(ha\s+)?(registr|marc)/i;
const RE_NEGATIVA  = /\b(?:no|nunca)\b[^.!]{0,40}(?:registr|marc)|no\s+(?:est[áa]\s+)?permitid|error|fall[oó]|rechaz|denegad|inv[aá]lid/i;
const RE_EXITO     = /exitosa|registrada|success|marcada|correctamente/i;

function clasificarMensajes(mensajes) {
  const texto = mensajes.join(' ');
  if (RE_DUPLICADA.test(texto)) return 'duplicada';
  if (RE_NEGATIVA.test(texto))  return 'rechazada';
  if (RE_EXITO.test(texto))     return 'ok';
  if (mensajes.length > 0)      return 'rechazada';
  return 'desconocida';
}

// ─── Flujo UTN ────────────────────────────────────────────────────────────────

// Abre sesión: login + validación de IP. Devuelve la sesión HTTP lista para usar.
// Lanza Error('LOGIN_FAILED') o Error('IP_DENEGADA').
async function abrirSesion(legajo, password, ip) {
  const http = makeHttpSession();

  await http.get('/index.php');
  const loginHtml = await http.post('/index.php', {
    legajo,
    password,
    ingreso: 'Ingresar',
  });

  if (!loginHtml.includes('apply-leave.php')) throw new Error('LOGIN_FAILED');

  const ipResText = await http.post('/verificar_ip.php', { ip });
  try {
    const ipRes = JSON.parse(ipResText);
    if (ipRes.acceso !== 'permitido') throw new Error('IP_DENEGADA');
  } catch (e) {
    if (e.message === 'IP_DENEGADA') throw e;
    // Respuesta no-JSON: el servidor puede variar, continuar
  }

  return http;
}

// Lista las materias que el backend ofrece en este momento.
// Devuelve null si la sesión caducó (hay que volver a abrirla).
async function listarMaterias(http) {
  const html = await http.get('/apply-leave.php');
  if (!html.includes('<select')) return null;
  return parseMaterias(html);
}

async function loginYObtenerMaterias(legajo, password, ip) {
  const http     = await abrirSesion(legajo, password, ip);
  const materias = await listarMaterias(http);
  return { http, materias: materias ?? [] };
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

module.exports = {
  BASE,
  makeHttpSession,
  parseMaterias,
  parseMensajes,
  clasificarMensajes,
  abrirSesion,
  listarMaterias,
  loginYObtenerMaterias,
  registrarAsistencia,
};
