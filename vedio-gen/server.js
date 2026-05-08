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
    console.log('FFmpeg command:', ffmpegPath, args.join(' '));
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg stderr:', stderr.slice(-500));
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
    
    // Kill FFmpeg if it runs too long (2 minutes max)
    setTimeout(() => {
      proc.kill('SIGTERM');
    }, 120000);
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
      
      console.log(`Downloading: ${currentUrl}`);
      
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
      
      req.on('error', done);
      req.setTimeout(30000, () => {
        req.destroy();
        done(new Error('Download timeout'));
      });
    };
    
    makeRequest(url);
  });
}

// OPTIMIZED Render endpoint for 2GB RAM
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, timestamps, duration } = req.body;
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
    console.log(`Starting render ${renderId} - ${clipData.length} clips, ${totalDuration}s using ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB RAM`);
    
    // Save audio once
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Calculate equal clip duration
    const clipDuration = Math.ceil(totalDuration / clipData.length);
    
    // Process ONE clip at a time
    const finalOutput = path.join(renderDir, 'final_silent.mp4');
    let firstClip = true;
    
    for (let i = 0; i < clipData.length; i++) {
      console.log(`\n📹 Clip ${i+1}/${clipData.length} (Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB)`);
      
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `trimmed_${i}.mp4`);
      const tempOutput = path.join(renderDir, `temp_${i}.mp4`);
      
      // Step 1: Download clip
      console.log(`  ⬇️ Downloading...`);
      await downloadFile(clipData[i].url, rawPath);
      const rawSize = (fs.statSync(rawPath).size / 1024 / 1024).toFixed(2);
      console.log(`  Downloaded: ${rawSize}MB`);
      
      // Step 2: Trim and scale clip (optimized for low RAM)
      console.log(`  ✂️ Trimming to ${clipDuration}s...`);
      await runFfmpeg([
        '-i', rawPath,
        '-t', String(clipDuration),
        '-vf', 'scale=480:854:force_original_aspect_ratio=increase,crop=480:854',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '38',
        '-threads', '1',
        '-bufsize', '200k',
        '-maxrate', '200k',
        '-an',
        '-y',
        trimmedPath
      ]);
      
      // Delete raw immediately
      fs.unlinkSync(rawPath);
      console.log(`  ✅ Trimmed successfully`);
      
      // Step 3: Concatenate or create base
      if (firstClip) {
        fs.copyFileSync(trimmedPath, finalOutput);
        fs.unlinkSync(trimmedPath);
        firstClip = false;
        console.log(`  📁 Created base video`);
      } else {
        const listPath = path.join(renderDir, 'concat.txt');
        fs.writeFileSync(listPath, `file '${finalOutput}'\nfile '${trimmedPath}'`);
        
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
          tempOutput
        ]);
        
        // Replace final with new concatenated version
        fs.unlinkSync(finalOutput);
        fs.renameSync(tempOutput, finalOutput);
        fs.unlinkSync(trimmedPath);
        fs.unlinkSync(listPath);
        console.log(`  🔗 Concatenated`);
      }
      
      // Force garbage collection
      if (global.gc) {
        global.gc();
        console.log(`  🗑️ GC triggered (Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB)`);
      }
    }
    
    // Step 4: Add audio to final video
    const outputWithAudio = path.join(renderDir, 'output.mp4');
    console.log(`\n🎵 Adding audio to final video...`);
    await runFfmpeg([
      '-i', finalOutput,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-threads', '1',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputWithAudio
    ]);
    
    // Clean up intermediate files
    fs.unlinkSync(finalOutput);
    fs.unlinkSync(audioPath);
    
    // Stream to client
    console.log(`\n📤 Streaming to client...`);
    const stat = fs.statSync(outputWithAudio);
    console.log(`Output size: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    console.log(`Final memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputWithAudio);
    
    readStream.on('end', () => {
      setTimeout(() => {
        try {
          if (fs.existsSync(renderDir)) {
            fs.rmSync(renderDir, { recursive: true, force: true });
            console.log('🧹 Cleaned up render directory');
          }
        } catch (e) {
          console.error('Cleanup error:', e.message);
        }
      }, 30000);
    });
    
    readStream.on('error', (err) => {
      console.error('❌ Stream error:', err);
      try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      }
    });
    
    readStream.pipe(res);
    
  } catch (error) {
    console.error('❌ Render failed:', error.message);
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
        console.log('Cleaned old temp:', dir);
      } catch (e) {
        console.log('Cleanup failed for:', dir);
      }
    }
  }
} catch (e) {
  console.log('Temp cleanup error:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT} with ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB RAM used`);
});
