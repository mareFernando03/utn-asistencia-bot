# UTN FRSFCO — Bot de Asistencias

Bot de Telegram que registra asistencias en el [sistema de UTN FRSFCO](https://asistencia.frsfco.utn.edu.ar:4443) sin pasar por el frontend.

El problema que resuelve: el docente habilita la asistencia en una ventana de pocos minutos, y si no estás mirando el celular en ese momento, la perdés. El bot la mira por vos.

Dos modos:

- **Manual** — `/registrar`, elegís la materia de una lista.
- **Automático** — durante tus clases mira el sistema y registra en cuanto el docente habilita.

> **Bot privado.** Guarda contraseñas SYSACAD, que abren la cuenta académica completa de quien las presta. `ALLOWED_IDS` es obligatoria: sin esa lista blanca no se da de alta a nadie.

## Uso

1. El administrador agrega tu chat id a `ALLOWED_IDS` (lo ves con [@userinfobot](https://t.me/userinfobot))
2. `/registrar` → legajo, contraseña, y aceptás qué se guarda
3. `/guardar_ip` **una vez**, conectado al WiFi de UTN
4. Listo: de ahí en más marca solo

### Comandos

| Comando | Descripción |
|---|---|
| `/registrar` | Da de alta y marca asistencia ahora |
| `/guardar_ip` | Link para capturar la IP de la red de UTN |
| `/auto` | Tu estado y el horario aprendido |
| `/horarios` | Las materias que marca solo |
| `/auto_on` · `/auto_off` | Reanuda / pausa tu modo automático |
| `/olvida` | Borra tus credenciales, horario y estado |
| `/diag` | Diagnóstico técnico de la instancia |

## Cómo aprende tu horario

No hace falta cargarlo. Sale del propio servidor de UTN.

**La clave:** el sistema solo lista una materia cuando hay clase de esa materia *en ese momento*, independientemente de que el docente haya habilitado la asistencia — eso último es el flag `habilitada` (🟢/🔴). Entonces anotar **cuándo aparece** cada materia equivale a leer tu horario de cursada de la fuente autoritativa.

El bot barre cada 15 minutos los días de la semana que todavía no conoce y cada 45 los que ya tiene mapeados; en cuanto te ve una clase nueva, la aprende y te avisa. La ventana es el envolvente de lo observado más 15 minutos de margen, y se va ajustando sola con cada clase.

### Cuántas veces pregunta

El servidor de asistencias de UTN es chico y compartido, así que el bot cuida las peticiones:

- **Piso de una consulta por minuto y por usuario**, sea cual sea `AUTO_INTERVAL_SEC`.
- **Franja ya resuelta** (registrada, duplicada o rendida): deja de preguntar por esa clase y pasa a la cadencia lenta de barrido.
- **Franja abierta sin habilitar todavía**: la espera crece 1 → 2 → 3 minutos. Con la materia habilitada vuelve al mínimo.
- **Login o IP rechazados**: reintenta cada 5 minutos, no cada minuto.
- **Sesión HTTP reutilizada**: solo se rehace el login cuando el servidor devuelve el formulario de login. `/registrar` a mano aprovecha la sesión que ya tiene el scheduler.

En una clase de 3 horas eso son ~4 consultas si el docente habilita temprano y ~60 si no habilita nunca, contra las 180 de un sondeo por minuto. `/diag` muestra el contador real de peticiones.

Dos consecuencias que importan:

- **Da igual si el docente habilita al principio o al final.** La ventana no se deduce de cuándo marcaste vos, sino de cuándo hay clase.
- **No hay matching por nombre.** Las franjas guardan el ID de materia que devolvió el servidor, así que no hay nada que adivinar ni que se pueda romper si cambia un nombre.

Si una materia se descubre estando ya habilitada, se registra en ese mismo ciclo — no espera al siguiente barrido.

### Avisos

| Situación | Mensaje |
|---|---|
| Registró | ✅ Asistencia registrada + materia y hora |
| Ya estaba | ℹ️ Ya estaba registrada |
| Materia nueva descubierta | 🆕 Una vez, al aprenderla |
| El servidor rechazó | ⚠️ En el 1er intento y otra vez al rendirse (3 intentos) |
| **La franja termina sin asistencia** | 🔴 Siempre, sea cual sea el motivo |
| Login / IP / red fallando | ❌ Una vez por error, y otra al recuperarse |

El aviso de cierre es el que importa: si algo falló, te enterás esa misma noche y no cuando salgan las actas.

## La IP de UTN

El sistema de UTN valida contra una whitelist la IP que el cliente le declara. Como el bot corre en un hosting, alguien tiene que estar en el campus y decírsela: `/guardar_ip` devuelve un link, lo abrís desde el WiFi de la facu, y el servidor lee la IP pública de ese request.

Es **una sola para todos** (es la misma red), así que alcanza con que la cargue una persona. El link vale 15 minutos.

## Deploy

Variables de entorno:

| Variable | Obligatoria | Valor |
|---|---|---|
| `BOT_TOKEN` | sí | Token de [@BotFather](https://t.me/BotFather) |
| `ALLOWED_IDS` | sí | Chat ids autorizados, separados por coma |
| `STORE_KEY` | recomendada | Clave para cifrar contraseñas en reposo |
| `BOT_URL` | sí | URL pública — sin esto no anda `/guardar_ip` |
| `AUTO_ENABLED` | no | `false` para arrancar pausado |
| `AUTO_INTERVAL_SEC` | no | Intervalo del tick, mínimo 30, default 60 |
| `AUTO_BACKOFF_MAX_MIN` | no | Espera máxima entre consultas de una franja sin habilitar, default 3 |
| `AUTO_FORZAR` | no | `true` = intentar igual si nunca habilitaron |

**El plan free de Render duerme el servicio tras ~15 min sin tráfico.** Con `BOT_URL` el bot se auto-pinguea cada 10 min, pero lo confiable es un cron externo ([cron-job.org](https://cron-job.org)) que pegue a la URL. Si el servicio está dormido cuando empieza tu clase, no hay scheduler.

**El disco de Render es efímero:** un redeploy borra `store.json`, o sea credenciales, horarios aprendidos e IP. Todos tienen que volver a darse de alta. Para que eso deje de pasar hay que mover `store.js` a una base de datos — su API ya es async justamente para que ese cambio sea reemplazar un archivo.

## Seguridad

Qué se guarda por usuario: legajo y contraseña SYSACAD.

`STORE_KEY` cifra la contraseña en reposo (AES-256-GCM). **Qué protege:** que el archivo se escape — commit accidental, snapshot, backup, una copia que se lleva alguien. **Qué no protege:** a quien controle el proceso, porque ahí también está la clave. Sin `STORE_KEY` se guarda en texto plano y el bot lo avisa al arrancar y en `/diag`.

El alta muestra explícitamente qué se guarda, quién puede verlo y que un redeploy lo borra, y requiere aceptación.

Nunca hardcodear credenciales en archivos versionados: van a `.env` (git-ignored) o a las variables del hosting.

## Desarrollo

```bash
npm install
cp .env.example .env   # completar
npm start              # producción
npm run dev            # recarga automática
npm test               # regresiones (red stubbeada, no toca UTN)
```

`npm test` cubre el cifrado del store, el aprendizaje de horarios, el aislamiento entre usuarios, el tope de reintentos y los casos que rompieron antes.

## Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `utn.js` | Cliente del sistema UTN: sesión HTTP, parser, login, listar, registrar |
| `store.js` | Persistencia (JSON hoy; API async para poder pasar a una DB) |
| `crypto.js` | Cifrado en reposo de las contraseñas |
| `auto.js` | Scheduler multiusuario y aprendizaje de horarios |
| `bot.js` | Comandos de Telegram, alta con consentimiento, captura de IP |
| `test-auto.js` | Regresiones con `utn.js` stubbeado |

Flujo HTTP replicado del frontend:

1. **Login** — `POST /index.php` con legajo y contraseña
2. **Verificación de IP** — `POST /verificar_ip.php`. El servidor valida **la IP que el cliente manda en el body**, no la de la conexión
3. **Consulta de materias** — `GET /apply-leave.php`, parsea el `<select>`
4. **Registro** — `POST /apply-leave.php` con los datos de la materia

## Notas

- El servidor UTN usa un certificado SSL autofirmado — el bot lo ignora explícitamente
- Las materias que devuelve dependen del día y horario actual: fuera de clase la lista viene vacía, y eso es lo normal
- El modo automático registra según el horario, sin verificar presencia en el aula
