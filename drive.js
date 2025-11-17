// drive.js
const { google } = require('googleapis');

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
const folderId = process.env.GDRIVE_FOLDER_ID;

// เตรียม auth แบบ Service Account
const auth = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/drive.file']
);

const drive = google.drive({ version: 'v3', auth });

/**
 * uploadImageToDrive(readStream, filename)
 * - readStream = stream จาก client.getMessageContent(message.id)
 * - filename   = ชื่อไฟล์ที่อยากให้ใช้บน Google Drive
 */
async function uploadImageToDrive(readStream, filename) {
  if (!folderId) {
    throw new Error('GDRIVE_FOLDER_ID is not set');
  }

  const media = {
    mimeType: 'image/jpeg', // ถ้าจะเดา type จริง ลองอ่านจาก header เพิ่มเองได้
    body: readStream
  };

  const fileMetadata = {
    name: filename,
    parents: [folderId]
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name'
  });

  console.log('[gdrive] uploaded:', res.data);
  return res.data;
}

module.exports = { uploadImageToDrive };
