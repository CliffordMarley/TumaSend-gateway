const { Router } = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { sendKycSubmittedEmail } = require('../services/emailService');

const router = Router();

// Exactly 2 document slots required for KYC approval
const DOCUMENT_TYPES = {
  business_registration: {
    label: 'Business Registration',
    description: 'Certificate of incorporation or business registration document',
    id_types: null
  },
  director_id: {
    label: 'Director ID',
    description: 'Government-issued identity document for a company director',
    id_types: {
      passport: 'Passport',
      national_id: 'National ID',
      driving_licence: 'Driving Licence'
    }
  }
};

const REQUIRED_TYPES = Object.keys(DOCUMENT_TYPES);

async function getOwnedTenant(userId) {
  const { data, error } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id, tenants(id, name, kyc_status, kyc_submitted_at, kyc_reviewed_at, kyc_rejection_reason)')
    .eq('user_id', userId)
    .eq('is_owner', true)
    .eq('status', 'active')
    .single();

  if (error || !data) return null;
  return data;
}

function buildCompletion(documents) {
  const active = (documents || []).filter(d => d.status !== 'rejected');
  const submittedTypes = new Set(active.map(d => d.document_type));
  const missing = REQUIRED_TYPES.filter(t => !submittedTypes.has(t));
  return {
    required_submitted: REQUIRED_TYPES.length - missing.length,
    required_total: REQUIRED_TYPES.length,
    is_complete: missing.length === 0,
    missing: missing.map(t => ({
      document_type: t,
      label: DOCUMENT_TYPES[t].label,
      description: DOCUMENT_TYPES[t].description
    }))
  };
}

// ─────────────────────────────────────────────
// GET /api/v1/kyc
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/kyc:
 *   get:
 *     summary: Get KYC status and documents
 *     description: |
 *       Returns the KYC status, all submitted documents, and a completion checklist
 *       for the authenticated owner's business.
 *
 *       **KYC requires exactly 2 documents:**
 *       - `business_registration` — Certificate of Incorporation or business registration doc
 *       - `director_id` — Passport, National ID, or Driving Licence
 *     tags:
 *       - KYC
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: KYC status, documents, and completion checklist
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 kyc_status:
 *                   type: string
 *                   enum: [not_submitted, submitted, approved, rejected]
 *                 completion:
 *                   type: object
 *                   properties:
 *                     required_submitted:
 *                       type: integer
 *                       example: 1
 *                     required_total:
 *                       type: integer
 *                       example: 2
 *                     is_complete:
 *                       type: boolean
 *                     missing:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           document_type:
 *                             type: string
 *                           label:
 *                             type: string
 *                           description:
 *                             type: string
 *                 documents:
 *                   type: array
 *       403:
 *         description: You do not own a business
 */
router.get('/', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  const { data: documents, error } = await supabaseAdmin
    .from('kyc_documents')
    .select('id, document_type, id_type, document_name, file_url, storage_provider, status, mime_type, file_size, rejection_reason, created_at, updated_at')
    .eq('tenant_id', owned.tenant_id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Failed to fetch KYC documents' });

  const kycStatus = owned.tenants.kyc_status === 'pending' ? 'not_submitted' : owned.tenants.kyc_status;

  return res.json({
    kyc_status: kycStatus,
    kyc_submitted_at: owned.tenants.kyc_submitted_at,
    kyc_reviewed_at: owned.tenants.kyc_reviewed_at,
    kyc_rejection_reason: owned.tenants.kyc_rejection_reason,
    completion: buildCompletion(documents),
    required_documents: REQUIRED_TYPES.map(t => ({
      document_type: t,
      label: DOCUMENT_TYPES[t].label,
      description: DOCUMENT_TYPES[t].description,
      ...(DOCUMENT_TYPES[t].id_types && { accepted_id_types: DOCUMENT_TYPES[t].id_types })
    })),
    documents: documents || []
  });
});

