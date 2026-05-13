const { Router } = require('express');
const axios = require('axios');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = Router();

const PAYCHANGU_API = 'https://api.paychangu.com';
const PAYCHANGU_KEY = process.env.PAYCHANGU_API_KEY;

// existingTransaction: pass when re-initiating checkout for an already-created transaction
// (avoids creating a duplicate transaction row for the same invoice)
async function initiatePaychanguCheckout({ user, invoice, amountMwk, tenantId, description, existingTransaction = null }) {
  // Step 1 — create the transaction record first so we get its auto-generated
  // transaction_reference (TXN-YYYYMMDD-000001). We use that as tx_ref so
  // the webhook can resolve straight to the transaction without going through
  // invoice_number as an intermediary.
  let transaction = existingTransaction;

  if (!transaction) {
    const { data: newTx, error: txCreateErr } = await supabaseAdmin
      .from('transactions')
      .insert({
        tenant_id:        tenantId,
        invoice_id:       invoice.id,
        transaction_type: 'payment',
        amount_mwk:       amountMwk,
        status:           'pending'
      })
      .select('id, transaction_reference')
      .single();

    if (txCreateErr || !newTx) {
      console.error('Failed to create transaction record', txCreateErr);
      throw new Error('Failed to create transaction record');
    }
    transaction = newTx;
  }

  // Step 2 — call PayChangu with transaction_reference as tx_ref
  const checkoutBody = {
    amount:       amountMwk,
    currency:     'MWK',
    email:        user.email,
    first_name:   (user.full_name || user.email).split(' ')[0],
    last_name:    (user.full_name || '').split(' ').slice(1).join(' ') || '-',
    callback_url: `${process.env.API_BASE_URL || 'http://localhost:3000'}/api/v1/webhooks/paychangu`,
    return_url:   `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/success`,
    cancel_url:   `${process.env.FRONTEND_URL || 'http://localhost:3000'}/billing/cancelled`,
    tx_ref:       transaction.transaction_reference,
    customization: { title: 'Comms Gateway', description }
  };

  const checkoutResponse = await axios.post(
    `${PAYCHANGU_API}/payment`,
    checkoutBody,
    { headers: { Authorization: `Bearer ${PAYCHANGU_KEY}`, 'Content-Type': 'application/json' } }
  );

  const responseData = checkoutResponse.data;
  if (!responseData?.data?.checkout_url) {
    console.error('PayChangu checkout: unexpected response shape', JSON.stringify(responseData));
    throw new Error('PayChangu did not return a checkout URL');
  }

  // Step 3 — patch transaction with checkout details now that we have them
  await supabaseAdmin
    .from('transactions')
    .update({
      paychangu_checkout_id: responseData.data.checkout_url_id ?? null,
      checkout_url:          responseData.data.checkout_url,
      checkout_request_body: checkoutBody,
      metadata:              responseData
    })
    .eq('id', transaction.id);

  return responseData.data.checkout_url;
}

/**
 * @swagger
 * /api/v1/tiers:
 *   get:
 *     summary: List available bundle tiers
 *     description: Returns all active SMS bundle tiers with computed prices and discount details. Enterprise plans are excluded.
 *     tags:
 *       - Billing
 *     security:
 *       - SystemKeyAuth: []
 *     responses:
 *       200:
 *         description: List of bundle tiers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tiers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       sms_credits_included:
 *                         type: integer
 *                         example: 1200
 *                       bundle_discount_pct:
 *                         type: number
 *                         example: 7.41
 *                       computed_bundle_price_mwk:
 *                         type: integer
 *                         example: 20000
 *                       full_price_mwk:
 *                         type: integer
 *                         example: 21600
 *                       sms_global_price_mwk:
 *                         type: number
 *                         example: 18.0
 *                       is_default:
 *                         type: boolean
 */
router.get('/tiers', async (req, res) => {
  const { data: tiers, error } = await supabaseAdmin
    .from('v_tier_pricing')
    .select('id, name, description, sms_credits_included, bundle_discount_pct, computed_bundle_price_mwk, full_price_mwk, sms_global_price_mwk, is_default, sort_order')
    .eq('tier_type', 'bundle')
    .eq('is_active', true)
    .order('sort_order');

  if (error) {
    console.error('Tiers Error:', error);
    return res.status(500).json({ error: 'Failed to load tiers' });
  }

  return res.json({ tiers });
});

