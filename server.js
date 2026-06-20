const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const jimp = require('jimp');
const { Resvg } = require('@resvg/resvg-js');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || 'imagefree-jwt-secret';
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAX_FILE_SIZE = 20 * 1024 * 1024;

[DATA_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => { console.log(`[${req.method}] ${req.url}`); next(); });

// ─── Security headers ───
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=*, display-capture=*, clipboard-read=*, clipboard-write=*');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' data: blob:; frame-src 'none'; object-src 'none'");
  next();
});

// ─── HTTPS redirect (production only) ───
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// ─── WWW → non-WWW redirect ───
app.use((req, res, next) => {
  const host = req.headers.host;
  if (host && host.startsWith('www.')) {
    return res.redirect(301, req.protocol + '://' + host.slice(4) + req.originalUrl);
  }
  next();
});

// ─── Trailing slash removal (keep root / as-is) ───
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const qs = req.originalUrl.slice(req.path.length);
    return res.redirect(301, req.path.slice(0, -1) + qs);
  }
  next();
});

const storage = multer.diskStorage({
  destination: OUTPUT_DIR,
  filename: (r, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (r, f, cb) => {
    if (/\.(jpg|jpeg|png|webp|gif|bmp|tiff?)$/i.test(path.extname(f.originalname))) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

function auth(r, res, next) {
  const h = r.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ e: 'Unauthorized' });
  try { r.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ e: 'Invalid token' }); }
}

// ─── Auth ───
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ e: 'Email and password required' });
    const users = loadUsers();
    if (users[email]) return res.status(409).json({ e: 'User already exists' });
    users[email] = { email, name: name || email.split('@')[0], password: await bcrypt.hash(password, 10), created: Date.now() };
    saveUsers(users);
    res.json({ token: jwt.sign({ email, name: users[email].name }, JWT_SECRET, { expiresIn: '7d' }), user: { email, name: users[email].name } });
  } catch (e) { res.status(500).json({ e: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = loadUsers();
    const u = users[email];
    if (!u || !(await bcrypt.compare(password, u.password))) return res.status(401).json({ e: 'Invalid credentials' });
    res.json({ token: jwt.sign({ email, name: u.name }, JWT_SECRET, { expiresIn: '7d' }), user: { email, name: u.name } });
  } catch (e) { res.status(500).json({ e: e.message }); }
});

app.get('/api/auth/me', auth, (r, res) => res.json({ user: r.user }));

// ─── API: Remove background (silueta AI only) ───
app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ e: 'No image uploaded' });
    const id = crypto.randomUUID(), out = path.join(OUTPUT_DIR, `${id}.png`);
    console.log(`[Remove] file=${req.file.filename}`);
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      const py = spawn('python', [path.join(__dirname, 'removebg.py'), req.file.path, out]);
      let stdout = '', stderr = '';
      py.stdout.on('data', d => { stdout += d; console.log('[Python]', d.toString().trim()); });
      py.stderr.on('data', d => { stderr += d; console.log('[Python:err]', d.toString().trim()); });
      const timeout = setTimeout(() => { py.kill(); reject(new Error('Python timed out')); }, 120000);
      py.on('close', code => {
        clearTimeout(timeout);
        fs.unlink(req.file.path, () => {});
        if (code === 0) {
          console.log(`[Remove] Done in ${(Date.now()-t0)/1000}s`);
          resolve();
        } else reject(new Error(stderr.trim() || `Python exit ${code}`));
      });
      py.on('error', e => { fs.unlink(req.file.path, () => {}); reject(e); });
    });
    res.json({ id, url: `/api/output/${id}.png` });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ e: 'Removal failed: ' + e.message });
  }
});

// Store browser-processed result
app.post('/api/store-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ e: 'No image' });
    const id = crypto.randomUUID();
    const out = path.join(OUTPUT_DIR, `${id}.png`);
    fs.renameSync(req.file.path, out);
    res.json({ id, url: `/api/output/${id}.png` });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ e: e.message });
  }
});

