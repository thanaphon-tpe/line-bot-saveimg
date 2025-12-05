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
      // ❌ ไม่ตอบข้อความกลับ
    } catch (e) {
      console.error('[gdrive upload ERROR]', e);
      // ❌ ไม่ตอบข้อความกลับ
    }

  } catch (e) {
    console.error('[handleEvent ERROR]', e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Mode: TEST (save from everyone)`);
});
