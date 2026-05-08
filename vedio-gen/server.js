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

// Run FFmpeg command with timeout
function runFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    console.log('🎬 FFmpeg:', args.join(' ').substring(0, 200) + '...');
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    let timedOut = false;
    
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error('FFmpeg timed out'));
    }, timeoutMs);
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg error:', stderr.slice(-300));
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
  });
}

// Download file with retries
function downloadFile(url, dest, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dest);
      let resolved = false;
      
      const done = (err) => {
        if (resolved) return;
        resolved = true;
        file.close();
        if (err) {
          try { fs.unlinkSync(dest); } catch (e) {}
          if (remaining > 0) {
            console.log(`Retrying download (${remaining} attempts left)...`);
            setTimeout(() => attempt(remaining - 1), 2000);
          } else {
            reject(err);
          }
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
          
          if (response.statusCode !== 200) {
            req.destroy();
            return done(new Error(`HTTP ${response.statusCode}`));
          }
          
          response.pipe(file);
          file.on('finish', () => done(null));
        });
        
        req.on('error', (err) => done(err));
        req.setTimeout(30000, () => {
          req.destroy();
          done(new Error('Download timeout'));
        });
      };
      
      makeRequest(url);
    };
    
    attempt(retries);
  });
}

// MAIN RENDER ENDPOINT - Optimized for 2GB RAM
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
    
    // LIMIT TO MAX 5 CLIPS to prevent OOM
    const MAX_CLIPS = 5;
    const clipsToProcess = clipData.slice(0, MAX_CLIPS);
    
    console.log(`\n🎬 RENDER START - ID: ${renderId}`);
    console.log(`📊 Clips: ${clipsToProcess.length} (limited from ${clipData.length})`);
    console.log(`⏱️ Duration: ${totalDuration}s`);
    console.log(`💾 Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB\n`);
    
    // Save audio
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Calculate equal clip duration
    const clipDuration = Math.ceil(totalDuration / clipsToProcess.length);
    
    // Process clips ONE AT A TIME - download, trim, delete raw
    const trimmedFiles = [];
    
    for (let i = 0; i < clipsToProcess.length; i++) {
      console.log(`📹 Clip ${i+1}/${clipsToProcess.length}`);
      
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `trimmed_${i}.mp4`);
      trimmedFiles.push(trimmedPath);
      
      // Download
      console.log(`  ⬇️ Downloading...`);
      await downloadFile(clipsToProcess[i].url, rawPath);
      
      // Trim with VERY LOW settings for 2GB RAM
      console.log(`  ✂️ Trimming to ${clipDuration}s...`);
      await runFfmpeg([
        '-i', rawPath,
        '-t', String(clipDuration),
        '-vf', 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '42',
        '-threads', '1',
        '-bufsize', '100k',
        '-maxrate', '100k',
        '-an',
        '-y',
        trimmedPath
      ]);
      
      // DELETE RAW IMMEDIATELY
      try { fs.unlinkSync(rawPath); } catch (e) {}
      
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      console.log(`  ✅ Done (Memory: ${mem}MB)`);
      
      // Force garbage collection
      if (global.gc) global.gc();
    }
    
    // CONCATENATE ALL TRIMMED CLIPS
    console.log(`\n🔗 Concatenating ${trimmedFiles.length} clips...`);
    
    const listPath = path.join(renderDir, 'list.txt');
    const listContent = trimmedFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    
    const silentVideo = path.join(renderDir, 'silent.mp4');
    
    await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '38',
      '-threads', '1',
      '-an',
      '-y',
      silentVideo
    ], 180000); // 3 minute timeout for concat
    
    // DELETE trimmed clips and list
    for (const f of trimmedFiles) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    try { fs.unlinkSync(listPath); } catch (e) {}
    
    if (global.gc) global.gc();
    
    // ADD AUDIO
    console.log(`🎵 Adding audio...`);
    const outputPath = path.join(renderDir, 'output.mp4');
    
    await runFfmpeg([
      '-i', silentVideo,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-threads', '1',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputPath
    ]);
    
    // DELETE silent video and audio
    try { fs.unlinkSync(silentVideo); } catch (e) {}
    try { fs.unlinkSync(audioPath); } catch (e) {}
    
    if (global.gc) global.gc();
    
    // STREAM TO CLIENT
    const stat = fs.statSync(outputPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    
    console.log(`\n✅ RENDER COMPLETE`);
    console.log(`📦 Output: ${sizeMB}MB`);
    console.log(`💾 Memory: ${memMB}MB`);
    console.log(`📤 Streaming to client...\n`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputPath);
    
    readStream.on('end', () => {
      setTimeout(() => {
        try {
          if (fs.existsSync(renderDir)) {
            fs.rmSync(renderDir, { recursive: true, force: true });
            console.log('🧹 Cleaned up render directory');
          }
        } catch (e) {
          console.log('Cleanup error:', e.message);
        }
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
    console.error(error.stack);
    
    try {
      if (fs.existsSync(renderDir)) {
        fs.rmSync(renderDir, { recursive: true, force: true });
      }
    } catch (e) {}
    
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Clean old temp files on startup
try {
  if (fs.existsSync(TEMP_DIR)) {
    const dirs = fs.readdirSync(TEMP_DIR);
    for (const dir of dirs) {
      try {
        fs.rmSync(path.join(TEMP_DIR, dir), { recursive: true, force: true });
      } catch (e) {}
    }
    console.log('🧹 Cleaned old temp files');
  }
} catch (e) {
  console.log('Temp cleanup error:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💾 Initial memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
});
