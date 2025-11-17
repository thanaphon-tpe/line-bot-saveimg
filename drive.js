// drive.js
const { google } = require('googleapis');

const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT || '{}';
let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (e) {
  console.error('GOOGLE_SERVICE_ACCOUNT JSON parse error:', e.message);
  serviceAccount = {};
}

const folderId = process.env.GDRIVE_FOLDER_ID;

const auth = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/drive.file']
);

const drive = google.drive({ version: 'v3', auth });

async function uploadImageToDrive(readStream, filename) {
  if (!folderId) throw new Error('GDRIVE_FOLDER_ID is not set');

  const media = {
    mimeType: 'image/jpeg',
    body: readStream,
  };

  const fileMetadata = {
    name: filename,
    parents: [folderId],
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name',
  });

  console.log('[gdrive] uploaded:', res.data);
  return res.data;
}

module.exports = { uploadImageToDrive };
