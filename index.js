// index.js
require('dotenv').config();

const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { uploadImageToDrive } = require('./drive');
const { google } = require('googleapis');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const TEST_MODE = true;

const app = express();
const client = new Client(config);

const processedMessageIds = new Set();
const pendingCaption = {};
const PENDING_TTL_MS = 5 * 60 * 1000;

app.get('/', (_, res) => res.send('LINE image saver to Google Drive is running'));

app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body.events || [];
  console.log('[webhook] events =', events.length);
  Promise.all(events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => { console.error('[webhook] error:', err); res.status(200).end(); });
});

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return;
    const { message, source } = event;
    const userId = source?.userId || 'nouser';
    const groupId = source?.groupId || 'nogroup';

    // text: จับ #JOB caption
    if (message.type === 'text') {
      const text = (message.text || '').trim();
      const match = text.match(/#(\d{2}-\d{3,})/i);
      if (match) {
        const jobId = match[1].toUpperCase();
        const caption = text.replace(match[0], '').trim();
        pendingCaption[userId] = { jobId, caption, ts: Date.now() };
        console.log('[pending set]', userId, '->', jobId, caption || '(no caption)');
      }
      return;
    }

    if (message.type !== 'image') return;

    if (processedMessageIds.has(message.id)) {
      console.log('[skip] duplicate:', message.id);
      return;
    }
    processedMessageIds.add(message.id);
    if (processedMessageIds.size > 1000) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    console.log('[image]', { messageId: message.id, userId, groupId });

    let stream;
    try {
      stream = await client.getMessageContent(message.id);
    } catch (e) {
      console.error('[getMessageContent ERROR]', e.statusCode, e.message);
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
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

    // ถ้ามี pending #JOB → log ลง Google Sheets
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
    console.error('[handleEvent ERROR]', e);
  }
}

// ── Google Sheets logging ────────────────────────────────────────────────
async function logPhotoToSheets(jobId, fileId, caption, userId) {
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const SA_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  if (!SA_EMAIL || !SA_KEY || !SHEET_ID) {
    console.warn('[sheets] env not set — skipping');
    return;
  }
  const auth = new google.auth.JWT(SA_EMAIL, null, SA_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date();
  const url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
  const dateTh = now.toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'numeric' });
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'photos!A:G',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[jobId.trim().toUpperCase(), url, caption||'', 'line', now.toISOString(), dateTh, userId||'']] },
    });
    console.log('[sheets] logged', jobId, url);
  } catch (e) {
    console.error('[sheets] error:', e.message);
  }
}

// ── /upload — รับรูปจาก Netlify ────────────────────────────────────────
app.post('/upload', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { job_id, image_base64, caption, mime_type } = req.body || {};
    if (!job_id || !image_base64) {
      return res.status(400).json({ error: 'job_id and image_base64 required' });
    }
    const { Readable } = require('stream');
    const buf = Buffer.from(image_base64, 'base64');
    const stream = Readable.from(buf);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${job_id.trim().toUpperCase()}_${ts}.jpg`;

    const result = await uploadImageToDrive(stream, filename);
    const fileId = result?.id;
    if (!fileId) throw new Error('Drive upload failed — no file ID returned');

    // ทำให้ public
    const oAuth2Client = new google.auth.OAuth2(process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET);
    oAuth2Client.setCredentials({ refresh_token: process.env.GDRIVE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

    // ✅ แก้: ใช้ thumbnail URL ที่ใช้ใน img tag ได้
    const url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
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
  console.log(`Sheets: ${process.env.GOOGLE_SHEET_ID ? 'enabled' : 'disabled'}`);
});
