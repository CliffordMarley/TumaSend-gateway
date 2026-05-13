const { Router } = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../../config/supabase');

const router = Router();

router.post('/', async (req, res) => {
  const log = (step, data) =>
    console.log(`[PayChangu Webhook] ${step}`, data !== undefined ? JSON.stringify(data) : '');

  log('Received', { event_type: req.body.event_type, status: req.body.status, tx_ref: req.body.tx_ref, reference: req.body.reference });

  // ── Signature verification ───────────────────────────────────────────────
  const signature = req.headers['signature'];
  const secret = process.env.PAYCHANGU_WEBHOOK_SECRET;

  if (secret) {
    if (!signature) {
      log('REJECTED — missing signature header');
      return res.status(400).send('Missing signature header');
    }
    const payload = req.rawBody?.toString();
    if (!payload) {
      log('REJECTED — missing raw body');
      return res.status(400).send('Missing request body');
    }
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (computed !== signature) {
      log('REJECTED — signature mismatch', { received: signature, computed });
      return res.status(403).send('Invalid webhook request');
    }
    log('Signature OK');
  } else {
    log('Signature check SKIPPED — PAYCHANGU_WEBHOOK_SECRET not set');
  }
  // ── End signature verification ───────────────────────────────────────────

  const { event_type, status, tx_ref, reference } = req.body;

  const isPaymentEvent = event_type === 'checkout.payment' || event_type === 'api.charge.payment';
  if (!isPaymentEvent) {
    log('IGNORED — unhandled event type', { event_type });
    return res.status(200).send('Webhook processed successfully');
  }

  if (!tx_ref) {
    log('REJECTED — tx_ref missing');
    return res.status(200).send('Webhook processed successfully');
  }

  const isSuccess = status === 'success' || status === 'successful';
  const isFailed  = status === 'failed' || status === 'cancelled' || status === 'error';

  if (!isSuccess && !isFailed) {
    log('IGNORED — intermediate status, no action needed', { status });
    return res.status(200).send('Webhook processed successfully');
  }

  // Idempotency — skip if already in a terminal state
  if (reference) {
    const { data: existing } = await supabaseAdmin
      .from('transactions')
      .select('id, status')
      .eq('paychangu_reference', reference)
      .maybeSingle();

    if (existing?.status === 'completed' || existing?.status === 'failed') {
      log('SKIPPED — already in terminal state', { transaction_id: existing.id, status: existing.status });
      return res.status(200).send('Webhook processed successfully');
    }
  }

  // Resolve transaction directly by transaction_reference (TXN-YYYYMMDD-000001)
  log('Looking up transaction', { tx_ref });
  const { data: transaction, error: txLookupErr } = await supabaseAdmin
    .from('transactions')
    .select('id, status, tenant_id, amount_mwk, invoice_id')
    .eq('transaction_reference', tx_ref)
    .maybeSingle();

  if (txLookupErr) log('Transaction query error', txLookupErr);

  if (!transaction) {
    log('FAILED — transaction not found', { tx_ref });
    return res.status(200).send('Webhook processed successfully');
  }
  log('Transaction found', { transaction_id: transaction.id, current_status: transaction.status });

  if (transaction.status === 'completed' || transaction.status === 'failed') {
    log('SKIPPED — transaction already in terminal state', { status: transaction.status });
    return res.status(200).send('Webhook processed successfully');
  }

  // Load invoice + order (needed for both success and failure paths)
  const { data: invoice } = await supabaseAdmin
    .from('invoices')
    .select('id, order_id, orders(*)')
    .eq('id', transaction.invoice_id)
    .maybeSingle();

  if (!invoice) {
    log('FAILED — invoice not found', transaction.invoice_id);
    return res.status(200).send('Webhook processed successfully');
  }

  // ── FAILED / CANCELLED ───────────────────────────────────────────────────
  if (isFailed) {
    log('Payment failed — marking transaction and order', { status });

    await supabaseAdmin
      .from('transactions')
      .update({
        status:          'failed',
        webhook_payload: req.body,
        metadata:        req.body,
        completed_at:    new Date().toISOString()
      })
      .eq('id', transaction.id);

    await supabaseAdmin
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', invoice.id);

    const order = invoice.orders;
    if (order?.id) {
      await supabaseAdmin
        .from('orders')
        .update({ status: 'failed' })
        .eq('id', order.id);
      log('Order marked failed', { order_id: order.id });
    }

    log('Done — payment failed ✗');
    return res.status(200).send('Webhook processed successfully');
  }

  // ── SUCCESS ──────────────────────────────────────────────────────────────
  const authorization  = req.body.authorization || {};
  const paymentChannel = authorization.channel || null;
  const mobileDetails  = authorization.mobile_money || {};
  const fee            = Number(req.body.charge ?? req.body.fee ?? 0);

  const payerPhone = mobileDetails.mobile_number || req.body.customer?.phone || null;
  const payerEmail = req.body.customer?.email    || req.body.email           || null;
  const payerName  = [req.body.customer?.first_name || req.body.first_name,
                      req.body.customer?.last_name  || req.body.last_name]
    .filter(Boolean).join(' ') || null;

  log('Updating transaction → completed', { transaction_id: transaction.id, fee, paymentChannel });

  const { error: txError } = await supabaseAdmin
    .from('transactions')
    .update({
      status:                'completed',
      paychangu_reference:   reference || null,
      payment_channel:       paymentChannel,
      authorization_details: Object.keys(authorization).length ? authorization : null,
      webhook_payload:       req.body,
      fee_mwk:               fee,
      net_amount_mwk:        transaction.amount_mwk - fee,
      payer_phone:           payerPhone,
      payer_email:           payerEmail,
      payer_name:            payerName,
      completed_at:          new Date().toISOString(),
      metadata:              req.body
    })
    .eq('id', transaction.id);

  if (txError) {
    log('ERROR — transaction update failed', txError);
    return res.status(500).send('Internal Server Error');
  }
  log('Transaction updated → completed');

  await supabaseAdmin
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString(), payment_reference: reference || tx_ref })
    .eq('id', invoice.id);
  log('Invoice updated → paid');

  const order = invoice.orders;
  if (order?.id) {
    const { error: fulfillError } = await supabaseAdmin.rpc('fulfill_bundle_order', { p_order_id: order.id });
    if (fulfillError) {
      log('ERROR — fulfill_bundle_order failed', fulfillError);
    } else {
      log('Order fulfilled → SMS credits granted', { order_id: order.id });
    }
  }

  log('Done ✓');
  return res.status(200).send('Webhook processed successfully');
});

module.exports = router;
