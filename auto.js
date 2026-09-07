'use strict';

// Modo automático multiusuario, con horarios aprendidos del propio servidor.
//
// Cómo sabe cuándo hay clase: el sistema de UTN solo lista una materia cuando
// hay clase de esa materia en ese momento, independientemente de que el docente
// haya habilitado la asistencia (eso es el flag `habilitada`). Entonces anotar
// cuándo aparece cada materia = leer el horario de la fuente autoritativa.
//
// Consecuencia práctica: da igual si el docente habilita al principio o al final
// de la clase. La ventana no se deduce de cuándo marcaste vos, sino de cuándo el
// servidor ofrece la materia.
//
// Las franjas guardan el ID de materia que devolvió el servidor, no su nombre,
// así que no hay matching difuso que pueda fallar.

const utn   = require('./utn');
const store = require('./store');

const TZ = process.env.TZ_UTN || 'America/Argentina/Buenos_Aires';

// Estados que dan la franja por cerrada: dejan de consultarse ese día.
const TERMINALES = new Set(['ok', 'duplicada', 'fallida']);

// POSTs de registro fallidos antes de rendirse con una franja.
const MAX_INTENTOS = 3;

// Minutos antes del fin de franja en que se avisa "no se registró".
const AVISO_FINAL_MIN = 10;

// Techo de usuarios por tick: el server de UTN es frágil.
const MAX_USUARIOS_POR_TICK = 25;

// Barrido de descubrimiento: fuera de las franjas conocidas se consulta cada
// tantos minutos, para mapear materias que todavía no se conocen.
const DESCUBRIR_CADA_MIN = 15;
const DESCUBRIR_DESDE    = 7 * 60;    // 07:00
const DESCUBRIR_HASTA    = 24 * 60;   // 00:00

// Margen que se le agrega a la ventana observada, en minutos.
const MARGEN_OBSERVADO = 15;

// ─── Tiempo local (Render corre en UTC: hay que forzar la zona) ───────────────

const DIAS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const NOMBRE_DIA = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function ahora(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d).reduce((acc, x) => (acc[x.type] = x.value, acc), {});

  return {
    fecha:   `${p.year}-${p.month}-${p.day}`,
    dia:     DIAS[p.weekday] ?? 0,
    minutos: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    hhmm:    `${p.hour}:${p.minute}`,
  };
}

function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(n => parseInt(n, 10));
  return h * 60 + (m || 0);
}

