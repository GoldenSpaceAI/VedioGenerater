const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy endpoint for GPT chat / scene extraction
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

// Proxy endpoint for Pexels video search
app.get('/api/pexels/videos', async (req, res) => {
  try {
    const { query, per_page } = req.query;
    
    const response = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page || 1}`,
      {
        headers: {
          'Authorization': `${process.env.PEXELS_API_KEY}`
        }
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy endpoint for Edge TTS (Microsoft - Free, human-like voices)
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    
    // SSML for Edge TTS with a natural female voice
    const ssml = `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
        <voice name="en-US-JennyNeural">
          <prosody rate="0.95" pitch="0%">
            ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}
          </prosody>
        </voice>
      </speak>
    `;

    const response = await fetch(
      'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY || '',
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-48khz-96kbitrate-mono-mp3',
          'User-Agent': 'ShortsForge'
        },
        body: ssml
      }
    );

    if (!response.ok) {
      // Fallback: use free Edge TTS endpoint
      const fallbackRes = await fetch(
        `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D9EAFF4E9FB37E23D68491D6F4`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
          },
          body: JSON.stringify({
            text: text,
            voiceName: 'en-US-JennyNeural',
            rate: '-5%',
            pitch: '0%',
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
          })
        }
      );

      if (!fallbackRes.ok) {
        throw new Error(`TTS failed: ${fallbackRes.status}`);
      }

      const audioBuffer = await fallbackRes.arrayBuffer();
      res.set('Content-Type', 'audio/mpeg');
      return res.send(Buffer.from(audioBuffer));
    }

    const audioBuffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shorts Forge running on port ${PORT}`);
});
