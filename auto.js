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

// Techo de consultas por tick: el server de UTN es frágil.
const MAX_USUARIOS_POR_TICK = 25;

// ─── Cadencia ─────────────────────────────────────────────────────────────────
//
// El servidor de asistencias de UTN es chico y compartido, así que cada
// petición cuesta. Cuatro reglas bajan el tráfico sin perder asistencias:
//
//  1. Piso duro por usuario: nunca más de una consulta por minuto, pase lo que
//     pase con el intervalo del tick.
//  2. Una franja ya resuelta hoy (registrada, duplicada o rendida) deja de
//     consultarse a cadencia de franja y pasa a la cadencia lenta de barrido,
//     que alcanza para seguir aprendiendo hasta dónde llega la clase.
//  3. Dentro de una franja sin resolver, mientras el docente no habilite, la
//     espera crece 1→2→…→BACKOFF_MAX_MIN. La ventana aprendida se estira sola
//     con cada consulta, así que aunque el docente habilite sobre el final la
//     franja sigue abierta cuando toca mirar de nuevo.
//  4. El barrido de descubrimiento va lento en los días de la semana que ya
//     están mapeados; materias nuevas casi solo aparecen al empezar el cuatri.

// Barrido de descubrimiento: fuera de las franjas conocidas se consulta cada
// tantos minutos, para mapear materias que todavía no se conocen.
const DESCUBRIR_CADA_MIN  = 15;       // día de la semana sin nada aprendido
const DESCUBRIR_LENTO_MIN = 45;       // día ya mapeado
const DESCUBRIR_DESDE     = 7 * 60;   // 07:00
const DESCUBRIR_HASTA     = 23 * 60;  // 23:00

// Piso entre dos consultas del mismo usuario, en minutos.
const MIN_ENTRE_CONSULTAS = 1;

// Techo del backoff dentro de una franja que el docente no habilitó todavía.
const BACKOFF_MAX_MIN = entero(process.env.AUTO_BACKOFF_MAX_MIN, 3, 1, 15);

// Espera tras un error de login/IP/red: reintentar cada minuto no arregla nada
// y multiplica las peticiones por usuario roto.
const ESPERA_ERROR_MIN = 5;