/**
 * @swagger
 * /api/v1/orders/bundle:
 *   post:
 *     summary: Purchase an SMS bundle
 *     description: |
 *       Creates a bundle purchase order and initiates a PayChangu hosted checkout session.
 *       Returns a `checkout_url` — redirect the user there to complete payment.
 *       The user selects their payment method (mobile money, card, etc.) on the PayChangu page.
 *       On payment success, PayChangu calls the webhook and SMS credits are granted automatically.
 *     tags:
 *       - Billing
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
 *               - tier_id
 *             properties:
 *               tier_id:
 *                 type: string
 *                 description: UUID of the bundle tier to purchase
 *                 example: "550e8400-e29b-41d4-a716-446655440001"
 *     responses:
 *       201:
 *         description: Order created, checkout session ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order_id:
 *                   type: string
 *                 invoice_number:
 *                   type: string
 *                   example: INV-2024-00001
 *                 checkout_url:
 *                   type: string
 *                   description: PayChangu hosted payment page — redirect the user here to complete payment
 *                 bundle:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     sms_credits:
 *                       type: integer
 *                     price_mwk:
 *                       type: integer
 *                     full_price_mwk:
 *                       type: integer
 *                     discount_pct:
 *                       type: number
 *       400:
 *         description: Missing required fields
 *       403:
 *         description: Not authorized for this tenant
 *       404:
 *         description: Tier not found or inactive
 *       500:
 *         description: Failed to create bundle order
 */
router.post('/orders/bundle', requireAuth, async (req, res) => {
  const { tier_id } = req.body;
  const user = req.user;

  if (!tier_id) {
    return res.status(400).json({ error: 'tier_id is required' });
  }

  try {
    const { data: membership } = await supabaseAdmin
      .from('tenant_members')
      .select('tenant_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    if (!membership) {
      return res.status(403).json({ error: 'No active business account' });
    }

    const tenant_id = membership.tenant_id;

    // Idempotency: return the existing pending order instead of creating a duplicate
    const { data: pendingOrder } = await supabaseAdmin
      .from('orders')
      .select('id, status, tier_id, bundle_sms_credits, bundle_price_mwk, bundle_discount_pct, invoices(id, invoice_number, transactions(id, checkout_url))')
      .eq('tenant_id', tenant_id)
      .eq('order_type', 'bundle')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingOrder) {
      const existingInvoice = pendingOrder.invoices?.[0];
      const existingTx = existingInvoice?.transactions?.[0];
      let checkoutUrl = existingTx?.checkout_url ?? null;

      // Checkout URL missing — re-initiate using the existing transaction (no new row created)
      if (!checkoutUrl && existingInvoice) {
        try {
          const [invoiceResult, txResult] = await Promise.all([
            supabaseAdmin.from('invoices').select('id, invoice_number, total_mwk').eq('id', existingInvoice.id).single(),
            supabaseAdmin.from('transactions').select('id, transaction_reference').eq('invoice_id', existingInvoice.id).maybeSingle()
          ]);
          if (invoiceResult.data) {
            checkoutUrl = await initiatePaychanguCheckout({
              user,
              invoice:             invoiceResult.data,
              amountMwk:           invoiceResult.data.total_mwk,
              tenantId:            tenant_id,
              description:         'SMS Bundle re-checkout',
              existingTransaction: txResult.data || null
            });
          }
        } catch (reErr) {
          console.error('Re-initiate bundle checkout failed:', reErr?.response?.data || reErr?.message);
        }
      }

      return res.status(200).json({
        order_id: pendingOrder.id,
        invoice_number: existingInvoice?.invoice_number ?? null,
        checkout_url: checkoutUrl,
        status: pendingOrder.status,
        existing_order: true,
        message: checkoutUrl
          ? 'You have an unpaid order. Complete this payment before placing a new one.'
          : 'You have an unpaid order with no payment link. Cancel it to place a new order.'
      });
    }

    const { data: tier, error: tierError } = await supabaseAdmin
      .from('v_tier_pricing')
      .select('id, name, sms_credits_included, bundle_discount_pct, computed_bundle_price_mwk, cached_bundle_price_mwk, full_price_mwk')
      .eq('id', tier_id)
      .eq('tier_type', 'bundle')
      .eq('is_active', true)
      .single();

    if (tierError || !tier) {
      return res.status(404).json({ error: 'Bundle tier not found or inactive' });
    }

    const priceMwk = tier.computed_bundle_price_mwk ?? tier.cached_bundle_price_mwk;
    if (!priceMwk) {
      return res.status(500).json({ error: 'Bundle tier price is not configured (sms_credits_included is missing on this tier)' });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        tenant_id,
        created_by: user.id,
        order_type: 'bundle',
        channel: 'sms',
        tier_id,
        bundle_sms_credits: tier.sms_credits_included,
        bundle_price_mwk: priceMwk,
        bundle_discount_pct: tier.bundle_discount_pct,
        status: 'pending'
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .insert({
        tenant_id,
        order_id: order.id,
        invoice_type: 'subscription',
        subtotal_mwk: priceMwk,
        total_mwk: priceMwk,
        line_items: [{ description: `SMS Bundle: ${tier.name}`, amount: priceMwk, credits: tier.sms_credits_included }]
      })
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    let checkoutUrl;
    try {
      checkoutUrl = await initiatePaychanguCheckout({
        user,
        invoice,
        amountMwk: priceMwk,
        tenantId: tenant_id,
        description: `${tier.name} — ${tier.sms_credits_included} SMS credits`
      });
    } catch (checkoutErr) {
      // Order and invoice exist but checkout failed — mark order failed so it's not orphaned
      await supabaseAdmin.from('orders').update({ status: 'failed' }).eq('id', order.id);
      console.error('PayChangu checkout error:', checkoutErr?.response?.data || checkoutErr?.message);
      return res.status(502).json({
        error: 'Payment gateway error — order has been cancelled',
        detail: checkoutErr?.response?.data?.message || checkoutErr?.message
      });
    }

    return res.status(201).json({
      order_id: order.id,
      invoice_number: invoice.invoice_number,
      checkout_url: checkoutUrl,
      bundle: {
        name: tier.name,
        sms_credits: tier.sms_credits_included,
        price_mwk: priceMwk,
        full_price_mwk: tier.full_price_mwk,
        discount_pct: tier.bundle_discount_pct
      }
    });
  } catch (error) {
    console.error('Bundle Order Error:', error);
    return res.status(500).json({ error: 'Failed to create bundle order', detail: error?.message });
  }
});

