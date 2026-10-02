import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
}) : null;

const upload = multer({
  dest: path.join(os.tmpdir(), 'vhub-uploads'),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024 }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), 'public')));

function sign(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function auth(required = true) {
  return async (req, res, next) => {
    try {
      const token = req.cookies.vhub_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) {
        if (!required) return next();
        return res.status(401).json({ error: 'Authentication required' });
      }
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await pool.query('SELECT id,email,display_name,role FROM users WHERE id=$1', [payload.sub]);
      if (!rows[0]) return res.status(401).json({ error: 'Account not found' });
      req.user = rows[0];
      next();
    } catch {
      if (!required) return next();
      res.status(401).json({ error: 'Invalid or expired session' });
    }
  };
}

function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || crypto.randomUUID();
}

function publicUrl(key) {
  if (!key) return null;
  const base = process.env.R2_PUBLIC_BASE_URL;
  return base ? base.replace(/\/$/, '') + '/' + key : null;
}

async function putR2(key, body, contentType) {
  if (!r2) throw new Error('R2 is not configured');
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
  return key;
}

async function deleteR2(key) {
  if (!r2 || !key) return;
  await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

async function transcodeToHls(input, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-i', input,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'segment-%05d.ts'),
      path.join(outputDir, 'index.m3u8')
    ]);
    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-4000))));
  });
}

async function processVideo(videoId, localVideoPath) {
  try {
    const { rows } = await pool.query('SELECT * FROM videos WHERE id=$1', [videoId]);
    const video = rows[0];
    if (!video) return;
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'vhub-hls-'));
    try {
      const hlsDir = path.join(work, 'hls');
      await transcodeToHls(localVideoPath, hlsDir);
      const files = (await fs.readdir(hlsDir)).sort();
      let manifestKey = null;
      for (const file of files) {
        const full = path.join(hlsDir, file);
        const key = `videos/${videoId}/${file}`;
        const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        await putR2(key, await fs.readFile(full), type);
        if (file === 'index.m3u8') manifestKey = key;
      }
      if (!manifestKey) throw new Error('FFmpeg did not produce an HLS manifest.');
      await pool.query(
        'UPDATE videos SET hls_manifest_key=$1, video_key=$2, status=\'published\', published_at=now() WHERE id=$3',
        [manifestKey, `videos/${videoId}`, videoId]
      );
    } finally {
      await fs.rm(work, { recursive: true, force: true });
      await fs.rm(localVideoPath, { force: true });
    }
  } catch (error) {
    console.error('HLS processing failed:', error.message);
    await pool.query('UPDATE videos SET status=\'rejected\' WHERE id=$1', [videoId]).catch(() => {});
    await fs.rm(localVideoPath, { force: true }).catch(() => {});
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true, r2: Boolean(r2) });
  } catch {
    res.status(503).json({ ok: false, database: false, r2: Boolean(r2) });
  }
});

app.get('/api/me', auth(false), (req, res) => res.json({ user: req.user || null }));

app.post('/api/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password || !displayName || password.length < 8) {
    return res.status(400).json({ error: 'Email, display name and an 8+ character password are required.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name,role',
      [email.toLowerCase().trim(), hash, displayName.trim()]
    );
    res.cookie('vhub_token', sign(rows[0]), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 });
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email is already registered.' });
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
  const safe = { id:user.id, email:user.email, display_name:user.display_name, role:user.role };
  res.cookie('vhub_token', sign(safe), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 });
  res.json({ user: safe });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('vhub_token');
  res.json({ ok: true });
});

app.get('/api/categories', async (_req, res) => {
  const { rows } = await pool.query('SELECT id,name,slug FROM categories ORDER BY name');
  res.json(rows);
});

app.post('/api/categories', auth(), admin, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Category name is required.' });
  try {
    const { rows } = await pool.query('INSERT INTO categories(name,slug) VALUES($1,$2) RETURNING *', [name.trim(), slugify(name)]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(409).json({ error: 'Category already exists.' });
  }
});

app.get('/api/videos', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 24), 60);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const category = req.query.category;
  const params = [limit, offset];
  let where = 'v.status=\'published\'';
  if (category) {
    params.push(category);
    where += ` AND c.slug=$${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT v.id,v.title,v.slug,v.description,v.view_count,v.created_at,v.poster_key,v.hls_manifest_key,c.name AS category,
            u.display_name AS creator
       FROM videos v
       LEFT JOIN categories c ON c.id=v.category_id
       LEFT JOIN users u ON u.id=v.owner_id
      WHERE ${where}
      ORDER BY v.view_count DESC,v.created_at DESC
      LIMIT $1 OFFSET $2`, params
  );
  res.json(rows.map(v => ({ ...v, poster_url: publicUrl(v.poster_key), stream_url: publicUrl(v.hls_manifest_key) })));
});

