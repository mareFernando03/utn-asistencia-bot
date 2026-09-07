// Regresiones del scheduler, con utn.js stubbeado (no toca la red) y el store
// aislado en un archivo temporal.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Deben quedar seteadas ANTES de requerir store/crypto: las leen al cargar.
const TMP = path.join(os.tmpdir(), `utn-bot-test-${Date.now()}.json`);
process.env.STORE_PATH = TMP;
process.env.STORE_KEY  = 'clave-de-prueba-no-usar-en-produccion';

const utn   = require('./utn');
const store = require('./store');
const a     = require('./auto');

const real = { ...utn };
let fallos = 0;

function chequear(nombre, cond, detalle) {
  console.log((cond ? '  ok   ' : 'FALLA  ') + nombre + (cond ? '' : `  ← ${detalle}`));
  if (!cond) fallos++;
}

function limpiarStore() {
  try { fs.unlinkSync(TMP); } catch {}
}

function materia(id, nombre, habilitada = 'S') {
  return { id, nombre, habilitada, condicional: 'N',
           anio: '2026', especialidad: '1', plan: '1', comision: 'A' };
}

// Arma un auto con la red stubbeada. `porUsuario` mapea legajo → respuesta.
function montar(porUsuario) {
  const avisos = [];
  const posts  = [];

  utn.abrirSesion = async (legajo) => {
    if (!porUsuario[legajo]) throw new Error('LOGIN_FAILED');
    return { legajo };
  };
  utn.listarMaterias = async (http) => porUsuario[http.legajo].materias;
  utn.registrarAsistencia = async (http, m) => {
    posts.push({ legajo: http.legajo, materiaId: m.id });
    return porUsuario[http.legajo].respuesta;
  };

  const bot = { telegram: { sendMessage: async (chatId, txt) => avisos.push({ chatId, txt }) } };
  return { auto: a.crearAuto(bot), avisos, posts };
}

