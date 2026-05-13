const { Router } = require('express');
const { requireAuth } = require('../middlewares/authMiddleware');

const router = Router();

router.post('/topup', requireAuth, async (_req, res) => {
  return res.status(308).json({
    error: 'This endpoint has been retired.',
    message: 'Please use POST /api/v1/orders/topup instead.',
    redirect: '/api/v1/orders/topup'
  });
});

module.exports = router;
