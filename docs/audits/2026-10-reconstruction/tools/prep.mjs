// Builds the audit test set: real artwork from GitHub (see manifest), rendered from its SVG master
// where one exists (upload + a 2x "truth" render to score against), and degraded copies (small,
// JPEG-compressed) of real uploads. Writes in/, truth/ and manifest.json.
import { chromium } from 'playwright-core'
import fs from 'fs'
import { execFileSync } from 'child_process'

const A = process.argv[2]
const raw = (f) => fs.readFileSync(`${A}/raw/${f}`, 'utf8')
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await b.newPage()
async function render(svg, w, h, out, bg) {
  await page.setViewportSize({ width: w, height: h })
  const s = svg.replace(/<svg\b/, `<svg width="${w}" height="${h}" preserveAspectRatio="none"`).replace(/\swidth="24"\s+height="24"/, '')
  await page.setContent(`<html><body style="margin:0;background:${bg ?? 'transparent'}">${s}</body></html>`)
  await page.screenshot({ path: out, omitBackground: !bg, clip: { x: 0, y: 0, width: w, height: h } })
}
const im = (...args) => execFileSync('convert', args)

const M = []
const add = (o) => M.push(o)
const GH = 'https://raw.githubusercontent.com'

// 1) Real uploads as found: project logos (PNG, 288 px, most with transparency). No master: scored against the upload itself.
const explore = {
  android: ['flat', 'simple flat-colour logo, transparent'],
  javascript: ['flat', 'flat logo with lettering, opaque square'],
  vue: ['flat', 'overlapping flat shapes'],
  kubernetes: ['negative-space', 'negative space (wheel), transparent'],
  rust: ['negative-space', 'gear with lettering, fine detail, one colour artwork'],
  react: ['fine-lines', 'thin overlapping ellipses'],
  docker: ['lettering', 'wordmark + illustration'],
  go: ['lettering', 'italic wordmark + fine speed lines'],
  python: ['gradient', 'two-colour logo with soft gradients, transparent'],
  angular: ['gradient', 'gradient logo with lettering'],
  firefox: ['complex', 'complex multicolour gradients'],
  ruby: ['gradient', 'faceted gem with gradients'],
  linux: ['illustration', 'detailed illustration with shading (Tux)'],
}
for (const [t, [cat, what]] of Object.entries(explore)) {
  fs.copyFileSync(`${A}/raw/explore-${t}.png`, `${A}/in/${t}.png`)
  add({ id: t, file: `${t}.png`, cat, what, kind: 'real upload', source: `${GH}/github/explore/main/topics/${t}/${t}.png`, truth: `in/${t}.png`, truthScale: 1 })
}
fs.copyFileSync(`${A}/raw/fluent-rocket-3d.png`, `${A}/in/rocket-3d.png`)
add({ id: 'rocket-3d', file: 'rocket-3d.png', cat: 'photo-like', what: '3D-rendered illustration (photographic shading): control case', kind: 'real upload', source: `${GH}/microsoft/fluentui-emoji/main/assets/Rocket/3D/rocket_3d.png`, truth: 'in/rocket-3d.png', truthScale: 1 })

// 2) Real vector masters rendered to an upload, with a 2x truth render.
const masters = [
  ['flag-br', 'flag-br.svg', 600, 450, '#fff', 'lettering', 'Brazil flag: small lettering on a curved band', 'lipis/flag-icons/main/flags/4x3/br.svg'],
  ['flag-mx', 'flag-mx.svg', 600, 450, '#fff', 'illustration', 'Mexico flag: detailed emblem (eagle, snake, wreath)', 'lipis/flag-icons/main/flags/4x3/mx.svg'],
  ['flag-sv', 'flag-sv.svg', 600, 450, '#fff', 'lettering', 'El Salvador flag: emblem with tiny lettering', 'lipis/flag-icons/main/flags/4x3/sv.svg'],
  ['fluent-rocket', 'fluent-rocket-color.svg', 512, 512, null, 'gradient', 'Fluent emoji (Color): vector gradients, transparent', 'microsoft/fluentui-emoji/main/assets/Rocket/Color/rocket_color.svg'],
  ['fluent-parrot', 'fluent-parrot-flat.svg', 512, 512, null, 'complex', 'Fluent emoji (Flat): flat multicolour illustration, transparent', 'microsoft/fluentui-emoji/main/assets/Parrot/Flat/parrot_flat.svg'],
  ['github-mark', 'si-github.svg', 400, 400, null, 'one-colour', 'GitHub mark: one colour with negative space, transparent', 'simple-icons/simple-icons/develop/icons/github.svg', (s) => s.replace('<path ', '<path fill="#181717" ')],
  ['world-thin', 'tabler-world.svg', 400, 400, '#fff', 'fine-lines', 'Line icon at a hairline stroke (0.35 of 24 units, ~6 px)', 'tabler/tabler-icons/main/icons/outline/world.svg', (s) => s.replace(/stroke="currentColor"/, 'stroke="#000"').replace(/stroke-width="2"/, 'stroke-width="0.35"')],
]
for (const [id, f, w, h, bg, cat, what, src, edit] of masters) {
  const svg = (edit ?? ((s) => s))(raw(f))
  await render(svg, w, h, `${A}/in/${id}.png`, bg)
  await render(svg, w * 2, h * 2, `${A}/truth/${id}.png`, bg)
  fs.writeFileSync(`${A}/truth/${id}.svg`, svg)
  add({ id, file: `${id}.png`, cat, what, kind: edit ? 'master, rendered (derived: ' + (id === 'world-thin' ? 'stroke thinned' : 'colour set') + ')' : 'master, rendered', source: `${GH}/${src}`, truth: `truth/${id}.png`, truthScale: 2 })
}

// 3) Degraded copies, as customers send them: small and JPEG-compressed. Scored against the clean original.
im(`${A}/raw/explore-python.png`, '-background', 'white', '-flatten', '-resize', '96x96', '-quality', '45', `${A}/in/python-tiny.jpg`)
add({ id: 'python-tiny', file: 'python-tiny.jpg', cat: 'low-res-jpeg', what: 'Python logo at 96 px, JPEG quality 45', kind: 'derived from real upload', source: 'explore python.png', truth: 'in/python.png', truthScale: 3, truthBg: '#fff' })
im(`${A}/raw/explore-docker.png`, '-background', 'white', '-flatten', '-resize', '160x160', '-quality', '60', `${A}/in/docker-small.jpg`)
add({ id: 'docker-small', file: 'docker-small.jpg', cat: 'low-res-jpeg', what: 'Docker logo at 160 px, JPEG quality 60 (small lettering)', kind: 'derived from real upload', source: 'explore docker.png', truth: 'in/docker.png', truthScale: 1.8, truthBg: '#fff' })
im(`${A}/in/flag-br.png`, '-resize', '240x180', '-quality', '55', `${A}/in/flag-br-web.jpg`)
add({ id: 'flag-br-web', file: 'flag-br-web.jpg', cat: 'low-res-jpeg', what: 'Brazil flag at 240 px, JPEG quality 55', kind: 'derived from master', source: 'flag-br master', truth: 'truth/flag-br.png', truthScale: 5 })

fs.writeFileSync(`${A}/manifest.json`, JSON.stringify(M, null, 1))
console.log(M.length, 'images')
await b.close()
