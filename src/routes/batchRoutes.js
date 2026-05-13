const { Router } = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');

const router = Router();

/**
 * @swagger
 * /api/v1/batches/{batchId}:
 *   get:
 *     summary: Get batch status
 *     description: Returns the status and delivery details of a message batch. Only accessible with the API key that created the batch.
 *     tags:
 *       - Messaging
 *     security:
 *       - SystemKeyAuth: []
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema:
 *           type: string
 *         description: The batch UUID returned when sending
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Batch details with per-message delivery status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: completed
 *                 total_recipients:
 *                   type: integer
 *                 total_sent:
 *                   type: integer
 *                 total_delivered:
 *                   type: integer
 *                 total_failed:
 *                   type: integer
 *                 messages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       recipient:
 *                         type: string
 *                       status:
 *                         type: string
 *                       delivered_at:
 *                         type: string
 *       404:
 *         description: Batch not found
 *       401:
 *         description: Invalid or missing API key
 */
router.get('/:batchId', apiKeyAuth, async (req, res) => {
  const { batchId } = req.params;
  const { tenantId } = req.apiKey;

  const { data: batch, error } = await supabaseAdmin
    .from('message_batches')
    .select('id, status, total_recipients, total_sent, total_delivered, total_failed, messages(id, recipient, status, delivered_at)')
    .eq('id', batchId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  res.status(200).json(batch);
});

module.exports = router;
