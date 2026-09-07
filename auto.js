'use strict';

// Modo automático: durante cada franja de cursada consulta el sistema UTN cada
// AUTO_INTERVAL_SEC segundos y registra la asistencia en cuanto el docente
// habilita la materia. No requiere ninguna acción del usuario.

const fs   = require('fs');
const path = require('path');
const utn  = require('./utn');

const TZ            = process.env.TZ_UTN || 'America/Argentina/Buenos_Aires';
const HORARIOS_PATH = path.join(__dirname, 'horarios.json');
const ESTADO_PATH   = path.join(__dirname, 'estado-auto.json');

// ─── Tiempo local (Render corre en UTC: hay que forzar la zona) ───────────────

const DIAS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const NOMBRE_DIA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function ahora(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  const hora   = parseInt(parts.hour, 10);
  const minuto = parseInt(parts.minute, 10);

  return {
    fecha:    `${parts.year}-${parts.month}-${parts.day}`,
    dia:      DIAS[parts.weekday] ?? 0,
    minutos:  hora * 60 + minuto,
    hhmm:     `${parts.hour}:${parts.minute}`,
  };
}

function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(n => parseInt(n, 10));
  return h * 60 + (m || 0);
}

// ─── Horarios ─────────────────────────────────────────────────────────────────

function cargarHorarios() {
  try {
    const raw = JSON.parse(fs.readFileSync(HORARIOS_PATH, 'utf8'));
    return (raw.franjas || []).filter(f => f.activo !== false);
  } catch (e) {
    console.error('[auto] No se pudo leer horarios.json:', e.message);
    return [];
  }
}

// Franjas que están corriendo en este instante.
function franjasActivas(franjas, t) {
  return franjas.filter(f =>
    f.dia === t.dia &&
    t.minutos >= aMinutos(f.desde) &&
    t.minutos <  aMinutos(f.hasta)
  );
}

function normalizar(s) {
  return String(s)
    .normalize('NFD').replace(/\p{M}/gu, '')   // saca acentos
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buscarMateria(materias, franja) {
  const frases = (franja.match || []).map(normalizar);
  return materias.find(m => {
    const nom = normalizar(m.nombre);
    return frases.some(f => f && nom.includes(f));
  });
}

// ─── Estado (qué franjas ya se resolvieron hoy) ───────────────────────────────
// El disco de Render es efímero, así que esto sobrevive al reinicio del proceso
// pero no a un redeploy. El servidor UTN rechaza duplicados igual, así que el
// peor caso es un intento de más.

function cargarEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')); }
  catch { return {}; }
}