// ─────────────────────────────────────────────
// POST /api/v1/kyc
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/kyc:
 *   post:
 *     summary: Submit a KYC document
 *     description: |
 *       Submits one of the two required KYC documents.
 *
 *       **Upload flow:**
 *       1. Frontend uploads the file to Firebase Storage or Supabase Storage.
 *       2. Frontend calls this endpoint with the resulting `file_url`.
 *
 *       **Document slot 1 — Business Registration:**
 *       ```json
 *       {
 *         "document_type": "business_registration",
 *         "document_name": "Certificate_of_Incorporation.pdf",
 *         "file_url": "https://firebasestorage.googleapis.com/...",
 *         "storage_provider": "firebase",
 *         "mime_type": "application/pdf"
 *       }
 *       ```
 *
 *       **Document slot 2 — Director ID:**
 *       ```json
 *       {
 *         "document_type": "director_id",
 *         "id_type": "passport",
 *         "document_name": "john_doe_passport.jpg",
 *         "file_url": "https://firebasestorage.googleapis.com/...",
 *         "storage_provider": "firebase",
 *         "mime_type": "image/jpeg"
 *       }
 *       ```
 *     tags:
 *       - KYC
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - document_type
 *               - document_name
 *               - file_url
 *             properties:
 *               document_type:
 *                 type: string
 *                 enum: [business_registration, director_id]
 *                 example: director_id
 *               id_type:
 *                 type: string
 *                 enum: [passport, national_id, driving_licence]
 *                 description: Required when document_type is director_id
 *                 example: passport
 *               document_name:
 *                 type: string
 *                 description: Original filename
 *                 example: john_doe_passport.jpg
 *               file_url:
 *                 type: string
 *                 description: Full public URL of the uploaded file (Firebase, Supabase, or any accessible URL)
 *                 example: https://firebasestorage.googleapis.com/v0/b/project.appspot.com/o/kyc%2Fpassport.jpg?alt=media
 *               storage_provider:
 *                 type: string
 *                 enum: [firebase, supabase, other]
 *                 example: firebase
 *               mime_type:
 *                 type: string
 *                 example: image/jpeg
 *               file_size:
 *                 type: integer
 *                 description: File size in bytes
 *                 example: 153600
 *     responses:
 *       201:
 *         description: Document submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 document:
 *                   type: object
 *                 completion:
 *                   type: object
 *       400:
 *         description: Missing required fields, invalid document_type, or missing id_type for director_id
 *       403:
 *         description: |
 *           - You do not own a business account
 *           - KYC documents are under review (kyc_status = submitted)
 *           - KYC is already approved (kyc_status = approved)
 */
router.post('/', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  const kycStatus = owned.tenants.kyc_status;

  if (kycStatus === 'submitted') {
    return res.status(403).json({
      error: 'KYC documents are under review. No further submissions are allowed until the review is complete.',
      kyc_status: 'submitted'
    });
  }
  if (kycStatus === 'approved') {
    return res.status(403).json({
      error: 'KYC is already approved for this business. No changes can be made.',
      kyc_status: 'approved'
    });
  }

  const body = req.body || {};
  const { document_type, id_type, document_name, file_url, storage_provider, mime_type, file_size } = body;

  // Validate required fields
  if (!document_type || !document_name || !file_url) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['document_type', 'document_name', 'file_url']
    });
  }

  if (!DOCUMENT_TYPES[document_type]) {
    return res.status(400).json({
      error: 'Invalid document_type',
      allowed: REQUIRED_TYPES,
      hint: 'Use "business_registration" for your business certificate, or "director_id" for a passport / national ID / driving licence'
    });
  }

  // id_type is required for director_id
  if (document_type === 'director_id') {
    const validIdTypes = Object.keys(DOCUMENT_TYPES.director_id.id_types);
    if (!id_type || !validIdTypes.includes(id_type)) {
      return res.status(400).json({
        error: 'id_type is required for director_id documents',
        allowed_id_types: validIdTypes
      });
    }
  }

  // Validate URL
  try { new URL(file_url); } catch {
    return res.status(400).json({ error: 'file_url must be a valid URL' });
  }

  const validProviders = ['firebase', 'supabase', 'other'];
  const resolvedProvider = validProviders.includes(storage_provider) ? storage_provider : 'other';

  const { data: document, error } = await supabaseAdmin
    .from('kyc_documents')
    .insert({
      tenant_id: owned.tenant_id,
      uploaded_by: req.user.id,
      document_type,
      id_type: document_type === 'director_id' ? id_type : null,
      document_name,
      file_url,
      storage_provider: resolvedProvider,
      storage_path: file_url,
      storage_bucket: resolvedProvider,
      mime_type: mime_type || null,
      file_size: file_size || null,
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    console.error('KYC insert error:', error);
    return res.status(500).json({ error: 'Failed to submit KYC document' });
  }

  // Re-fetch all docs to check completion
  const { data: allDocs } = await supabaseAdmin
    .from('kyc_documents')
    .select('document_type, status')
    .eq('tenant_id', owned.tenant_id);

  const completion = buildCompletion(allDocs);

  // Advance to 'submitted' only once BOTH required documents are present
  if (completion.is_complete) {
    await supabaseAdmin
      .from('tenants')
      .update({ kyc_status: 'submitted', kyc_submitted_at: new Date().toISOString() })
      .eq('id', owned.tenant_id)
      .in('kyc_status', ['pending', 'rejected']);

    sendKycSubmittedEmail({ tenantId: owned.tenant_id, tenantName: owned.tenants.name })
      .catch(err => console.error('[email] kycSubmitted:', err.message));
  }

  return res.status(201).json({
    message: completion.is_complete
      ? 'KYC document submitted. Both documents are now under review.'
      : 'KYC document submitted successfully',
    document,
    completion
  });
});

