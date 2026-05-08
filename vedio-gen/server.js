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
try {
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  console.log('FFmpeg found at:', ffmpegPath);
} catch (e) {
  console.log('FFmpeg installer not found, trying system ffmpeg...');
  ffmpegPath = 'ffmpeg';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const TEMP_DIR = '/tmp/video-gen';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
if (!fs.existsSync(FONT_PATH)) {
  FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';
  if (!fs.existsSync(FONT_PATH)) {
    console.log('⚠️ No font found');
    FONT_PATH = '';
  }
}
console.log('🔤 Font:', FONT_PATH, fs.existsSync(FONT_PATH) ? '✅' : '❌');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        temperature: 0.7
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/pexels/videos', async (req, res) => {
  try {
    const { query, per_page } = req.query;
    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page || 1}`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('🎬 FFmpeg:', args.join(' ').substring(0, 200));
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        console.error('❌ FFmpeg error:', stderr.slice(-500));
        reject(new Error(`FFmpeg code ${code}`));
      }
    });
    
    proc.on('error', (err) => reject(err));
    setTimeout(() => proc.kill('SIGKILL'), 300000);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    let resolved = false;
    
    const done = (err) => {
      if (resolved) return;
      resolved = true;
      file.close();
      if (err) { try { fs.unlinkSync(dest); } catch (e) {} reject(err); }
      else resolve();
    };
    
    const makeRequest = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) return done(new Error('Too many redirects'));
      const req = protocol.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          req.destroy();
          return makeRequest(response.headers.location, redirectCount + 1);
        }
        response.pipe(file);
        file.on('finish', () => done(null));
      });
      req.on('error', done);
      req.setTimeout(30000, () => { req.destroy(); done(new Error('Timeout')); });
    };
    
    makeRequest(url);
  });
}

// Clean text for subtitles - removes special chars only
function cleanText(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\[\]{}%;\\]/g, '')
    .replace(/"/g, '')
    .replace(/'/g, '')
    .replace(/:/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build subtitle filter - MULTI-LINE with word wrap
function buildSubtitleFilter(subtitles, clipStart, clipEnd) {
  if (!FONT_PATH || !subtitles || subtitles.length === 0) return '';
  
  const clipSubtitles = subtitles.filter(s => {
    const sStart = parseFloat(s.startTime);
    return sStart >= clipStart && sStart < clipEnd;
  });
  
  if (clipSubtitles.length === 0) return '';
  
  // Get text and clean it
  let text = clipSubtitles.map(s => s.text).join(' ');
  text = cleanText(text);
  
  if (!text || text.length < 1) return '';
  
  // Limit to ~60 chars per line, split into max 2 lines
  const maxCharsPerLine = 55;
  let line1 = text;
  let line2 = '';
  
  if (text.length > maxCharsPerLine) {
    // Find a space near the middle to split
    const midPoint = Math.floor(text.length / 2);
    let splitPoint = text.indexOf(' ', midPoint);
    if (splitPoint === -1 || splitPoint > maxCharsPerLine) {
      splitPoint = text.indexOf(' ', maxCharsPerLine);
    }
    if (splitPoint > 0 && splitPoint < maxCharsPerLine + 20) {
      line1 = text.substring(0, splitPoint).trim();
      line2 = text.substring(splitPoint + 1).trim();
      if (line2.length > maxCharsPerLine) {
        line2 = line2.substring(0, maxCharsPerLine - 3) + '...';
      }
    } else {
      line1 = text.substring(0, maxCharsPerLine - 3) + '...';
    }
  }
  
  // Escape for FFmpeg
  const esc1 = line1.replace(/'/g, "'\\''");
  const esc2 = line2.replace(/'/g, "'\\''");
  
  if (line2) {
    // Two-line subtitle
    return `,drawtext=text='${esc1}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.5:boxborderw=6:x=(w-text_w)/2:y=h-th-80:fontfile='${FONT_PATH}',drawtext=text='${esc2}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.5:boxborderw=6:x=(w-text_w)/2:y=h-th-30:fontfile='${FONT_PATH}'`;
  } else {
    // Single line subtitle - centered near bottom
    return `,drawtext=text='${esc1}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.5:boxborderw=6:x=(w-text_w)/2:y=h-th-60:fontfile='${FONT_PATH}'`;
  }
}

// RENDER ENDPOINT
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, duration, subtitles } = req.body;
    const clipData = JSON.parse(clips);
    const subtitleData = subtitles ? JSON.parse(subtitles) : [];
    const audioBuffer = req.file ? req.file.buffer : null;
    const totalDuration = parseFloat(duration);
    
    if (!clipData || !clipData.length) return res.status(400).json({ error: 'No clips' });
    if (!audioBuffer) return res.status(400).json({ error: 'No audio' });
    
    fs.mkdirSync(renderDir);
    
    const MAX_CLIPS = 5;
    const clipsToProcess = clipData.slice(0, MAX_CLIPS);
    
    console.log(`\n🎬 RENDER #${renderId} | ${clipsToProcess.length} clips | ${totalDuration}s | ${subtitleData.length} subs`);
    
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    const clipDuration = Math.ceil(totalDuration / clipsToProcess.length);
    const trimmedFiles = [];
    
    for (let i = 0; i < clipsToProcess.length; i++) {
      console.log(`📹 Clip ${i+1}/${clipsToProcess.length}`);
      
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `trim_${i}.mp4`);
      trimmedFiles.push(trimmedPath);
      
      const clipStart = i * clipDuration;
      const clipEnd = (i + 1) * clipDuration;
      const subtitleFilter = buildSubtitleFilter(subtitleData, clipStart, clipEnd);
      
      await downloadFile(clipsToProcess[i].url, rawPath);
      
      let videoFilter = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      if (subtitleFilter) {
        videoFilter += subtitleFilter;
        console.log(`  📝 Subs added`);
      }
      
      await runFfmpeg([
        '-i', rawPath, '-t', String(clipDuration), '-vf', videoFilter,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
        '-r', '30', '-threads', '1', '-an', '-y', trimmedPath
      ]);
      
      try { fs.unlinkSync(rawPath); } catch (e) {}
      console.log(`  ✅ Done`);
      if (global.gc) global.gc();
    }
    
    // Concat
    const listPath = path.join(renderDir, 'list.txt');
    fs.writeFileSync(listPath, trimmedFiles.map(f => `file '${f}'`).join('\n'));
    const silentVideo = path.join(renderDir, 'silent.mp4');
    
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy', '-an', '-y', silentVideo]);
    
    for (const f of trimmedFiles) try { fs.unlinkSync(f); } catch (e) {}
    try { fs.unlinkSync(listPath); } catch (e) {}
    if (global.gc) global.gc();
    
    // Add audio
    const outputPath = path.join(renderDir, 'output.mp4');
    await runFfmpeg([
      '-i', silentVideo, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '192k', '-ar', '44100', '-ac', '2', '-threads', '1',
      '-movflags', '+faststart', '-shortest', '-y', outputPath
    ]);
    
    try { fs.unlinkSync(silentVideo); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    const stat = fs.statSync(outputPath);
    console.log(`✅ Done | ${(stat.size/1024/1024).toFixed(2)}MB`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputPath);
    readStream.on('end', () => setTimeout(() => { try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {} }, 60000));
    readStream.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: 'Stream failed' }); });
    readStream.pipe(res);
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

try {
  if (fs.existsSync(TEMP_DIR)) { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TEMP_DIR, { recursive: true }); }
} catch (e) {}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));
