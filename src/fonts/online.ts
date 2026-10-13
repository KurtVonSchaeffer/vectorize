import type { OnlineFont } from '../../supabase/functions/identify-font/whatfontis'
import type { FontReport, TextLine } from './identify'
import { inkMask } from './match'

export type { OnlineFont }

/**
 * Online font identification (WhatFontIs, ~1M commercial and free fonts) through the app's own
 * server endpoint, which holds the API key. Set VITE_FONT_API_URL to the deployed edge function;
 * otherwise the dev/preview server's /api/identify-font is used.
 */
const ENDPOINT = import.meta.env.VITE_FONT_API_URL || '/api/identify-font'

let available: Promise<boolean> | null = null

/** Whether the server has a key, so the option is only offered when it will work. */
export function onlineAvailable(): Promise<boolean> {
  available ??= fetch(ENDPOINT)
    .then(async (r) => r.ok && (await r.json()).configured === true)
    .catch(() => false)
  return available
}

export async function identifyOnline(report: FontReport, line: TextLine): Promise<OnlineFont[]> {
  const image = await blobToBase64(await lineImage(report, line))
  let res: Response
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, limit: 10 }) })
  } catch {
    throw new Error('Could not reach the font search. Check your internet connection.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `The font search failed (${res.status}).`)
  return Array.isArray(data.fonts) ? data.fonts : []
}

/** Longest side of the image sent; plenty for font recognition, small to upload. */
const MAX_SIDE = 1200

/**
 * Just the lettering of one line, as black text on white. Colors, the background and the rest
 * of the artwork are left out: only the letter shapes leave the computer.
 */
export async function lineImage(report: FontReport, line: TextLine): Promise<Blob> {
  const { canvas } = report
  const pad = Math.round((line.box.y1 - line.box.y0) * 0.15)
  const box = {
    x0: Math.max(0, Math.floor(line.box.x0 - pad)),
    y0: Math.max(0, Math.floor(line.box.y0 - pad)),
    x1: Math.min(canvas.width, Math.ceil(line.box.x1 + pad)),
    y1: Math.min(canvas.height, Math.ceil(line.box.y1 + pad)),
  }
  const img = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
  const W = box.x1 - box.x0
  const H = box.y1 - box.y0
  const ink = inkMask(img, box)
  const out = new ImageData(W, H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      let v: number
      if (ink) v = Math.round(255 * (1 - ink[y * W + x]))
      else {
        // Too little contrast to separate: fall back to grayscale.
        const i = ((box.y0 + y) * img.width + box.x0 + x) * 4
        v = Math.round(img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114)
      }
      out.data[o] = out.data[o + 1] = out.data[o + 2] = v
      out.data[o + 3] = 255
    }
  const crop = new OffscreenCanvas(W, H)
  crop.getContext('2d')!.putImageData(out, 0, 0)
  const s = Math.min(1, MAX_SIDE / Math.max(W, H))
  if (s === 1) return crop.convertToBlob({ type: 'image/png' })
  const small = new OffscreenCanvas(Math.round(W * s), Math.round(H * s))
  const ctx = small.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(crop, 0, 0, small.width, small.height)
  return small.convertToBlob({ type: 'image/png' })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
