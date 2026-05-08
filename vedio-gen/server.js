const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Get FFmpeg path
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
  console.log('Temp directory created:', TEMP_DIR);
}

// Find available font
let FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
if (!fs.existsSync(FONT_PATH)) {
  FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  if (!fs.existsSync(FONT_PATH)) {
    console.log('⚠️ No font found - subtitles disabled');
    FONT_PATH = '';
  }
}
console.log('🔤 Font path:', FONT_PATH, fs.existsSync(FONT_PATH) ? '✅' : '❌');

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

// Run FFmpeg command
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    // Log the full command for debugging
    const cmdStr = args.join(' ');
    console.log('🎬 FFmpeg cmd length:', cmdStr.length, 'chars');
    console.log('🎬 First 300 chars:', cmdStr.substring(0, 300));
    
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error('❌ FFmpeg stderr (last 800 chars):', stderr.slice(-800));
        reject(new Error(`FFmpeg error (code ${code})`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
    
    // 5 minute timeout
    setTimeout(() => {
      proc.kill('SIGKILL');
    }, 300000);
  });
}

// Download file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    let resolved = false;
    
    const done = (err) => {
      if (resolved) return;
      resolved = true;
      file.close();
      if (err) {
        try { fs.unlinkSync(dest); } catch (e) {}
        reject(err);
      } else {
        resolve();
      }
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
      req.setTimeout(30000, () => {
        req.destroy();
        done(new Error('Download timeout'));
      });
    };
    
    makeRequest(url);
  });
}

