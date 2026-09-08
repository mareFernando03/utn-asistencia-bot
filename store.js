'use strict';

// Persistencia del bot.
//
// Implementación actual: un JSON en disco. En Render free el disco es EFÍMERO:
// se borra en cada redeploy, así que usuarios, horarios aprendidos e IP se
// pierden y cada uno tiene que volver a enrolarse.
//
// Toda la API es async a propósito, aunque el backend de hoy sea síncrono: así
// migrar a Postgres es reescribir este archivo y nada más.

const fs     = require('fs');
const path   = require('path');
const cripto = require('./crypto');

const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, 'store.json');

const VACIO = { usuarios: {}, utn: {}, estado: {}, observaciones: {}, admins: [] };

function leer() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...VACIO, ...raw };
  } catch {
    return { ...VACIO, usuarios: {}, utn: {}, estado: {} };
  }
}

function escribir(db) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[store] No se pudo guardar:', e.message);
  }
}

// ─── Autorizados ──────────────────────────────────────────────────────────────
// Quién puede darse de alta. El primero en usar el bot lo reclama; después solo
// entra quien él autorice. Así no hace falta configurar nada en el hosting.

async function getAdmins() {
  return leer().admins || [];
}

async function agregarAdmin(chatId) {
  const db = leer();
  db.admins = db.admins || [];
  const id = String(chatId);
  if (!db.admins.includes(id)) { db.admins.push(id); escribir(db); }
  return db.admins;
}

async function quitarAdmin(chatId) {
  const db = leer();
  const id = String(chatId);
  db.admins = (db.admins || []).filter(x => x !== id);
  escribir(db);
  return db.admins;
}

// ─── Usuarios ─────────────────────────────────────────────────────────────────
// Registro: { legajo, password, auto, franjas: [], creado }

// La contraseña viaja cifrada en el archivo y en claro dentro del proceso.
function aplanar(u) {
  if (!u) return null;
  return { ...u, password: u.password == null ? u.password : cripto.descifrar(u.password) };
}

async function getUsuario(chatId) {
  return aplanar(leer().usuarios[String(chatId)]);
}

async function setUsuario(chatId, datos) {
  const db = leer();
  const id = String(chatId);
  const guardar = { ...datos };
  if (guardar.password != null) guardar.password = cripto.cifrar(guardar.password);
  db.usuarios[id] = { ...db.usuarios[id], ...guardar };
  escribir(db);
  return aplanar(db.usuarios[id]);
}

// Sin descifrar: para /diag, que informa el estado sin exponer el valor.
async function getUsuarioCrudo(chatId) {
  return leer().usuarios[String(chatId)] || null;
}

async function borrarUsuario(chatId) {
  const db = leer();
  const id = String(chatId);
  const existia = Boolean(db.usuarios[id]);
  delete db.usuarios[id];
  delete db.observaciones[id];
  // Arrastrar el estado del día de ese usuario.
  for (const k of Object.keys(db.estado)) {
    if (k.includes(`|${id}|`)) delete db.estado[k];
  }
  escribir(db);
  return existia;
}

// Usuarios con modo automático activo y credenciales completas.
// Con credenciales completas: el scheduler los consulta aunque todavía no tengan
// franjas, porque es justamente consultando como descubre sus horarios.
async function usuariosActivos() {
  const db = leer();
  return Object.entries(db.usuarios)
    .filter(([, u]) => u.auto && u.legajo && u.password)
    .map(([chatId, u]) => ({ chatId, ...aplanar(u) }));
}

async function contarUsuarios() {
  return Object.keys(leer().usuarios).length;
}

// ─── Franjas aprendidas ───────────────────────────────────────────────────────
// Franja: { id, dia, desde, hasta, materiaId, materia, anio, especialidad, plan, comision }

async function agregarFranja(chatId, franja) {
  const db = leer();
  const id = String(chatId);
  const u  = db.usuarios[id];
  if (!u) return null;
  u.franjas = u.franjas || [];
  // Una franja por materia y día: re-aprender pisa la anterior.
  u.franjas = u.franjas.filter(f => !(f.dia === franja.dia && f.materiaId === franja.materiaId));
  u.franjas.push(franja);
  escribir(db);
  return u.franjas;
}

