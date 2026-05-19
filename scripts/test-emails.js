/**
 * Email test script — sends every email template to a single address.
 *
 * Usage:
 *   npm run test:email -- you@example.com
 *   node scripts/test-emails.js you@example.com
 *
 * Requires RESEND_API_KEY (and optionally API_BASE_URL / FRONTEND_URL) in .env
 */

require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const { Resend } = require('resend');
const templates = require('../src/services/emailTemplates');

const TO = process.argv[2];

if (!TO || !TO.includes('@')) {
  console.error('Usage: node scripts/test-emails.js <recipient@email.com>');
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  console.error('RESEND_API_KEY is not set in .env / .env.local');
  process.exit(1);
}

const resend = new Resend(apiKey);
const FROM = 'TumaSend <tumasend@digitalhope.mw>';

const EMAILS = [
  {
    name: '1. Welcome',
    ...templates.welcome({ fullName: 'Test User' }),
  },
  {
    name: '2. Business Created',
    ...templates.businessCreated({
      fullName: 'Test User',
      businessName: 'Acme Corp',
      smsBonusCredits: 10,
      waBonusCredits: 10,
    }),
  },
  {
    name: '3. KYC Submitted',
    ...templates.kycSubmitted({ fullName: 'Test User', businessName: 'Acme Corp' }),
  },
  {
    name: '4. KYC Approved',
    ...templates.kycApproved({ fullName: 'Test User', businessName: 'Acme Corp' }),
  },
  {
    name: '5. KYC Rejected',
    ...templates.kycRejected({
      fullName: 'Test User',
      businessName: 'Acme Corp',
      reason: 'The business registration certificate provided was expired.',
    }),
  },
  {
    name: '6. Sender ID Approved',
    ...templates.senderIdApproved({ fullName: 'Test User', senderId: 'ACMECORP' }),
  },
  {
    name: '7. Sender ID Rejected',
    ...templates.senderIdRejected({
      fullName: 'Test User',
      senderId: 'ACMECORP',
      reason: 'Sender ID resembles a known financial institution name.',
    }),
  },
  {
    name: '8. Enterprise Assigned',
    ...templates.enterpriseAssigned({ fullName: 'Test User', businessName: 'Acme Corp' }),
  },
  {
    name: '9. Payment Success',
    ...templates.paymentSuccess({
      fullName: 'Test User',
      amountMwk: 50000,
      creditsGranted: 1000,
      invoiceNumber: 'INV-20260001',
      channel: 'sms',
    }),
  },
  {
    name: '10. Payment Failed',
    ...templates.paymentFailed({ fullName: 'Test User', amountMwk: 50000 }),
  },
  {
    name: '11. Team Invite',
    ...templates.teamInvite({
      inviteeName: 'Jane Smith',
      businessName: 'Acme Corp',
      role: 'developer',
    }),
  },
  {
    name: '12. Invitation Accepted',
    ...templates.invitationAccepted({
      ownerName: 'Test User',
      memberName: 'Jane Smith',
      businessName: 'Acme Corp',
    }),
  },
];

async function run() {
  console.log(`Sending ${EMAILS.length} test emails to ${TO}...\n`);

  let passed = 0;
  let failed = 0;

  for (const email of EMAILS) {
    const { name, subject, html } = email;
    try {
      const result = await resend.emails.send({ from: FROM, to: TO, subject: `[TEST] ${subject}`, html });
      if (result.error) {
        console.error(`  ✗ ${name} — ${result.error.message}`);
        failed++;
      } else {
        console.log(`  ✓ ${name} — id: ${result.data?.id}`);
        passed++;
      }
    } catch (err) {
      console.error(`  ✗ ${name} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${passed} sent, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
