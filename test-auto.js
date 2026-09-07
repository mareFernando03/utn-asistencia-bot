// Verifica los arreglos del review sobre auto.js, con utn.js stubbeado (no toca
// la red). Escribe un horarios.json sintético que cubre "ahora" y lo restaura.
const fs   = require('fs');
const path = require('path');
const REPO = __dirname;

const HOR    = path.join(REPO, 'horarios.json');
const ESTADO = path.join(REPO, 'estado-auto.json');
const backup = fs.readFileSync(HOR, 'utf8');

const utn  = require(path.join(REPO, 'utn.js'));
const real = { ...utn };

let fallos = 0;
function chequear(nombre, cond, detalle) {
  console.log((cond ? '  ok   ' : 'FALLA  ') + nombre + (cond ? '' : `  ← ${detalle}`));
  if (!cond) fallos++;
}

// Franja sintética que termina en `minutosRestantes` minutos desde ahora.
function escribirFranja(minutosRestantes) {
  const { ahora } = require(path.join(REPO, 'auto.js'));
  const t   = ahora();
  const fin = t.minutos + minutosRestantes;
  const hh  = String(Math.floor(fin / 60)).padStart(2, '0');
  const mm  = String(fin % 60).padStart(2, '0');
  fs.writeFileSync(HOR, JSON.stringify({
    franjas: [{
      id: 'test', dia: t.dia, desde: '00:00', hasta: `${hh}:${mm}`,
      materia: 'Materia De Prueba', match: ['materia de prueba'], activo: true,
    }],
  }, null, 2));
}

function nuevoAuto(materias, respuestaRegistro) {
  try { fs.unlinkSync(ESTADO); } catch {}
  delete require.cache[require.resolve(path.join(REPO, 'auto.js'))];
  const { crearAuto } = require(path.join(REPO, 'auto.js'));

  const avisos = [];
  const posts  = [];
  utn.abrirSesion       = async () => ({ marca: 'sesion-stub' });
  utn.listarMaterias    = async () => materias;
  utn.registrarAsistencia = async (http, m) => { posts.push({ http, m }); return respuestaRegistro; };

  const bot  = { telegram: { sendMessage: async (id, txt) => avisos.push(txt) } };
  const auto = crearAuto(bot, { legajo: '1', password: 'x', ip: '1.2.3.4', chatId: '9' });
  return { auto, avisos, posts };
}

(async () => {
  try {
    // ── Hallazgo 3: el servidor no ofrece NADA en toda la franja ──────────────
    escribirFranja(5);  // quedan 5 min → porTerminar
    {
      const { auto, avisos } = nuevoAuto([], []);
      await auto.tickAhora();
      chequear('lista vacía + franja terminando → avisa que no se registró',
        avisos.some(a => a.includes('no se registró la asistencia')),
        `avisos=${JSON.stringify(avisos)}`);

      await auto.tickAhora();
      const cierres = avisos.filter(a => a.includes('no se registró la asistencia')).length;
      chequear('ese aviso se manda una sola vez', cierres === 1, `se mandó ${cierres} veces`);
    }

    // ── Hallazgo 2: respuesta rechazada no debe reintentar para siempre ───────
    escribirFranja(120);  // lejos del final, para aislar el tope de intentos
    {
      const materias = [{ id: '7', nombre: 'MATERIA DE PRUEBA', habilitada: 'S',
                          condicional: 'N', anio: '', especialidad: '', plan: '', comision: '' }];
      const { auto, avisos, posts } = nuevoAuto(materias, ['No se pudo registrar la asistencia']);

      for (let i = 0; i < 8; i++) await auto.tickAhora();

      chequear('se rinde a los 3 POSTs (no uno por tick)', posts.length === 3, `hubo ${posts.length} POSTs`);
      chequear('avisa 2 veces, no 8', avisos.length === 2, `hubo ${avisos.length} avisos`);
      chequear('el último aviso dice que se rinde',
        avisos[avisos.length - 1].includes('Me rindo'), avisos[avisos.length - 1]);
    }

    // ── Hallazgo 6: "no fue registrada" no puede contar como éxito ────────────
    {
      const materias = [{ id: '7', nombre: 'MATERIA DE PRUEBA', habilitada: 'S',
                          condicional: 'N', anio: '', especialidad: '', plan: '', comision: '' }];
      const { auto, avisos, posts } = nuevoAuto(materias, ['La asistencia no fue registrada']);
      await auto.tickAhora();
      chequear('rechazo con la palabra "registrada" no se marca ok',
        !avisos.some(a => a.includes('Asistencia registrada')), JSON.stringify(avisos));
      chequear('y reintenta', (await auto.tickAhora(), posts.length === 2), `POSTs=${posts.length}`);
    }

    // ── Camino feliz: registra una vez y deja de consultar ────────────────────
    {
      const materias = [{ id: '7', nombre: 'MATERIA DE PRUEBA', habilitada: 'S',
                          condicional: 'N', anio: '', especialidad: '', plan: '', comision: '' }];
      const { auto, avisos, posts } = nuevoAuto(materias, ['Asistencia registrada exitosamente']);
      await auto.tickAhora();
      await auto.tickAhora();
      await auto.tickAhora();
      chequear('éxito → un solo POST aunque siga ticking', posts.length === 1, `POSTs=${posts.length}`);
      chequear('éxito → un solo aviso ✅', avisos.length === 1, JSON.stringify(avisos));
      chequear('el aviso confirma la registración',
        avisos[0].includes('Asistencia registrada'), avisos[0]);
    }

    // ── Hallazgo 5: el POST usa la sesión devuelta, no la variable compartida ─
    {
      const materias = [{ id: '7', nombre: 'MATERIA DE PRUEBA', habilitada: 'S',
                          condicional: 'N', anio: '', especialidad: '', plan: '', comision: '' }];
      const { auto, posts } = nuevoAuto(materias, ['Asistencia registrada exitosamente']);
      await auto.tickAhora();
      chequear('registrarAsistencia recibe una sesión no nula',
        posts[0] && posts[0].http && posts[0].http.marca === 'sesion-stub',
        JSON.stringify(posts[0] && posts[0].http));
    }

    // ── Docente que no habilitó, lejos del final: silencio y sin POST ─────────
    {
      const materias = [{ id: '7', nombre: 'MATERIA DE PRUEBA', habilitada: 'N',
                          condicional: 'N', anio: '', especialidad: '', plan: '', comision: '' }];
      const { auto, avisos, posts } = nuevoAuto(materias, ['x']);
      await auto.tickAhora();
      chequear('no habilitada → no postea', posts.length === 0, `POSTs=${posts.length}`);
      chequear('no habilitada lejos del final → no molesta', avisos.length === 0, JSON.stringify(avisos));
    }

  } finally {
    Object.assign(utn, real);
    fs.writeFileSync(HOR, backup);
    try { fs.unlinkSync(ESTADO); } catch {}
  }

  console.log(fallos === 0 ? '\nTODOS LOS CHEQUEOS OK' : `\n${fallos} CHEQUEO(S) FALLARON`);
  process.exit(fallos === 0 ? 0 : 1);
})();