/**
 * @swagger
 * /api/v1/orders/topup:
 *   post:
 *     summary: Purchase an SMS top-up
 *     description: |
 *       Creates an SMS credit top-up order. Requires an active bundle subscription.
 *       User specifies the exact number of SMS credits to buy (integer only, no decimals).
 *       Minimum order value is MWK 10,000. Price is determined by the global SMS rate with no discount.
 *       Payment method is chosen by the user on the PayChangu hosted checkout page.
 *     tags:
 *       - Billing
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
 *               - sms_count
 *             properties:
 *               sms_count:
 *                 type: integer
 *                 description: Number of SMS credits to purchase (must be a whole number, minimum ~556 at MWK 18/SMS)
 *                 example: 1000
 *     responses:
 *       201:
 *         description: Top-up order created, checkout session ready
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order_id:
 *                   type: string
 *                 invoice_number:
 *                   type: string
 *                 checkout_url:
 *                   type: string
 *                   description: PayChangu hosted payment page — redirect the user here to complete payment
 *                 sms_count:
 *                   type: integer
 *                 cost_mwk:
 *                   type: number
 *                 price_per_sms:
 *                   type: number
 *       400:
 *         description: Invalid sms_count or below minimum spend
 *       403:
 *         description: Not authorized for this tenant, or no active bundle subscription
 *       500:
 *         description: Failed to create top-up order
 */
