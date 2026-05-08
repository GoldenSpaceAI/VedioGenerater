// Main render endpoint - OPTIMIZED FOR 2GB RAM
app.post('/api/render', upload.single('audio'), async (req, res) => {
  const renderId = uuidv4();
  const renderDir = '/tmp/video-' + renderId; // Use /tmp for disk space
  
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
    console.log(`Starting render ${renderId} - ${clipData.length} clips, ${totalDuration}s`);
    
    // Save audio once
    const audioPath = path.join(renderDir, 'voice.webm');
    fs.writeFileSync(audioPath, audioBuffer);
    
    // Calculate equal clip duration
    const clipDuration = Math.ceil(totalDuration / clipData.length);
    
    // Process ONE clip at a time, trim it, and immediately concatenate to output
    const finalOutput = path.join(renderDir, 'final_silent.mp4');
    let firstClip = true;
    let currentOutput = finalOutput;
    
    for (let i = 0; i < clipData.length; i++) {
      console.log(`Processing clip ${i+1}/${clipData.length}...`);
      
      const rawPath = path.join(renderDir, `raw_${i}.mp4`);
      const trimmedPath = path.join(renderDir, `trimmed_${i}.mp4`);
      const tempOutput = path.join(renderDir, `temp_${i}.mp4`);
      
      // Step 1: Download clip
      console.log(`  Downloading clip ${i+1}...`);
      await downloadFile(clipData[i].url, rawPath);
      console.log(`    Downloaded: ${(fs.statSync(rawPath).size / 1024 / 1024).toFixed(2)}MB`);
      
      // Step 2: Trim and scale clip (LOW QUALITY for 2GB RAM)
      console.log(`  Trimming to ${clipDuration}s...`);
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
      
      // DELETE raw immediately
      fs.unlinkSync(rawPath);
      console.log('  Trimmed and cleaned raw file');
      
      // Step 3: Concatenate or create final video
      if (firstClip) {
        // First clip becomes the base
        fs.copyFileSync(trimmedPath, finalOutput);
        fs.unlinkSync(trimmedPath);
        firstClip = false;
        console.log('  Base video created');
      } else {
        // Concatenate current final with new trimmed clip
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
        console.log('  Concatenated successfully');
      }
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        console.log('  GC triggered');
      }
    }
    
    // Step 4: Add audio to final video using stream copy (memory efficient)
    const outputWithAudio = path.join(renderDir, 'output.mp4');
    console.log('Adding audio...');
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
    console.log('Streaming to client...');
    const stat = fs.statSync(outputWithAudio);
    console.log(`Output size: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="video_${Date.now()}.mp4"`,
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(outputWithAudio);
    
    readStream.on('end', () => {
      // Clean up everything after 30 seconds
      setTimeout(() => {
        try {
          if (fs.existsSync(renderDir)) {
            fs.rmSync(renderDir, { recursive: true, force: true });
            console.log('Cleaned up render directory');
          }
        } catch (e) {
          console.error('Cleanup error:', e.message);
        }
      }, 30000);
    });
    
    readStream.on('error', (err) => {
      console.error('Stream error:', err);
      try { fs.rmSync(renderDir, { recursive: true, force: true }); } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream failed' });
      }
    });
    
    readStream.pipe(res);
    
  } catch (error) {
    console.error('Render failed:', error);
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
