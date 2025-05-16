require('dotenv').config();
const express = require('express');

const router = express.Router();
const verifyToken = require('../middlewares/verifyToken');
const validator = require('../middlewares/validator');
const WhatsAppService = require('../services/baileys');
const { sendText, checkNumber, sendImage } = require('../validators/message');

router.post('/check-number', verifyToken, validator(checkNumber), async (req, res) => {
  try {
    const { to } = req.body;
    const result = await WhatsAppService.checkNumber(to);
    res.sendResponse(200, result);
  } catch (error) {
    res.sendError(500, error);
  }
});

router.post('/send-text', verifyToken, validator(sendText), async (req, res) => {
  try {
    const { to, message } = req.body;
    const result = await WhatsAppService.sendMessage(to, message);
    if (result.status === 1) {
      res.sendResponse(200, result);
    } else {
      res.sendError(400, result);
    }
  } catch (error) {
    res.sendError(500, error);
  }
});

router.post('/send-image', verifyToken, validator(sendImage), async (req, res) => {
  try {
    const { to, image } = req.body;
    const result = await WhatsAppService.sendImage(to, image);
    if (result.status === 1) {
      res.sendResponse(200, result);
    } else {
      res.sendError(400, result);
    }
  } catch (error) {
    res.sendError(500, error);
  }
});

module.exports = router;
