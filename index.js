// index.js
require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { uploadImageToDrive } = require('./drive');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// TEST MODE = เก็บรูปจากทุกคน
const TEST_MODE = true;

const app = express();
const client = new Client(config);

// เก็บ message.id ที่เคยประมวลผลแล้ว ในหน่วยความจำ
const processedMessageIds = new Set();

app.get('/', (_, res) => res.send('LINE image saver to Google Drive is running'));

app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body.events || [];
  console.log('[webhook] events =', events.length);

  Promise.all(events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error('[webhook] error:', err);
      res.status(200).end();
    });
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return;

    const { message, source } = event;

    // รับเฉพาะรูป — ถ้าไม่ใช่รูป ไม่ทำอะไร (เงียบ)
    if (message.type !== 'image') {
      console.log('[skip] not image:', message.type);
      return;
    }

    // 🔒 กันซ้ำด้วย message.id
    if (processedMessageIds.has(message.id)) {
      console.log('[skip] duplicate message id:', message.id);
      return;
    }
    processedMessageIds.add(message.id);

    // ถ้าอยากกันไม่ให้ set โตเกินไป ก็ตัดให้เหลือแค่ล่าสุด ๆ
    if (processedMessageIds.size > 1000) {
      // ลบตัวเก่า ๆ ทิ้งบ้าง (แบบง่าย ๆ)
      const firstKey = processedMessageIds.values().next().value;
      processedMessageIds.delete(firstKey);
    }

    console.log('[image event]', {
      id: message.id,
      source,
    });

    // ขอ stream รูปจาก LINE
    let stream;
    try {
      stream = await client.getMessageContent(message.id);
    } catch (e) {
      console.error('[getMessageContent ERROR]', e.statusCode, e.message);
      return; // ไม่ตอบกลับ
    }

    // ตั้งชื่อไฟล์
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const groupId = source?.groupId || 'nogroup';
    const senderId = source?.userId || 'nouser';
    const filename = `${ts}_${groupId}_${senderId}_${message.id}.jpg`;

    // อัปโหลดขึ้น Google Drive
    try {
      await uploadImageToDrive(stream, filename);
      console.log('[uploaded]', filename);
    } catch (e) {
      console.error('[gdrive upload ERROR]', e);
    }

  } catch (e) {
    console.error('[handleEvent ERROR]', e);
  }
}


// ── /upload — รับรูปจาก Netlify แล้วอัปโหลดขึ้น Google Drive ──────────
// POST { job_id, image_base64, caption, mime_type }
app.post('/upload', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { job_id, image_base64, caption, mime_type } = req.body || {};
    if (!job_id || !image_base64) {
      return res.status(400).json({ error: 'job_id and image_base64 required' });
    }
    const buf = Buffer.from(image_base64, 'base64');
    const { Readable } = require('stream');
    const stream = Readable.from(buf);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${job_id.trim().toUpperCase()}_${ts}.jpg`;
    const result = await uploadImageToDrive(stream, filename);
    const fileId = result?.id;
    if (!fileId) throw new Error('Drive upload failed — no file ID returned');
    // ทำให้ public
    const { google } = require('googleapis');
    const oAuth2Client = new google.auth.OAuth2(process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET);
    oAuth2Client.setCredentials({ refresh_token: process.env.GDRIVE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    const viewUrl = `https://lh3.googleusercontent.com/d/${file.id}`;
    console.log('[/upload] ok', job_id, url);
    res.json({ ok: true, url, fileId });
  } catch (e) {
    console.error('[/upload] error', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Mode: TEST (save from everyone)`);
});