(async () => {
  try {
    // ── El store cifra la contraseña en disco y la devuelve en claro ──────────
    limpiarStore();
    {
      await store.setUsuario('111', { legajo: 'L1', password: 'secreta', auto: true });
      const enDisco = JSON.parse(fs.readFileSync(TMP, 'utf8')).usuarios['111'].password;
      const leida   = (await store.getUsuario('111')).password;

      chequear('la contraseña no queda en claro en el archivo',
        !enDisco.includes('secreta'), enDisco);
      chequear('pero se lee descifrada', leida === 'secreta', leida);
      chequear('la contraseña no aparece en ningún lado del JSON',
        !fs.readFileSync(TMP, 'utf8').includes('secreta'), 'aparece en el JSON');
    }

    // ── Observación → franja, con margen ─────────────────────────────────────
    {
      const f = a.franjaDesdeObservacion({
        dia: 1, materiaId: '7', materia: 'X', desdeMin: 18 * 60, hastaMin: 20 * 60 + 30,
        vistas: 4, datos: {},
      });
      chequear('la ventana aprendida cubre lo observado con margen',
        f.desde === '17:45' && f.hasta === '20:45', `${f.desde}-${f.hasta}`);
    }

    // ── El horario se aprende de lo que ofrece el servidor ───────────────────
    limpiarStore();
    {
      await store.setUsuario('111', { legajo: 'L1', password: 'p', auto: true, franjas: [] });
      await store.setIp('1.2.3.4', '111');

      // Materia listada pero NO habilitada: es horario igual, no se registra.
      const { auto, posts } = montar({ L1: {
        materias: [materia('7', 'ARQ MOVILES', 'N')], respuesta: [],
      } });
      await auto.tickAhora();

      const obs = await store.getObservaciones('111');
      chequear('una materia no habilitada igual se aprende como horario',
        obs.length === 1 && obs[0].materiaId === '7', JSON.stringify(obs));
      chequear('...pero no se postea nada', posts.length === 0, `POSTs=${posts.length}`);
    }

    // ── En cuanto el docente habilita, registra ──────────────────────────────
    {
      const { auto, posts, avisos } = montar({ L1: {
        materias: [materia('7', 'ARQ MOVILES', 'S')],
        respuesta: ['Asistencia registrada exitosamente'],
      } });
      await auto.tickAhora();
      chequear('al habilitarse, registra', posts.length === 1, `POSTs=${posts.length}`);
      chequear('y avisa al usuario correcto',
        avisos.some(x => x.chatId === '111' && x.txt.includes('Asistencia registrada')),
        JSON.stringify(avisos));

      await auto.tickAhora();
      await auto.tickAhora();
      chequear('no vuelve a postear el mismo día', posts.length === 1, `POSTs=${posts.length}`);
    }

    // ── Dos usuarios no se cruzan ────────────────────────────────────────────
    limpiarStore();
    {
      await store.setIp('1.2.3.4', '111');
      await store.setUsuario('111', { legajo: 'L1', password: 'p1', auto: true, franjas: [] });
      await store.setUsuario('222', { legajo: 'L2', password: 'p2', auto: true, franjas: [] });

      const { auto, posts, avisos } = montar({
        L1: { materias: [materia('7', 'ARQ MOVILES')], respuesta: ['Asistencia registrada'] },
        L2: { materias: [materia('9', 'SEGURIDAD')],   respuesta: ['Asistencia registrada'] },
      });
      await auto.tickAhora();

      const deL1 = posts.filter(p => p.legajo === 'L1');
      const deL2 = posts.filter(p => p.legajo === 'L2');
      chequear('cada usuario postea solo su materia',
        deL1.length === 1 && deL1[0].materiaId === '7' &&
        deL2.length === 1 && deL2[0].materiaId === '9', JSON.stringify(posts));

      const o1 = await store.getObservaciones('111');
      const o2 = await store.getObservaciones('222');
      chequear('los horarios aprendidos no se mezclan',
        o1.length === 1 && o1[0].materiaId === '7' &&
        o2.length === 1 && o2[0].materiaId === '9',
        `u1=${JSON.stringify(o1.map(o => o.materiaId))} u2=${JSON.stringify(o2.map(o => o.materiaId))}`);

      chequear('cada aviso va a su propio chat',
        avisos.every(x => x.chatId === '111' || x.chatId === '222') &&
        avisos.some(x => x.chatId === '111') && avisos.some(x => x.chatId === '222'),
        JSON.stringify(avisos.map(x => x.chatId)));
    }

    // ── Un login roto no frena a los demás ───────────────────────────────────
    limpiarStore();
    {
      await store.setIp('1.2.3.4', '111');
      await store.setUsuario('111', { legajo: 'ROTO', password: 'p', auto: true, franjas: [] });
      await store.setUsuario('222', { legajo: 'L2',   password: 'p', auto: true, franjas: [] });

      const { auto, posts, avisos } = montar({
        L2: { materias: [materia('9', 'SEGURIDAD')], respuesta: ['Asistencia registrada'] },
      });
      await auto.tickAhora();

      chequear('el usuario sano registra igual',
        posts.length === 1 && posts[0].legajo === 'L2', JSON.stringify(posts));
      chequear('y el del login roto recibe su aviso',
        avisos.some(x => x.chatId === '111' && x.txt.includes('login rechazado')),
        JSON.stringify(avisos.filter(x => x.chatId === '111')));
    }

    // ── Rechazo repetido: tope de intentos ───────────────────────────────────
    limpiarStore();
    {
      await store.setIp('1.2.3.4', '111');
      await store.setUsuario('111', { legajo: 'L1', password: 'p', auto: true, franjas: [] });

      const { auto, posts, avisos } = montar({ L1: {
        materias: [materia('7', 'ARQ MOVILES')],
        respuesta: ['No se pudo registrar la asistencia'],
      } });
      for (let i = 0; i < 8; i++) await auto.tickAhora();

      chequear('se rinde a los 3 POSTs, no uno por tick',
        posts.length === a.MAX_INTENTOS, `POSTs=${posts.length}`);

      // Aparte del aviso único de "descubrí esta materia".
      const quejas = avisos.filter(x => x.txt.includes('respuesta del servidor'));
      chequear('avisa del rechazo 2 veces, no 8', quejas.length === 2, `quejas=${quejas.length}`);
      chequear('el último dice que se rinde',
        quejas[quejas.length - 1].txt.includes('Me rindo'), quejas[quejas.length - 1].txt);
    }

    // ── Un rechazo que dice "registrada" no puede contar como éxito ──────────
    limpiarStore();
    {
      await store.setIp('1.2.3.4', '111');
      await store.setUsuario('111', { legajo: 'L1', password: 'p', auto: true, franjas: [] });

      const { auto, posts, avisos } = montar({ L1: {
        materias: [materia('7', 'ARQ MOVILES')],
        respuesta: ['La asistencia no fue registrada'],
      } });
      await auto.tickAhora();
      chequear('no lo reporta como registrado',
        !avisos.some(x => x.txt.includes('*Asistencia registrada*')), JSON.stringify(avisos));
      await auto.tickAhora();
      chequear('y reintenta', posts.length === 2, `POSTs=${posts.length}`);
    }

    // ── Sin IP cargada no se hace nada ───────────────────────────────────────
    limpiarStore();
    {
      await store.setUsuario('111', { legajo: 'L1', password: 'p', auto: true, franjas: [] });
      const { auto, posts } = montar({ L1: { materias: [materia('7', 'X')], respuesta: [] } });
      await auto.tickAhora();
      chequear('sin IP de UTN no consulta nada', posts.length === 0, `POSTs=${posts.length}`);
    }

    // ── /olvida borra todo lo del usuario ────────────────────────────────────
    limpiarStore();
    {
      await store.setIp('1.2.3.4', '111');
      await store.setUsuario('111', { legajo: 'L1', password: 'p', auto: true, franjas: [] });
      const { auto } = montar({ L1: { materias: [materia('7', 'X')], respuesta: [] } });
      await auto.tickAhora();

      chequear('había observaciones antes de borrar',
        (await store.getObservaciones('111')).length === 1, 'no las hubo');
      await store.borrarUsuario('111');
      chequear('/olvida borra usuario y horario',
        (await store.getUsuario('111')) === null &&
        (await store.getObservaciones('111')).length === 0, 'quedó algo');
    }

    // ── intervaloMs: un valor basura no puede dar NaN ────────────────────────
    chequear('AUTO_INTERVAL_SEC basura → 60s',
      a.intervaloMs('medio') === 60000 && a.intervaloMs(undefined) === 60000, 'dio NaN');
    chequear('AUTO_INTERVAL_SEC con piso de 30s', a.intervaloMs('5') === 30000, 'sin piso');

  } finally {
    Object.assign(utn, real);
    limpiarStore();
  }

  console.log(fallos === 0 ? '\nTODOS LOS CHEQUEOS OK' : `\n${fallos} CHEQUEO(S) FALLARON`);
  process.exit(fallos === 0 ? 0 : 1);
})();
