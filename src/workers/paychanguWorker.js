const axios = require('axios');
const { supabaseAdmin } = require('../config/supabase');

const PAYCHANGU_API = 'https://api.paychangu.com';
const PAYCHANGU_KEY = process.env.PAYCHANGU_API_KEY;

// Only check transactions older than this (give the webhook time to arrive first)
const MIN_AGE_MS = 5 * 60 * 1000;        // 5 minutes

// Stop checking transactions older than this (too old to recover gracefully)
const MAX_AGE_MS = 48 * 60 * 60 * 1000;  // 48 hours

// Max transactions checked per run (keeps API usage predictable)
const BATCH_LIMIT = 15;

let recoveryTimer = null;

/**
 * Settle a transaction that PayChangu confirms as paid.
 * Mirrors the webhook handler logic so both paths produce identical DB state.
 */
async function settleTransaction(transaction, payData) {
  const log = (msg, data) =>
    console.log(`[paychanguWorker] ${msg}`, data !== undefined ? JSON.stringify(data) : '');

  const fee       = Number(payData.charge ?? payData.fee ?? 0);
  const channel   = payData.mobile_money ? 'Mobile Money' : (payData.card ? 'Card' : null);
  const payerPhone = payData.mobile || null;
  const payerEmail = payData.email  || null;
  const payerName  = [payData.first_name, payData.last_name].filter(Boolean).join(' ') || null;

  const { error: txError } = await supabaseAdmin
    .from('transactions')
    .update({
      status:                'completed',
      paychangu_charge_id:   payData.charge_id  || null,
      paychangu_reference:   payData.ref_id     || null,
      payment_channel:       channel,
      authorization_details: payData.mobile_money ? { channel, mobile_money: payData.mobile_money } : null,
      fee_mwk:               fee,
      net_amount_mwk:        transaction.amount_mwk - fee,
      payer_phone:           payerPhone,
      payer_email:           payerEmail,
      payer_name:            payerName,
      completed_at:          payData.completed_at || new Date().toISOString(),
      metadata:              payData
    })
    .eq('id', transaction.id);

  if (txError) {
    log('ERROR — transaction update failed', txError);
    return;
  }
  log('Transaction settled', { transaction_id: transaction.id });

  // Mark invoice paid
  const { data: invoice } = await supabaseAdmin
    .from('invoices')
    .update({
      status:            'paid',
      paid_at:           payData.completed_at || new Date().toISOString(),
      payment_reference: payData.ref_id || payData.charge_id || null
    })
    .eq('id', transaction.invoice_id)
    .select('id, order_id, orders(*)')
    .single();

  if (!invoice) {
    log('ERROR — invoice not found for transaction', transaction.invoice_id);
    return;
  }
  log('Invoice marked paid', { invoice_id: invoice.id });

  // Fulfil the order (grants SMS credits, updates subscription)
  const order = invoice.orders;
  if (order?.id) {
    const { error: fulfillError } = await supabaseAdmin.rpc('fulfill_bundle_order', {
      p_order_id: order.id
    });
    if (fulfillError) {
      log('ERROR — fulfill_bundle_order failed', fulfillError);
    } else {
      log('Order fulfilled — SMS credits granted', { order_id: order.id });
    }
  }
}

/**
 * Mark a transaction and its order as failed when PayChangu confirms it did not go through.
 */
async function failTransaction(transaction) {
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'failed', completed_at: new Date().toISOString() })
    .eq('id', transaction.id);

  const { data: invoice } = await supabaseAdmin
    .from('invoices')
    .update({ status: 'cancelled' })
    .eq('id', transaction.invoice_id)
    .select('id, order_id')
    .single();

  if (invoice?.order_id) {
    await supabaseAdmin
      .from('orders')
      .update({ status: 'failed' })
      .eq('id', invoice.order_id);
  }

  console.log(`[paychanguWorker] Transaction failed — marked tx/invoice/order`, { transaction_id: transaction.id });
}

/**
 * Main recovery run — polls PayChangu for each stale pending transaction.
 */
async function recoverPendingTransactions() {
  const now        = Date.now();
  const minAgo     = new Date(now - MIN_AGE_MS).toISOString();
  const maxAgo     = new Date(now - MAX_AGE_MS).toISOString();

  const { data: pending, error } = await supabaseAdmin
    .from('transactions')
    .select('id, transaction_reference, invoice_id, amount_mwk, tenant_id, paychangu_checkout_id')
    .eq('status', 'pending')
    .not('paychangu_checkout_id', 'is', null)  // must have a PayChangu reference to check against
    .lt('created_at', minAgo)                  // older than 5 min (webhook had time to arrive)
    .gt('created_at', maxAgo)                  // not older than 48 h (abandon stale ones)
    .order('created_at', { ascending: true })  // oldest first so nothing starves
    .limit(BATCH_LIMIT);

  if (error) {
    console.error('[paychanguWorker] DB query error:', error.message);
    return;
  }

  if (!pending || pending.length === 0) return;

  console.log(`[paychanguWorker] checking ${pending.length} pending transaction(s)`);

  for (const tx of pending) {
    try {
      const { data: apiResponse } = await axios.get(
        `${PAYCHANGU_API}/mobile-money/payments/${tx.paychangu_checkout_id}/details`,
        {
          headers: {
            Accept:        'application/json',
            Authorization: `Bearer ${PAYCHANGU_KEY}`
          },
          timeout: 10000
        }
      );

      const payData = apiResponse?.data;
      const apiStatus = (payData?.status || apiResponse?.status || '').toLowerCase();

      console.log(`[paychanguWorker] tx ${tx.id} → PayChangu status: ${apiStatus}`);

      if (apiStatus === 'successful' || apiStatus === 'success') {
        await settleTransaction(tx, payData);
      } else if (apiStatus === 'failed' || apiStatus === 'cancelled' || apiStatus === 'error') {
        await failTransaction(tx);
      }
      // 'pending' or unknown — leave as-is and check again next run
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.message || err.message;
      console.error(`[paychanguWorker] check failed for tx ${tx.id} (HTTP ${status}): ${detail}`);
      // Don't throw — continue to next transaction
    }
  }
}

function startPaychanguWorker() {
  // Run every 10 minutes — webhook is primary; this is a safety net
  recoveryTimer = setInterval(() => {
    recoverPendingTransactions().catch(err =>
      console.error('[paychanguWorker] run error:', err.message)
    );
  }, 10 * 60 * 1000);

  // First run 2 minutes after server start (let everything warm up)
  setTimeout(() => {
    recoverPendingTransactions().catch(err =>
      console.error('[paychanguWorker] startup run error:', err.message)
    );
  }, 2 * 60 * 1000);

  console.log('[paychanguWorker] started — recovery every 10 min, window 5 min – 48 h, limit ' + BATCH_LIMIT);
}

function stopPaychanguWorker() {
  if (recoveryTimer) clearInterval(recoveryTimer);
}

module.exports = { startPaychanguWorker, stopPaychanguWorker };
