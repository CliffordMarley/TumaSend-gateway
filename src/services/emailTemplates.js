const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.tumasend.com';

const LOGO_URL = `${API_BASE_URL}/logo-icon.png`;
const MASCOT_HERO_URL = `${API_BASE_URL}/mascot-hero.png`;
const MASCOT_THUMBSUP_URL = `${API_BASE_URL}/mascot-thumbsup.png`;

const COLORS = {
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  header: '#1E293B',
  bg: '#F8FAFC',
  card: '#FFFFFF',
  text: '#1E293B',
  muted: '#64748B',
  success: '#16A34A',
  warning: '#D97706',
  danger: '#DC2626',
  border: '#E2E8F0',
};

function baseLayout(content, { mascotUrl } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TumaSend</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.bg};padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:${COLORS.header};border-radius:12px 12px 0 0;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <img src="${LOGO_URL}" alt="TumaSend" width="40" height="40" style="display:inline-block;vertical-align:middle;border-radius:8px;" />
                    <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;">TumaSend</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card body -->
          <tr>
            <td style="background-color:${COLORS.card};padding:40px 32px 32px;border-left:1px solid ${COLORS.border};border-right:1px solid ${COLORS.border};">
              ${mascotUrl ? `
              <div style="text-align:center;margin-bottom:32px;">
                <img src="${mascotUrl}" alt="" width="160" style="display:inline-block;" />
              </div>` : ''}
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:${COLORS.header};border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:13px;color:#94A3B8;">© TumaSend · DigitalHope · <a href="mailto:support@digitalhope.mw" style="color:#94A3B8;">support@digitalhope.mw</a></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function h1(text) {
  return `<h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:${COLORS.text};line-height:1.3;">${text}</h1>`;
}

function p(text, style = '') {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${COLORS.text};${style}">${text}</p>`;
}

function muted(text) {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLORS.muted};">${text}</p>`;
}

function button(label, href) {
  return `<div style="margin:28px 0;">
    <a href="${href}" style="display:inline-block;background-color:${COLORS.primary};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">${label}</a>
  </div>`;
}

function infoBox(content) {
  return `<div style="background-color:#EFF6FF;border-left:4px solid ${COLORS.primary};border-radius:4px;padding:16px 20px;margin:20px 0;">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#1E40AF;">${content}</p>
  </div>`;
}

function successBox(content) {
  return `<div style="background-color:#F0FDF4;border-left:4px solid ${COLORS.success};border-radius:4px;padding:16px 20px;margin:20px 0;">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#166534;">${content}</p>
  </div>`;
}

function warningBox(content) {
  return `<div style="background-color:#FFFBEB;border-left:4px solid ${COLORS.warning};border-radius:4px;padding:16px 20px;margin:20px 0;">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#92400E;">${content}</p>
  </div>`;
}

function errorBox(content) {
  return `<div style="background-color:#FEF2F2;border-left:4px solid ${COLORS.danger};border-radius:4px;padding:16px 20px;margin:20px 0;">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#991B1B;">${content}</p>
  </div>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid ${COLORS.border};margin:28px 0;" />`;
}

function statRow(label, value) {
  return `<tr>
    <td style="padding:10px 0;font-size:14px;color:${COLORS.muted};border-bottom:1px solid ${COLORS.border};">${label}</td>
    <td style="padding:10px 0;font-size:14px;color:${COLORS.text};font-weight:600;text-align:right;border-bottom:1px solid ${COLORS.border};">${value}</td>
  </tr>`;
}

// ─── Template functions ───────────────────────────────────────────────────────

function welcome({ fullName }) {
  const subject = 'Welcome to TumaSend!';
  const html = baseLayout(`
    ${h1(`Welcome, ${fullName}! 🎉`)}
    ${p('Your TumaSend account is ready. You can now reach your customers across Malawi with fast, reliable SMS and WhatsApp messaging — all from one platform.')}
    ${infoBox('Next step: Create your business account to start sending messages and managing your team.')}
    ${button('Create Your Business', `${FRONTEND_URL}/business/create`)}
    ${divider()}
    ${muted('Need help getting started? Reply to this email or visit our documentation.')}
  `, { mascotUrl: MASCOT_HERO_URL });
  return { subject, html };
}

