# UTN FRSFCO — Bot de Asistencias

Bot de Telegram para registrar asistencias en el [sistema web de UTN FRSFCO](https://asistencia.frsfco.utn.edu.ar:4443), sin depender del frontend.

Tiene dos modos:

- **Manual** — `/registrar`, elegís la materia de una lista y listo.
- **Automático** — durante tus franjas de cursada el bot consulta el sistema cada minuto y registra la asistencia en cuanto el docente la habilita. Sin acción tuya.

## Uso manual

1. Buscá `@UtnAsistBot` en Telegram
2. Enviá `/registrar`
3. Si es la primera vez, ingresá tu legajo, contraseña SYSACAD e IP pública de UTN
4. Seleccioná la materia de la lista

### Comandos

| Comando | Descripción |
|---|---|
| `/registrar` | Marca asistencia para el día de hoy |
| `/olvida` | Borra las credenciales guardadas |
| `/auto` | Estado del modo automático y franjas configuradas |
| `/auto_on` · `/auto_off` | Reanuda / pausa el modo automático (recarga `horarios.json`) |
| `/materias_hoy` | Muestra los nombres exactos que devuelve SYSACAD ahora mismo |

Los cuatro comandos `auto*` / `materias_hoy` están restringidos a `AUTO_CHAT_ID`: operan sobre la cuenta SYSACAD del dueño (pausan su asistencia, disparan logins con sus credenciales, listan sus materias), y `ALLOWED_IDS` es opcional.

## Modo automático

### Cómo funciona

Cada `AUTO_INTERVAL_SEC` segundos (60 por defecto) el scheduler mira si el momento actual cae dentro de alguna franja de `horarios.json`. Si cae:

1. Reutiliza la sesión HTTP abierta (vuelve a loguearse solo si caducó)
2. Lista las materias que ofrece el sistema
3. Busca la que corresponde a la franja según el campo `match`
4. Si figura con `habilitada="S"`, hace el POST de registro y avisa por Telegram

Registrada una materia, deja de consultarla por ese día. Fuera de las franjas no hace ninguna petición.

Eso resuelve el problema real: la ventana en la que el docente habilita la asistencia puede durar tres minutos, y el bot la está mirando cada 60 segundos.

> **El modo automático no verifica que estés en el aula.** Marca presente en cada franja configurada, estés donde estés — el servidor de UTN acepta la IP que el cliente le declara, así que corriendo en Render no hay ninguna comprobación de presencia. Es una decisión consciente de quien lo configura; `AUTO_ENABLED=false` o `/auto_off` lo dejan pausado.

### Configurar los horarios

`horarios.json` define las franjas:

```json
{
  "id": "lun-sg",
  "dia": 1,                          // 1=lunes ... 7=domingo
  "desde": "18:00",
  "hasta": "21:00",                  // "24:00" = hasta medianoche
  "materia": "Sistemas de Gestión",  // solo para los avisos
  "match": ["sistemas de gestion"],  // frases a buscar en el nombre de SYSACAD
  "activo": true
}
```

`match` compara contra el nombre normalizado (minúsculas, sin acentos) y alcanza con que **alguna** frase esté contenida. Los nombres de SYSACAD no son los que usás vos: corré **`/materias_hoy` durante una clase** para ver los reales y ajustar `match`. Si el bot está en franja y no encuentra la materia, te manda por Telegram la lista de lo que devolvió el servidor.

Después de editar `horarios.json`, `/auto_on` lo recarga sin reiniciar.

### Avisos que manda

| Situación | Mensaje |
|---|---|
| Registró | ✅ Asistencia registrada + materia y hora |
| Ya estaba registrada | ℹ️ Ya estaba |
| No encontró la materia | ⚠️ Lista de lo que devolvió el servidor, para corregir `match` |
| El servidor rechazó el registro | ⚠️ En el 1er intento y otra vez al rendirse (3 intentos) |
| **La franja termina sin asistencia** | 🔴 Siempre, sea cual sea el motivo — el docente no habilitó, la materia no apareció, o el sistema no ofreció nada |
| Login / IP / red fallando | ❌ Una sola vez por error, y otro aviso al recuperarse |

El aviso de cierre sale en los últimos 10 minutos de la franja y es el que importa: si algo falló, te enterás **esa misma noche**, no cuando salgan las actas.

Un registro rechazado se reintenta hasta 3 veces y después la franja se da por perdida. Sin ese tope, una respuesta que el parser no entiende generaría un POST y un mensaje de Telegram por minuto durante horas.

## Deploy en Render

1. Crear un **Web Service** conectado al repo
2. Configurar las variables de entorno:

| Variable | Valor |
|---|---|
| `BOT_TOKEN` | Token de [@BotFather](https://t.me/BotFather) |
| `AUTO_LEGAJO` | Legajo SYSACAD |
| `AUTO_PASSWORD` | Contraseña SYSACAD |
| `AUTO_IP` | IP pública de la red UTN |
| `AUTO_CHAT_ID` | Chat de Telegram al que van los avisos |
| `ALLOWED_IDS` | (Opcional) IDs de Telegram autorizados, separados por coma |
| `BOT_URL` | (Opcional) URL pública del servicio — activa el auto-ping anti-sleep |
| `AUTO_ENABLED` | (Opcional) `false` para arrancar pausado |
| `AUTO_INTERVAL_SEC` | (Opcional) intervalo de consulta, mínimo 30, default 60 |
| `AUTO_FORZAR` | (Opcional) `true` = intentar igual si nunca habilitaron, sobre el final de la franja |

3. Render detecta el `Procfile` y ejecuta `node bot.js`

**El plan free duerme el servicio tras ~15 min sin tráfico.** Con `BOT_URL` el bot se auto-pinguea cada 10 min, pero lo confiable es un cron externo ([cron-job.org](https://cron-job.org)) que pegue a la URL cada 10 minutos, o al menos que la despierte antes de las 18:00.

El disco de Render es efímero: por eso la config del modo automático va por variables de entorno y no por `users.json`, que se pierde en cada redeploy.

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar BOT_TOKEN y las AUTO_*
npm start              # producción
npm run dev            # desarrollo con recarga automática
npm test               # regresiones del scheduler (stubbea la red, no toca UTN)
```

`npm test` cubre los casos que rompieron antes: franja que termina sin registrar, tope de reintentos, y respuestas del servidor que contienen "registrada" dentro de una negación.

## Test del flujo HTTP

Para diagnosticar problemas de IP o credenciales contra el backend de UTN:

```bash
AUTO_LEGAJO=... AUTO_PASSWORD=... node test-http.mjs
```

> Debe correrse desde la red WiFi de UTN. Detecta la IP pública automáticamente.

## Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `utn.js` | Cliente del sistema UTN: sesión HTTP, parser del HTML, login, listar, registrar |
| `auto.js` | Scheduler del modo automático: franjas, matching, estado, avisos |
| `bot.js` | Comandos de Telegram y flujo manual |
| `horarios.json` | Franjas de cursada (versionado, sin secretos) |
| `estado-auto.json` | Qué franjas ya se resolvieron hoy (git-ignored, efímero) |
| `test-auto.js` | Regresiones del scheduler con `utn.js` stubbeado |

El flujo HTTP replicado es el del frontend web:

1. **Login** — `POST /index.php` con legajo y contraseña
2. **Verificación de IP** — `POST /verificar_ip.php`. El servidor valida contra la whitelist de UTN **la IP que el cliente le manda en el body**, no la de la conexión
3. **Consulta de materias** — `GET /apply-leave.php`, parsea el `<select>`
4. **Registro** — `POST /apply-leave.php` con los datos de la materia

## Notas

- El servidor UTN usa un certificado SSL autofirmado — el bot lo ignora explícitamente
- Las materias disponibles dependen del día y horario actual según el backend
- Nunca hardcodear credenciales en archivos versionados: van a `.env` (local) o a las variables de entorno de Render
