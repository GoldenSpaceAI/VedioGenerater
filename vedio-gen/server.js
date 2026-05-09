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
  ffmpegPath = 'ffmpeg';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

const TEMP_DIR = '/tmp/video-gen';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
if (!fs.existsSync(FONT_PATH)) {
  FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';
  if (!fs.existsSync(FONT_PATH)) {
    FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  }
}
console.log('🔤 Font:', FONT_PATH, fs.existsSync(FONT_PATH) ? '✅' : '❌');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.7 })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PEXELS VIDEOS
app.get('/api/pexels/videos', async (req, res) => {
  try {
    const { query, per_page } = req.query;
    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page || 1}`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } }
    );
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PEXELS IMAGES - THIS IS THE MISSING ENDPOINT
app.get('/api/pexels/images', async (req, res) => {
  try {
    const { query, per_page } = req.query;
    console.log('🖼️ Fetching images for:', query);
    const response = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${per_page || 3}&orientation=portrait`,
      { headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` } }
    );
    const data = await response.json();
    console.log('📸 Got', data.photos?.length || 0, 'images');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('🎬 FFmpeg:', args.join(' ').substring(0, 300));
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
    setTimeout(() => proc.kill('SIGKILL'), 600000);
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
      req.setTimeout(60000, () => { req.destroy(); done(new Error('Timeout')); });
    };
    makeRequest(url);
  });
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/[\[\]{}%;\\"']/g, '')
    .replace(/:/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (testLine.length <= maxCharsPerLine) currentLine = testLine;
    else { if (currentLine) lines.push(currentLine); currentLine = word; }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function buildSubtitleFilter(subtitles, clipStart, clipEnd) {
  if (!FONT_PATH || !subtitles || subtitles.length === 0) return '';
  const clipSubtitles = subtitles.filter(s => parseFloat(s.startTime) >= clipStart && parseFloat(s.startTime) < clipEnd);
  if (clipSubtitles.length === 0) return '';
  const rawText = clipSubtitles.map(s => s.text).join(' ');
  const text = cleanText(rawText);
  if (!text || text.length < 2) return '';
  const allLines = wrapText(text, 28);
  const displayLines = allLines.slice(0, 2);
  const filters = [];
  const fontSize = 44;
  const lineHeight = 56;
  const baseY = 'h*0.30';
  displayLines.forEach((line, index) => {
    const escaped = line.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const yPos = index === 0 ? `y=${baseY}` : `y=${baseY}+${lineHeight}`;
    filters.push(`drawtext=text='${escaped}':fontcolor=white:fontsize=${fontSize}:box=1:boxcolor=black@0.65:boxborderw=8:x=(w-text_w)/2:${yPos}:fontfile='${FONT_PATH}'`);
  });
  return ',' + filters.join(',');
}

async function renderShorts(clipsToProcess, audioPath, totalDuration, subtitleData, renderDir) {
  const clipDuration = Math.ceil(totalDuration / clipsToProcess.length);
  const trimmedFiles = [];
  for (let i = 0; i < clipsToProcess.length; i++) {
    console.log(`📹 Clip ${i+1}/${clipsToProcess.length}`);
    const rawPath = path.join(renderDir, `raw_${i}.mp4`);
    const trimmedPath = path.join(renderDir, `trim_${i}.mp4`);
    trimmedFiles.push(trimmedPath);
    const clipStart = i * clipDuration;
    const clipEnd = (i + 1) * clipDuration;
    const subFilter = buildSubtitleFilter(subtitleData, clipStart, clipEnd);
    await downloadFile(clipsToProcess[i].url, rawPath);
    let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
    if (subFilter) vf += subFilter;
    await runFfmpeg(['-i', rawPath, '-t', String(clipDuration), '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
      '-r', '30', '-threads', '1', '-an', '-y', trimmedPath]);
    try { fs.unlinkSync(rawPath); } catch (e) {}
    if (global.gc) global.gc();
  }
  const listPath = path.join(renderDir, 'list.txt');
  fs.writeFileSync(listPath, trimmedFiles.map(f => `file '${f}'`).join('\n'));
  const silentVideo = path.join(renderDir, 'silent.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy', '-an', '-y', silentVideo]);
  for (const f of trimmedFiles) try { fs.unlinkSync(f); } catch (e) {}
  try { fs.unlinkSync(listPath); } catch (e) {}
  const outputPath = path.join(renderDir, 'output.mp4');
  await runFfmpeg(['-i', silentVideo, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac',
    '-b:a', '192k', '-ar', '44100', '-ac', '2', '-threads', '1',
    '-movflags', '+faststart', '-shortest', '-y', outputPath]);
  try { fs.unlinkSync(silentVideo); } catch (e) {}
  return outputPath;
}

async function renderLongVideo(images, audioPath, totalDuration, subtitleData, renderDir, hasAudio) {
  const imageDuration = totalDuration / images.length;
  const imageFiles = [];
  for (let i = 0; i < images.length; i++) {
    console.log(`🖼️ Image ${i+1}/${images.length}`);
    const imgPath = path.join(renderDir, `img_${i}.jpg`);
    await downloadFile(images[i].url, imgPath);
    imageFiles.push(imgPath);
  }
  const segments = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const segPath = path.join(renderDir, `seg_${i}.mp4`);
    const startTime = i * imageDuration;
    const endTime = (i + 1) * imageDuration;
    const subFilter = buildSubtitleFilter(subtitleData, startTime, endTime);
    let vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0004,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920`;
    if (subFilter) vf += subFilter;
    await runFfmpeg(['-loop', '1', '-i', imageFiles[i], '-t', String(imageDuration), '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '1', '-an', '-y', segPath]);
    segments.push(segPath);
    if (global.gc) global.gc();
  }
  for (const f of imageFiles) try { fs.unlinkSync(f); } catch (e) {}
  const listPath = path.join(renderDir, 'list.txt');
  fs.writeFileSync(listPath, segments.map(f => `file '${f}'`).join('\n'));
  const silentVideo = path.join(renderDir, 'silent.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'copy', '-an', '-y', silentVideo]);
  for (const f of segments) try { fs.unlinkSync(f); } catch (e) {}
  try { fs.unlinkSync(listPath); } catch (e) {}
  const outputPath = path.join(renderDir, 'output.mp4');
  if (hasAudio && audioPath && fs.existsSync(audioPath)) {
    await runFfmpeg(['-i', silentVideo, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '192k', '-ar', '44100', '-ac', '2', '-threads', '1',
      '-movflags', '+faststart', '-shortest', '-y', outputPath]);
  } else {
    fs.copyFileSync(silentVideo, outputPath);
  }
  try { fs.unlinkSync(silentVideo); } catch (e) {}
  return outputPath;
}

app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  try {
    const { clips, images, duration, subtitles, mode } = req.body;
    const totalDuration = parseFloat(duration);
    const subtitleData = subtitles ? JSON.parse(subtitles) : [];
    const isLongMode = mode === 'long';
    fs.mkdirSync(renderDir);
    let audioPath = null;
    let hasAudio = false;
    if (req.file && req.file.buffer && req.file.buffer.length > 1000) {
      audioPath = path.join(renderDir, 'voice.webm');
      fs.writeFileSync(audioPath, req.file.buffer);
      hasAudio = true;
    }
    let outputPath;
    if (isLongMode) {
      const imageData = JSON.parse(images || '[]');
      if (!imageData.length) return res.status(400).json({ error: 'No images' });
      console.log(`🖼️ LONG | ${imageData.length} images | ${totalDuration}s`);
      outputPath = await renderLongVideo(imageData, audioPath, totalDuration, subtitleData, renderDir, hasAudio);
    } else {
      const clipData = JSON.parse(clips || '[]');
      if (!clipData.length) return res.status(400).json({ error: 'No clips' });
      if (!hasAudio) return res.status(400).json({ error: 'Audio required' });
      console.log(`🎬 SHORTS | ${clipData.length} clips | ${totalDuration}s`);
      outputPath = await renderShorts(clipData.slice(0, 5), audioPath, totalDuration, subtitleData, renderDir);
    }
    const stat = fs.statSync(outputPath);
    console.log(`✅ Done | ${(stat.size/1024/1024).toFixed(2)}MB`);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${isLongMode ? 'video' : 'short'}_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    const readStream = fs.createReadStream(outputPath);
    readStream.on('end', () => setTimeout(() => { try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {} }, 60000));
    readStream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream failed' }); });
    readStream.pipe(res);
  } catch (error) {
    console.error('❌', error.message);
    try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

try {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch (e) {}

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT} | RAM: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(1)}MB`));
