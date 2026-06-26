/**
 * Run this ONCE to generate VAPID keys for Web Push.
 * node scripts/generate_vapid.js
 * Then add the output to your Railway environment variables.
 */
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nAdd these to Railway environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nVAPID_PUBLIC_KEY also goes in your frontend (see App.jsx).\n');
