const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Multer setup for audio upload
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB max
});

// Temp directory for video processing
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy endpoint for GPT
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

// Proxy endpoint for Pexels videos
app.get('/api/pexels/videos', async (req, res) => {
  try {
    const { query, per_page } = req.query;
    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page || 1}`,
      {
        headers: { 'Authorization': `${process.env.PEXELS_API_KEY}` }
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Render video endpoint
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = path.join(TEMP_DIR, renderId);
  
  try {
    const { clips, duration } = req.body;
    const clipData = JSON.parse(clips);
    const audioBuffer = req.file.buffer;
    const totalDuration = parseFloat(duration);
    
    if (!clipData || !clipData.length) {
      return res.status(400).json({ error: 'No video clips provided' });
    }
    
    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio provided' });
    }
    
    // Create temp directory
    fs.mkdirSync(renderDir);
    
    const clipDuration = Math.ceil(totalDuration / clipData.length);
    
    // Save audio
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Download and process each clip
    for (let i = 0; i < clipData.length; i++) {
      const clipUrl = clipData[i].url;
      const inputPath = path.join(renderDir, `raw_${i}.mp4`);
      const outputPath = path.join(renderDir, `clip_${i}.mp4`);
      
      // Download clip
      await downloadFile(clipUrl, inputPath);
      
      // Trim and resize clip
      await processClip(inputPath, outputPath, clipDuration);
    }
    
    // Create concat list
    const concatPath = path.join(renderDir, 'list.txt');
    const concatContent = clipData.map((_, i) => `file '${path.join(renderDir, `clip_${i}.mp4`)}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);
    
    // Final render
    const outputPath = path.join(renderDir, 'output.mp4');
    
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .input(audioPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
          '-shortest'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Send file to client
    const videoBuffer = fs.readFileSync(outputPath);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="short_${Date.now()}.mp4"`,
      'Content-Length': videoBuffer.length
    });
    res.send(videoBuffer);
    
    // Cleanup temp files
    setTimeout(() => {
      try {
        fs.rmSync(renderDir, { recursive: true, force: true });
      } catch (e) {
        console.log('Cleanup error:', e.message);
      }
    }, 60000); // Delete after 1 minute
    
  } catch (error) {
    console.error('Render error:', error);
    
    // Cleanup on error
    try {
      fs.rmSync(renderDir, { recursive: true, force: true });
    } catch (e) {}
    
    res.status(500).json({ error: error.message });
  }
});

// Download file utility
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    
    protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

// Process clip (trim + resize)
function processClip(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-t', String(duration),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-an'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Cleanup old temp files on startup
try {
  const dirs = fs.readdirSync(TEMP_DIR);
  dirs.forEach(dir => {
    const dirPath = path.join(TEMP_DIR, dir);
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (e) {}
  });
} catch (e) {}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shorts Forge running on port ${PORT}`);
  console.log(`FFmpeg path: ${ffmpegPath}`);
});
