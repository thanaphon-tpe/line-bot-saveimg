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


// ── CORS — อนุญาต WordPress และ localhost ──────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── /sheets — Proxy Google Sheets API ──────────────────────────────
app.post('/sheets', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { createSign } = require('crypto');
    const { method, range, values } = req.body || {};
    const EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const KEY   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const SID   = process.env.GOOGLE_SHEET_ID;
    if (!EMAIL||!KEY||!SID) return res.status(500).json({ error:'Missing env vars' });

    // JWT
    const now = Math.floor(Date.now()/1000);
    const h = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const p = Buffer.from(JSON.stringify({iss:EMAIL,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now})).toString('base64url');
    const sign = createSign('RSA-SHA256'); sign.update(`${h}.${p}`);
    const jwt = `${h}.${p}.${sign.sign(KEY,'base64url')}`;
    const tr = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`});
    const token = (await tr.json()).access_token;

    const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SID}`;
    let r;
    if (method==='get') {
      r = await fetch(`${BASE}/values/${encodeURIComponent(range)}`,{headers:{Authorization:'Bearer '+token}});
    } else if (method==='append') {
      r = await fetch(`${BASE}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({values})});
    } else if (method==='update') {
      r = await fetch(`${BASE}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({values})});
    } else if (method==='clear') {
      r = await fetch(`${BASE}/values/${encodeURIComponent(range)}:clear`,{method:'POST',headers:{Authorization:'Bearer '+token}});
    } else return res.status(400).json({error:'Unknown method'});
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── /lark-sync — Sync JOB from Lark Base → Google Sheets ──────────
app.post('/lark-sync', express.json(), async (req, res) => {
  try {
    const { createSign } = require('crypto');
    const APP_TOKEN = process.env.LARK_BASE_APP_TOKEN;
    const TABLE_ID  = process.env.LARK_TABLE_ID;
    if (!APP_TOKEN||!TABLE_ID) return res.status(500).json({error:'Missing LARK env vars'});

    // Lark token
    const lr = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:process.env.LARK_APP_ID,app_secret:process.env.LARK_APP_SECRET})});
    const ld = await lr.json();
    if (ld.code!==0) throw new Error('Lark token: '+ld.msg);
    const larkToken = ld.tenant_access_token;

    // Fetch records
    let allRecords=[],pageToken=null;
    do {
      let url=`https://open.larksuite.com/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=100`;
      if (pageToken) url+=`&page_token=${pageToken}`;
      const rr=await fetch(url,{headers:{Authorization:'Bearer '+larkToken}});
      const dd=await rr.json();
      if (dd.code!==0) throw new Error('Lark records: '+dd.msg);
      allRecords=allRecords.concat(dd.data.items||[]);
      pageToken=dd.data.has_more?dd.data.page_token:null;
    } while(pageToken);

    // Date helper
    function toThaiDate(val){
      if(!val)return'';
      let ms=typeof val==='number'?val:parseInt(val);
      if(!ms)return String(val);
      if(ms<9999999999)ms*=1000;
      const d=new Date(ms);
      if(isNaN(d.getTime()))return String(val);
      return d.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
    }

    const FIELDS={job_id:'JOB',open_date:'วันที่เปิด JOB',job_name:'งาน',company:'บริษัท',action_date:'วันที่ดำเนินการ',status:'สถานะ',quotation:'เลขใบเสนอราคา',delivery:'ส่งมอบงาน',job_type:'ประเภทงาน',expected_end:'วันที่คาดเสร็จ'};
    const headers=['job_id','open_date','job_name','company','action_date','status','quotation','delivery','job_type','expected_end','lark_record_id','synced_at'];

    const rows=allRecords.map(rec=>{
      const f=rec.fields;
      const get=(k)=>{const v=f[k];if(!v)return'';if(Array.isArray(v))return v.map(x=>x.text||x.name||x).join(', ');if(typeof v==='object'&&v.text)return v.text;return String(v)};
      const getDate=(k)=>{const v=f[k];if(!v)return'';if(typeof v==='number')return toThaiDate(v);if(typeof v==='object'&&v.text)return v.text;if(!isNaN(parseInt(v)))return toThaiDate(parseInt(v));return String(v)};
      return[get(FIELDS.job_id),getDate(FIELDS.open_date),get(FIELDS.job_name),get(FIELDS.company),getDate(FIELDS.action_date),get(FIELDS.status),get(FIELDS.quotation),get(FIELDS.delivery),get(FIELDS.job_type),getDate(FIELDS.expected_end),rec.record_id,new Date().toISOString()];
    });

    // Write to Sheets
    const now2=Math.floor(Date.now()/1000);
    const EMAIL=process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,KEY2=(process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g,'\n'),SID=process.env.GOOGLE_SHEET_ID;
    const h2=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
    const p2=Buffer.from(JSON.stringify({iss:EMAIL,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',exp:now2+3600,iat:now2})).toString('base64url');
    const sign2=require('crypto').createSign('RSA-SHA256');sign2.update(`${h2}.${p2}`);
    const jwt2=`${h2}.${p2}.${sign2.sign(KEY2,'base64url')}`;
    const tr2=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt2}`});
    const token2=(await tr2.json()).access_token;
    const BASE2=`https://sheets.googleapis.com/v4/spreadsheets/${SID}`;
    await fetch(`${BASE2}/values/jobs!A:Z:clear`,{method:'POST',headers:{Authorization:'Bearer '+token2}});
    await fetch(`${BASE2}/values/jobs!A1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:'Bearer '+token2,'Content-Type':'application/json'},body:JSON.stringify({values:[headers,...rows]})});

    console.log('[/lark-sync] synced',rows.length,'jobs');
    res.json({ok:true,synced:rows.length,at:new Date().toISOString()});
  } catch(e){ console.error('[/lark-sync]',e.message); res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
  console.log(`Sheets: ${process.env.GOOGLE_SHEET_ID ? 'enabled' : 'disabled'}`);
});