async function borrarFranja(chatId, franjaId) {
  const db = leer();
  const u  = db.usuarios[String(chatId)];
  if (!u) return null;
  const antes = (u.franjas || []).length;
  u.franjas = (u.franjas || []).filter(f => f.id !== franjaId);
  escribir(db);
  return antes !== u.franjas.length;
}

// ─── Observaciones: el horario real, aprendido del servidor ───────────────────
//
// El sistema de UTN solo lista una materia cuando hay clase de esa materia en
// ese momento — con independencia de que el docente haya habilitado o no la
// asistencia (ese es el flag `habilitada`). Entonces anotar CUÁNDO aparece cada
// materia equivale a leer el horario de cursada de la fuente autoritativa, sin
// que el usuario cargue nada y sin depender de cuándo marcó a mano.
//
// Clave: observaciones[chatId][`${dia}|${materiaId}`] = { desdeMin, hastaMin, vistas, materia, datos }

async function registrarObservacion(chatId, dia, materia, minutos) {
  const db = leer();
  const id = String(chatId);
  db.observaciones[id] = db.observaciones[id] || {};

  const k = `${dia}|${materia.id}`;
  const o = db.observaciones[id][k];

  if (!o) {
    db.observaciones[id][k] = {
      dia, materiaId: materia.id, materia: materia.nombre,
      desdeMin: minutos, hastaMin: minutos, vistas: 1,
      datos: {
        anio: materia.anio, especialidad: materia.especialidad,
        plan: materia.plan, comision: materia.comision,
      },
      visto: new Date().toISOString(),
    };
  } else {
    o.desdeMin = Math.min(o.desdeMin, minutos);
    o.hastaMin = Math.max(o.hastaMin, minutos);
    o.vistas  += 1;
    o.materia  = materia.nombre;
    o.visto    = new Date().toISOString();
  }

  escribir(db);
  return db.observaciones[id][k];
}

async function getObservaciones(chatId) {
  return Object.values(leer().observaciones[String(chatId)] || {});
}

async function borrarObservaciones(chatId) {
  const db = leer();
  delete db.observaciones[String(chatId)];
  escribir(db);
}

// ─── IP de UTN (compartida: es la misma red para todos) ───────────────────────

async function getIp() {
  return leer().utn.ip || process.env.AUTO_IP || null;
}

async function setIp(ip, porChatId) {
  const db = leer();
  db.utn = { ip, ts: new Date().toISOString(), por: String(porChatId || '') };
  escribir(db);
  return db.utn;
}

async function getIpInfo() {
  return leer().utn;
}

// ─── Estado diario del scheduler ──────────────────────────────────────────────
// Clave: `${fecha}|${chatId}|${franjaId}`

async function getEstado(clave) {
  return leer().estado[clave] || null;
}

async function marcarEstado(clave, valor) {
  const db = leer();
  db.estado[clave] = { ...db.estado[clave], ...valor, ts: new Date().toISOString() };
  escribir(db);
  return db.estado[clave];
}

// Borra todo lo que no sea de hoy, para que el store no crezca sin límite.
async function limpiarEstado(fecha) {
  const db = leer();
  let cambio = false;
  for (const k of Object.keys(db.estado)) {
    if (!k.startsWith(`${fecha}|`)) { delete db.estado[k]; cambio = true; }
  }
  if (cambio) escribir(db);
}

module.exports = {
  STORE_PATH,
  getAdmins, agregarAdmin, quitarAdmin,
  getUsuario, getUsuarioCrudo, setUsuario, borrarUsuario, usuariosActivos, contarUsuarios,
  agregarFranja, borrarFranja,
  registrarObservacion, getObservaciones, borrarObservaciones,
  getIp, setIp, getIpInfo,
  getEstado, marcarEstado, limpiarEstado,
};
