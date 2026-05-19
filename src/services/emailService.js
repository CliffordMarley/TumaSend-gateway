const { Resend } = require('resend');
const { supabaseAdmin } = require('../config/supabase');
const templates = require('./emailTemplates');

const FROM = 'TumaSend <tumasend@digitalhope.mw>';

let resend = null;
function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) return null;
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

async function send(to, { subject, html }) {
  const client = getResend();
  if (!client) {
    console.warn('[emailService] RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  try {
    await client.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error(`[emailService] Failed to send "${subject}" to ${to}:`, err.message);
  }
}

async function getTenantOwnerContact(tenantId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_members')
    .select('users(email, full_name)')
    .eq('tenant_id', tenantId)
    .eq('is_owner', true)
    .eq('status', 'active')
    .single();

  if (error || !data?.users) {
    console.warn(`[emailService] Could not find owner for tenant ${tenantId}:`, error?.message);
    return null;
  }
  return { email: data.users.email, full_name: data.users.full_name };
}

async function getTenantName(tenantId) {
  const { data } = await supabaseAdmin
    .from('tenants')
    .select('name')
    .eq('id', tenantId)
    .single();
  return data?.name || 'your business';
}

// ─── Exported send functions ──────────────────────────────────────────────────

async function sendWelcomeEmail({ email, fullName }) {
  await send(email, templates.welcome({ fullName }));
}

async function sendBusinessCreatedEmail({ email, fullName, businessName, smsBonusCredits = 0, waBonusCredits = 0 }) {
  await send(email, templates.businessCreated({ fullName, businessName, smsBonusCredits, waBonusCredits }));
}

async function sendKycSubmittedEmail({ tenantId, tenantName }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  await send(owner.email, templates.kycSubmitted({ fullName: owner.full_name, businessName: tenantName }));
}

async function sendKycApprovedEmail({ tenantId, tenantName }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  await send(owner.email, templates.kycApproved({ fullName: owner.full_name, businessName: tenantName }));
}

async function sendKycRejectedEmail({ tenantId, tenantName, reason }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  await send(owner.email, templates.kycRejected({ fullName: owner.full_name, businessName: tenantName, reason }));
}

async function sendSenderIdApprovedEmail({ tenantId, senderId }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  await send(owner.email, templates.senderIdApproved({ fullName: owner.full_name, senderId }));
}

async function sendSenderIdRejectedEmail({ tenantId, senderId, reason }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  await send(owner.email, templates.senderIdRejected({ fullName: owner.full_name, senderId, reason }));
}

async function sendEnterpriseAssignedEmail({ tenantId }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  const businessName = await getTenantName(tenantId);
  await send(owner.email, templates.enterpriseAssigned({ fullName: owner.full_name, businessName }));
}

async function sendPaymentSuccessEmail({ toEmail, toName, amountMwk, creditsGranted, invoiceNumber, channel }) {
  await send(toEmail, templates.paymentSuccess({ fullName: toName, amountMwk, creditsGranted, invoiceNumber, channel }));
}

async function sendPaymentFailedEmail({ tenantId, toEmail, toName, amountMwk }) {
  let email = toEmail;
  let name = toName;
  if (!email && tenantId) {
    const owner = await getTenantOwnerContact(tenantId);
    if (!owner) return;
    email = owner.email;
    name = owner.full_name;
  }
  if (!email) return;
  await send(email, templates.paymentFailed({ fullName: name, amountMwk }));
}

async function sendTeamInviteEmail({ inviteeEmail, inviteeName, businessName, role }) {
  await send(inviteeEmail, templates.teamInvite({ inviteeName, businessName, role }));
}

async function sendInvitationAcceptedEmail({ tenantId, tenantName, memberName }) {
  const owner = await getTenantOwnerContact(tenantId);
  if (!owner) return;
  const businessName = tenantName || await getTenantName(tenantId);
  await send(owner.email, templates.invitationAccepted({ ownerName: owner.full_name, memberName, businessName }));
}

module.exports = {
  sendWelcomeEmail,
  sendBusinessCreatedEmail,
  sendKycSubmittedEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendSenderIdApprovedEmail,
  sendSenderIdRejectedEmail,
  sendEnterpriseAssignedEmail,
  sendPaymentSuccessEmail,
  sendPaymentFailedEmail,
  sendTeamInviteEmail,
  sendInvitationAcceptedEmail,
};
