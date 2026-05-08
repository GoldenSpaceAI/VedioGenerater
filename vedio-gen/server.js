      K;KM const express = require('express');
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

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
  console.log('Temp directory created');
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
    console.log('FFmpeg:', ffmpegPath, args.join(' '));
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg error (code ${code}): ${stderr.slice(-300)}`));
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

// Main render endpoint
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, timestamps, duration } = req.body;
    const clipData = JSON.parse(clips);
    const audioBuffer = req.file.buffer;
    const totalDuration = parseFloat(duration);
    
    if (!clipData || !clipData.length) {
      return res.status(400).json({ error: 'No video clips provided' });
    }
    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio provided' });
    }
    
    fs.mkdirSync(renderDir);
    console.log(`Starting render ${renderId} with ${clipData.length} clips, duration ${totalDuration}s`);
    
    // Save audio
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Calculate clip duration (equal split)
    const clipDuration = Math.ceil(totalDuration / clipData.length);
    
    // Process clips one at a time
    const trimmedPaths = [];
    for (let i = 0; i < clipData.length; i++) {
      const rawPath = path.join(renderDir, `r${i}.mp4`);
      const trimmedPath = path.join(renderDir, `t${i}.mp4`);
      trimmedPaths.push(trimmedPath);
      
      console.log(`Clip ${i+1}/${clipData.length}: downloading...`);
      await downloadFile(clipData[i].url, rawPath);
      
      console.log(`Clip ${i+1}/${clipData.length}: trimming to ${clipDuration}s...`);
      await runFfmpeg([
        '-i', rawPath,
        '-t', String(clipDuration),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '35',
        '-an',
        '-y',
        trimmedPath
      ]);
      
      // Delete raw immediately
      try { fs.unlinkSync(rawPath); } catch (e) {}
      console.log(`Clip ${i+1} done`);
    }
    
    // Create concat list
    const listPath = path.join(renderDir, 'list.txt');
    fs.writeFileSync(listPath, trimmedPaths.map(p => `file '${p}'`).join('\n'));
    
    // Step 1: Stitch video only (no audio, saves memory)
    const silentPath = path.join(renderDir, 'silent.mp4');
    console.log('Stitching video...');
    await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-y',
      silentPath
    ]);
    
    // Delete trimmed clips and list to free memory
    for (const p of trimmedPaths) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
    try { fs.unlinkSync(listPath); } catch (e) {}
    
    // Step 2: Add audio (copy video stream = zero memory)
    const outputPath = path.join(renderDir, 'output.mp4');
    console.log('Adding audio...');
    await runFfmpeg([
      '-i', silentPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputPath
    ]);
    
    // Delete silent video
    try { fs.unlinkSync(silentPath); } catch (e) {}
    
    // STREAM the file instead of loading into memory
    console.log('Streaming file to client...');
    const stat = fs.statSync(outputPath);
    console.log('Output size:', (stat.size / 1024 / 1024).toFixed(2), 'MB');
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    
    readStream.on('end', () => {
      setTimeout(() => {
        try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
      }, 60000);
    });
    
    readStream.on('error', (err) => {
      console.error('Stream error:', err.message);
      try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    });
    
  } catch (error) {
    console.error('Render failed:', error.message);
    try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: error.message });
  }
});

// Clean old temp files on startup
try {
  const dirs = fs.readdirSync(TEMP_DIR);
  for (const dir of dirs) {
    try { fs.rmSync(path.join(TEMP_DIR, dir), { recursive: true, force: true }); } catch (e) {}
  }
} catch (e) {}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