// ─────────────────────────────────────────────
// PATCH /api/v1/kyc/:documentId — Resubmit a rejected document
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/kyc/{documentId}:
 *   patch:
 *     summary: Replace a rejected KYC document
 *     description: |
 *       Upload a corrected file and submit the new URL here. Resets the document to `pending` for re-review.
 *       Can also update `id_type` if the director changed which form of ID they are submitting.
 *     tags:
 *       - KYC
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               document_name:
 *                 type: string
 *               file_url:
 *                 type: string
 *               id_type:
 *                 type: string
 *                 enum: [passport, national_id, driving_licence]
 *               storage_provider:
 *                 type: string
 *                 enum: [firebase, supabase, other]
 *               mime_type:
 *                 type: string
 *               file_size:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Document updated and re-submitted for review
 *       403:
 *         description: |
 *           - KYC documents are under review (kyc_status = submitted) — no changes allowed
 *           - Approved documents cannot be modified (individual document status = approved)
 *           - You do not own a business account
 *       404:
 *         description: Document not found
 */
router.patch('/:documentId', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  const kycStatus = owned.tenants.kyc_status;

  if (kycStatus === 'submitted') {
    return res.status(403).json({
      error: 'KYC documents are under review. No changes are allowed until the review is complete.',
      kyc_status: 'submitted'
    });
  }

  const { documentId } = req.params;
  const body = req.body || {};
  const { document_name, file_url, id_type, storage_provider, mime_type, file_size } = body;

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('kyc_documents')
    .select('id, document_type, status')
    .eq('id', documentId)
    .eq('tenant_id', owned.tenant_id)
    .single();

  if (fetchError || !existing) return res.status(404).json({ error: 'Document not found' });

  if (existing.status === 'approved') {
    return res.status(403).json({ error: 'Approved documents cannot be modified' });
  }

  if (file_url) {
    try { new URL(file_url); } catch {
      return res.status(400).json({ error: 'file_url must be a valid URL' });
    }
  }

  if (id_type && existing.document_type === 'director_id') {
    const validIdTypes = Object.keys(DOCUMENT_TYPES.director_id.id_types);
    if (!validIdTypes.includes(id_type)) {
      return res.status(400).json({ error: 'Invalid id_type', allowed: validIdTypes });
    }
  }

  const validProviders = ['firebase', 'supabase', 'other'];
  const updates = { status: 'pending' };
  if (document_name) updates.document_name = document_name;
  if (file_url) {
    updates.file_url = file_url;
    updates.storage_path = file_url;
    updates.storage_provider = validProviders.includes(storage_provider) ? storage_provider : 'other';
    updates.storage_bucket = updates.storage_provider;
  }
  if (id_type && existing.document_type === 'director_id') updates.id_type = id_type;
  if (mime_type) updates.mime_type = mime_type;
  if (file_size) updates.file_size = file_size;

  const { data, error } = await supabaseAdmin
    .from('kyc_documents')
    .update(updates)
    .eq('id', documentId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update document' });

  // Re-check completion — advance to 'submitted' only if all docs are now present
  const { data: allDocs } = await supabaseAdmin
    .from('kyc_documents')
    .select('document_type, status')
    .eq('tenant_id', owned.tenant_id);

  const completion = buildCompletion(allDocs);

  if (completion.is_complete) {
    await supabaseAdmin
      .from('tenants')
      .update({ kyc_status: 'submitted', kyc_submitted_at: new Date().toISOString() })
      .eq('id', owned.tenant_id)
      .in('kyc_status', ['pending', 'rejected']);

    sendKycSubmittedEmail({ tenantId: owned.tenant_id, tenantName: owned.tenants.name })
      .catch(err => console.error('[email] kycSubmitted:', err.message));
  }

  return res.json({
    message: completion.is_complete
      ? 'Document updated. Both documents are now under review.'
      : 'Document updated and re-submitted for review',
    document: data,
    completion
  });
});

// ─────────────────────────────────────────────
// DELETE /api/v1/kyc/:documentId
// ─────────────────────────────────────────────
/**
 * @swagger
 * /api/v1/kyc/{documentId}:
 *   delete:
 *     summary: Delete a pending or rejected KYC document
 *     tags:
 *       - KYC
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Document deleted
 *       403:
 *         description: Approved documents cannot be deleted
 *       404:
 *         description: Document not found
 */
router.delete('/:documentId', requireAuth, async (req, res) => {
  const owned = await getOwnedTenant(req.user.id);
  if (!owned) return res.status(403).json({ error: 'You do not own a business account' });

  const { documentId } = req.params;

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('kyc_documents')
    .select('id, status')
    .eq('id', documentId)
    .eq('tenant_id', owned.tenant_id)
    .single();

  if (fetchError || !existing) return res.status(404).json({ error: 'Document not found' });

  if (existing.status === 'approved') {
    return res.status(403).json({ error: 'Approved documents cannot be deleted' });
  }

  const { error } = await supabaseAdmin
    .from('kyc_documents')
    .delete()
    .eq('id', documentId);

  if (error) return res.status(500).json({ error: 'Failed to delete document' });

  return res.json({ message: 'KYC document deleted successfully' });
});

module.exports = router;
