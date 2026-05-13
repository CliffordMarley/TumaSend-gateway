const admin = require('firebase-admin');
require('dotenv').config();

try {
  // Assuming FIREBASE_SERVICE_ACCOUNT is either a path to a json file or a base64 encoded JSON string
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  
  if (serviceAccountPath) {
    let serviceAccount;
    if (serviceAccountPath.startsWith('{')) {
       serviceAccount = JSON.parse(serviceAccountPath);
    } else {
       serviceAccount = require(serviceAccountPath);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    console.warn('Firebase Service Account is missing. Check your .env file.');
  }
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', error.message);
}

module.exports = admin;
