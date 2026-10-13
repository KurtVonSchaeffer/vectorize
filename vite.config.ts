import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { handle } from './supabase/functions/identify-font/whatfontis.ts'

// Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web needs for
// multi-threaded WASM (several times faster AI). Production hosting must send these too.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Serves /api/identify-font from the dev and preview servers, with the WhatFontIs key from
 * .env.local (server-side; it is never bundled into the app). Production uses the same code as
 * a Supabase edge function (supabase/functions/identify-font).
 */
function fontApi(): Plugin {
  let apiKey: string | undefined
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/identify-font')) return next()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    for await (const chunk of req) chunks.push(chunk as Uint8Array<ArrayBuffer>)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Blob(chunks),
    })
    const response = await handle(request, { apiKey, allowedOrigins: [] })
    res.statusCode = response.status
    response.headers.forEach((v, k) => res.setHeader(k, v))
    res.end(Buffer.from(await response.arrayBuffer()))
  }
  return {
    name: 'font-api',
    configResolved(config) {
      apiKey = loadEnv(config.mode, config.root, '').WHATFONTIS_API_KEY || undefined
    },
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fontApi()],
  worker: { format: 'es' },
  // transformers.js ships its own onnxruntime-web WASM loader; pre-bundling breaks it.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  server: { headers: isolation },
  preview: { headers: isolation },
})
