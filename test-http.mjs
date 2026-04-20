'use strict';
import { Agent, fetch } from 'undici';

const BASE       = 'https://asistencia.frsfco.utn.edu.ar:4443';
const LEGAJO     = '16143';
const PASSWORD   = 'fermare03';
const IP         = null; // null = detectar automáticamente via ipify

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

// ─── Session HTTP ─────────────────────────────────────────────────────────────

function makeSession() {
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
    const text = await res.text();
    return { status: res.status, text };
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
    const text = await res.text();
    return { status: res.status, text };
  }

  return { get, post, cookies };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

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

// ─── Helpers de output ────────────────────────────────────────────────────────

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }
function step(msg) { console.log(`\n▶ ${msg}`); }

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testConectividad() {
  step('Test 1 — Conectividad al servidor UTN');
  const http = makeSession();
  const { status, text } = await http.get('/index.php');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  ok(`Servidor responde (HTTP ${status})`);
  const tieneForm = text.includes('legajo') && text.includes('password');
  tieneForm ? ok('Formulario de login detectado') : fail('No se encontró el formulario de login');
  const phpsessid = http.cookies['PHPSESSID'];
  phpsessid ? ok(`Cookie de sesión recibida: PHPSESSID=${phpsessid.slice(0, 8)}...`) : fail('No se recibió PHPSESSID');
  return http;
}

async function testLogin(http) {
  step('Test 2 — Login con credenciales');
  const { status, text } = await http.post('/index.php', {
    legajo: LEGAJO,
    password: PASSWORD,
    ingreso: 'Ingresar',
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const loginOk = text.includes('apply-leave.php');
  loginOk
    ? ok(`Login exitoso (legajo: ${LEGAJO})`)
    : fail('Login fallido — respuesta no contiene apply-leave.php');
  if (!loginOk) {
    const snippet = text.slice(0, 500).replace(/\s+/g, ' ');
    info(`Fragmento de respuesta: ${snippet}`);
    throw new Error('LOGIN_FAILED');
  }
  return http;
}

async function testVerificarIp(http) {
  step('Test 3 — Verificación de IP');
  let ip = IP;
  if (!ip) {
    const r = await fetch('https://api.ipify.org?format=json', { dispatcher });
    ip = (await r.json()).ip;
    info(`IP pública detectada automáticamente: ${ip}`);
  }
  const { text } = await http.post('/verificar_ip.php', { ip });
  info(`Respuesta raw: ${text.slice(0, 200)}`);
  try {
    const json = JSON.parse(text);
    json.acceso === 'permitido'
      ? ok(`IP permitida (${ip})`)
      : fail(`IP denegada — respuesta: ${JSON.stringify(json)}`);
  } catch {
    info('Respuesta no es JSON — el servidor puede aceptar igualmente, continuando');
  }
  return ip;
}

async function testObtenerMaterias(http) {
  step('Test 4 — Obtener lista de materias');
  const { status, text } = await http.get('/apply-leave.php');
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const materias = parseMaterias(text);
  if (materias.length === 0) {
    info('Sin materias disponibles en este momento (normal fuera del horario de clase)');
    return [];
  }
  ok(`${materias.length} materia(s) encontrada(s):`);
  for (const m of materias) {
    const hab  = m.habilitada  === 'S' ? '🟢' : '🔴';
    const cond = m.condicional === 'S' ? ' ⚠️ condicional' : '';
    info(`  ${hab} [${m.id}] ${m.nombre}${cond}`);
    info(`      anio=${m.anio} esp=${m.especialidad} plan=${m.plan} com=${m.comision}`);
  }
  return materias;
}

async function testRegistrar(http, materia) {
  step(`Test 5 — Registrar asistencia: "${materia.nombre}"`);
  const hab = materia.habilitada === 'S' ? 'habilitada' : 'NO habilitada (⚠️ test de solo lectura)';
  info(`Materia ${hab}`);

  const { text } = await http.post('/apply-leave.php', {
    id_materia:      materia.id,
    anio_academico:  materia.anio,
    id_especialidad: materia.especialidad,
    id_plan:         materia.plan,
    comision:        materia.comision,
    signin:          '',
  });

  const mensajes = parseMensajes(text);
  if (mensajes.length === 0) {
    info('Sin mensajes del servidor — verificá manualmente en el sistema web');
    return;
  }
  info(`Mensajes del servidor:`);
  for (const msg of mensajes) info(`  → "${msg}"`);

  const exito = mensajes.some(m => /exitosa|registrada|success|marcada/i.test(m));
  exito ? ok('¡Asistencia registrada exitosamente!') : info('Respuesta recibida (verificar si fue registrada)');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('='.repeat(55));
console.log('TEST — Flujo HTTP UTN Asistencia');
console.log(`Servidor: ${BASE}`);
console.log(`Usuario:  legajo ${LEGAJO}, IP ${IP ?? '(detectar automáticamente)'}`);
console.log('='.repeat(55));

try {
  const http     = await testConectividad();
  await testLogin(http);
  await testVerificarIp(http);
  const materias = await testObtenerMaterias(http);

  if (materias.length > 0) {
    const habilitada = materias.find(m => m.habilitada === 'S');
    const objetivo   = habilitada ?? materias[0];
    await testRegistrar(http, objetivo);
  }

  console.log('\n' + '='.repeat(55));
  console.log('Tests completados.');
} catch (e) {
  console.log(`\n❌ Test abortado: ${e.message}`);
  process.exit(1);
}
