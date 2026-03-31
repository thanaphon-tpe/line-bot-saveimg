// index.js
require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { uploadImageToDrive } = require('./drive');
const { google } = require('googleapis');

// ── Config ───────────────────────────────────────────────────
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};

const app    = express();
const client = new Client(config);

// กันซ้ำ
const processedMessageIds = new Set();

// pending caption: { userId: { jobId, caption, ts } }
// ผจก. พิมพ์ #26-001 caption → รอรูปถัดไปภายใน 5 นาที
const pendingCaption = {};
const PENDING_TTL_MS = 5 * 60 * 1000;

// ── Google Sheets helper ──────────────────────────────────────
function getSheetsAuth() {
  const email  = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key    = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!email || !key || !sheetId) return null;
  const auth = new google.auth.JWT(email, null, key, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  return { sheets: google.sheets({ version:'v4', auth }), sheetId };
}

async function logPhotoToSheets(jobId, driveFileId, caption, userId) {
  const ctx = getSheetsAuth();
  if (!ctx) { console.warn('[sheets] skipped — env not set'); return; }

  const now    = new Date();
  const url    = `https://drive.google.com/uc?export=view&id=${driveFileId}`;
  const dateTh = now.toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'numeric' });

  try {
    await ctx.sheets.spreadsheets.values.append({
      spreadsheetId:    ctx.sheetId,
      range:            'photos!A:G',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          jobId.trim().toUpperCase(),
          url,
          caption || '',
          'line',
          now.toISOString(),
          dateTh,
          userId || '',
        ]],
      },
    });
    console.log('[sheets] logged', jobId, '->', url);
  } catch (e) {
    console.error('[sheets] error:', e.message);
  }
}

// ── Routes ───────────────────────────────────────────────────
app.get('/', (_, res) => res.send('LINE image saver — running'));

app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body.events || [];
  console.log('[webhook] events:', events.length);
  Promise.all(events.map(handleEvent))
    .then(()  => res.status(200).end())
    .catch(err => { console.error('[webhook]', err); res.status(200).end(); });
});

// ── Event handler ─────────────────────────────────────────────
async function handleEvent(event) {
  try {
    if (event.type !== 'message') return;

    const { message, source } = event;
    const userId  = source?.userId  || 'nouser';
    const groupId = source?.groupId || 'nogroup';

    // ── ข้อความ text ─────────────────────────────────────────
    // ดักจับ #26-001 [caption] เพื่อตั้ง pending รอรูปถัดไป
    if (message.type === 'text') {
      const text  = (message.text || '').trim();
      const match = text.match(/#(\d{2}-\d{3,})/i);
      if (match) {
        const jobId   = match[1].toUpperCase();
        const caption = text.replace(match[0], '').trim();
        pendingCaption[userId] = { jobId, caption, ts: Date.now() };
        console.log('[pending set]', userId, '->', jobId, caption || '(no caption)');
      }
      return;
    }

    // ── รูปภาพ ───────────────────────────────────────────────
    if (message.type !== 'image') return;

    // กันซ้ำ
    if (processedMessageIds.has(message.id)) {
      console.log('[skip dup]', message.id);
      return;
    }
    processedMessageIds.add(message.id);
    if (processedMessageIds.size > 1000) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    console.log('[image]', { messageId: message.id, userId, groupId });

    // ดาวน์โหลดรูปจาก Line
    let stream;
    try {
      stream = await client.getMessageContent(message.id);
    } catch (e) {
      console.error('[getMessageContent]', e.statusCode, e.message);
      return;
    }

    // ── อัปโหลด Google Drive ทุกรูป (เหมือนเดิม) ─────────────
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}_${groupId}_${userId}_${message.id}.jpg`;

    let fileId = null;
    try {
      const result = await uploadImageToDrive(stream, filename);
      fileId = result?.id;
      console.log('[drive ok]', filename, fileId);
    } catch (e) {
      console.error('[drive error]', e);
      return;
    }

    // ── ถ้ามี pending #JOB → log ลง Google Sheets ────────────
    const pending = pendingCaption[userId];
    if (pending && fileId) {
      const expired = Date.now() - pending.ts > PENDING_TTL_MS;
      if (!expired) {
        await logPhotoToSheets(pending.jobId, fileId, pending.caption, userId);
        delete pendingCaption[userId];
      } else {
        console.log('[pending expired]', userId);
        delete pendingCaption[userId];
      }
    }

  } catch (e) {
    console.error('[handleEvent]', e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server :${PORT}`);
  console.log(`Sheets: ${getSheetsAuth() ? 'enabled' : 'disabled'}`);
});
