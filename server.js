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
const JWT_SECRET = process.env.JWT_SECRET || 'imagetools-jwt-secret';
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
  bg: { title: 'Free AI Background Remover — Remove Image Background Online | ImageTools', desc: 'Remove backgrounds from photos instantly using AI. Free online background removal tool with image composition, text overlay, gradients, and more. No signup required.', keywords: 'background remover, remove background from image, AI background removal, photo background eraser, transparent background maker' },
  resize: { title: 'Free Image Resizer — Resize Photos Online Instantly | ImageTools', desc: 'Resize images online for free. Change photo dimensions, maintain aspect ratio, use preset sizes. Fast image resizer tool for social media, web, and print.', keywords: 'image resizer, resize photo online, image dimension changer, photo scaler, picture resizer tool' },
  filter: { title: 'Free Image Filter Editor — Apply Photo Effects Online | ImageTools', desc: 'Apply stunning filters to your images online for free. Adjust brightness, contrast, saturation, grayscale, sepia, blur, and hue rotation. Download with one click.', keywords: 'image filter editor, photo effects, image brightness adjuster, photo contrast, image filter online' }
};
const PAGE_NAMES = { bg: 'Background Remover', resize: 'Image Resizer', filter: 'Image Filter Editor' };

// SPA routes — inject SEO meta and serve index.html
app.get(['/bg','/resize','/filter'], (req, res) => {
  const page = req.path.slice(1);
  const s = PAGE_SEO[page] || PAGE_SEO.bg;
  const base = req.protocol + '://' + req.get('host');
  const fp = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(fp)) return res.status(404).end();
  let html = fs.readFileSync(fp, 'utf8');
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${s.title}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${s.desc}">`)
    .replace(/<meta name="keywords"[^>]*>/, `<meta name="keywords" content="${s.keywords}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="ImageTools — Free ${PAGE_NAMES[page]} Online">`)
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
  const pages = ['bg','resize','filter'];
  const urls = pages.map(p => `  <url><loc>${host}/${p}</loc><changefreq>weekly</changefreq><priority>${p === 'bg' ? '1.0' : '0.8'}</priority></url>`).join('\n');
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
