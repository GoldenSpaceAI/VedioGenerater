// ==================== STATE ====================
let scenes = [];
let sceneTimestamps = [];
let videoClips = [];
let recordedAudio = null;
let videoDuration = 0;

// ==================== SCENES (WITH TIMESTAMPS) ====================
async function extractScenes() {
  const script = document.getElementById('scriptInput').value.trim();
  if (!script) return alert('Paste your script first.');
  const btn = document.getElementById('btnScenes');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.innerHTML = '<span class="spinner"></span> Analyzing script...';

  const charCount = script.length;
  const estDuration = Math.min(60, charCount / 15);
  const numScenes = Math.max(2, Math.min(8, Math.ceil(estDuration / 5)));

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: `Split this voiceover script into ${numScenes} visual scenes. For each scene, provide the START TIMESTAMP (in seconds) and 3-5 keyword search terms.

Format exactly like this (one scene per line):
0 nature forest trees
5 city traffic cars
12 office desk work

The timestamps should spread evenly across the estimated ${Math.round(estDuration)} second duration. Output ONLY the formatted lines, nothing else.`
          },
          { role: 'user', content: script }
        ]
      })
    });
    const d = await r.json();
    if (d.choices?.[0]) {
      const lines = d.choices[0].message.content.split('\n').filter(l => l.trim());
      scenes = [];
      sceneTimestamps = [];
      
      lines.forEach(line => {
        const parts = line.trim().split(' ');
        const timestamp = parseFloat(parts[0]);
        const keywords = parts.slice(1).join(' ');
        if (!isNaN(timestamp) && keywords) {
          sceneTimestamps.push(timestamp);
          scenes.push(keywords);
        }
      });

      if (scenes.length === 0) {
        // Fallback: use old method
        scenes = lines.map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^\d+\.?\d*\s*/, '').trim());
        sceneTimestamps = [];
      }

      renderScenes();
      document.getElementById('btnFetch').disabled = false;
      status.innerHTML = `✅ ${scenes.length} scenes with timestamps extracted`;
    }
  } catch (e) {
    status.innerHTML = '❌ Failed to extract scenes';
  }
  btn.disabled = false;
  updateStats();
}

function renderScenes() {
  document.getElementById('sceneList').innerHTML = scenes.map((s, i) => {
    const time = sceneTimestamps[i] !== undefined ? `${Math.floor(sceneTimestamps[i]/60)}:${String(Math.floor(sceneTimestamps[i]%60)).padStart(2,'0')}` : 'auto';
    return `
      <div class="scene-item" id="scene-${i}">
        <span class="scene-num">${i+1}</span>
        <span>${s}</span>
        <span style="font-size:10px;color:#888;">${time}</span>
        <span class="status-dot pending" id="dot-${i}"></span>
      </div>
    `;
  }).join('');
}

// ==================== SERVER-SIDE RENDER ====================
async function renderVideo() {
  const validClips = videoClips.filter(c => c);
  if (!validClips.length) return alert('No video clips to render.');
  if (!recordedAudio) return alert('Record your voiceover first.');

  const btn = document.getElementById('btnRender');
  const status = document.getElementById('status');
  btn.disabled = true;

  try {
    status.innerHTML = '<span class="spinner"></span> Uploading to server for rendering...';

    const formData = new FormData();
    formData.append('audio', recordedAudio, 'voice.webm');
    formData.append('clips', JSON.stringify(validClips.map(c => ({ url: c.url }))));
    formData.append('timestamps', JSON.stringify(sceneTimestamps));
    formData.append('duration', videoDuration.toString());

    const response = await fetch('/api/render', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Server render failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `short_${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    status.innerHTML = '✅ Video downloaded! Ready for YouTube Shorts.';
  } catch (e) {
    console.error(e);
    status.innerHTML = `❌ Error: ${e.message}`;
  }
  btn.disabled = false;
}
