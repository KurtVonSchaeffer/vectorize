import { describe, expect, it } from 'vitest'
import { handle, identifyFont } from '../../supabase/functions/identify-font/whatfontis'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** A fake WhatFontIs: records the request and answers with `reply`. */
function fakeApi(reply: () => Response) {
  const calls: { url: string; body: URLSearchParams | null }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body instanceof URLSearchParams ? init.body : null })
    if (u.includes('sample')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })
    return reply()
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('online font identification', () => {
  it('sends the crop as base64 and normalizes the fonts', async () => {
    const { calls, fetchImpl } = fakeApi(() =>
      Response.json([
        { title: 'Helvetica Neue Black', url: 'https://www.whatfontis.com/x.font', image: 'https://cdn.example/sample1.png', type: 'Commercial', site: 'myfonts.com' },
        { title: 'Archivo Black', url: 'https://www.whatfontis.com/y.font', type: 'Free' },
        { title: "Jenna\\\\\\'s Feet", type: 'Free' },
        { nope: true },
      ]),
    )
    const res = await identifyFont('KEY', `data:image/png;base64,${PNG}`, 5, fetchImpl)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.fonts.map((f) => [f.name, f.type])).toEqual([
      ['Helvetica Neue Black', 'commercial'],
      ['Archivo Black', 'free'],
      ["Jenna's Feet", 'free'],
    ])
    expect(res.fonts[0].sample).toMatch(/^data:image\/png;base64,/)
    expect(res.fonts[1].sample).toBeNull()
    const body = calls[0].body!
    expect(body.get('API_KEY')).toBe('KEY')
    expect(body.get('IMAGEBASE64')).toBe('1')
    expect(body.get('urlimagebase64')).toBe(PNG)
    expect(body.get('limit')).toBe('5')
  })

  it('turns API error codes into plain messages', async () => {
    for (const [reply, status] of [
      [() => new Response('429', { status: 429 }), 429],
      [() => Response.json({ error: 4223 }), 422],
      [() => new Response('420'), 503],
      [() => new Response('<html>oops</html>', { status: 500 }), 502],
    ] as [() => Response, number][]) {
      const res = await identifyFont('KEY', PNG, 5, fakeApi(reply).fetchImpl)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.status).toBe(status)
    }
  })

  it('rejects input that is not base64 without calling the API', async () => {
    const { calls, fetchImpl } = fakeApi(() => Response.json([]))
    const res = await identifyFont('KEY', 'not base64!', 5, fetchImpl)
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports whether it is configured and guards the key', async () => {
    const get = (key: string | undefined, origin?: string) =>
      handle(new Request('http://app.test/api/identify-font', { headers: origin ? { origin } : {} }), { apiKey: key, allowedOrigins: ['https://allowed.test'] })
    expect(await (await get(undefined)).json()).toEqual({ configured: false })
    expect(await (await get('KEY')).json()).toEqual({ configured: true })
    expect((await get('KEY', 'https://allowed.test')).headers.get('access-control-allow-origin')).toBe('https://allowed.test')
    expect((await get('KEY', 'https://evil.test')).status).toBe(403)
    const post = await handle(new Request('http://app.test/api/identify-font', { method: 'POST', body: JSON.stringify({ image: PNG }) }), { apiKey: undefined, allowedOrigins: [] })
    expect(post.status).toBe(503)
    // The key never appears in a response.
    expect(JSON.stringify(await (await get('SECRET')).json())).not.toContain('SECRET')
  })
})
