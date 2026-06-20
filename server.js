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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => { console.log(`[${req.method}] ${req.url}`); next(); });

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
    img.brightness(0.12).contrast(0.08);
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
  'free-remove-background': { title: 'Free AI Background Remover — Remove Image Background Online | ImageFree', desc: 'Remove backgrounds from photos instantly using AI. Free online background removal tool with image composition, text overlay, gradients, and more. No signup required.', keywords: 'background remover, remove background from image, AI background removal, photo background eraser, transparent background maker' },
  'free-resize-image': { title: 'Free Image Resizer — Resize Photos Online Instantly | ImageFree', desc: 'Resize images online for free. Change photo dimensions, maintain aspect ratio, use preset sizes. Fast image resizer tool for social media, web, and print.', keywords: 'image resizer, resize photo online, image dimension changer, photo scaler, picture resizer tool' },
  'free-image-filter': { title: 'Free Image Filter Editor — Apply Photo Effects Online | ImageFree', desc: 'Apply stunning filters to your images online for free. Adjust brightness, contrast, saturation, grayscale, sepia, blur, and hue rotation. Download with one click.', keywords: 'image filter editor, photo effects, image brightness adjuster, photo contrast, image filter online' },
  'free-background-blur': { title: 'Free Background Blur Tool — Blur Photo Background Online | ImageFree', desc: 'Blur photo backgrounds with AI-powered subject detection. Create beautiful portrait mode effects online for free. Adjustable blur intensity, instant download.', keywords: 'background blur, blur photo background, portrait mode, AI subject detection, blur background online' },
  'free-selfie-filter': { title: 'Free Selfie Filter Editor — Apply Photo Presets Online | ImageFree', desc: 'Apply stunning selfie filter presets to your photos. Glow, vintage, B&W, vivid and more. Free online photo filter effects with one-click download.', keywords: 'selfie filter, photo filter presets, glow filter, vintage photo, photo effects online' },
  'free-image-uploader': { title: 'Free Image Uploader — Upload & Share Images Online | ImageFree', desc: 'Upload images and get instant shareable URLs for free. Drag-and-drop upload, copy links, manage uploads. Fast, private, no signup required.', keywords: 'image uploader, upload photos online, image hosting, share image link, drag and drop upload' },
  'free-image-to-text-ocr-converter': { title: 'Free Image to Text OCR Converter — Extract Text from Images Online | ImageFree', desc: 'Extract text from images instantly with our free online OCR converter. Upload a photo or screenshot and convert image to text. Accurate, fast, no signup required.', keywords: 'image to text converter, OCR online, extract text from image, image to text OCR, photo to text, optical character recognition, free OCR tool' },
  'free-online-camera': { title: 'Free Online Camera — Take Photos with Webcam | ImageFree', desc: 'Use your device camera to take photos online for free. Capture, apply effects, download and share. No signup required, works in your browser.', keywords: 'online camera, webcam photo, take photo online, camera capture, webcam selfie' },
  'free-api-documentation': { title: 'ImageFree API Documentation — Developer Guide | ImageFree', desc: 'Complete API documentation for ImageFree. Background removal, image resizing, filters, and more. Integrate AI image processing into your apps.', keywords: 'API documentation, image processing API, background removal API, developer guide, REST API' }
};
const PAGE_NAMES = { 'free-remove-background': 'Background Remover', 'free-resize-image': 'Image Resizer', 'free-image-filter': 'Image Filter Editor', 'free-background-blur': 'Background Blur', 'free-selfie-filter': 'Selfie Filter', 'free-image-to-text-ocr-converter': 'Image to Text OCR Converter', 'free-image-uploader': 'Image Uploader', 'free-online-camera': 'Online Camera', 'free-api-documentation': 'API Documentation' };

// SPA routes — inject SEO meta and serve index.html
app.get(['/free-remove-background','/free-resize-image','/free-image-filter','/free-background-blur','/free-selfie-filter','/free-image-to-text-ocr-converter','/free-image-uploader','/free-online-camera','/free-api-documentation'], (req, res) => {
  const page = req.path.slice(1);
  const s = PAGE_SEO[page] || PAGE_SEO['free-remove-background'];
  const base = req.protocol + '://' + req.get('host');
  const fp = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(fp)) return res.status(404).end();
  let html = fs.readFileSync(fp, 'utf8');
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${s.title}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${s.desc}">`)
    .replace(/<meta name="keywords"[^>]*>/, `<meta name="keywords" content="${s.keywords}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="ImageFree — Free ${PAGE_NAMES[page]} Online">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${s.desc}">`)
    .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${base}/${page}">`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${base}/${page}">`);
  res.send(html);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  const pages = ['free-remove-background','free-resize-image','free-image-filter','free-background-blur','free-selfie-filter','free-image-to-text-ocr-converter','free-image-uploader','free-online-camera','free-api-documentation'];
  const urls = pages.map(p => `  <url><loc>${host}/${p}</loc><changefreq>weekly</changefreq><priority>${p === 'free-remove-background' ? '1.0' : '0.8'}</priority></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); }
}));

function escXml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

if (require.main === module || process.env.RUN_SERVER === 'true') {
  app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
}

module.exports = app;