router.post('/orders/topup', requireAuth, async (req, res) => {
  const { sms_count } = req.body;
  const user = req.user;

  if (!Number.isInteger(sms_count) || sms_count <= 0) {
    return res.status(400).json({ error: 'sms_count must be a positive integer' });
  }

  try {
    const { data: membership } = await supabaseAdmin
      .from('tenant_members')
      .select('tenant_id')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    if (!membership) {
      return res.status(403).json({ error: 'No active business account' });
    }

    const tenant_id = membership.tenant_id;

    // Idempotency: return the existing pending topup instead of creating a duplicate
    const { data: pendingTopup } = await supabaseAdmin
      .from('orders')
      .select('id, status, topup_sms_count, topup_amount_mwk, invoices(id, invoice_number, total_mwk, transactions(id, checkout_url))')
      .eq('tenant_id', tenant_id)
      .eq('order_type', 'topup')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingTopup) {
      const existingInvoice = pendingTopup.invoices?.[0];
      const existingTx = existingInvoice?.transactions?.[0];
      let checkoutUrl = existingTx?.checkout_url ?? null;

      if (!checkoutUrl && existingInvoice) {
        try {
          const [invoiceResult, txResult] = await Promise.all([
            supabaseAdmin.from('invoices').select('id, invoice_number, total_mwk').eq('id', existingInvoice.id).single(),
            supabaseAdmin.from('transactions').select('id, transaction_reference').eq('invoice_id', existingInvoice.id).maybeSingle()
          ]);
          if (invoiceResult.data) {
            checkoutUrl = await initiatePaychanguCheckout({
              user,
              invoice:             invoiceResult.data,
              amountMwk:           invoiceResult.data.total_mwk,
              tenantId:            tenant_id,
              description:         'SMS Top-Up re-checkout',
              existingTransaction: txResult.data || null
            });
          }
        } catch (reErr) {
          console.error('Re-initiate topup checkout failed:', reErr?.response?.data || reErr?.message);
        }
      }

      return res.status(200).json({
        order_id: pendingTopup.id,
        invoice_number: existingInvoice?.invoice_number ?? null,
        checkout_url: checkoutUrl,
        sms_count: pendingTopup.topup_sms_count,
        cost_mwk: pendingTopup.topup_amount_mwk,
        status: pendingTopup.status,
        existing_order: true,
        message: checkoutUrl
          ? 'You have an unpaid top-up order. Complete this payment before placing a new one.'
          : 'You have an unpaid top-up order with no payment link. Cancel it to place a new order.'
      });
    }

    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('subscription_tier_id, subscription_tiers(tier_type)')
      .eq('id', tenant_id)
      .single();

    if (!tenant?.subscription_tier_id || tenant.subscription_tiers?.tier_type !== 'bundle') {
      return res.status(403).json({ error: 'Top-ups require an active bundle subscription' });
    }

    const { data: pricing } = await supabaseAdmin
      .from('platform_pricing')
      .select('price_per_unit')
      .eq('channel', 'sms')
      .eq('currency', 'MWK')
      .eq('is_active', true)
      .single();

    if (!pricing) {
      return res.status(500).json({ error: 'SMS pricing not configured' });
    }

    const pricePerSms = parseFloat(pricing.price_per_unit);
    const costMwk = sms_count * pricePerSms;

    if (costMwk < 10000) {
      return res.status(400).json({
        error: 'Minimum top-up is MWK 10,000',
        current_cost_mwk: costMwk,
        minimum_sms_count: Math.ceil(10000 / pricePerSms)
      });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        tenant_id,
        created_by: user.id,
        order_type: 'topup',
        channel: 'sms',
        topup_sms_count: sms_count,
        topup_price_per_sms: pricePerSms,
        topup_amount_mwk: costMwk,
        status: 'pending'
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from('invoices')
      .insert({
        tenant_id,
        order_id: order.id,
        invoice_type: 'topup',
        subtotal_mwk: costMwk,
        total_mwk: costMwk,
        line_items: [{ description: `SMS Top-Up: ${sms_count} credits @ MWK ${pricePerSms}`, amount: costMwk }]
      })
      .select()
      .single();

    if (invoiceError) throw invoiceError;

    let checkoutUrl;
    try {
      checkoutUrl = await initiatePaychanguCheckout({
        user,
        invoice,
        amountMwk: costMwk,
        tenantId: tenant_id,
        description: `SMS Top-Up: ${sms_count} credits`
      });
    } catch (checkoutErr) {
      await supabaseAdmin.from('orders').update({ status: 'failed' }).eq('id', order.id);
      console.error('PayChangu checkout error:', checkoutErr?.response?.data || checkoutErr?.message);
      return res.status(502).json({
        error: 'Payment gateway error — order has been cancelled',
        detail: checkoutErr?.response?.data?.message || checkoutErr?.message
      });
    }

    return res.status(201).json({
      order_id: order.id,
      invoice_number: invoice.invoice_number,
      checkout_url: checkoutUrl,
      sms_count,
      cost_mwk: costMwk,
      price_per_sms: pricePerSms
    });
  } catch (error) {
    console.error('Topup Order Error:', error);
    return res.status(500).json({ error: 'Failed to create top-up order', detail: error?.message });
  }
});

