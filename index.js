// index.js
// LINE → Save images to local OneDrive folder
// Mode default = TEST (save images from everyone). Switch to ALLOWLIST later.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');

// ====== ENV & CONFIG ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const SAVE_DIR = process.env.SAVE_DIR || path.join(__dirname, 'saved');
const PORT = Number(process.env.PORT || 3000);

// โมดทดสอบ (true = เซฟจากทุกคน, false = เซฟเฉพาะรายชื่ออนุญาต)
const TEST_MODE = process.env.TEST_MODE === 'false' ? false : true;

// ส่งข้อความตอบกลับยืนยันหรือไม่ (true = ตอบกลับ)
const TEXT_REPLY = process.env.TEXT_REPLY === 'false' ? false : true;

// รายชื่อ userId ที่อนุญาต (ใช้เมื่อ TEST_MODE=false)
const ALLOWED_SENDER_IDS = new Set([
  // 'U1234567890abcdef1234567890abcdef',
]);

// สร้างโฟลเดอร์ปลายทางถ้ายังไม่มี
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// ====== APP ======
const app = express();

// health check
app.get('/', (_, res) => res.send('LINE image saver is running'));

// webhook
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body?.events || [];
    await Promise.all(events.map(ev => handleEvent(ev)));
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] error:', err);
    res.sendStatus(200); // ตอบ 200 กลับให้ LINE เสมอ เพื่อกันรีทริกเกอร์
  }
});

// ====== HANDLER ======
async function handleEvent(event) {
  if (event.type !== 'message') return;
  const { message, source, replyToken } = event;
  console.log('[event]', { type: message.type, id: message.id, source });

  if (message.type !== 'image') {
    if (replyToken) {
      await new Client(config).replyMessage(replyToken, { type: 'text', text: `รับ ${message.type} (ยังไม่เก็บ)` });
    }
    return;
  }

  const client = new Client(config);
  try {
    const stream = await client.getMessageContent(message.id); // จุดที่ 401
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const groupId = source?.groupId || 'nogroup';
    const senderId = source?.userId || 'nouser';
    const filename = `${ts}_${groupId}_${senderId}_${message.id}.jpg`;
    const fullpath = require('path').join(SAVE_DIR, filename);
    await saveStreamToFile(stream, fullpath);
    console.log('[saved]', fullpath);
    if (replyToken && process.env.TEXT_REPLY !== 'false') {
      await client.replyMessage(replyToken, { type: 'text', text: `บันทึกรูปแล้ว: ${filename}` });
    }
  } catch (e) {
    console.error('[getMessageContent ERROR]', e?.status || e?.statusCode, e?.statusMessage || e?.message);
    if (replyToken) {
      await client.replyMessage(replyToken, { type: 'text', text: `ดึงรูปไม่สำเร็จ (HTTP ${e?.status || e?.statusCode})` });
    }
  }
}

// ====== UTIL ======
function saveStreamToFile(readable, filepath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filepath);
    readable.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    readable.on('error', reject);
  });
}

// ====== START ======
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Saving to: ${SAVE_DIR}`);
  console.log(`Mode: ${TEST_MODE ? 'TEST (save from everyone)' : 'ALLOWLIST ONLY'}`);
});