'use strict';

// Cifrado en reposo de las contraseñas SYSACAD (AES-256-GCM).
//
// Qué protege: que el archivo del store se escape — commit accidental, snapshot
// de disco, backup, alguien que se lleva una copia. Ese es el escenario probable.
//
// Qué NO protege: a quien controle el proceso, porque ahí también está la clave.
// No lo vendas como más de lo que es.
//
// La clave sale de STORE_KEY (variable de entorno). Sin ella se guarda en texto
// plano con una advertencia: cifrar con una clave que se pierde en cada redeploy
// sería peor que no cifrar, porque volvería ilegible lo ya guardado.

const crypto = require('crypto');

const PREFIJO = 'enc:v1:';
const SAL     = 'utn-asistencia-bot';   // fija: la clave debe ser estable entre reinicios

let clave = null;
if (process.env.STORE_KEY) {
  clave = crypto.scryptSync(process.env.STORE_KEY, SAL, 32);
} else {
  console.warn(
    '[crypto] STORE_KEY no está definida: las contraseñas se guardan SIN CIFRAR. ' +
    'Generá una con `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
    'y cargala como variable de entorno.'
  );
}

function hayClave() {
  return clave !== null;
}

function cifrar(texto) {
  if (texto == null) return texto;
  if (!clave) return String(texto);

  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const ct     = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return PREFIJO + [iv, tag, ct].map(b => b.toString('base64')).join(':');
}

function descifrar(valor) {
  if (valor == null) return valor;
  const s = String(valor);

  // Sin prefijo: quedó de antes de activar el cifrado, o no hay clave.
  if (!s.startsWith(PREFIJO)) return s;

  if (!clave) {
    throw new Error('El store tiene datos cifrados pero falta STORE_KEY');
  }

  const [ivB64, tagB64, ctB64] = s.slice(PREFIJO.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ¿Está guardado en claro? Sirve para avisar en /diag.
function estaCifrado(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIJO);
}

module.exports = { cifrar, descifrar, hayClave, estaCifrado };