function aHHMM(minutos) {
  const m = Math.max(0, Math.min(1440, Math.round(minutos)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Un valor no numérico daría NaN, y setInterval(fn, NaN) dispara cada 1 ms.
function intervaloMs(valor) {
  const n = parseInt(valor ?? '', 10);
  return (Number.isFinite(n) ? Math.max(30, n) : 60) * 1000;
}

function franjasActivas(franjas, t) {
  return (franjas || []).filter(f =>
    f.dia === t.dia &&
    t.minutos >= aMinutos(f.desde) &&
    t.minutos <  aMinutos(f.hasta)
  );
}

// ─── Horarios derivados de las observaciones ──────────────────────────────────

// Convierte una observación acumulada en una franja utilizable. La ventana es el
// envolvente de lo visto más un margen; se va ensanchando sola con cada clase.
function franjaDesdeObservacion(o) {
  return {
    id:           `${o.dia}-${o.materiaId}`,
    dia:          o.dia,
    desde:        aHHMM(o.desdeMin - MARGEN_OBSERVADO),
    hasta:        aHHMM(o.hastaMin + MARGEN_OBSERVADO),
    materiaId:    o.materiaId,
    materia:      o.materia,
    vistas:       o.vistas,
    ...(o.datos || {}),
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function crearAuto(bot, opciones = {}) {
  const cfg = {
    intervalo: intervaloMs(process.env.AUTO_INTERVAL_SEC),
    forzar:    process.env.AUTO_FORZAR === 'true',
    ...opciones,
  };

  let habilitado = process.env.AUTO_ENABLED !== 'false';
  let corriendo  = false;
  let timer      = null;
  let ultimoTick = null;

  const sesiones   = new Map();   // chatId → sesión HTTP reutilizada
  const errores    = new Map();   // chatId → último error avisado
  const ultimoScan = new Map();   // chatId → minuto del último barrido

  async function avisar(chatId, texto) {
    try {
      await bot.telegram.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`[auto] No se pudo notificar a ${chatId}:`, e.message);
    }
  }

  // Devuelve también la sesión usada: quien registre después debe usar ESA y no
  // releer el Map, que otra llamada puede haber invalidado mientras tanto.
  async function obtenerMaterias(chatId, u, ip) {
    const previa = sesiones.get(chatId);
    if (previa) {
      const materias = await utn.listarMaterias(previa);
      if (materias !== null) return { http: previa, materias };
      sesiones.delete(chatId);
    }
    const http = await utn.abrirSesion(u.legajo, u.password, ip);
    sesiones.set(chatId, http);
    return { http, materias: (await utn.listarMaterias(http)) ?? [] };
  }

  // ¿Corresponde consultar a este usuario en este instante?
  // Sí si está dentro de alguna franja conocida sin resolver, o si toca barrido.
  function debeConsultar(u, t, franjas) {
    if (franjasActivas(franjas, t).length > 0) return 'franja';

    if (t.minutos < DESCUBRIR_DESDE || t.minutos >= DESCUBRIR_HASTA) return null;
    const ultimo = ultimoScan.get(u.chatId);
    if (ultimo == null || t.minutos - ultimo >= DESCUBRIR_CADA_MIN) return 'barrido';
    return null;
  }

  // Franjas confirmadas por el usuario + las aprendidas por observación.
  async function franjasDeUsuario(u) {
    const observaciones = await store.getObservaciones(u.chatId);
    const confirmadas   = u.franjas || [];
    const ids           = new Set(confirmadas.map(f => f.id));
    return [
      ...confirmadas,
      ...observaciones.map(franjaDesdeObservacion).filter(f => !ids.has(f.id)),
    ];
  }

  async function procesarUsuario(u, t, ip) {
    const observaciones = await store.getObservaciones(u.chatId);
    const franjasPrevias = await franjasDeUsuario(u);

    const motivo = debeConsultar({ ...u, chatId: u.chatId }, t, franjasPrevias);
    if (!motivo) return;

    let http, materias;
    try {
      ({ http, materias } = await obtenerMaterias(u.chatId, u, ip));
      const previo = errores.get(u.chatId);
      if (previo) {
        errores.delete(u.chatId);
        await avisar(u.chatId, `✅ Modo automático recuperado (${previo} resuelto).`);
      }
    } catch (e) {
      sesiones.delete(u.chatId);
      const motivoErr =
        e.message === 'LOGIN_FAILED' ? 'login rechazado — si cambiaste tu contraseña SYSACAD, usá /olvida y volvé a cargarla' :
        e.message === 'IP_DENEGADA'  ? 'UTN rechazó la IP — hay que actualizarla con /guardar\\_ip desde el WiFi de la facu' :
        `error de conexión: ${e.message}`;
      if (errores.get(u.chatId) !== motivoErr) {
        errores.set(u.chatId, motivoErr);
        await avisar(u.chatId, `❌ *Modo automático*: ${motivoErr}.\n_Sigo reintentando._`);
      }
      return;
    }

    if (motivo === 'barrido') ultimoScan.set(u.chatId, t.minutos);

    // Toda materia listada implica que hay clase ahora: es horario, se anota
    // esté habilitada o no.
    const nuevas = [];
    for (const m of materias) {
      const previa = observaciones.find(o => o.dia === t.dia && o.materiaId === m.id);
      await store.registrarObservacion(u.chatId, t.dia, m, t.minutos);
      if (!previa) nuevas.push(m);
    }

    // Recalcular con lo recién observado: si una materia se descubre AHORA y ya
    // está habilitada, hay que registrarla en este mismo ciclo. Esperar al
    // siguiente podía costar hasta 15 minutos (el paso del barrido) y perder la
    // ventana entera del docente.
    const franjas = await franjasDeUsuario(u);

    // Registrar donde corresponda.
    for (const f of franjas) {
      if (!franjasActivas([f], t).length) continue;

      const clave = `${t.fecha}|${u.chatId}|${f.id}`;
      const st    = (await store.getEstado(clave)) || {};
      if (TERMINALES.has(st.resultado)) continue;

      const porTerminar = aMinutos(f.hasta) - t.minutos <= AVISO_FINAL_MIN;
      const materia     = materias.find(m => m.id === f.materiaId);

      const avisarCierre = async (razon) => {
        if (!porTerminar || st.avisoFinal) return;
        await store.marcarEstado(clave, { avisoFinal: true });
        await avisar(u.chatId,
          `🔴 *${f.materia}*: la franja termina (${f.hasta}) y no se registró la asistencia.\n${razon}`);
      };

      if (!materia) {
        await avisarCierre(materias.length === 0
          ? '_El sistema no ofreció ninguna materia._'
          : '_Tu materia no apareció entre las que ofrece el sistema._');
        continue;
      }

      if (materia.habilitada !== 'S' && !(cfg.forzar && porTerminar)) {
        await avisarCierre('_El docente nunca la habilitó._');
        continue;
      }

      const intentos = (st.intentos || 0) + 1;
      const mensajes = await utn.registrarAsistencia(http, materia);
      const clase    = utn.clasificarMensajes(mensajes);
      const cond     = materia.condicional === 'S' ? '\n⚠️ _Figurás como condicional._' : '';

      if (clase === 'ok') {
        await store.marcarEstado(clave, { resultado: 'ok', intentos });
        await avisar(u.chatId,
          `✅ *Asistencia registrada*\n${materia.nombre}\n_${t.hhmm} — automático_${cond}`);
        continue;
      }
      if (clase === 'duplicada') {
        await store.marcarEstado(clave, { resultado: 'duplicada', intentos });
        await avisar(u.chatId, `ℹ️ *${materia.nombre}*: ya estaba registrada.`);
        continue;
      }

      // Rechazada o ilegible: reintentar con tope. Sin él, una respuesta que el
      // parser no entiende genera un POST y un mensaje por tick durante horas.
      const agotado = intentos >= MAX_INTENTOS;
      await store.marcarEstado(clave, { resultado: agotado ? 'fallida' : clase, intentos });

      if (intentos === 1 || agotado) {
        const detalle = mensajes.length
          ? `respuesta del servidor:\n${mensajes.join('\n')}`
          : 'el servidor respondió algo que no pude interpretar.';
        await avisar(u.chatId,
          `⚠️ *${materia.nombre}* — ${detalle}\n\n` +
          (agotado
            ? `_Me rindo con esta franja tras ${intentos} intentos. Probá /registrar a mano._`
            : `_Reintento hasta ${MAX_INTENTOS} veces._`));
      }
    }

    // Avisar de materias nuevas descubiertas, una vez cada una.
    for (const m of nuevas) {
      await avisar(u.chatId,
        `🆕 Descubrí que cursás *${m.nombre}* los ${NOMBRE_DIA[t.dia]} ` +
        `(la vi a las ${t.hhmm}).\n\n` +
        `Ya la voy a marcar sola. Mirá /horarios para ver la ventana que aprendí.`);
    }
  }

  async function tick() {
    if (!habilitado || corriendo) return;

    const t = ahora();
    ultimoTick = t;

    const usuarios = await store.usuariosActivos();
    if (usuarios.length === 0) return;

    const ip = await store.getIp();
    if (!ip) return;   // sin IP de UTN no hay nada que hacer

    corriendo = true;
    try {
      await store.limpiarEstado(t.fecha);
      for (const u of usuarios.slice(0, MAX_USUARIOS_POR_TICK)) {
        try {
          await procesarUsuario(u, t, ip);
        } catch (e) {
          console.error(`[auto] usuario ${u.chatId}:`, e.message);
        }
      }
    } finally {
      corriendo = false;
    }
  }

  return {
    iniciar() {
      timer = setInterval(() => { tick().catch(e => console.error('[auto]', e)); }, cfg.intervalo);
      timer.unref?.();
      tick().catch(e => console.error('[auto]', e));
      console.log(`[auto] Activo — tick cada ${cfg.intervalo / 1000}s (${TZ})`);
    },

    detener() { if (timer) clearInterval(timer); timer = null; },

    // Ejecuta un ciclo ahora y espera a que termine (tests, disparo manual).
    tickAhora() { return tick(); },

    ultimoTick: () => ultimoTick,

    set habilitado(v) { habilitado = v; },
    get habilitado()  { return habilitado; },

    // Franjas de un usuario: confirmadas + aprendidas por observación.
    async franjasDe(chatId) {
      const u = await store.getUsuario(chatId);
      if (!u) return [];
      return franjasDeUsuario({ ...u, chatId });
    },

    async estadoTexto(chatId) {
      const t  = ahora();
      const u  = await store.getUsuario(chatId);
      const ip = await store.getIp();

      if (!u) return 'No estás registrado. Usá /registrar para empezar.';

      const franjas = await this.franjasDe(chatId);
      const lineas = [
        `*Tu modo automático*: ${u.auto ? '🟢 activo' : '⚪ pausado'}`,
        `IP de UTN: ${ip ? `\`${ip}\`` : '❌ ninguna — usá /guardar\\_ip desde el WiFi de la facu'}`,
        `Ahora: ${NOMBRE_DIA[t.dia]} ${t.hhmm}`,
        '',
      ];

      if (franjas.length === 0) {
        lineas.push(
          '_Todavía no aprendí ninguna materia._',
          '',
          'Voy a consultar el sistema cada tanto y, en cuanto te vea una clase,',
          'la aprendo sola. También podés forzarlo marcando una vez con /registrar.'
        );
        return lineas.join('\n');
      }

      const activas = franjasActivas(franjas, t);
      if (activas.length) {
        lineas.push('*En franja ahora:*');
        for (const f of activas) {
          const st = await store.getEstado(`${t.fecha}|${chatId}|${f.id}`);
          const marca = st?.resultado === 'ok'        ? '✅ registrada'
                      : st?.resultado === 'duplicada' ? '✅ ya estaba'
                      : st?.resultado === 'fallida'   ? `❌ falló tras ${st.intentos} intentos`
                      : '⏳ esperando que habiliten';
          lineas.push(`• ${f.materia} — ${marca}`);
        }
        lineas.push('');
      }

      lineas.push('*Horario aprendido:*');
      for (const f of [...franjas].sort((a, b) => a.dia - b.dia || aMinutos(a.desde) - aMinutos(b.desde))) {
        const conf = f.vistas ? ` _(${f.vistas} obs.)_` : '';
        lineas.push(`• ${NOMBRE_DIA[f.dia]} ${f.desde}–${f.hasta} — ${f.materia}${conf}`);
      }
      return lineas.join('\n');
    },
  };
}

module.exports = {
  crearAuto, ahora, aMinutos, aHHMM, franjasActivas, franjaDesdeObservacion,
  intervaloMs, NOMBRE_DIA, TERMINALES, MAX_INTENTOS, DESCUBRIR_CADA_MIN,
};