app.get('/api/videos/:slug', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*,c.name AS category,u.display_name AS creator
       FROM videos v
       LEFT JOIN categories c ON c.id=v.category_id
       LEFT JOIN users u ON u.id=v.owner_id
      WHERE v.slug=$1 AND v.status='published'`, [req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Video not found.' });
  const v = rows[0];
  res.json({ ...v, poster_url: publicUrl(v.poster_key), stream_url: publicUrl(v.hls_manifest_key) });
});

app.post('/api/videos/:id/view', auth(false), async (req, res) => {
  const ip = req.ip || '';
  const ipHash = crypto.createHash('sha256').update(ip + (process.env.JWT_SECRET || '')).digest('hex');
  await pool.query('INSERT INTO views(video_id,viewer_id,ip_hash) VALUES($1,$2,$3)', [req.params.id, req.user?.id || null, ipHash]);
  await pool.query('UPDATE videos SET view_count=view_count+1 WHERE id=$1 AND status=\'published\'', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/my/videos', auth(), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id,v.title,v.slug,v.status,v.view_count,v.created_at,c.name AS category
       FROM videos v LEFT JOIN categories c ON c.id=v.category_id
      WHERE v.owner_id=$1 ORDER BY v.created_at DESC`, [req.user.id]
  );
  res.json(rows);
});

app.post('/api/videos', auth(), upload.fields([{ name:'video', maxCount:1 }, { name:'poster', maxCount:1 }]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const posterFile = req.files?.poster?.[0];
  if (!videoFile || !posterFile) return res.status(400).json({ error: 'Video and poster are required.' });
  if (!r2) return res.status(503).json({ error: 'R2 is not configured yet.' });

  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  const id = crypto.randomUUID();
  const slug = slugify(title) + '-' + id.slice(0, 8);
  const posterKey = `posters/${id}-${slugify(posterFile.originalname)}`;

  try {
    await putR2(posterKey, await fs.readFile(posterFile.path), posterFile.mimetype || 'image/jpeg');
    const { rows } = await pool.query(
      `INSERT INTO videos(id,owner_id,category_id,title,slug,description,poster_key,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,'processing') RETURNING id,slug,status`,
      [id, req.user.id, req.body.categoryId || null, title, slug, String(req.body.description || ''), posterKey]
    );
    res.status(202).json({ ...rows[0], message: 'Upload accepted. Video processing has started.' });
    processVideo(id, videoFile.path);
  } catch (e) {
    await fs.rm(videoFile.path, { force:true }).catch(()=>{});
    await fs.rm(posterFile.path, { force:true }).catch(()=>{});
    await deleteR2(posterKey).catch(()=>{});
    res.status(500).json({ error: e.message || 'Upload failed.' });
  } finally {
    await fs.rm(posterFile.path, { force:true }).catch(()=>{});
  }
});

app.get('/api/admin/videos', auth(), admin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*,u.display_name AS creator,c.name AS category
       FROM videos v LEFT JOIN users u ON u.id=v.owner_id LEFT JOIN categories c ON c.id=v.category_id
      ORDER BY v.created_at DESC LIMIT 200`
  );
  res.json(rows.map(v => ({ ...v, poster_url: publicUrl(v.poster_key) })));
});

app.patch('/api/admin/videos/:id', auth(), admin, async (req, res) => {
  const { status, title, categoryId } = req.body;
  const allowed = ['processing','published','rejected'];
  if (status && !allowed.includes(status)) return res.status(400).json({ error:'Invalid status.' });
  const { rows } = await pool.query(
    `UPDATE videos SET
       title=COALESCE($1,title),
       category_id=COALESCE($2,category_id),
       status=COALESCE($3,status),
       published_at=CASE WHEN $3='published' THEN COALESCE(published_at,now()) ELSE published_at END
     WHERE id=$4 RETURNING *`,
    [title || null, categoryId || null, status || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error:'Video not found.' });
  res.json(rows[0]);
});

app.get('/api/admin/stats', auth(), admin, async (_req, res) => {
  const [videos, users, views] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM videos'),
    pool.query('SELECT COUNT(*)::int AS count FROM users'),
    pool.query('SELECT COUNT(*)::bigint AS count FROM views')
  ]);
  res.json({ videos:videos.rows[0].count, users:users.rows[0].count, views:views.rows[0].count });
});

app.get('/{*splat}', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.listen(port, () => console.log(`VHub listening on http://localhost:${port}`));