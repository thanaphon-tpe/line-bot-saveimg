// drive.js
const { google } = require('googleapis');

const {
  GDRIVE_CLIENT_ID,
  GDRIVE_CLIENT_SECRET,
  GDRIVE_REFRESH_TOKEN,
  GDRIVE_FOLDER_ID,
} = process.env;

console.log('[drive] using OAuth2 client');
console.log('[drive] folder id =', GDRIVE_FOLDER_ID || '(not set)');

if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REFRESH_TOKEN) {
  console.warn('[drive] WARNING: OAuth env not fully set');
}

const oAuth2Client = new google.auth.OAuth2(
  GDRIVE_CLIENT_ID,
  GDRIVE_CLIENT_SECRET
);

oAuth2Client.setCredentials({ refresh_token: GDRIVE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oAuth2Client });

async function uploadImageToDrive(readStream, filename) {
  if (!GDRIVE_FOLDER_ID) {
    throw new Error('GDRIVE_FOLDER_ID is not set');
  }

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [GDRIVE_FOLDER_ID],
    },
    media: {
      mimeType: 'image/jpeg',
      body: readStream,
    },
    fields: 'id,name',
  });

  console.log('[gdrive] uploaded:', res.data);
  return res.data;
}

module.exports = { uploadImageToDrive };
