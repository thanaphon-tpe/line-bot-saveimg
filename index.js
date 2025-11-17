require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');

const { uploadImageToDrive } = require('./drive');  // <-- เพิ่มบรรทัดนี้

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
app.get('/', (_, res) => res.send('LINE image saver to Google Drive is running'));

// โหมดอนุญาต: ถ้า TEST_MODE=true จะเก็บทุกรูปจากทุกคน
const TEST_MODE = (process.env.TEST_MODE || 'false').toLowerCase() === 'true';

// กรณีใช้งานจริง: ใส่ userId ที่อนุญาตให้เก็บรูปได้
const ALLOWED_SENDER_IDS = new Set([
  // 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
]);

app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body?.events || [];
  console.log('[webhook] events =', events.length);

  Promise.all(events.map(ev => handleEvent(ev).catch(err => {
    console.error('[handleEvent error]', err);
  })))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error('[webhook outer error]', err);
      res.status(200).end();
    });
});

// ฟังก์ชันหลัก
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const { message, source, replyToken } = event;
  const client = new Client(config);

  // ถ้าเป็นโหมดไม่ TEST ให้ตรวจว่าเป็นคนที่อนุญาตเท่านั้น
  if (!TEST_MODE) {
    const senderId = source?.userId;
    if (!senderId || !ALLOWED_SENDER_IDS.has(senderId)) {
      console.log('[skip] not allowed user:', senderId);
      return;
    }
  }

  // รับเฉพาะรูป
  if (message.type !== 'image') {
    console.log('[skip] not image:', message.type);
    if (process.env.TEXT_REPLY === 'true' && replyToken) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: 'ตอนนี้บอทเก็บเฉพาะ "รูปภาพ" เท่านั้นนะครับ',
      });
    }
    return;
  }

  // log ดู event
  console.log('[image event]', {
    id: message.id,
    source: source,
  });

  // ขอ content จาก LINE (เป็น stream)
  let stream;
  try {
    stream = await client.getMessageContent(message.id);
  } catch (err) {
    console.error('[getMessageContent ERROR]', err.statusCode, err.message);
    if (replyToken) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `ดึงรูปจาก LINE ไม่สำเร็จ (${err.statusCode || ''})`,
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
        text: `บันทึกรูปขึ้น Google Drive แล้ว: ${filename}`,
      });
    }
  } catch (err) {
    console.error('[gdrive upload ERROR]', err);
    if (replyToken) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: `อัปโหลดไป Google Drive ไม่สำเร็จ`,
      });
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Mode: ${TEST_MODE ? 'TEST (save from everyone)' : 'ONLY ALLOWLIST'}`);
});