// ─── API: Background Blur ───
app.post('/api/background-blur', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ e: 'No image uploaded' });
    const blurRadius = Math.min(30, Math.max(1, parseInt(req.body.blurRadius) || 10));
    const id = crypto.randomUUID(), out = path.join(OUTPUT_DIR, `${id}.png`);
    const fgPath = path.join(OUTPUT_DIR, `fg_${id}.png`);
    // Run silueta to get transparent foreground
    await new Promise((resolve, reject) => {
      const py = spawn('python', [path.join(__dirname, 'removebg.py'), req.file.path, fgPath]);
      let stderr = '';
      py.stdout.on('data', d => console.log('[Python]', d.toString().trim()));
      py.stderr.on('data', d => { stderr += d; });
      const timeout = setTimeout(() => { py.kill(); reject(new Error('Python timed out')); }, 120000);
      py.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Python exit ${code}`));
      });
      py.on('error', reject);
    });
    // Load original and foreground, blur original, composite sharp fg over blurred bg
    const orig = await jimp.Jimp.read(req.file.path);
    const fg = await jimp.Jimp.read(fgPath);
    const blurred = orig.clone().gaussian(blurRadius);
    blurred.composite(fg, 0, 0);
    await blurred.write(out);
    fs.unlink(req.file.path, () => {});
    fs.unlink(fgPath, () => {});
    res.json({ id, url: `/api/output/${id}.png` });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ e: 'Background blur failed: ' + e.message });
  }
});

// ─── Selfie filter presets ───
const SELFIE_PRESETS = {
  glow: async (img) => {
    img.brightness(1.12).contrast(0.08);
    return img;
  },
  warm: async (img) => {
    img.color([{ apply: 'red', params: [15] }, { apply: 'green', params: [8] }, { apply: 'blue', params: [-10] }]);
    img.contrast(0.05);
    return img;
  },
  vintage: async (img) => {
    img.sepia().contrast(0.1);
    applyVignette(img, 0.3);
    return img;
  },
  'bw-classic': async (img) => {
    img.greyscale().contrast(0.15);
    return img;
  },
  'soft-glam': async (img) => {
    img.brightness(0.08).gaussian(1);
    return img;
  },
  vivid: async (img) => {
    img.color([{ apply: 'saturate', params: [50] }]);
    img.contrast(0.1).brightness(0.05);
    return img;
  },
  cool: async (img) => {
    img.color([{ apply: 'red', params: [-10] }, { apply: 'green', params: [-5] }, { apply: 'blue', params: [15] }, { apply: 'desaturate', params: [20] }]);
    return img;
  },
  dramatic: async (img) => {
    img.contrast(0.2).brightness(-0.05);
    applyVignette(img, 0.35);
    return img;
  }
};
function applyVignette(image, amount) {
  const w = image.bitmap.width, h = image.bitmap.height;
  const cx = w / 2, cy = h / 2, maxDist = Math.sqrt(cx * cx + cy * cy);
  image.scan(0, 0, w, h, function (x, y, idx) {
    const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
    const factor = Math.min(1, dist / maxDist);
    const darken = factor * amount;
    this.bitmap.data[idx] = Math.round(this.bitmap.data[idx] * (1 - darken));
    this.bitmap.data[idx + 1] = Math.round(this.bitmap.data[idx + 1] * (1 - darken));
    this.bitmap.data[idx + 2] = Math.round(this.bitmap.data[idx + 2] * (1 - darken));
  });
}

app.post('/api/selfie-filter', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ e: 'No image uploaded' });
    const preset = req.body.preset || 'vivid';
    if (!SELFIE_PRESETS[preset]) return res.status(400).json({ e: 'Unknown preset' });
    const id = crypto.randomUUID(), out = path.join(OUTPUT_DIR, `${id}.png`);
    const img = await jimp.Jimp.read(req.file.path);
    await SELFIE_PRESETS[preset](img);
    await img.write(out);
    fs.unlink(req.file.path, () => {});
    res.json({ id, url: `/api/output/${id}.png` });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ e: 'Selfie filter failed: ' + e.message });
  }
});

// ─── Composition ───
app.post('/api/compose', auth, (req, res, next) => {
  if (req.is('multipart/form-data')) return upload.single('foreground')(req, res, next);
  next();
}, async (req, res) => {
  try {
    const { bgType, bgColor, gradientColors, gradientDirection, text, textColor, textSize, textRotation, textX, textY, bgUrl, foregroundId } = req.body;
    let fg;
    if (req.file) fg = await jimp.Jimp.read(req.file.path);
    else if (foregroundId) fg = await jimp.Jimp.read(path.join(OUTPUT_DIR, `${foregroundId}.png`));
    else return res.status(400).json({ e: 'No foreground image' });

    const id = crypto.randomUUID(), out = path.join(OUTPUT_DIR, `${id}.png`);
    const w = fg.bitmap.width, h = fg.bitmap.height;

    let bgImg;
    if (bgType === 'url' && bgUrl) {
      const resp = await fetch(bgUrl);
      if (!resp.ok) throw new Error('Failed to fetch URL');
      bgImg = await jimp.Jimp.read(Buffer.from(await resp.arrayBuffer()));
      bgImg.cover({ w, h });
    } else {
      let bgSvg;
      if (bgType === 'gradient') {
        const colors = gradientColors ? JSON.parse(gradientColors) : ['#ff7e5f', '#feb47b'];
        const dir = gradientDirection || 'right';
        const map = { right: 'x1="0" y1="0" x2="100%" y2="0"', top: 'x1="0" y1="100%" x2="0" y2="0"', diagonal: 'x1="0" y1="0" x2="100%" y2="100%"' };
        const stops = colors.map((c, i) => `<stop offset="${(i/(colors.length-1))*100}%" stop-color="${c}"/>`).join('');
        bgSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" ${map[dir]||map.right}>${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
      } else {
        bgSvg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bgColor||'#1a1a2e'}"/></svg>`;
      }
      const bgPng = new Resvg(bgSvg, { fitTo: { mode: 'width', value: w } }).render().asPng();
      bgImg = await jimp.Jimp.read(Buffer.from(bgPng));
    }
    bgImg.composite(fg, 0, 0);

    if (text?.trim()) {
      const tColor = textColor || '#ffffff';
      const tSize = parseInt(textSize) || 48;
      const lines = text.split('\n');
      const lh = tSize * 1.4;
      const startY = Math.max(10, (h - lines.length * lh) / 2);
      const isWhite = tColor.toLowerCase() === '#ffffff' || tColor.toLowerCase() === 'white';
      const fontSizes = [8, 10, 12, 14, 16, 32, 64, 128];
      const closest = fontSizes.reduce((a, b) => Math.abs(b - tSize) < Math.abs(a - tSize) ? b : a);
      const fontName = `open-sans-${closest}-${isWhite ? 'white' : 'black'}`;
      const font = await jimp.loadFont(path.join(__dirname, 'node_modules/@jimp/plugin-print/fonts/open-sans', fontName, fontName + '.fnt'));

      // Render text on a temp image at the bitmap font size, then scale
      const maxLineW = Math.max(...lines.map(l => jimp.measureText(font, l)));
      const textH = lines.length * (closest * 1.4);
      const tmp = new jimp.Jimp({ width: maxLineW + 20, height: Math.round(textH + 20) });
      lines.forEach((l, i) => {
        tmp.print({ font, x: 10, y: Math.round(10 + i * closest * 1.4), text: l });
      });

      if (!isWhite) {
        const r = parseInt(tColor.slice(1, 3), 16);
        const g = parseInt(tColor.slice(3, 5), 16);
        const b = parseInt(tColor.slice(5, 7), 16);
        tmp.scan(0, 0, tmp.bitmap.width, tmp.bitmap.height, function(_x, _y, idx) {
          if (this.bitmap.data[idx + 3] > 0) {
            this.bitmap.data[idx] = r;
            this.bitmap.data[idx + 1] = g;
            this.bitmap.data[idx + 2] = b;
          }
        });
      }

      const scaled = tmp.clone().resize({ w: Math.round(maxLineW * tSize / closest + 20), h: Math.round(textH * tSize / closest + 20) });
      if (textRotation) scaled.rotate(parseFloat(textRotation), 0x00000000);
      const tcX = Math.round(w / 2 + (parseInt(textX) || 0) - scaled.bitmap.width / 2);
      const tcY = Math.round(h / 2 + (parseInt(textY) || 0) - scaled.bitmap.height / 2);
      bgImg.composite(scaled, Math.max(0, tcX), Math.max(0, tcY));
    }

    await bgImg.write(out);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.json({ id, url: `/api/output/${id}.png` });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ e: 'Composition failed: ' + e.message });
  }
});

