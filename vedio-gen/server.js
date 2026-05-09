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

let FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
if (!fs.existsSync(FONT_PATH)) FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';

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
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(req.query.query)}&per_page=${req.query.per_page || 1}`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('🎬', args.join(' ').substring(0, 250));
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else { console.error('❌', stderr.slice(-400)); reject(new Error(`Code ${code}`)); }
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

function safeText(t, maxLen = 60) {
  return (t || '').replace(/['"\[\]{}%;:,]/g, '').replace(/\s+/g, ' ').trim().substring(0, maxLen);
}

// ==================== RENDER ====================
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const id = uuidv4();
  const dir = path.join(TEMP_DIR, id);
  
  try {
    const { clips, subtitles, introText, midText, endText, duration } = req.body;
    const clipData = JSON.parse(clips || '[]');
    const subData = subtitles ? JSON.parse(subtitles) : [];
    const intro = introText || '';
    const mid = midText || '';
    const end = endText || '';
    
    // Filter out null clips
    const validClips = clipData.filter(c => c && c.url);
    if (!validClips.length) return res.status(400).json({ error: 'No valid clips' });
    
    // Use only valid clips count
    const totalDuration = parseFloat(duration) || 30;
    const actualCount = validClips.length;
    const clipDuration = totalDuration / actualCount;
    
    console.log(`\n🎬 RENDER | ${actualCount} clips | ${totalDuration}s`);
    console.log(`📝 Intro: "${intro}" | Mid: "${mid}" | End: "${end}"`);
    console.log(`📊 Subtitles: ${subData.length} entries`);
    
    fs.mkdirSync(dir);
    
    // Audio
    const hasAudio = req.file && req.file.buffer && req.file.buffer.length > 500;
    const audioPath = path.join(dir, 'voice.webm');
    if (hasAudio) {
      fs.writeFileSync(audioPath, req.file.buffer);
      console.log('🎙️ Audio recorded');
    } else {
      await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(totalDuration), '-c:a', 'libopus', '-y', audioPath]);
      console.log('🔇 Silent audio generated');
    }
    
    const segments = [];
    
    for (let i = 0; i < actualCount; i++) {
      console.log(`\n📹 Clip ${i+1}/${actualCount}`);
      
      const raw = path.join(dir, `r${i}.mp4`);
      const seg = path.join(dir, `s${i}.mp4`);
      
      await downloadFile(validClips[i].url, raw);
      console.log(`  ⬇️ Downloaded`);
      
      const cStart = i * clipDuration;
      const cEnd = (i + 1) * clipDuration;
      
      // Get subtitles for this clip
      const cSubs = subData.filter(s => {
        const st = parseFloat(s.startTime);
        return st >= cStart && st < cEnd;
      });
      const subText = safeText(cSubs.map(s => s.text).join(' '));
      
      // Build video filter
      let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      
      // ===== SMOOTH TRANSITION (fade in) =====
      if (i > 0) {
        vf += `,fade=t=in:d=0.3`;
      }
      
      // ===== INTRO HOOK (first clip, 0-4 seconds) =====
      if (i === 0 && intro) {
        const escI = safeText(intro, 40).replace(/'/g, "'\\''");
        vf += `,drawtext=text='${escI}':fontcolor=yellow:fontsize=56:box=1:boxcolor=black@0.85:boxborderw=18:x=(w-text_w)/2:y=(h-text_h)/2:fontfile='${FONT_PATH}':enable='between(t,0,4)'`;
        console.log(`  ⚡ Intro hook added`);
      }
      
      // ===== SUBTITLES (top) =====
      if (subText && subText.length > 1) {
        const escS = subText.replace(/'/g, "'\\''");
        vf += `,drawtext=text='${escS}':fontcolor=white:fontsize=50:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-text_w)/2:y=h*0.06:fontfile='${FONT_PATH}'`;
      }
      
      // ===== MIDDLE TEXT (halfway clip, shows 3 seconds) =====
      const midClipIndex = Math.floor(actualCount / 2);
      if (mid && i === midClipIndex) {
        const escM = safeText(mid, 35).replace(/'/g, "'\\''");
        const midStart = cStart + 0.5;
        const midEnd = cStart + 3.5;
        vf += `,drawtext=text='${escM}':fontcolor=orange:fontsize=50:box=1:boxcolor=black@0.85:boxborderw=16:x=(w-text_w)/2:y=(h-text_h)/2:fontfile='${FONT_PATH}':enable='between(t,${midStart},${midEnd})'`;
        console.log(`  ❓ Middle text added at clip ${i+1}`);
      }
      
      // ===== END TEXT (last clip) =====
      if (end && i === actualCount - 1) {
        const escE = safeText(end, 30).replace(/'/g, "'\\''");
        vf += `,drawtext=text='${escE}':fontcolor=yellow:fontsize=58:box=1:boxcolor=black@0.85:boxborderw=18:x=(w-text_w)/2:y=(h-text_h)/2:fontfile='${FONT_PATH}':enable='between(t,${cStart+0.5},${cEnd})'`;
        console.log(`  💬 End text added`);
      }
      
      // Render
      await runFfmpeg([
        '-i', raw, '-t', String(clipDuration), '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
        '-r', '30', '-threads', '1', '-an', '-y', seg
      ]);
      
      segments.push(seg);
      try { fs.unlinkSync(raw); } catch (e) {}
      console.log(`  ✅ Rendered`);
      if (global.gc) global.gc();
    }
    
    // Concatenate
    console.log(`\n🔗 Concatenating...`);
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, segments.map(f => `file '${f}'`).join('\n'));
    const silent = path.join(dir, 'silent.mp4');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-an', '-y', silent]);
    segments.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    try { fs.unlinkSync(list); } catch (e) {}
    
    // Add audio
    console.log(`🎵 Adding audio...`);
    const output = path.join(dir, 'output.mp4');
    await runFfmpeg([
      '-i', silent, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '192k', '-ar', '44100', '-ac', '2', '-threads', '1',
      '-movflags', '+faststart', '-shortest', '-y', output
    ]);
    
    try { fs.unlinkSync(silent); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    const stat = fs.statSync(output);
    console.log(`✅ COMPLETE | ${(stat.size/1024/1024).toFixed(2)}MB`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="viral_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const stream = fs.createReadStream(output);
    stream.on('end', () => setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }, 60000));
    stream.pipe(res);
    
  } catch (e) {
    console.error('❌ RENDER FAILED:', e.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

try { if (fs.existsSync(TEMP_DIR)) { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); } } catch (e) {}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));