/**
 * @swagger
 * /api/v1/orders:
 *   get:
 *     summary: List orders for the authenticated tenant
 *     tags:
 *       - Billing
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, processing, fulfilled, failed, cancelled]
 *         description: Filter by order status
 *     responses:
 *       200:
 *         description: List of orders
 *       403:
 *         description: No active business account
 */
router.get('/orders', requireAuth, async (req, res) => {
  const { status } = req.query;

  const { data: membership } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No active business account' });
  }

  let query = supabaseAdmin
    .from('orders')
    .select('id, order_type, channel, bundle_sms_credits, bundle_price_mwk, bundle_discount_pct, topup_sms_count, topup_price_per_sms, topup_amount_mwk, effective_sms_credits, status, fulfilled_at, created_at, subscription_tiers(name)')
    .eq('tenant_id', membership.tenant_id)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data: orders, error } = await query;

  if (error) {
    console.error('Orders List Error:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }

  return res.json({ orders });
});

/**
 * @swagger
 * /api/v1/orders/{id}:
 *   get:
 *     summary: Get a single order
 *     tags:
 *       - Billing
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order UUID
 *     responses:
 *       200:
 *         description: Order details
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Order not found
 */
router.get('/orders/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('*, subscription_tiers(name), invoices(invoice_number, status, paid_at, total_mwk)')
    .eq('id', id)
    .single();

  if (error || !order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const { data: membership } = await supabaseAdmin
    .from('tenant_members')
    .select('id')
    .eq('tenant_id', order.tenant_id)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'Not authorized for this order' });
  }

  return res.json(order);
});

/**
 * @swagger
 * /api/v1/orders/{id}/cancel:
 *   post:
 *     summary: Cancel a pending order
 *     description: |
 *       Cancels a `pending` order and its associated invoice and transaction.
 *       Only `pending` orders can be cancelled — `processing`, `fulfilled`, or `failed` orders cannot.
 *       Use this to clear a stuck pending order so you can place a new one.
 *     tags:
 *       - Billing
 *     security:
 *       - SystemKeyAuth: []
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Order UUID
 *     responses:
 *       200:
 *         description: Order cancelled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 order_id:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Order is not cancellable (wrong status)
 *       403:
 *         description: Not authorized for this order
 *       404:
 *         description: Order not found
 */
router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: membership } = await supabaseAdmin
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', req.user.id)
    .eq('status', 'active')
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No active business account' });
  }

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, status, tenant_id')
    .eq('id', id)
    .eq('tenant_id', membership.tenant_id)
    .maybeSingle();

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (order.status !== 'pending') {
    return res.status(400).json({
      error: `Cannot cancel a ${order.status} order`,
      hint: order.status === 'fulfilled'
        ? 'This order has already been paid and fulfilled.'
        : order.status === 'processing'
        ? 'Payment is being processed — wait for it to complete or contact support.'
        : null
    });
  }

  // Cancel order, invoice, and any pending transaction in parallel
  const [, invoiceResult] = await Promise.all([
    supabaseAdmin
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', id),
    supabaseAdmin
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('order_id', id)
      .select('id')
  ]);

  const invoiceId = invoiceResult.data?.[0]?.id;
  if (invoiceId) {
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'cancelled' })
      .eq('invoice_id', invoiceId)
      .neq('status', 'completed');
  }

  return res.status(200).json({
    success: true,
    order_id: id,
    message: 'Order cancelled. You can now place a new order.'
  });
});

module.exports = router;