function entero(valor, def, min, max) {
  const n = parseInt(valor ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

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
  const ultimoScan = new Map();   // chatId → { fecha, minuto } del último barrido
  const proxima    = new Map();   // chatId → { fecha, minuto } de la próxima consulta
  const backoff    = new Map();   // chatId → espera actual, en minutos
  let   arranque   = 0;           // rotación del turno cuando sobran usuarios

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
    try {
      const http = await utn.abrirSesion(u.legajo, u.password, ip);
      sesiones.set(chatId, http);
      return { http, materias: (await utn.listarMaterias(http)) ?? [] };
    } catch (e) {
      sesiones.delete(chatId);
      throw e;
    }
  }

  // ¿Ya pasó el momento agendado para volver a consultar a este usuario?
  function tocaConsultar(chatId, t) {
    const p = proxima.get(chatId);
    return !p || p.fecha !== t.fecha || t.minutos >= p.minuto;
  }

  function agendar(chatId, t, minutos) {
    proxima.set(chatId, { fecha: t.fecha, minuto: t.minutos + Math.max(MIN_ENTRE_CONSULTAS, minutos) });
  }

  // ¿Corresponde consultar a este usuario en este instante?
  // Sí si tiene una franja activa SIN resolver, o si le toca barrido.
  //
  // Que la franja esté resuelta importa: una vez registrada la asistencia, el
  // resto de la clase no hay nada que preguntar, y antes se seguía preguntando
  // cada minuto hasta que la ventana cerraba.
  function debeConsultar(chatId, t, pendientes, observaciones) {
    if (!tocaConsultar(chatId, t)) return null;
    if (pendientes.length > 0) return 'franja';

    if (t.minutos < DESCUBRIR_DESDE || t.minutos >= DESCUBRIR_HASTA) return null;

    // Un día de la semana ya mapeado casi no da sorpresas: basta con mirarlo de
    // tanto en tanto para estirar la ventana aprendida.
    const cada   = observaciones.some(o => o.dia === t.dia) ? DESCUBRIR_LENTO_MIN : DESCUBRIR_CADA_MIN;
    const ultimo = ultimoScan.get(chatId);
    if (!ultimo || ultimo.fecha !== t.fecha || t.minutos - ultimo.minuto >= cada) return 'barrido';
    return null;
  }

  // Agenda la próxima consulta según lo que se acaba de ver.
  //
  // Sin franja pendiente no hay nada que esperar del servidor y manda la
  // cadencia de barrido. Con una materia ya habilitada tampoco se espacia: se
  // está por postear, y si el POST sale mal conviene reintentar enseguida.
  function reprogramar(chatId, t, pendientes, materias) {
    const habilitada = materias.some(m =>
      m.habilitada === 'S' && pendientes.some(f => f.materiaId === m.id));

    if (pendientes.length === 0 || habilitada) {
      backoff.delete(chatId);
      return agendar(chatId, t, MIN_ENTRE_CONSULTAS);
    }
    const espera = Math.min(BACKOFF_MAX_MIN, (backoff.get(chatId) || 0) + 1);
    backoff.set(chatId, espera);
    agendar(chatId, t, espera);
  }

  // Franjas confirmadas por el usuario + las aprendidas por observación.
  function combinarFranjas(confirmadas, observaciones) {
    const ids = new Set((confirmadas || []).map(f => f.id));
    return [
      ...(confirmadas || []),
      ...observaciones.map(franjaDesdeObservacion).filter(f => !ids.has(f.id)),
    ];
  }

  async function franjasDeUsuario(u) {
    return combinarFranjas(u.franjas, await store.getObservaciones(u.chatId));
  }

  // Devuelve true si efectivamente consultó al servidor de UTN: el tick lleva
  // presupuesto de CONSULTAS, no de usuarios mirados.
  async function procesarUsuario(u, t, ip) {
    const observaciones  = await store.getObservaciones(u.chatId);
    const franjasPrevias = combinarFranjas(u.franjas, observaciones);

    // Franjas activas que todavía tienen algo que resolver hoy.
    const pendientes = [];
    for (const f of franjasActivas(franjasPrevias, t)) {
      const st = await store.getEstado(`${t.fecha}|${u.chatId}|${f.id}`);
      if (!TERMINALES.has(st?.resultado)) pendientes.push(f);
    }

    const motivo = debeConsultar(u.chatId, t, pendientes, observaciones);
    if (!motivo) return false;

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
      // Reintentar cada minuto un login que el servidor rechaza no arregla
      // nada y multiplica las peticiones por cada usuario roto.
      agendar(u.chatId, t, ESPERA_ERROR_MIN);
      const motivoErr =
        e.message === 'LOGIN_FAILED' ? 'login rechazado — si cambiaste tu contraseña SYSACAD, usá /olvida y volvé a cargarla' :
        e.message === 'IP_DENEGADA'  ? 'UTN rechazó la IP — hay que actualizarla con /guardar\\_ip desde el WiFi de la facu' :
        `error de conexión: ${e.message}`;
      if (errores.get(u.chatId) !== motivoErr) {
        errores.set(u.chatId, motivoErr);
        await avisar(u.chatId, `❌ *Modo automático*: ${motivoErr}.\n_Sigo reintentando._`);
      }
      return true;
    }

    reprogramar(u.chatId, t, pendientes, materias);
    if (motivo === 'barrido') ultimoScan.set(u.chatId, { fecha: t.fecha, minuto: t.minutos });

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
    const franjas = combinarFranjas(u.franjas, await store.getObservaciones(u.chatId));

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

    return true;
  }

  async function tick(momento) {
    if (!habilitado || corriendo) return;

    const t = ahora(momento);
    ultimoTick = t;

    const usuarios = await store.usuariosActivos();
    if (usuarios.length === 0) return;

    const ip = await store.getIp();
    if (!ip) return;   // sin IP de UTN no hay nada que hacer

    corriendo = true;
    try {
      await store.limpiarEstado(t.fecha);

      // El techo es de CONSULTAS, no de usuarios: mirar a alguien a quien no le
      // toca no cuesta ninguna petición. Y el turno rota, así que con muchos
      // usuarios no entran siempre los mismos.
      let presupuesto = MAX_USUARIOS_POR_TICK;
      for (let i = 0; i < usuarios.length && presupuesto > 0; i++) {
        const u = usuarios[(arranque + i) % usuarios.length];
        try {
          if (await procesarUsuario(u, t, ip)) presupuesto--;
        } catch (e) {
          console.error(`[auto] usuario ${u.chatId}:`, e.message);
        }
      }
      arranque = usuarios.length ? (arranque + MAX_USUARIOS_POR_TICK) % usuarios.length : 0;
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

    // Sesión HTTP compartida con los comandos manuales: si el scheduler ya tiene
    // una sesión viva de este usuario, /registrar no rehace el login (4
    // peticiones) para preguntar lo mismo.
    materiasDe(chatId, u, ip) { return obtenerMaterias(chatId, u, ip); },

    // Al borrar o desautorizar a alguien no queda su sesión colgada, ni su
    // agenda de consultas si vuelve a darse de alta.
    olvidarSesion(chatId) {
      for (const m of [sesiones, errores, ultimoScan, proxima, backoff]) m.delete(chatId);
    },

    // Ejecuta un ciclo y espera a que termine (tests, disparo manual).
    // `momento` permite simular el reloj: la cadencia depende del minuto, así
    // que sin eso no se puede testear más de un ciclo seguido.
    tickAhora(momento) { return tick(momento); },

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
  intervaloMs, NOMBRE_DIA, TERMINALES, MAX_INTENTOS,
  DESCUBRIR_CADA_MIN, DESCUBRIR_LENTO_MIN, BACKOFF_MAX_MIN, ESPERA_ERROR_MIN,
};