app.get('/api/output/:f', (req, res) => {
  const fp = path.join(OUTPUT_DIR, req.params.f);
  if (!fs.existsSync(fp)) return res.status(404).json({ e: 'Not found' });
  res.sendFile(fp);
});

// ─── SEO: SPA meta injection ───
const PAGE_SEO = {
  'free-remove-background': { title: 'AI Background Remover — Remove BG Online Free | ImageFree', desc: 'Remove backgrounds instantly with AI. Free online tool with composition, text overlay, gradients & more. No signup required.', keywords: 'background remover, remove background from image, AI background removal, photo background eraser, transparent background maker' },
  'free-resize-image': { title: 'Free Image Resizer — Resize Photos Online | ImageFree', desc: 'Resize images online free. Change dimensions, maintain aspect ratio, use presets for social media, web & print.', keywords: 'image resizer, resize photo online, image dimension changer, photo scaler, picture resizer tool' },
  'free-image-filter': { title: 'Free Image Filter Editor — Apply Photo Effects | ImageFree', desc: 'Apply stunning filters to images free. Adjust brightness, contrast, saturation, grayscale, sepia, blur & more. One-click download.', keywords: 'image filter editor, photo effects, image brightness adjuster, photo contrast, image filter online' },
  'free-background-blur': { title: 'Free Background Blur — Blur Photo BG Online | ImageFree', desc: 'Blur photo backgrounds with AI subject detection. Create portrait mode effects free. Adjustable blur intensity, instant download.', keywords: 'background blur, blur photo background, portrait mode, AI subject detection, blur background online' },
  'free-selfie-filter': { title: 'Free Selfie Filter Editor — Photo Presets | ImageFree', desc: 'Apply selfie filter presets to your photos free. Glow, vintage, B&W, vivid & more. One-click download, no signup required.', keywords: 'selfie filter, photo filter presets, glow filter, vintage photo, photo effects online, photo editor' },
  'free-image-uploader': { title: 'Free Image Uploader — Upload & Share Online | ImageFree', desc: 'Upload images & get shareable URLs free. Drag-and-drop, copy links, manage uploads. Fast, private, no signup required.', keywords: 'image uploader, upload photos online, image hosting, share image link, drag and drop upload' },
  'free-image-to-text-ocr-converter': { title: 'Free OCR Converter — Extract Text from Images | ImageFree', desc: 'Extract text from images instantly free. Upload photo or screenshot, convert image to text. Accurate, fast, no signup.', keywords: 'image to text converter, OCR online, extract text from image, image to text OCR, photo to text, optical character recognition, free OCR tool' },
  'free-online-camera': { title: 'Free Online Camera — Take Webcam Photos | ImageFree', desc: 'Take photos with your device camera free. Capture, apply real-time filters, download & share. No signup, works in browser.', keywords: 'online camera, webcam photo, take photo online, camera capture, webcam selfie, browser camera' },
  'free-api-documentation': { title: 'ImageFree API Docs — Developer Guide | ImageFree', desc: 'Complete ImageFree API docs. Background removal, image resizing, filters & more. Integrate AI image processing with simple REST APIs.', keywords: 'API documentation, image processing API, background removal API, developer guide, REST API' }
};
const PAGE_NAMES = { 'free-remove-background': 'Background Remover', 'free-resize-image': 'Image Resizer', 'free-image-filter': 'Image Filter Editor', 'free-background-blur': 'Background Blur', 'free-selfie-filter': 'Selfie Filter', 'free-image-to-text-ocr-converter': 'Image to Text OCR Converter', 'free-image-uploader': 'Image Uploader', 'free-online-camera': 'Online Camera', 'free-api-documentation': 'API Documentation' };
const SPA_PAGES = Object.keys(PAGE_SEO);

