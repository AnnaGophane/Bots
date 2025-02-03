import { logger } from '../logger.js';
import { config } from '../config.js';
import { handleAdminCommands } from './admin.js';
import { forwardMessage } from './forward.js';

export async function handleMessage(msg, bot) {
  if (!msg || !msg.chat) {
    logger.warn('Received invalid message:', msg);
    return;
  }

  try {
    if (msg.text?.startsWith('/')) {
      await handleAdminCommands(msg, bot);
    } else {
      await forwardMessage(msg, bot);
    }
  } catch (error) {
    logger.error('Error in message handler:', {
      error: error.message,
      messageId: msg?.message_id,
      chatId: msg?.chat?.id
    });
    
    try {
      await bot.sendMessage(msg.chat.id, 'Sorry, there was an error processing your message.');
    } catch (sendError) {
      logger.error('Failed to send error message:', sendError.message);
    }
  }
}
