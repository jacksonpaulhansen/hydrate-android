import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import QRCode from 'qrcode';

const projectRoot = process.cwd();
const configPath = path.join(projectRoot, 'app.config.json');
const outPngPath = path.join(projectRoot, 'publish-qr.png');
const outHtmlPath = path.join(projectRoot, 'publish-qr.html');

let publishUrl = process.argv[2]?.trim();

if (!publishUrl) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing app config: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  publishUrl = String(config.publishUrl ?? '').trim();
}

if (!publishUrl) {
  throw new Error('publishUrl is empty. Set app.config.json -> publishUrl.');
}

await QRCode.toFile(outPngPath, publishUrl, {
  margin: 2,
  width: 460,
});

const safeUrl = publishUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Publish QR</title>
    <style>
      body { font-family: Consolas, monospace; background: #111; color: #eee; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { text-align: center; border: 1px solid #333; background: #171717; padding: 18px; border-radius: 10px; }
      img { width: 300px; max-width: 80vw; background: #fff; padding: 8px; border-radius: 6px; }
      code { color: #b8ffb8; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h2>Scan QR In Even App</h2>
      <img src="./publish-qr.png" alt="Publish QR" />
      <p><code>${safeUrl}</code></p>
    </main>
  </body>
</html>`;

fs.writeFileSync(outHtmlPath, html, 'utf8');
console.log(`QR written: ${outPngPath}`);
console.log(`Viewer: ${outHtmlPath}`);