function guardarEstado(e) {
  try { fs.writeFileSync(ESTADO_PATH, JSON.stringify(e, null, 2)); }
  catch (err) { console.error('[auto] No se pudo guardar estado:', err.message); }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

// Estados que dan la franja por cerrada: dejan de consultarse ese día.
const TERMINALES = new Set(['ok', 'duplicada', 'fallida']);

// POSTs de registro fallidos antes de rendirse con una franja. Sin este tope,
// una respuesta que el parser no entiende se reintenta cada tick durante horas.
const MAX_INTENTOS = 3;

// Minutos antes del fin de franja en que se manda el aviso de "no se registró".
const AVISO_FINAL_MIN = 10;

// Un valor no numérico daría NaN, y setInterval(fn, NaN) dispara cada 1 ms.
function intervaloMs(valor) {
  const n = parseInt(valor ?? '', 10);
  return (Number.isFinite(n) ? Math.max(30, n) : 60) * 1000;
}

function crearAuto(bot, opciones = {}) {
  const cfg = {
    legajo:      process.env.AUTO_LEGAJO,
    password:    process.env.AUTO_PASSWORD,
    ip:          process.env.AUTO_IP,
    chatId:      process.env.AUTO_CHAT_ID,
    intervalo:   intervaloMs(process.env.AUTO_INTERVAL_SEC),
    // Si la franja termina y el docente nunca habilitó, intentar igual una vez.
    forzar:      process.env.AUTO_FORZAR === 'true',
    ...opciones,
  };

  let habilitado = process.env.AUTO_ENABLED !== 'false';
  let estado     = cargarEstado();
  let franjas    = cargarHorarios();
  let sesion     = null;   // sesión HTTP reutilizada entre ticks
  let corriendo  = false;
  let timer      = null;
  let ultimoError = null;  // para no spamear el mismo error cada minuto

  function configurado() {
    return Boolean(cfg.legajo && cfg.password && cfg.ip && cfg.chatId);
  }

  async function avisar(texto) {
    if (!cfg.chatId) return;
    try {
      await bot.telegram.sendMessage(cfg.chatId, texto, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[auto] No se pudo notificar:', e.message);
    }
  }

  // Fusiona con lo que ya había: los flags de "ya avisé" no se deben perder al
  // actualizar el resultado.
  function marcar(clave, valor) {
    estado[clave] = { ...estado[clave], ...valor, ts: new Date().toISOString() };
    guardarEstado(estado);
  }

  // Purga entradas de días anteriores para que estado-auto.json no crezca.
  function limpiarEstado(fecha) {
    let cambio = false;
    for (const k of Object.keys(estado)) {
      if (!k.startsWith(`${fecha}|`)) { delete estado[k]; cambio = true; }
    }
    if (cambio) guardarEstado(estado);
  }

  // Devuelve también la sesión usada: quien registre después debe usar ESA y no
  // releer `sesion`, que otra llamada concurrente puede haber puesto en null.
  async function obtenerMaterias() {
    if (sesion) {
      const materias = await utn.listarMaterias(sesion);
      if (materias !== null) return { http: sesion, materias };
      sesion = null;  // sesión caducada → volver a loguear
    }
    const http = await utn.abrirSesion(cfg.legajo, cfg.password, cfg.ip);
    sesion = http;
    return { http, materias: (await utn.listarMaterias(http)) ?? [] };
  }

  async function tick() {
    if (!habilitado || corriendo || !configurado()) return;

    const t       = ahora();
    const activas = franjasActivas(franjas, t);
    if (activas.length === 0) { sesion = null; return; }

    // Franjas de hoy que todavía no se resolvieron.
    const pendientes = activas.filter(f => !TERMINALES.has(estado[`${t.fecha}|${f.id}`]?.resultado));
    if (pendientes.length === 0) return;

    corriendo = true;
    try {
      limpiarEstado(t.fecha);
      const { http, materias } = await obtenerMaterias();

      if (ultimoError) {
        await avisar(`✅ Modo automático recuperado (${ultimoError} resuelto).`);
        ultimoError = null;
      }

      for (const f of pendientes) {
        const clave       = `${t.fecha}|${f.id}`;
        const st          = estado[clave] || {};
        const porTerminar = aMinutos(f.hasta) - t.minutos <= AVISO_FINAL_MIN;
        const materia     = buscarMateria(materias, f);

        // Aviso de cierre: la franja se termina sin asistencia registrada. Va en
        // TODOS los caminos que no llegan a registrar — incluido el de "el
        // servidor no devolvió ninguna materia", que si no pasaría en silencio.
        const avisarCierre = async (motivo) => {
          if (!porTerminar || st.avisoFinal) return;
          marcar(clave, { avisoFinal: true });
          await avisar(
            `🔴 *${f.materia}*: la franja termina (${f.hasta}) y no se registró la ` +
            `asistencia.\n${motivo}`
          );
        };

        if (!materia) {
          // Avisar una sola vez qué nombres devolvió el servidor, así se pueden
          // corregir los 'match' de horarios.json.
          if (!st.avisoSinMatch && materias.length > 0) {
            marcar(clave, { resultado: 'sin-match', avisoSinMatch: true });
            await avisar(
              `⚠️ *${f.materia}*: no encontré la materia en el sistema.\n\n` +
              `El servidor devolvió:\n${materias.map(m => `• ${m.nombre}`).join('\n')}\n\n` +
              `Corregí el campo \`match\` de la franja \`${f.id}\` en horarios.json.`
            );
          }
          await avisarCierre(materias.length === 0
            ? '_El sistema no ofreció ninguna materia en toda la franja._'
            : `_No hubo ninguna materia que coincidiera con \`${f.id}\`._`);
          continue;
        }

        if (materia.habilitada !== 'S' && !(cfg.forzar && porTerminar)) {
          // El docente todavía no abrió la ventana: seguir esperando.
          await avisarCierre('_El docente nunca la habilitó._');
          continue;
        }

        const intentos = (st.intentos || 0) + 1;
        const mensajes = await utn.registrarAsistencia(http, materia);
        const clase    = utn.clasificarMensajes(mensajes);
        const cond     = materia.condicional === 'S' ? '\n⚠️ _Figurás como condicional._' : '';

        if (clase === 'ok') {
          marcar(clave, { resultado: 'ok', materia: materia.nombre, intentos });
          await avisar(`✅ *Asistencia registrada*\n${materia.nombre}\n_${t.hhmm} — automático_${cond}`);
          continue;
        }
        if (clase === 'duplicada') {
          marcar(clave, { resultado: 'duplicada', materia: materia.nombre, intentos });
          await avisar(`ℹ️ *${materia.nombre}*: ya estaba registrada.`);
          continue;
        }

        // Rechazada o ilegible: reintentar, pero con tope. Sin él, un mensaje que
        // el parser no entiende genera un POST y un mensaje de Telegram por tick.
        const agotado = intentos >= MAX_INTENTOS;
        marcar(clave, { resultado: agotado ? 'fallida' : clase, materia: materia.nombre, intentos });

        if (intentos === 1 || agotado) {
          const detalle = mensajes.length
            ? `respuesta del servidor:\n${mensajes.join('\n')}`
            : 'el servidor respondió algo que no pude interpretar.';
          await avisar(
            `⚠️ *${materia.nombre}* — ${detalle}\n\n` +
            (agotado
              ? `_Me rindo con esta franja tras ${intentos} intentos. Probá /registrar a mano._`
              : `_Reintento hasta ${MAX_INTENTOS} veces._`)
          );
        }
      }
    } catch (e) {
      sesion = null;
      const motivo =
        e.message === 'LOGIN_FAILED' ? 'login rechazado (revisá AUTO_LEGAJO / AUTO_PASSWORD)' :
        e.message === 'IP_DENEGADA'  ? 'IP no autorizada (actualizá AUTO_IP con la IP pública de UTN)' :
        `error de conexión: ${e.message}`;

      if (ultimoError !== motivo) {   // avisar el cambio, no cada minuto
        ultimoError = motivo;
        await avisar(`❌ *Modo automático*: ${motivo}.\n_Sigo reintentando._`);
      }
      console.error('[auto]', motivo);
    } finally {
      corriendo = false;
    }
  }

  return {
    iniciar() {
      if (!configurado()) {
        console.log('[auto] Desactivado: faltan AUTO_LEGAJO / AUTO_PASSWORD / AUTO_IP / AUTO_CHAT_ID');
        return;
      }
      timer = setInterval(() => { tick().catch(e => console.error('[auto]', e)); }, cfg.intervalo);
      timer.unref?.();
      tick().catch(e => console.error('[auto]', e));
      console.log(`[auto] Activo — ${franjas.length} franjas, tick cada ${cfg.intervalo / 1000}s (${TZ})`);
    },

    detener() { if (timer) clearInterval(timer); timer = null; },

    // Ejecuta un ciclo ahora mismo y espera a que termine (tests, disparo manual).
    tickAhora() { return tick(); },

    set habilitado(v) { habilitado = v; },
    get habilitado()  { return habilitado; },

    recargarHorarios() { franjas = cargarHorarios(); return franjas.length; },

    estadoTexto() {
      const t       = ahora();
      const activas = franjasActivas(franjas, t);
      const lineas  = [
        `*Modo automático*: ${habilitado ? '🟢 activo' : '⚪ pausado'}`,
        `Configurado: ${configurado() ? 'sí' : 'no — faltan variables AUTO_*'}`,
        `Ahora: ${NOMBRE_DIA[t.dia]} ${t.hhmm} (${TZ})`,
        '',
      ];

      if (activas.length) {
        lineas.push('*En franja ahora:*');
        for (const f of activas) {
          const st = estado[`${t.fecha}|${f.id}`];
          const marca = st?.resultado === 'ok'        ? '✅ registrada'
                      : st?.resultado === 'duplicada' ? '✅ ya estaba'
                      : st?.resultado === 'fallida'   ? `❌ falló tras ${st.intentos} intentos`
                      : st?.resultado === 'sin-match' ? '⚠️ no la encuentro en el sistema'
                      : '⏳ esperando que habiliten';
          lineas.push(`• ${f.materia} (${f.desde}–${f.hasta}) — ${marca}`);
        }
      } else {
        lineas.push('_Fuera de horario de cursada._');
      }

      lineas.push('', '*Franjas configuradas:*');
      for (const f of franjas) {
        lineas.push(`• ${NOMBRE_DIA[f.dia]} ${f.desde}–${f.hasta} — ${f.materia}`);
      }
      return lineas.join('\n');
    },

    configurado,

    // Expuesto para /materias_hoy. Abre su propia sesión a propósito: compartir
    // `sesion` con el tick permite que este la deje en null a mitad de camino.
    async materiasAhora() {
      const http = await utn.abrirSesion(cfg.legajo, cfg.password, cfg.ip);
      return (await utn.listarMaterias(http)) ?? [];
    },

    _internos: { ahora, aMinutos, franjasActivas, buscarMateria, normalizar, cargarHorarios },
  };
}

module.exports = { crearAuto, ahora, aMinutos, franjasActivas, buscarMateria, normalizar };
