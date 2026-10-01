# Kárdex IA

Aplicación para escanear facturas (foto, imagen o PDF), extraer automáticamente
los datos contables con IA, y guardarlas organizadas por mes en una base de
datos real.

**No reemplaza tu software contable** (Siigo, Alegra, Excel) — es la capa de
captura previa: convierte el desorden de fotos/PDFs sueltos que mandan los
clientes en datos organizados, listos para llevar a donde ya trabajas.

## Requisitos

- [Node.js](https://nodejs.org/) versión 18 o superior.
- Una clave gratuita de **Google Gemini**: https://aistudio.google.com/apikey
- Una base de datos PostgreSQL gratis en **Supabase**: https://supabase.com
  (gratis, sin tarjeta, sin fecha de expiración — a diferencia del Postgres
  gratis de Render, que se borra a los 30 días).

## Instalación (solo la primera vez)

1. Abre esta carpeta en Visual Studio Code.
2. Terminal → Nueva terminal, luego:

   ```bash
   npm install
   ```

3. Copia `.env.example` a `.env`.
4. Completa `.env` con tus valores reales:

   ```
   GEMINI_API_KEY=tu-clave-real-de-gemini
   DATABASE_URL=tu-cadena-de-conexión-de-supabase
   PORT=3000
   ```

   Para `DATABASE_URL`: en Supabase, ve a **Project Settings → Database →
   Connection string**, elige el modo **"Transaction pooler"**, y copia esa
   cadena completa (reemplazando la contraseña por la real).

   **Nunca compartas tu `.env` ni lo subas a GitHub** — el `.gitignore` ya lo
   protege, pero verifícalo si tienes dudas.

## Cómo correr la app

```bash
npm start
```

Debe mostrar:

```
✔ Kárdex IA corriendo en http://localhost:3000
✔ Base de datos conectada y lista
```

Abre `http://localhost:3000`.

## Qué puedes hacer

- **Escanear**: tomar foto o subir imagen/PDF de una factura, la IA lee los
  datos, los revisas/corriges, y los guardas.
- **Facturas**: ver todo lo guardado, filtrado por mes, con el total sumado.

## Cómo funciona por dentro

- El navegador le habla a **tu propio servidor** (`server.js`), nunca
  directo a Google — así tu clave de API nunca queda expuesta.
- El servidor guarda las facturas en **PostgreSQL** (vía Supabase), no en un
  archivo — así los datos sobreviven a reinicios y redespliegues.

## Estructura del proyecto

```
kardex-ia/
├── server.js            → backend: lee facturas con IA + guarda en Postgres
├── package.json
├── .env.example          → plantilla (copiar a .env)
├── .gitignore
└── public/
    ├── index.html          → página Escanear
    ├── facturas.html        → página Facturas (listado por mes)
    └── styles.css            → estilos compartidos entre ambas páginas
```

## Desplegar en internet

Ver `DEPLOY.md` para el paso a paso completo con Render.

## Próximos pasos posibles

- Gestión de varios clientes/NITs bajo una sola cuenta.
- Exportar a Excel/CSV.
- Login (una cuenta por contador).
