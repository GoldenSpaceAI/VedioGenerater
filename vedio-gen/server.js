const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

let ffmpegPath;
try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch (e) { ffmpegPath = 'ffmpeg'; }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const TEMP_DIR = '/tmp/video-gen';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/images', (req, res) => res.sendFile(path.join(__dirname, 'images.html')));

app.post('/api/chat', async (req, res) => {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: req.body.messages, temperature: 0.7 })
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pexels/videos', async (req, res) => {
  try {
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(req.query.query)}&per_page=1`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pexels/images', async (req, res) => {
  try {
    const { query, per_page, page } = req.query;
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${per_page || 80}&page=${page || 1}`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg code ${code}: ${stderr.slice(-200)}`));
    });
    proc.on('error', reject);
    setTimeout(() => proc.kill('SIGKILL'), 180000);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const p = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      file.close();
      if (err) { try { fs.unlinkSync(dest); } catch (e) {} reject(err); }
      else resolve();
    };
    const req = (u, r = 0) => {
      if (r > 5) return finish(new Error('Redirects'));
      p.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return req(res.headers.location, r + 1);
        res.pipe(file);
        file.on('finish', () => finish(null));
      }).on('error', finish).setTimeout(60000, () => finish(new Error('Timeout')));
    };
    req(url);
  });
}

// ==================== SIMPLE VIDEO RENDER (No effects, 10s per clip) ====================
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const id = uuidv4();
  const dir = path.join(TEMP_DIR, id);
  
  try {
    const { clips, subtitles, duration } = req.body;
    const clipData = JSON.parse(clips || '[]');
    const subData = subtitles ? JSON.parse(subtitles) : [];
    const totalDuration = parseFloat(duration) || 30;
    
    const validClips = clipData.filter(c => c && c.url);
    if (!validClips.length) return res.status(400).json({ error: 'No clips' });
    
    const actualCount = validClips.length;
    const clipDuration = 10; // FIXED 10 seconds per clip
    const adjustedTotal = actualCount * clipDuration;
    
    console.log(`🎬 SIMPLE RENDER | ${actualCount} clips × 10s = ${adjustedTotal}s`);
    
    fs.mkdirSync(dir);
    
    // Audio
    const hasAudio = req.file && req.file.buffer && req.file.buffer.length > 500;
    const audioPath = path.join(dir, 'voice.webm');
    if (hasAudio) {
      fs.writeFileSync(audioPath, req.file.buffer);
    } else {
      await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(adjustedTotal), '-c:a', 'libopus', '-y', audioPath]);
    }
    
    const segments = [];
    
    for (let i = 0; i < actualCount; i++) {
      console.log(`📹 Clip ${i+1}/${actualCount}`);
      const raw = path.join(dir, `r${i}.mp4`);
      const seg = path.join(dir, `s${i}.mp4`);
      
      await downloadFile(validClips[i].url, raw);
      
      // SIMPLE filter - just scale, no effects
      let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      
      // Subtitles only
      const cStart = i * clipDuration;
      const cEnd = (i + 1) * clipDuration;
      const cSubs = subData.filter(s => parseFloat(s.startTime) >= cStart && parseFloat(s.startTime) < cEnd);
      const subText = cSubs.map(s => s.text).join(' ').replace(/['"\[\]{}%;:,]/g, '').trim().substring(0, 50);
      
      if (subText) {
        const esc = subText.replace(/'/g, "'\\''");
        vf += `,drawtext=text='${esc}':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h*0.08`;
      }
      
      await runFfmpeg(['-i', raw, '-t', String(clipDuration), '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '1',
        '-bufsize', '500k', '-maxrate', '500k', '-an', '-y', seg]);
      
      segments.push(seg);
      try { fs.unlinkSync(raw); } catch (e) {}
      if (global.gc) global.gc();
    }
    
    // Concat
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, segments.map(f => `file '${f}'`).join('\n'));
    const silent = path.join(dir, 'silent.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-an', '-y', silent]);
    segments.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    try { fs.unlinkSync(list); } catch (e) {}
    
    // Audio
    const output = path.join(dir, 'output.mp4');
    await runFfmpeg(['-i', silent, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '128k', '-ar', '44100', '-ac', '2', '-threads', '1',
      '-movflags', '+faststart', '-shortest', '-y', output]);
    
    try { fs.unlinkSync(silent); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    const stat = fs.statSync(output);
    console.log(`✅ ${(stat.size/1024/1024).toFixed(2)}MB`);
    
    req.setTimeout(300000);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const stream = fs.createReadStream(output);
    stream.on('end', () => setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 60000));
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
    
  } catch (e) {
    console.error('❌', e.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ==================== IMAGE DOWNLOADER ====================
const archiver = require('archiver');

app.post('/api/download-images', async (req, res) => {
  try {
    const { query, count } = req.body;
    const total = Math.min(count || 30, 300);
    
    console.log(`🖼️ Downloading ${total} images for "${query}"`);
    
    // Fetch images from Pexels (80 per page)
    let allPhotos = [];
    let page = 1;
    
    while (allPhotos.length < total && page <= 4) {
      const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=80&page=${page}`,
        { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } });
      const d = await r.json();
      if (d.photos?.length) {
        allPhotos = allPhotos.concat(d.photos);
      } else break;
      page++;
    }
    
    const photos = allPhotos.slice(0, total);
    console.log(`📸 Got ${photos.length} photos`);
    
    // Create ZIP
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${query}_${photos.length}_images.zip"`
    });
    
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.pipe(res);
    
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const imgUrl = photo.src.large2x || photo.src.large;
      const ext = '.jpg';
      const filename = `${query}_${i+1}${ext}`;
      
      try {
        const imgData = await fetch(imgUrl).then(r => r.buffer());
        archive.append(imgData, { name: filename });
        console.log(`  ✅ ${i+1}/${photos.length}`);
      } catch (e) {
        console.log(`  ❌ ${i+1} failed`);
      }
    }
    
    await archive.finalize();
    console.log(`✅ ZIP sent!`);
    
  } catch (e) {
    console.error('❌', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

try { if (fs.existsSync(TEMP_DIR)) { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); } } catch (e) {}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));
