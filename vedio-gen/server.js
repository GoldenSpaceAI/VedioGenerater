const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

// Get FFmpeg path from the installer package
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

app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, timestamps, duration } = req.body;
    const clipData = JSON.parse(clips);
    const timestampData = JSON.parse(timestamps || '[]');
    const audioBuffer = req.file.buffer;
    const totalDuration = parseFloat(duration);
    
    if (!clipData || !clipData.length) {
      return res.status(400).json({ error: 'No video clips provided' });
    }
    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio provided' });
    }
    
    fs.mkdirSync(renderDir);
    console.log(`Starting render ${renderId}, ${clipData.length} clips`);
    
    // Save audio
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Calculate durations
    const clipDurations = [];
    if (timestampData.length > 0) {
      for (let i = 0; i < clipData.length; i++) {
        const startTime = timestampData[i] || 0;
        const endTime = (timestampData[i + 1] !== undefined) ? timestampData[i + 1] : totalDuration;
        clipDurations.push(Math.max(1, endTime - startTime));
      }
    } else {
      const equalDur = Math.ceil(totalDuration / clipData.length);
      for (let i = 0; i < clipData.length; i++) {
        clipDurations.push(equalDur);
      }
    }
    
    // Process each clip
    for (let i = 0; i < clipData.length; i++) {
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `clip_${i}.mp4`);
      
      console.log(`Clip ${i+1}/${clipData.length}: downloading...`);
      await downloadFile(clipData[i].url, rawPath);
      
      console.log(`Clip ${i+1}/${clipData.length}: trimming to ${clipDurations[i]}s...`);
      await runFfmpeg([
        '-i', rawPath,
        '-t', String(clipDurations[i]),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '30',
        '-an',
        '-y',
        trimmedPath
      ]);
      
      // Delete raw
      try { fs.unlinkSync(rawPath); } catch (e) {}
      console.log(`Clip ${i+1} done`);
    }
    
    // Concat list
    const listPath = path.join(renderDir, 'list.txt');
    let listContent = '';
    for (let i = 0; i < clipData.length; i++) {
      listContent += `file '${path.join(renderDir, `clip_${i}.mp4`)}'\n`;
    }
    fs.writeFileSync(listPath, listContent);
    
    // Final render
    const outputPath = path.join(renderDir, 'output.mp4');
    console.log('Final render...');
    
    await runFfmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-i', audioPath,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputPath
    ]);
    
    console.log('Sending file...');
    const videoBuffer = fs.readFileSync(outputPath);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': videoBuffer.length
    });
    res.send(videoBuffer);
    
    // Cleanup after 5 min
    setTimeout(() => {
      try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    }, 300000);
    
  } catch (error) {
    console.error('Render failed:', error.message);
    try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: error.message });
  }
});

// Clean old temp on startup
try {
  const dirs = fs.readdirSync(TEMP_DIR);
  for (const dir of dirs) {
    try { fs.rmSync(path.join(TEMP_DIR, dir), { recursive: true, force: true }); } catch (e) {}
  }
} catch (e) {}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
