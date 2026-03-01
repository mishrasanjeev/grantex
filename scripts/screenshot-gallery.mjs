#!/usr/bin/env node

/**
 * Captures 6 Product Hunt gallery slides from web/ph-gallery.html
 * as individual 1270×760 PNGs into web/ph-gallery/.
 *
 * Usage: npx playwright install chromium && node scripts/screenshot-gallery.mjs
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { mkdir } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SLIDES = [
  { index: 1, name: 'slide-1-hero' },
  { index: 2, name: 'slide-2-problem' },
  { index: 3, name: 'slide-3-how-it-works' },
  { index: 4, name: 'slide-4-code-quickstart' },
  { index: 5, name: 'slide-5-integrations' },
  { index: 6, name: 'slide-6-open-source' },
];

const WIDTH = 1270;
const HEIGHT = 760;

async function main() {
  const outDir = join(ROOT, 'web', 'ph-gallery');
  await mkdir(outDir, { recursive: true });

  const galleryPath = join(ROOT, 'web', 'ph-gallery.html');
  const fileUrl = `file://${galleryPath.replace(/\\/g, '/')}`;

  console.log(`Opening ${fileUrl}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH + 200, height: HEIGHT + 200 },
  });

  await page.goto(fileUrl, { waitUntil: 'networkidle' });

  // Wait for fonts to load
  await page.waitForTimeout(2000);

  const wrappers = await page.locator('.slide-wrapper').all();

  if (wrappers.length !== 6) {
    console.error(`Expected 6 slides, found ${wrappers.length}`);
    await browser.close();
    process.exit(1);
  }

  for (const slide of SLIDES) {
    const wrapper = wrappers[slide.index - 1];
    const slideEl = wrapper.locator('.slide');

    const outPath = join(outDir, `${slide.name}.png`);

    await slideEl.screenshot({
      path: outPath,
      type: 'png',
    });

    console.log(`✓ ${slide.name}.png (${WIDTH}×${HEIGHT})`);
  }

  await browser.close();
  console.log(`\nDone — ${SLIDES.length} screenshots saved to web/ph-gallery/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
