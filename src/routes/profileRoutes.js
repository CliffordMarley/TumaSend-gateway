const { Router } = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');
const { supabaseAdmin } = require('../config/supabase');
const { normalizePhone, isValidMalawiPhone } = require('../utils/numberResolver');

const router = Router();

/**
 * @swagger
 * /api/v1/profile:
 *   get:
 *     summary: Get current user profile
 *     description: Returns the authenticated user's full profile.
 *     tags:
 *       - Profile
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, phone, avatar_url, email_verified, phone_verified, status, created_at')
      .eq('id', req.user.id)
      .single();

    if (error || !user) return res.status(404).json({ error: 'Profile not found' });

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * @swagger
 * /api/v1/profile:
 *   patch:
 *     summary: Update user profile
 *     description: Update the authenticated user's profile details. Phone numbers are normalized automatically.
 *     tags:
 *       - Profile
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name:
 *                 type: string
 *                 example: John Updated Doe
 *               phone:
 *                 type: string
 *                 example: "0991234567"
 *               avatar_url:
 *                 type: string
 *                 example: https://cdn.example.com/avatar.png
 *     responses:
 *       200:
 *         description: Profile updated
 *       400:
 *         description: Invalid phone number
 *       401:
 *         description: Unauthorized
 */
router.patch('/', requireAuth, async (req, res) => {
  const { full_name, phone, avatar_url } = req.body;
  const updates = { updated_at: new Date().toISOString() };

  if (full_name) updates.full_name = full_name.trim();
  if (avatar_url) updates.avatar_url = avatar_url.trim();

  if (phone) {
    const normalized = normalizePhone(phone);
    if (!isValidMalawiPhone(normalized)) {
      return res.status(400).json({
        error: 'Invalid phone number',
        message: 'Phone must be a valid Malawi number (265XXXXXXXXX)',
        received: phone
      });
    }

    // Check for duplicate phone (excluding current user)
    const { data: existingPhone } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('phone', normalized)
      .neq('id', req.user.id)
      .single();

    if (existingPhone) {
      return res.status(409).json({ error: 'This phone number is already in use' });
    }

    updates.phone = normalized;
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update profile' });

  res.json({ message: 'Profile updated successfully', user: data });
});

/**
 * @swagger
 * /api/v1/profile:
 *   delete:
 *     summary: Deactivate own account
 *     description: Sets the authenticated user's account status to 'deactivated'. This is a soft delete — the account can be reactivated by an admin.
 *     tags:
 *       - Profile
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Account deactivated
 *       401:
 *         description: Unauthorized
 */
router.delete('/', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ status: 'deactivated', updated_at: new Date().toISOString() })
    .eq('id', req.user.id);

  if (error) return res.status(500).json({ error: 'Failed to deactivate account' });

  res.json({ message: 'Account deactivated successfully. Contact support to reactivate.' });
});

module.exports = router;
