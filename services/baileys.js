const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const pino = require('pino');
const fs = require('fs').promises;
const { logger, errorLogger } = require('../utils/logger');

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.qr = null;
    this.sessionPath = path.join(__dirname, '../sessions');
    this.connectionUpdateHandler = null;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 5;
  }

  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
  }

  async waitForQR(timeout = 60000) {
    return new Promise((resolve) => {
      let timeoutId = null;

      // Function to cleanup event handlers
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.connectionUpdateHandler && this.sock?.ev) {
          this.sock.ev.off('connection.update', this.connectionUpdateHandler);
          this.connectionUpdateHandler = null;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        // Resolve with null on timeout
        resolve(null);
      }, timeout);

      if (this.sock) {
        this.connectionUpdateHandler = (update) => {
          const { connection, qr } = update;

          if (qr) {
            cleanup();
            this.qr = qr;
            resolve(qr);
          } else if (connection === 'open') {
            cleanup();
            resolve(null);
          }
        };

        this.sock.ev.on('connection.update', this.connectionUpdateHandler);
      } else {
        cleanup();
        resolve(null);
      }
    });
  }

  async initialize(isReconnecting = false) {
    try {
      // Check if session directory exists
      try {
        await fs.access(this.sessionPath);
      } catch (error) {
        if (isReconnecting) {
          logger.warn('No session found, cannot reconnect');
          return {
            success: false,
            status: 'error',
            message: 'No session found, cannot reconnect',
          };
        }
      }

      if (isReconnecting) {
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
          logger.warn(`Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`);
          await this.handleLogout('max_attempts_exceeded');
          return await this.initialize(false);
        }
        logger.info(`Attempting to reconnect... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
      } else {
        this.resetReconnectAttempts();
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['Baileys REST API', 'Chrome', '1.0.0'],
        logger: pino({ level: 'silent' }),
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          // If already connected and trying to reconnect, cancel the operation
          if (this.isConnected && isReconnecting) {
            logger.info({
              msg: 'Connection already active, reconnection cancelled',
            });
            return;
          }

          const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && !this.isConnected) {
            await this.initialize(true);
          } else if (!shouldReconnect) {
            logger.info({
              msg: 'Session terminated',
            });
            await this.handleLogout('connection_closed');
            await this.initialize(false);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          this.qr = null;
          this.resetReconnectAttempts();
          logger.info({
            msg: 'WhatsApp connection successful!',
          });
          await WhatsAppService.notifyWebhook('connection', { status: 'connected' });
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
          try {
            await Promise.all(m.messages.map(async (msg) => {
              // Debug log for raw message
              logger.debug({
                msg: 'Raw message received',
                data: msg,
              });

              // Extract relevant message information
              const messageInfo = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                fromMe: msg.key.fromMe,
                timestamp: msg.messageTimestamp,
                type: Object.keys(msg.message || {})[0],
                pushName: msg.pushName,
                content: WhatsAppService.extractMessageContent(msg),
                isGroup: msg.key.remoteJid?.endsWith('@g.us') || false,
              };

              // Debug log for processed message
              logger.debug({
                msg: 'Processed message info',
                data: messageInfo,
              });

              // Send to webhook
              await WhatsAppService.notifyWebhook('message.received', messageInfo);
              logger.info({
                msg: 'New message processed',
                messageId: messageInfo.id,
                from: messageInfo.from,
                type: messageInfo.type,
                content: messageInfo.content,
                isGroup: messageInfo.isGroup,
                timestamp: new Date(messageInfo.timestamp * 1000).toISOString(),
              });
            }));
          } catch (error) {
            errorLogger.error({
              msg: 'Error processing incoming message',
              error: error.message,
            });
            await WhatsAppService.notifyWebhook('error', {
              type: 'message_processing_error',
              error: error.message,
            });
          }
        }
      });

      // Wait for QR code or successful connection
      const qr = await this.waitForQR();

      // If QR code is received
      if (qr) {
        await WhatsAppService.notifyWebhook('connection', { status: 'waiting_qr', qr });
        return {
          success: true,
          status: 'waiting_qr',
          qr,
        };
      }

      // If connection is successful
      if (this.isConnected) {
        return {
          success: true,
          status: 'connected',
          message: 'WhatsApp connection successful',
        };
      }

      // In case of timeout or other issues
      return {
        success: false,
        status: 'error',
        message: 'Failed to get QR code or establish connection',
      };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during WhatsApp connection initialization',
        error: error?.message || error,
      });
      await WhatsAppService.notifyWebhook('error', { error: error.message });
      return {
        success: false,
        status: 'error',
        message: 'Failed to initialize WhatsApp connection',
        error: error.message,
      };
    }
  }

  async handleLogout(reason = 'normal_logout') {
    try {
      // Clean up session files
      await fs.rm(this.sessionPath, { recursive: true, force: true });

      // Reset state
      this.sock = null;
      this.isConnected = false;
      this.qr = null;

      // Notify webhook
      await WhatsAppService.notifyWebhook('connection', {
        status: 'logged_out',
        reason,
      });

      logger.info(`Session files cleaned and session terminated (${reason})`);

      return {
        success: true,
        status: 'logged_out',
        message: 'Session successfully terminated',
        reason,
      };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during session cleanup',
        error: error?.message || error,
      });
      return {
        success: false,
        status: 'error',
        message: 'Error occurred while terminating session',
        error: error.message,
      };
    }
  }

  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
        return await this.handleLogout('user_logout');
      }
      return {
        success: false,
        status: 'error',
        message: 'No active session found',
      };
    } catch (error) {
      errorLogger.error({
        msg: 'Error during logout',
        error: error?.message || error,
      });
      return {
        success: false,
        status: 'error',
        message: 'Error occurred while logging out',
        error: error.message,
      };
    }
  }

  static async notifyWebhook(event, data) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      logger.warn({
        msg: 'Webhook URL not configured, skipping notification',
      });
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Baileys-API-Webhook',
          'X-Event-Type': event,
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed with status ${response.status}: ${response.statusText}`);
      }

      logger.debug({
        msg: 'Webhook notification sent successfully',
        event,
        status: response.status,
      });
    } catch (error) {
      errorLogger.error({
        msg: 'Error during webhook notification',
        event,
        error: error.message,
        data: JSON.stringify(data),
      });
    }
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      qr: this.qr,
    };
  }

  async sendMessage(to, message) {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      const result = await this.sock.sendMessage(to, { text: message });
      logger.info({
        msg: 'Message sent',
        to,
        messageId: result.key.id,
      });
      return result;
    } catch (error) {
      errorLogger.error({
        msg: 'Failed to send message',
        error: error.message,
      });
      throw error;
    }
  }

  async sendImage(to, image) {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      const result = await this.sock.sendMessage(to, { image });
      logger.info({
        msg: 'Image sent',
        to,
        imageId: result.key.id,
      });
      return result;
    } catch (error) {
      errorLogger.error({
        msg: 'Failed to send image',
        error: error.message,
      });
      throw error;
    }
  }

  async checkNumber(phoneNumber) {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      // Check if the number exists on WhatsApp
      const [result] = await this.sock.onWhatsApp(phoneNumber.replace(/[^\d]/g, ''));

      if (result) {
        logger.info({
          msg: 'Phone number check completed',
          phoneNumber,
          exists: true,
          jid: result.jid,
        });
        return {
          exists: true,
          jid: result.jid,
        };
      }

      logger.info({
        msg: 'Phone number check completed',
        phoneNumber,
        exists: false,
      });
      return {
        exists: false,
        jid: null,
      };
    } catch (error) {
      errorLogger.error({
        msg: 'Failed to check phone number',
        phoneNumber,
        error: error.message,
      });
      throw error;
    }
  }

  // Change to static method
  static extractMessageContent(msg) {
    if (!msg.message) return null;

    // Get the first message type (text, image, video, etc.)
    const messageType = Object.keys(msg.message)[0];
    const messageContent = msg.message[messageType];

    switch (messageType) {
      case 'conversation':
        return { type: 'text', text: messageContent };

      case 'extendedTextMessage':
        return {
          type: 'text',
          text: messageContent.text,
          contextInfo: messageContent.contextInfo,
        };

      case 'imageMessage':
        return {
          type: 'image',
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case 'videoMessage':
        return {
          type: 'video',
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case 'audioMessage':
        return {
          type: 'audio',
          mimetype: messageContent.mimetype,
          seconds: messageContent.seconds,
        };

      case 'documentMessage':
        return {
          type: 'document',
          fileName: messageContent.fileName,
          mimetype: messageContent.mimetype,
        };

      case 'stickerMessage':
        return {
          type: 'sticker',
          mimetype: messageContent.mimetype,
        };

      case 'locationMessage':
        return {
          type: 'location',
          degreesLatitude: messageContent.degreesLatitude,
          degreesLongitude: messageContent.degreesLongitude,
          name: messageContent.name,
        };

      case 'contactMessage':
        return {
          type: 'contact',
          displayName: messageContent.displayName,
          vcard: messageContent.vcard,
        };

      default:
        return {
          type: messageType,
          content: 'Message type not specifically handled',
        };
    }
  }
}

module.exports = new WhatsAppService();
