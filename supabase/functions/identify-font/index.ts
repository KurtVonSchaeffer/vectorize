// Supabase edge function: proxies font identification to WhatFontIs, keeping the API key secret.
//   supabase secrets set WHATFONTIS_API_KEY=... ALLOWED_ORIGINS=https://your-app.example
//   supabase functions deploy identify-font --no-verify-jwt
import { handle } from './whatfontis.ts'

Deno.serve((req) =>
  handle(req, {
    apiKey: Deno.env.get('WHATFONTIS_API_KEY'),
    allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }),
)
