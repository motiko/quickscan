#!/usr/bin/env node
/*
 * Renders every app icon and splash image from the masters in assets/ (icon.svg,
 * icon-foreground.svg, icon-monochrome.svg) with Playwright's Chromium, so web, iOS and
 * Android always show the same mark. Run after changing a master: `npm run icons`.
 *
 * - Web: src/app/icon.png (favicon link), src/app/apple-icon.png, src/app/favicon.ico,
 *   public/icons/icon-192.png / icon-512.png (manifest, also maskable: the mark sits inside the
 *   safe zone).
 * - iOS: the 1024 px App Store icon and the launch image, both without an alpha channel
 *   (App Store Connect refuses icons with one): rendered as JPEG, converted back with `sips`.
 * - Android: legacy launcher icons (square and round) per density, the adaptive icon's
 *   foreground and monochrome layers at the inset layer's size (72 dp, see ic_launcher.xml),
 *   and the pre-Android-12 splash images at the sizes already in res/.
 * - assets/: PNG copies for `@capacitor/assets`, should anyone run it again.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const ICON = read('assets/icon.svg');
const FOREGROUND = read('assets/icon-foreground.svg');
const MONOCHROME = read('assets/icon-monochrome.svg');
const BACKGROUND = ICON.replace(/<g[\s\S]*<\/svg>/, '</svg>').replace(/<path[\s\S]*?\/>/g, '');

// The adaptive icon's foreground is drawn inset by 16.7% on each side (ic_launcher.xml), so
// its PNG holds only the middle two thirds of the 1024 master
const INSET_VIEWBOX = '170.67 170.67 682.67 682.67';
const LIGHT_SPLASH = '#ffffff';
const DARK_SPLASH = '#0a0a0a';

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const tmp = mkdtempSync(join(tmpdir(), 'quickscan-icons-'));

/**
 * One image of `width` × `height`: `svg` drawn `size` px wide, centred, in a box with
 * `radius` (CSS) on `background` (null: transparent).
 */
async function render({ svg, width, height = width, size = Math.min(width, height), radius = '0', background = null, viewBox, format = 'png' }) {
  const drawn = viewBox ? svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`) : svg;
  const sized = drawn.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `);
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<html><body style="margin:0;width:${width}px;height:${height}px;display:grid;place-items:center;background:${background ?? 'transparent'}">` +
      `<div style="width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden">${sized}</div></body></html>`
  );
  return page.screenshot({ type: format, quality: format === 'jpeg' ? 100 : undefined, omitBackground: background === null });
}

/** A PNG without an alpha channel (the App Store refuses icons with one). */
function opaquePng(jpeg, out) {
  const src = join(tmp, 'opaque.jpg');
  writeFileSync(src, jpeg);
  execFileSync('sips', ['-s', 'format', 'png', src, '--out', join(root, out)], { stdio: 'ignore' });
}

const write = (out, data) => writeFileSync(join(root, out), data);

/** An .ico holding PNG images (Vista+ format, which every current browser reads). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

// --- Web ---------------------------------------------------------------------------------
write('src/app/icon.png', await render({ svg: ICON, width: 192 }));
write('src/app/apple-icon.png', await render({ svg: ICON, width: 180 }));
write('public/icons/icon-192.png', await render({ svg: ICON, width: 192 }));
write('public/icons/icon-512.png', await render({ svg: ICON, width: 512 }));
// One page renders one image at a time: render() sets its viewport and content
const favicons = [];
for (const size of [16, 32, 48]) favicons.push({ size, data: await render({ svg: ICON, width: size, radius: '18%' }) });
write('src/app/favicon.ico', ico(favicons));

// --- iOS ---------------------------------------------------------------------------------
opaquePng(await render({ svg: ICON, width: 1024, format: 'jpeg' }), 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
const iosSplash = await render({ svg: ICON, width: 2732, size: 520, radius: '22.5%', background: LIGHT_SPLASH, format: 'jpeg' });
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  opaquePng(iosSplash, `ios/App/App/Assets.xcassets/Splash.imageset/${name}`);
}

// --- Android -----------------------------------------------------------------------------
const res = 'android/app/src/main/res';
const densities = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(densities)) {
  const dir = `${res}/mipmap-${density}`;
  const legacy = Math.round(48 * scale);
  const layer = Math.round(72 * scale);
  write(`${dir}/ic_launcher.png`, await render({ svg: ICON, width: legacy, radius: '18%' }));
  write(`${dir}/ic_launcher_round.png`, await render({ svg: ICON, width: legacy, radius: '50%' }));
  write(`${dir}/ic_launcher_foreground.png`, await render({ svg: FOREGROUND, width: layer, viewBox: INSET_VIEWBOX }));
  write(`${dir}/ic_launcher_monochrome.png`, await render({ svg: MONOCHROME, width: layer, viewBox: INSET_VIEWBOX }));
}
// Splash images before Android 12 (12+ draws the adaptive icon itself): same sizes as before
for (const dir of readdirSync(join(root, res)).filter((d) => d.startsWith('drawable'))) {
  const file = `${res}/${dir}/splash.png`;
  let buf;
  try {
    buf = readFileSync(join(root, file));
  } catch {
    continue;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const background = dir.includes('night') ? DARK_SPLASH : LIGHT_SPLASH;
  write(file, await render({ svg: ICON, width, height, size: Math.round(Math.min(width, height) * 0.3), radius: '22.5%', background }));
}

// --- Sources for @capacitor/assets ----------------------------------------------------------
write('assets/icon-only.png', await render({ svg: ICON, width: 1024 }));
write('assets/icon-foreground.png', await render({ svg: FOREGROUND, width: 1024 }));
write('assets/icon-background.png', await render({ svg: BACKGROUND, width: 1024 }));
write('assets/splash.png', await render({ svg: ICON, width: 2732, size: 520, radius: '22.5%', background: LIGHT_SPLASH }));
write('assets/splash-dark.png', await render({ svg: ICON, width: 2732, size: 520, radius: '22.5%', background: DARK_SPLASH }));

await browser.close();
console.log('Rendered the app icons and splash images from assets/*.svg');