function injectSeo(html, page, base, s, name) {
  const label = name || PAGE_NAMES[page] || 'ImageFree';
  const ogSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect fill="#05050a" width="1200" height="630"/><text x="600" y="280" font-family="Inter,sans-serif" font-size="64" font-weight="800" fill="#a29bfe" text-anchor="middle">ImageFree</text><text x="600" y="360" font-family="Inter,sans-serif" font-size="32" fill="#6c5ce7" text-anchor="middle">${label}</text><text x="600" y="410" font-family="Inter,sans-serif" font-size="20" fill="#6b6b8a" text-anchor="middle">Free • Online • No Signup</text></svg>`);
  const canonical = base + '/' + page;
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${s.title}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${s.desc}">`)
    .replace(/<meta name="keywords"[^>]*>/, `<meta name="keywords" content="${s.keywords}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="ImageFree — ${label}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${s.desc}">`)
    .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${canonical}">`)
    .replace(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="data:image/svg+xml,${ogSvg}">`)
    .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="ImageFree — ${label}">`)
    .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${s.desc}">`)
    .replace(/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="data:image/svg+xml,${ogSvg}">`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}">`)
    .replace(/<link rel="alternate" hreflang="x-default"[^>]*>/, `<link rel="alternate" hreflang="x-default" href="${base}/">`)
    .replace(/<link rel="alternate" hreflang="en"[^>]*>/, `<link rel="alternate" hreflang="en" href="${base}/">`)
    // Update JSON-LD WebApplication schema
    .replace(/"description":"[^"]*"/, `"description":"${s.desc.replace(/"/g, '\\"')}"`)
    .replace(/"url":"[^"]*"/, `"url":"${canonical}"`)
    .replace(/"name":"[^"]*"/, `"name":"${label}"`)
    // Update Organization schema URL in JSON-LD
    .replace(/(id="ldJsonOrg">[^<]*"url":")[^"]*(")/, `$1${base}$2`);
}

// Root route — serve with default SEO
app.get('/', (req, res) => {
  const fp = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(fp)) return res.status(404).end();
  const base = req.protocol + '://' + req.get('host');
  const s = PAGE_SEO['free-remove-background'];
  let html = fs.readFileSync(fp, 'utf8');
  html = injectSeo(html, '', base, s, 'Background Remover');
  res.send(html);
});

// SPA routes — inject SEO meta and serve index.html
app.get(SPA_PAGES.map(p => '/' + p), (req, res) => {
  const page = req.path.slice(1);
  const s = PAGE_SEO[page] || PAGE_SEO['free-remove-background'];
  const base = req.protocol + '://' + req.get('host');
  const fp = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(fp)) return res.status(404).end();
  let html = fs.readFileSync(fp, 'utf8');
  html = injectSeo(html, page, base, s);
  res.send(html);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  const now = new Date().toISOString().split('T')[0];
  const urls = SPA_PAGES.map(p => `  <url><loc>${host}/${p}</loc><lastmod>${now}</lastmod><changefreq>weekly</changefreq><priority>${p === 'free-remove-background' ? '1.0' : '0.8'}</priority></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${host}/</loc><lastmod>${now}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>\n${urls}\n</urlset>`);
});

// ads.txt
app.get('/ads.txt', (req, res) => {
  res.type('text/plain').send('google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n');
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, fp) => {
    const ext = path.extname(fp).toLowerCase();
    if (ext === '.html') {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (['.jpg','.jpeg','.png','.gif','.webp','.svg','.ico'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=86400');
    } else if (['.css','.js','.woff','.woff2','.ttf'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// SPA catch-all — serve index.html for unmatched routes with 404 status
app.get('*', (req, res) => {
  const fp = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(fp)) return res.status(404).end();
  const base = req.protocol + '://' + req.get('host');
  let html = fs.readFileSync(fp, 'utf8');
  const s = PAGE_SEO['free-remove-background'];
  html = injectSeo(html, '', base, s, 'Background Remover');
  res.status(404).send(html);
});

// ─── Module exports ───
if (require.main === module || process.env.RUN_SERVER === 'true') {
  app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
}

module.exports = app;
