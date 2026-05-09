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
    setTimeout(() => proc.kill('SIGKILL'), 300000);
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
      if (r > 5) return finish(new Error('Too many redirects'));
      p.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return req(res.headers.location, r + 1);
        res.pipe(file);
        file.on('finish', () => finish(null));
      }).on('error', finish).setTimeout(60000, () => finish(new Error('Timeout')));
    };
    req(url);
  });
}

// ==================== HIGH QUALITY RENDER ====================
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const id = uuidv4();
  const dir = path.join(TEMP_DIR, id);
  
  try {
    const { clips, subtitles, duration } = req.body;
    const clipData = JSON.parse(clips || '[]');
    const subData = subtitles ? JSON.parse(subtitles) : [];
    
    const validClips = clipData.filter(c => c && c.url);
    if (!validClips.length) return res.status(400).json({ error: 'No valid clips' });
    
    const actualCount = validClips.length;
    const clipDuration = 10;
    const adjustedTotal = actualCount * clipDuration;
    
    console.log(`🎬 HIGH QUALITY | ${actualCount} clips × 10s | CRF 20 medium`);
    
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
      
      // Video filter - scale only
      let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      
      // Subtitles
      const cStart = i * clipDuration;
      const cEnd = (i + 1) * clipDuration;
      const cSubs = subData.filter(s => parseFloat(s.startTime) >= cStart && parseFloat(s.startTime) < cEnd);
      const subText = cSubs.map(s => s.text).join(' ').replace(/['"\[\]{}%;:,]/g, '').trim().substring(0, 50);
      
      if (subText) {
        const esc = subText.replace(/'/g, "'\\''");
        vf += `,drawtext=text='${esc}':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h*0.08`;
      }
      
      // HIGH QUALITY ENCODE
      await runFfmpeg([
        '-i', raw, '-t', String(clipDuration), '-vf', vf,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-r', '30', '-threads', '1',
        '-an', '-y', seg
      ]);
      
      segments.push(seg);
      try { fs.unlinkSync(raw); } catch (e) {}
      if (global.gc) global.gc();
    }
    
    // Concatenate
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, segments.map(f => `file '${f}'`).join('\n'));
    const silent = path.join(dir, 'silent.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-an', '-y', silent]);
    segments.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    try { fs.unlinkSync(list); } catch (e) {}
    if (global.gc) global.gc();
    
    // Add audio
    const output = path.join(dir, 'output.mp4');
    await runFfmpeg([
      '-i', silent, '-i', audioPath, '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
      '-threads', '1', '-movflags', '+faststart',
      '-shortest', '-y', output
    ]);
    
    try { fs.unlinkSync(silent); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    const stat = fs.statSync(output);
    console.log(`✅ ${(stat.size/1024/1024).toFixed(2)}MB`);
    
    req.setTimeout(300000);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="HQ_short_${Date.now()}.mp4"`,
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

try { if (fs.existsSync(TEMP_DIR)) { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); } } catch (e) {}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT} | HIGH QUALITY MODE`));
