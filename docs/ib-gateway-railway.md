# IB Gateway en Railway

El servidor habla con Interactive Brokers a través de un IB Gateway con la sesión iniciada
(`server/ib.js`). En producción ese Gateway es un segundo servicio del mismo proyecto de Railway,
con la imagen `ghcr.io/gnzsnz/ib-gateway`, que entra solo en IB con IBC y se reinicia cada noche.
Solo la cuenta **paper**: no pide el segundo factor y puede quedarse sin nadie delante.

## 1. El servicio del Gateway

En el proyecto de Railway: **New → Docker Image** → `ghcr.io/gnzsnz/ib-gateway:stable`.
Llamarlo `ib-gateway`. Sin dominio público (no hace falta y no debe tenerlo).

Variables del servicio `ib-gateway`:

| Variable | Valor |
|---|---|
| `TWS_USERID` | el usuario de la cuenta paper |
| `TWS_PASSWORD` | su contraseña |
| `TRADING_MODE` | `paper` |
| `READ_ONLY_API` | `no` |
| `TIME_ZONE` | `Europe/Madrid` |
| `AUTO_RESTART_TIME` | `11:45 PM` |
| `TWOFA_TIMEOUT_ACTION` | `restart` |
| `RELOGIN_AFTER_TWOFA_TIMEOUT` | `yes` |
| `EXISTING_SESSION_DETECTED_ACTION` | `primary` |
| `JAVA_HEAP_SIZE` | `768` |

IB solo deja una sesión por usuario: si se entra con el mismo usuario en otro sitio (la TWS o el
Gateway de casa, la app del móvil), echa al de Railway, que vuelve a entrar más tarde. Para no
pisarse, crear en el portal de IB un segundo usuario para la misma cuenta paper y usar ese aquí.

## 2. El servidor

Variables del servicio `Situational-Analysis`:

| Variable | Valor |
|---|---|
| `IB_HOST` | `${{ib-gateway.RAILWAY_PRIVATE_DOMAIN}}` |
| `IB_PORT` | `4004` (el puerto paper de la imagen; el 4002 de dentro solo escucha en local) |

Railway deja los cambios de variables pendientes hasta pulsar **Deploy**.

## 3. Comprobarlo

Bots → Interactive Brokers en la web de producción (con la clave del bot), o
`GET /api/bot/ib` con la cabecera `X-Bot-Token`: tiene que salir `conectado: true` y la cuenta
`DU…`. El Gateway tarda uno o dos minutos en entrar después de arrancar.

Si sale «No hay IB Gateway escuchando», mirar los registros del servicio `ib-gateway`: el inicio
de sesión de IBC (usuario o contraseña mal, sesión abierta en otro sitio) aparece ahí.
