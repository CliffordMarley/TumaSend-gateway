const { Router } = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = Router();

/**
 * @swagger
 * /api/v1/balance:
 *   get:
 *     summary: Get SMS credit balance and usage summary
 *     description: |
 *       Returns the tenant's current SMS credit balance and lifetime usage stats.
 *
 *       **Credit model:**
 *       - Credits are purchased via bundle tiers (`POST /orders/bundle`) or top-ups (`POST /orders/topup`).
 *       - 1 credit = 1 SMS. Credits are deducted per recipient when a batch is sent.
 *       - Enterprise tenants are postpaid — no credit check on send.
 *     tags:
 *       - Billing
 *     security:
 *       - BearerAuth: []
 *       - SystemKeyAuth: []
 *     responses:
 *       200:
 *         description: Credit balance and usage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sms_credits:
 *                   type: integer
 *                   description: Current credit balance (1 credit = 1 SMS)
 *                   example: 1153
 *                 is_postpaid:
 *                   type: boolean
 *                   description: Enterprise tenants are postpaid — credits are not checked on send
 *                   example: false
 *                 subscription_tier:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     name: { type: string, example: "Basic Bundle" }
 *                     tier_type: { type: string, enum: [bundle, enterprise] }
 *                 usage:
 *                   type: object
 *                   properties:
 *                     total_credits_purchased:
 *                       type: integer
 *                       description: Lifetime credits purchased across all orders
 *                       example: 1200
 *                     total_sms_sent:
 *                       type: integer
 *                       description: Lifetime credits consumed (equals SMS sent)
 *                       example: 47
 *                     total_send_operations:
 *                       type: integer
 *                       description: Number of batch sends
 *                       example: 3
 *                     last_send_at:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                     last_credit_at:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: No active business account
 *       404:
 *         description: Tenant not found
 */
router.get('/', requireAuth, async (req, res) => {
  const { data: membership } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No active business account' });
  }

  const tenantId = membership.tenant_id;

  const [tenantResult, usageResult] = await Promise.all([
    supabaseAdmin
      .from('tenants')
      .select('sms_credits, subscription_tier_id, subscription_tiers(name, tier_type, is_postpaid)')
      .eq('id', tenantId)
      .single(),
    supabaseAdmin
      .from('v_tenant_sms_summary')
      .select('total_credits_ever, total_sms_sent, total_send_operations, last_send_at, last_credit_at')
      .eq('tenant_id', tenantId)
      .maybeSingle()
  ]);

  if (tenantResult.error || !tenantResult.data) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const tenant = tenantResult.data;
  const usage = usageResult.data;
  const isPostpaid = tenant.subscription_tiers?.is_postpaid === true;

  return res.status(200).json({
    sms_credits: tenant.sms_credits ?? 0,
    is_postpaid: isPostpaid,
    subscription_tier: tenant.subscription_tiers
      ? {
          name: tenant.subscription_tiers.name,
          tier_type: tenant.subscription_tiers.tier_type
        }
      : null,
    usage: {
      total_credits_purchased: Number(usage?.total_credits_ever ?? 0),
      total_sms_sent: Number(usage?.total_sms_sent ?? 0),
      total_send_operations: Number(usage?.total_send_operations ?? 0),
      last_send_at: usage?.last_send_at ?? null,
      last_credit_at: usage?.last_credit_at ?? null
    }
  });
});

module.exports = router;
