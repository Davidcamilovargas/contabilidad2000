# Publicar la app en internet (Render)

Esto te da una URL pública (ej. `https://escaner-facturas.onrender.com`) que puedes compartir con tus socios para que prueben la app sin que tú tengas que tener el computador prendido con `npm start`.

## Requisitos

- Una cuenta de [GitHub](https://github.com) (gratis).
- Una cuenta de [Render](https://render.com) (gratis, no pide tarjeta).
- Tu clave de **Gemini** y tu `DATABASE_URL` de Supabase (las mismas de tu `.env` local).

## Paso 1: Subir el proyecto a GitHub

1. Ve a [github.com/new](https://github.com/new) y crea un repositorio nuevo (puede ser privado). Por ejemplo: `escaner-facturas`.
2. En la terminal, dentro de la carpeta del proyecto, ejecuta:

   ```bash
   git init
   git add .
   git commit -m "Primera versión del escáner de facturas"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/escaner-facturas.git
   git push -u origin main
   ```

   Reemplaza `TU-USUARIO` por tu usuario de GitHub. El archivo `.gitignore` ya incluido evita que subas `node_modules` o tu clave `.env` por accidente.

## Paso 2: Crear el servicio en Render

1. Entra a [render.com](https://render.com) y crea una cuenta (puedes usar tu cuenta de GitHub para entrar más rápido).
2. Click en **New +** → **Web Service**.
3. Conecta tu repositorio de GitHub (`escaner-facturas`).
4. Configura así:
   - **Name**: `escaner-facturas` (o el que quieras — será parte de tu URL)
   - **Region**: la más cercana a Colombia (Oregon o similar suele ser la más rápida disponible)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. En la sección **Environment Variables**, agrega:
   - Key: `GEMINI_API_KEY` → Value: tu clave real de Gemini
   - Key: `DATABASE_URL` → Value: tu cadena de conexión de Supabase
6. Click en **Create Web Service**.

> **Si ya tenías el servicio creado en Render** (de una versión anterior):
> ve a tu servicio → **Settings → Environment Variables**, borra las que ya
> no apliquen (como `ANTHROPIC_API_KEY`) y agrega `GEMINI_API_KEY` y
> `DATABASE_URL` como se indica arriba.

## Paso 3: Esperar el despliegue

Render va a instalar dependencias y arrancar tu app automáticamente (toma 1-3 minutos). Cuando termine, verás una URL pública arriba, algo como:

```
https://escaner-facturas.onrender.com
```

Esa es la URL que puedes compartir con tus socios.

## Notas importantes

- **Plan gratis = "se duerme"**: si nadie usa la app por 15 minutos, Render la apaga para ahorrar recursos. La primera visita después de eso tarda 30-60 segundos en cargar (luego va rápido normal). Es totalmente normal, no es un error.
- **Actualizar la app**: cada vez que hagas cambios, sube el código de nuevo con `git add . && git commit -m "cambios" && git push`, y Render la actualiza sola automáticamente.
- **Tu clave de API sigue segura**: nunca queda expuesta en el navegador ni en GitHub, solo vive dentro de la configuración privada de Render.
