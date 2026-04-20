# UTN FRSFCO — Bot de Asistencias

Bot de Telegram para registrar asistencias automáticamente en el [sistema web de UTN FRSFCO](https://asistencia.frsfco.utn.edu.ar:4443), sin depender del frontend.

## Requisitos

- Estar conectado a la **red WiFi de UTN FRSFCO** al momento de registrar
- Tener una cuenta de Telegram

## Uso

1. Buscá `@UtnAsistBot` en Telegram
2. Enviá `/registrar`
3. Si es la primera vez, ingresá tu legajo y contraseña SYSACAD
4. Seleccioná la materia de la lista
5. Listo — la asistencia queda registrada

### Comandos disponibles

| Comando | Descripción |
|---|---|
| `/registrar` | Marca asistencia para el día de hoy |
| `/olvida` | Borra las credenciales guardadas |
| `/guardar_ip` | Registra tu IP desde la red UTN *(requiere deploy con `BOT_URL`)* |

## Deploy en Render

1. Hacer fork del repositorio
2. Crear un nuevo **Web Service** en [Render](https://render.com) conectado al repo
3. Configurar las variables de entorno:

| Variable | Valor |
|---|---|
| `BOT_TOKEN` | Token de [@BotFather](https://t.me/BotFather) |
| `ALLOWED_IDS` | (Opcional) IDs de Telegram autorizados, separados por coma |
| `BOT_URL` | (Opcional) URL pública del servicio en Render |

4. Render detecta el `Procfile` automáticamente y ejecuta `node bot.js`

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar BOT_TOKEN
npm start              # producción
npm run dev            # desarrollo con recarga automática
```

## Test del flujo HTTP

Para verificar que el backend de UTN responde correctamente (útil para diagnosticar problemas de IP o credenciales):

```bash
node test-http.mjs
```

> Debe correrse desde la red WiFi de UTN. Detecta la IP pública automáticamente.

## Cómo funciona

El bot replica el flujo HTTP del frontend web:

1. **Login** — `POST /index.php` con legajo y contraseña
2. **Verificación de IP** — `POST /verificar_ip.php` con la IP pública (obtenida de `api.ipify.org`). El servidor valida que la IP esté en la whitelist de la red UTN
3. **Consulta de materias** — `GET /apply-leave.php`, parsea el `<select>` del HTML
4. **Registro** — `POST /apply-leave.php` con los datos de la materia seleccionada

Las credenciales se guardan por usuario en `users.json` (excluido del repo). Las sesiones HTTP se mantienen en memoria durante el flujo y se descartan al finalizar.

## Notas

- El servidor UTN usa un certificado SSL autofirmado — el bot lo ignora explícitamente
- La validación de IP es por IP pública: solo funciona desde la red de UTN FRSFCO
- Las materias disponibles dependen del día y horario actual según el backend
