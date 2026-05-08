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
    console.log('🎬 FFmpeg:', args.join(' ').substring(0, 200) + '...');
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error('❌ FFmpeg error:', stderr.slice(-500));
        reject(new Error(`FFmpeg error (code ${code})`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
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

// ==================== YOUTUBE-COMPATIBLE RENDER ====================
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, duration } = req.body;
    const clipData = JSON.parse(clips);
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
    const MAX_CLIPS = 4;
    const clipsToProcess = clipData.slice(0, MAX_CLIPS);
    
    console.log(`\n🎬 RENDER #${renderId}`);
    console.log(`📊 Clips: ${clipsToProcess.length}, Duration: ${totalDuration}s`);
    
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
      
      // Download
      console.log(`  ⬇️ Downloading...`);
      await downloadFile(clipsToProcess[i].url, rawPath);
      
      // Trim with YOUTUBE-COMPATIBLE settings
      console.log(`  ✂️ Trimming to ${clipDuration}s...`);
      await runFfmpeg([
        '-i', rawPath,
        '-t', String(clipDuration),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',        // REQUIRED for YouTube
        '-profile:v', 'main',          // YouTube compatible
        '-level', '4.0',
        '-r', '30',                    // Standard framerate
        '-threads', '1',
        '-an',
        '-y',
        trimmedPath
      ]);
      
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
      '-c:v', 'copy',              // Copy video (no re-encode = saves memory)
      '-c:a', 'aac',               // AAC audio required for YouTube
      '-b:a', '192k',              // Good audio quality
      '-ar', '44100',              // Standard sample rate
      '-ac', '2',                  // Stereo
      '-threads', '1',
      '-movflags', '+faststart',   // Web optimized (YouTube likes this)
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
      }, 30000);
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
