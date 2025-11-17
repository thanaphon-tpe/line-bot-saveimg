// index.js
require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { uploadImageToDrive } = require('./drive');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// บังคับ TEST MODE = true ไปเลยก่อน (เก็บรูปจากทุกคน)
// ภายหลังค่อยเปลี่ยนมาดู ALLOWED_SENDER_IDS ได้
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
    const { message, source, replyToken } = event;

    // รับเฉพาะรูป
    if (message.type !== 'image') {
      console.log('[skip] not image:', message.type);
      if (process.env.TEXT_REPLY === 'true' && replyToken) {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: 'บอทเก็บเฉพาะรูปภาพเท่านั้นนะครับ 🙂',
        });
      }
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
      if (replyToken) {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `ดึงรูปจาก LINE ไม่สำเร็จ (${e.statusCode || ''})`,
        });
      }
      return;
    }

    // ตั้งชื่อไฟล์
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const groupId = source?.groupId || 'nogroup';
    const senderId = source?.userId || 'nouser';
    const filename = `${ts}_${groupId}_${senderId}_${message.id}.jpg`;

    // อัปโหลดขึ้น Google Drive
    try {
      await uploadImageToDrive(stream, filename);

      if (replyToken && process.env.TEXT_REPLY === 'true') {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: `อัปโหลดรูปขึ้น Google Drive แล้ว: ${filename}`,
        });
      }
    } catch (e) {
      console.error('[gdrive upload ERROR]', e);
      if (replyToken) {
        await client.replyMessage(replyToken, {
          type: 'text',
          text: 'อัปโหลดรูปไป Google Drive ไม่สำเร็จครับ 😢',
        });
      }
    }
  } catch (e) {
    console.error('[handleEvent ERROR]', e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Mode: TEST (save from everyone)`); // บังคับ TEST MODE
});