function businessCreated({ fullName, businessName, smsBonusCredits, waBonusCredits }) {
  const subject = `Your business "${businessName}" is live on TumaSend`;
  const html = baseLayout(`
    ${h1(`You're all set, ${fullName}!`)}
    ${p(`Your business account <strong>${businessName}</strong> has been created successfully. Here's what you got as a welcome bonus:`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${smsBonusCredits ? statRow('SMS Credits', `${smsBonusCredits} free messages`) : ''}
      ${waBonusCredits ? statRow('WhatsApp Credits', `${waBonusCredits} free messages`) : ''}
    </table>
    ${successBox('Your free credits have been added to your account. Go send your first message!')}
    ${button('Go to Dashboard', `${FRONTEND_URL}/dashboard`)}
    ${divider()}
    ${p('Next steps:', 'font-weight:600;')}
    ${p('1. Complete your <a href="${FRONTEND_URL}/kyc" style="color:${COLORS.primary};">KYC verification</a> to unlock higher sending limits.')}
    ${p('2. Register a <a href="${FRONTEND_URL}/sender-ids" style="color:${COLORS.primary};">Sender ID</a> to send under your brand name.')}
    ${p('3. Top up your balance to keep the messages flowing.')}
  `, { mascotUrl: MASCOT_HERO_URL });
  return { subject, html };
}

function kycSubmitted({ fullName, businessName }) {
  const subject = 'KYC documents received — we\'re reviewing your application';
  const html = baseLayout(`
    ${h1('Documents Received!')}
    ${p(`Hi ${fullName}, we've received the KYC documents for <strong>${businessName}</strong>. Our team will review them shortly.`)}
    ${infoBox('Typical review time is <strong>1–2 business days</strong>. You\'ll receive an email as soon as a decision is made.')}
    ${p('While you wait, you can still use your free credits and explore the platform. Full sending limits will be unlocked after approval.')}
    ${button('Check Application Status', `${FRONTEND_URL}/kyc`)}
    ${divider()}
    ${muted('Questions about your application? Contact us at support@digitalhope.mw')}
  `);
  return { subject, html };
}

function kycApproved({ fullName, businessName }) {
  const subject = `KYC Approved — ${businessName} is verified!`;
  const html = baseLayout(`
    ${h1('Your KYC is Approved! ✅')}
    ${p(`Congratulations ${fullName}! <strong>${businessName}</strong> has been successfully verified on TumaSend.`)}
    ${successBox('Your account is now fully verified. You have full access to all sending features and higher volume limits.')}
    ${button('Start Sending', `${FRONTEND_URL}/dashboard`)}
    ${divider()}
    ${p('You can now:')}
    ${p('• Register custom Sender IDs for your brand')}
    ${p('• Send bulk SMS campaigns to your contacts')}
    ${p('• Access higher daily and monthly sending limits')}
  `, { mascotUrl: MASCOT_THUMBSUP_URL });
  return { subject, html };
}

function kycRejected({ fullName, businessName, reason }) {
  const subject = `KYC Review — Action required for ${businessName}`;
  const html = baseLayout(`
    ${h1('KYC Review — Action Required')}
    ${p(`Hi ${fullName}, we were unable to approve the KYC documents submitted for <strong>${businessName}</strong> at this time.`)}
    ${errorBox(`<strong>Reason:</strong> ${reason || 'The submitted documents did not meet our verification requirements.'}`)}
    ${p('Please review the feedback above and resubmit your documents with the necessary corrections or additional information.')}
    ${button('Resubmit Documents', `${FRONTEND_URL}/kyc`)}
    ${divider()}
    ${muted('If you believe this is an error or need clarification, please contact support@digitalhope.mw')}
  `);
  return { subject, html };
}

function senderIdApproved({ fullName, senderId }) {
  const subject = `Sender ID "${senderId}" has been approved`;
  const html = baseLayout(`
    ${h1(`Sender ID Approved! ✅`)}
    ${p(`Hi ${fullName}, your Sender ID <strong>${senderId}</strong> has been approved and is now active.`)}
    ${successBox(`Messages sent using <strong>${senderId}</strong> will now display this name to your recipients.`)}
    ${button('Send a Message', `${FRONTEND_URL}/send`)}
    ${divider()}
    ${muted('Sender IDs are subject to Malawi Communications Regulatory Authority (MACRA) guidelines. Misuse may result in suspension.')}
  `, { mascotUrl: MASCOT_THUMBSUP_URL });
  return { subject, html };
}

function senderIdRejected({ fullName, senderId, reason }) {
  const subject = `Sender ID "${senderId}" could not be approved`;
  const html = baseLayout(`
    ${h1('Sender ID Not Approved')}
    ${p(`Hi ${fullName}, we were unable to approve the Sender ID <strong>${senderId}</strong>.`)}
    ${errorBox(`<strong>Reason:</strong> ${reason || 'The requested Sender ID did not meet our approval requirements.'}`)}
    ${p('You can submit a different Sender ID or contact support if you need help choosing one that will be approved.')}
    ${button('Request a New Sender ID', `${FRONTEND_URL}/sender-ids`)}
    ${divider()}
    ${muted('Need help? Contact support@digitalhope.mw')}
  `);
  return { subject, html };
}

function enterpriseAssigned({ fullName, businessName }) {
  const subject = `${businessName} has been upgraded to Enterprise`;
  const html = baseLayout(`
    ${h1('Welcome to Enterprise! 🚀')}
    ${p(`Hi ${fullName}, your business <strong>${businessName}</strong> has been upgraded to the TumaSend Enterprise plan.`)}
    ${successBox('You now have access to enterprise-grade features including higher throughput, dedicated support, and priority routing.')}
    ${button('Explore Enterprise Features', `${FRONTEND_URL}/dashboard`)}
    ${divider()}
    ${p('Your dedicated account manager will be in touch soon. For any immediate questions, contact support@digitalhope.mw')}
  `, { mascotUrl: MASCOT_THUMBSUP_URL });
  return { subject, html };
}

function paymentSuccess({ fullName, amountMwk, creditsGranted, invoiceNumber, channel }) {
  const channelLabel = channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  const subject = `Payment confirmed — ${creditsGranted} ${channelLabel} credits added`;
  const html = baseLayout(`
    ${h1('Payment Successful! ✅')}
    ${p(`Hi ${fullName}, your payment has been confirmed and your credits have been added to your account.`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      ${statRow('Amount Paid', `MWK ${Number(amountMwk).toLocaleString()}`)}
      ${statRow(`${channelLabel} Credits Added`, Number(creditsGranted).toLocaleString())}
      ${invoiceNumber ? statRow('Invoice Number', invoiceNumber) : ''}
    </table>
    ${button('View Balance', `${FRONTEND_URL}/billing`)}
    ${divider()}
    ${muted('A receipt has been generated for this transaction. You can view all your invoices from the billing section.')}
  `);
  return { subject, html };
}

function paymentFailed({ fullName, amountMwk }) {
  const subject = 'Payment could not be processed';
  const html = baseLayout(`
    ${h1('Payment Failed')}
    ${p(`Hi ${fullName}, we were unable to process your payment of <strong>MWK ${Number(amountMwk).toLocaleString()}</strong>.`)}
    ${warningBox('No credits have been deducted and no amount has been charged to your account.')}
    ${p('This can happen due to insufficient funds, a network issue, or a temporary problem with the payment provider. Please try again.')}
    ${button('Try Again', `${FRONTEND_URL}/billing/topup`)}
    ${divider()}
    ${muted('If the problem persists, contact your bank or reach out to support@digitalhope.mw')}
  `);
  return { subject, html };
}

function teamInvite({ inviteeName, businessName, role }) {
  const subject = `You've been invited to join ${businessName} on TumaSend`;
  const html = baseLayout(`
    ${h1(`You're Invited!`)}
    ${p(`Hi ${inviteeName}, you've been invited to join <strong>${businessName}</strong> on TumaSend as a <strong>${role}</strong>.`)}
    ${infoBox('TumaSend is a business messaging platform for SMS and WhatsApp campaigns in Malawi.')}
    ${button('Accept Invitation', `${FRONTEND_URL}/invitations`)}
    ${divider()}
    ${muted('If you did not expect this invitation, you can safely ignore this email. The link will expire in 7 days.')}
  `, { mascotUrl: MASCOT_HERO_URL });
  return { subject, html };
}

function invitationAccepted({ ownerName, memberName, businessName }) {
  const subject = `${memberName} has joined ${businessName}`;
  const html = baseLayout(`
    ${h1('New Team Member!')}
    ${p(`Hi ${ownerName}, <strong>${memberName}</strong> has accepted their invitation and joined <strong>${businessName}</strong>.`)}
    ${successBox(`Your team is growing! You can manage team permissions and roles from your business settings.`)}
    ${button('Manage Team', `${FRONTEND_URL}/business/team`)}
    ${divider()}
    ${muted('You can update roles or remove members at any time from your business settings.')}
  `, { mascotUrl: MASCOT_THUMBSUP_URL });
  return { subject, html };
}

module.exports = {
  welcome,
  businessCreated,
  kycSubmitted,
  kycApproved,
  kycRejected,
  senderIdApproved,
  senderIdRejected,
  enterpriseAssigned,
  paymentSuccess,
  paymentFailed,
  teamInvite,
  invitationAccepted,
};