// SAFE text escaping for FFmpeg drawtext
function safeText(text) {
  if (!text) return ' ';
  
  // Remove or replace ALL problematic characters
  let cleaned = text
    // Remove smart quotes and special unicode
    .replace(/[\u2018\u2019]/g, "'")     // Smart single quotes → regular
    .replace(/[\u201C\u201D]/g, '"')     // Smart double quotes → regular
    .replace(/[\u2013\u2014]/g, '-')     // Em/en dashes → hyphen
    .replace(/[\u2026]/g, '...')          // Ellipsis
    .replace(/[\u00A0]/g, ' ')           // Non-breaking space
    .replace(/[\u200B]/g, '')            // Zero-width space
    
    // Remove all characters except: letters, numbers, basic punctuation, spaces
    .replace(/[^\w\s.,!?;:'"()\-\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g, '')
    
    // Replace problematic FFmpeg characters with safe alternatives
    .replace(/,/g, ' ')      // Commas break FFmpeg filter parsing → use space
    .replace(/;/g, ' ')      // Semicolons → space
    .replace(/\[/g, '(')     // Brackets → parentheses
    .replace(/\]/g, ')')
    .replace(/{/g, '(')
    .replace(/}/g, ')')
    .replace(/%/g, ' percent')
    .replace(/:/g, ' -')     // Colons → dash
    .replace(/\\/g, '')      // Remove backslashes
    .replace(/"/g, "'")      // Double quotes → single quotes
    .replace(/'/g, '')       // Remove ALL quotes (safest)
    .replace(/\n/g, ' ')     // Newlines → space
    .replace(/\r/g, '')      // Remove carriage returns
    .replace(/\t/g, ' ')     // Tabs → space
    
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    
    // Trim
    .trim();
  
  // Limit length to prevent FFmpeg issues
  if (cleaned.length > 70) {
    cleaned = cleaned.substring(0, 67) + '...';
  }
  
  // If completely empty after cleaning, return space
  return cleaned || ' ';
}

// Build subtitle filter for a clip
function buildSubtitleFilter(subtitles, clipStart, clipEnd) {
  if (!FONT_PATH || !subtitles || subtitles.length === 0) return '';
  
  // Find subtitles that fall within this clip's time range
  const clipSubtitles = subtitles.filter(s => {
    const sStart = parseFloat(s.startTime);
    const cStart = parseFloat(clipStart);
    const cEnd = parseFloat(clipEnd);
    return sStart >= cStart && sStart < cEnd;
  });
  
  if (clipSubtitles.length === 0) return '';
  
  // Combine all subtitle text for this clip
  const rawText = clipSubtitles.map(s => s.text).join(' ');
  const text = safeText(rawText);
  
  if (!text || text.length < 2) return '';
  
  // Build a simple, safe drawtext filter
  // Using single quotes around the text with escaped special chars
  const escapedText = text.replace(/'/g, "'\\''");
  
  return `,drawtext=text='${escapedText}':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=(h-text_h)/2:fontfile='${FONT_PATH}'`;
}

// ==================== YOUTUBE-COMPATIBLE RENDER ====================
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, duration, subtitles } = req.body;
    const clipData = JSON.parse(clips);
    const subtitleData = subtitles ? JSON.parse(subtitles) : [];
    const audioBuffer = req.file ? req.file.buffer : null;
    const totalDuration = parseFloat(duration);
    
    if (!clipData || !clipData.length) {
      return res.status(400).json({ error: 'No video clips provided' });
    }
    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio provided' });
    }
    
    fs.mkdirSync(renderDir);
    
    // Limit clips for 2GB RAM
    const MAX_CLIPS = 5;
    const clipsToProcess = clipData.slice(0, MAX_CLIPS);
    
    console.log(`\n🎬 RENDER #${renderId}`);
    console.log(`📊 Clips: ${clipsToProcess.length}, Duration: ${totalDuration}s`);
    console.log(`📝 Subtitles: ${subtitleData.length} entries`);
    
    // Save audio
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    const clipDuration = Math.ceil(totalDuration / clipsToProcess.length);
    
    // Process each clip one at a time
    const trimmedFiles = [];
    
    for (let i = 0; i < clipsToProcess.length; i++) {
      console.log(`\n📹 Clip ${i+1}/${clipsToProcess.length}`);
      
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `trim_${i}.mp4`);
      trimmedFiles.push(trimmedPath);
      
      // Calculate time range for this clip
      const clipStart = i * clipDuration;
      const clipEnd = (i + 1) * clipDuration;
      
      // Build subtitle filter
      const subtitleFilter = buildSubtitleFilter(subtitleData, clipStart, clipEnd);
      
      // Download
      console.log(`  ⬇️ Downloading...`);
      await downloadFile(clipsToProcess[i].url, rawPath);
      
      // Build base video filter
      let videoFilter = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
      
      // Add subtitle filter if available
      if (subtitleFilter) {
        videoFilter += subtitleFilter;
        console.log(`  📝 Adding subtitle filter`);
      } else {
        console.log(`  ⚠️ No subtitles for this clip`);
      }
      
      // Build FFmpeg args
      const ffmpegArgs = [
        '-i', rawPath,
        '-t', String(clipDuration),
        '-vf', videoFilter,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'main',
        '-level', '4.0',
        '-r', '30',
        '-threads', '1',
        '-an',
        '-y',
        trimmedPath
      ];
      
      // Trim with subtitles
      console.log(`  ✂️ Trimming to ${clipDuration}s...`);
      await runFfmpeg(ffmpegArgs);
      
      // Delete raw immediately
      try { fs.unlinkSync(rawPath); } catch (e) {}
      
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      console.log(`  ✅ Done | RAM: ${mem}MB`);
      
      if (global.gc) global.gc();
    }
    
    // Concatenate all trimmed clips
    console.log(`\n🔗 Stitching ${trimmedFiles.length} clips...`);
    
    const listPath = path.join(renderDir, 'list.txt');
    fs.writeFileSync(listPath, trimmedFiles.map(f => `file '${f}'`).join('\n'));
    
    const silentVideo = path.join(renderDir, 'silent.mp4');
    
    await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'copy',
      '-an',
      '-y',
      silentVideo
    ]);
    
    // Clean up trimmed files
    for (const f of trimmedFiles) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    try { fs.unlinkSync(listPath); } catch (e) {}
    
    if (global.gc) global.gc();
    
    // Add audio to video
    console.log(`🎵 Adding audio...`);
    const outputPath = path.join(renderDir, 'output.mp4');
    
    await runFfmpeg([
      '-i', silentVideo,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-threads', '1',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputPath
    ]);
    
    // Clean up
    try { fs.unlinkSync(silentVideo); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    if (global.gc) global.gc();
    
    // Stream to client
    const stat = fs.statSync(outputPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    
    console.log(`\n✅ RENDER COMPLETE`);
    console.log(`📦 Output: ${sizeMB}MB`);
    console.log(`📤 Streaming to client...`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="shorts_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputPath);
    
    readStream.on('end', () => {
      setTimeout(() => {
        try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
      }, 60000);
    });
    
    readStream.on('error', (err) => {
      console.error('❌ Stream error:', err.message);
      try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      }
    });
    
    readStream.pipe(res);
    
  } catch (error) {
    console.error('❌ RENDER FAILED:', error.message);
    try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Cleanup on startup
try {
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log('🧹 Cleaned temp directory');
  }
} catch (e) {
  console.log('Cleanup error:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
});
