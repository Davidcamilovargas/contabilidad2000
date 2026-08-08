# Escáner de Facturas

App para escanear facturas (foto, imagen o PDF) y extraer automáticamente los datos contables usando IA.

## Requisitos

- [Node.js](https://nodejs.org/) versión 18 o superior instalado en tu computador.
- Una clave de API de Anthropic. Consíguela gratis en: https://console.anthropic.com/settings/keys
  (necesitas crear una cuenta en la Consola de Anthropic, distinta de tu cuenta de Claude.ai, y cargar algo de crédito para poder usar la API).

## Instalación (solo la primera vez)

1. Abre esta carpeta en Visual Studio Code.
2. Abre una terminal dentro de VS Code (`Terminal` → `Nueva terminal`).
3. Instala las dependencias:

   ```bash
   npm install
   ```

4. Copia el archivo `.env.example` y renómbralo a `.env`.
5. Abre `.env` y reemplaza `sk-ant-tu-clave-aqui` con tu clave de API real:

   ```
   ANTHROPIC_API_KEY=sk-ant-tu-clave-real-aqui
   ```

   **Importante:** nunca compartas tu archivo `.env` ni lo subas a GitHub — contiene tu clave privada.

## Cómo correr la app

En la terminal, dentro de la carpeta del proyecto:

```bash
npm start
```

Verás un mensaje como:

```
✔ Escáner de Facturas corriendo en http://localhost:3000
```

Abre esa dirección (`http://localhost:3000`) en tu navegador (Chrome, Edge, etc.) y ya puedes usar la app.

## Cómo funciona

- El navegador (frontend) le manda la imagen o PDF a **tu propio servidor** (`server.js`), corriendo en tu computador.
- El servidor es el único que conoce tu clave de API, y es quien llama a Anthropic para leer la factura.
- Esto evita exponer tu clave en el navegador, donde cualquiera podría verla y usarla.

## Estructura del proyecto

```
escaner-facturas-app/
├── server.js          → servidor Node.js (backend)
├── package.json        → dependencias del proyecto
├── .env.example         → plantilla de configuración (copiar a .env)
├── .env                 → tu clave real (créala tú, no se sube a ningún lado)
└── public/
    └── index.html        → interfaz de la app (frontend)
```

## Próximos pasos posibles

- Guardar las facturas leídas en una base de datos o archivo, en vez de solo mostrarlas.
- Agregar gestión de varios clientes/NITs.
- Exportar todo a Excel.
- Desplegar la app en internet (ej. Render, Railway) para no depender de tu computador.
# contabilidad2000
