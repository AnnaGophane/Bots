import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

// Configure logger first
const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'bot.log' })
  ]
});

// Load environment variables
config();

// Validate bot token with proper error message
if (!process.env.BOT_TOKEN) {
  logger.error('BOT_TOKEN environment variable is required. Please set it in your .env file.');
  process.exit(1);
}

// Helper function to validate bot token format
function isValidBotToken(token) {
  // Updated regex to be more flexible while maintaining security
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
}

// Initialize configuration
let botConfig;
try {
  botConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
} catch (error) {
  logger.info('Creating new configuration from environment variables');
  botConfig = {
    botToken: process.env.BOT_TOKEN,
    sourceChats: JSON.parse(process.env.SOURCE_CHATS || '[]'),
    destinationChats: JSON.parse(process.env.DESTINATION_CHATS || '[]'),
    filters: {
      keywords: JSON.parse(process.env.FILTER_KEYWORDS || '[]'),
      types: JSON.parse(process.env.FILTER_TYPES || '["text","photo","video","document"]')
    },
    rateLimit: {
      maxMessages: parseInt(process.env.RATE_LIMIT_MAX || '10'),
      timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60')
    },
    admins: JSON.parse(process.env.ADMIN_USERS || '[]'),
    clonedBots: new Map(),
    logChannel: process.env.LOG_CHANNEL || ''
  };
}

// Initialize bot with improved error handling
let bot;
try {
  const token = process.env.BOT_TOKEN.trim();
  
  if (!isValidBotToken(token)) {
    throw new Error('Invalid bot token format. Please check your token from @BotFather');
  }
  
  bot = new TelegramBot(token, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: {
        timeout: 30,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post']
      }
    },
    request: {
      timeout: 30000,
      retry: 3,
      connect_timeout: 10000
    },
    webHook: false
  });
  
  // Test connection
  const me = await bot.getMe();
  logger.info(`Bot initialized successfully: @${me.username}`);
} catch (error) {
  if (error.message.includes('ETELEGRAM: 404')) {
    logger.error('Invalid bot token. Please check your token from @BotFather');
  } else if (error.message.includes('ETELEGRAM: 401')) {
    logger.error('Unauthorized. The bot token is invalid or has been revoked.');
  } else if (error.message.includes('Invalid bot token format')) {
    logger.error(error.message);
  } else {
    logger.error('Failed to initialize bot:', error.message);
  }
  process.exit(1);
}

// Enhanced polling error handler with improved reconnection logic
let retryCount = 0;
const maxRetries = 10;
const baseDelay = 2000;
let isReconnecting = false;

bot.on('polling_error', async (error) => {
  // Ignore EFATAL errors as they are usually temporary
  if (error.message.includes('EFATAL')) {
    return;
  }
  
  // Avoid multiple reconnection attempts
  if (isReconnecting) return;
  
  logger.error('Polling error:', error.message);
  
  if (retryCount < maxRetries) {
    const delay = Math.min(baseDelay * Math.pow(1.5, retryCount), 10000); // Max 10 second delay
    retryCount++;
    isReconnecting = true;
    
    try {
      await bot.stopPolling();
      await new Promise(resolve => setTimeout(resolve, delay));
      
      await bot.startPolling();
      retryCount = 0;
      isReconnecting = false;
      logger.info('Successfully reconnected');
    } catch (reconnectError) {
      logger.error('Reconnection failed:', reconnectError.message);
      isReconnecting = false;
      
      // If we can't reconnect after multiple attempts, restart the process
      if (retryCount >= maxRetries) {
        logger.error('Max retries reached, restarting bot...');
        process.exit(1); // Let the process manager restart the bot
      }
    }
  }
});

// Welcome message handler
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name;
  
  const welcomeMessage = `
Welcome ${username}! 🤖

I'm an Auto-Forward bot that can help you forward messages between multiple chats without the forwarded tag.

*Main Commands:*
/clone - Create your own bot using your token
/add_sources - Add multiple source chats
/add_destinations - Add multiple destination chats
/list_sources - List all source chats
/list_destinations - List all destination chats
/remove_sources - Remove multiple source chats
/remove_destinations - Remove multiple destination chats
/clear_sources - Remove all source chats
/clear_destinations - Remove all destination chats
/status - Check bot status
/help - Show all commands

*Examples:*
• Add multiple sources:
/add_sources -100123456789 -100987654321

• Add multiple destinations:
/add_destinations -100123456789 -100987654321 -100555555555

• Remove multiple sources:
/remove_sources -100123456789 -100987654321

Note: Some commands require admin privileges.
`;

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  
  if (botConfig.logChannel) {
    await bot.sendMessage(botConfig.logChannel, 
      `New user started the bot:\nID: ${msg.from.id}\nUsername: @${msg.from.username || 'N/A'}\nName: ${msg.from.first_name} ${msg.from.last_name || ''}`
    );
  }
});

// Clone bot command
bot.onText(/\/clone (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const newToken = match[1];
  
  try {
    const testBot = new TelegramBot(newToken, { polling: false });
    const me = await testBot.getMe();
    
    const clonedBot = new TelegramBot(newToken, {
      polling: {
        interval: 1000,
        autoStart: true,
        params: {
          timeout: 30,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post']
        }
      },
      webHook: false
    });
    
    const clonedConfig = {
      botToken: newToken,
      sourceChats: [],
      destinationChats: [],
      filters: { ...botConfig.filters },
      rateLimit: { ...botConfig.rateLimit },
      admins: [msg.from.id],
      owner: msg.from.id
    };
    
    setupBotEventHandlers(clonedBot, clonedConfig);
    
    botConfig.clonedBots.set(newToken, {
      bot: clonedBot,
      config: clonedConfig,
      owner: msg.from.id,
      username: me.username
    });
    
    await bot.sendMessage(chatId, 
      `✅ Bot cloned successfully!\n\nBot username: @${me.username}\n\nYou can now use all commands with your bot.`
    );
    
    if (botConfig.logChannel) {
      await bot.sendMessage(botConfig.logChannel, 
        `New bot cloned:\nOwner: ${msg.from.id} (@${msg.from.username || 'N/A'})\nBot: @${me.username}`
      );
    }
  } catch (error) {
    await bot.sendMessage(chatId, '❌ Invalid bot token. Please check your token and try again.');
    logger.error('Clone error:', error.message);
  }
});

// Rate limiting
const messageCounter = new Map();

function checkRateLimit(chatId) {
  const now = Date.now();
  const chatMessages = messageCounter.get(chatId) || [];
  const recentMessages = chatMessages.filter(
    timestamp => now - timestamp < botConfig.rateLimit.timeWindow * 1000
  );
  
  if (recentMessages.length >= botConfig.rateLimit.maxMessages) {
    return false;
  }
  
  recentMessages.push(now);
  messageCounter.set(chatId, recentMessages);
  return true;
}

function matchesFilters(msg) {
  const messageType = Object.keys(msg).find(key => 
    ['text', 'photo', 'video', 'document'].includes(key)
  );
  
  if (!botConfig.filters.types.includes(messageType)) {
    return false;
  }
  
  if (messageType === 'text' && botConfig.filters.keywords.length > 0) {
    const hasKeyword = botConfig.filters.keywords.some(keyword =>
      msg.text.toLowerCase().includes(keyword.toLowerCase())
    );
    if (!hasKeyword) {
      return false;
    }
  }
  
  return true;
}

// Admin commands
async function handleAdminCommands(msg, botInstance = bot, config = botConfig) {
  const text = msg.text;
  const chatId = msg.chat.id;

  const isAdmin = config.admins.includes(msg.from.id);
  const requiresAdmin = ['/add_sources', '/add_destinations', '/remove_sources', '/remove_destinations', '/clear_sources', '/clear_destinations'].some(cmd => text.startsWith(cmd));
  
  if (requiresAdmin && !isAdmin) {
    await botInstance.sendMessage(chatId, '⚠️ This command requires admin privileges.');
    return;
  }

  if (text.startsWith('/add_sources')) {
    const sourceIds = text.split(' ').slice(1).map(id => parseInt(id));
    if (sourceIds.length === 0) {
      await botInstance.sendMessage(chatId, 
        'Please provide at least one valid chat ID\n' +
        'Format: /add_sources -100123456789 -100987654321 ...'
      );
      return;
    }

    let added = 0;
    let skipped = 0;
    
    for (const sourceId of sourceIds) {
      if (!sourceId) continue;
      
      if (!config.sourceChats.includes(sourceId)) {
        config.sourceChats.push(sourceId);
        added++;
      } else {
        skipped++;
      }
    }
    
    saveConfig();
    
    const message = [
      added > 0 ? `✅ Added ${added} new source${added > 1 ? 's' : ''}` : '',
      skipped > 0 ? `⚠️ Skipped ${skipped} existing source${skipped > 1 ? 's' : ''}` : ''
    ].filter(Boolean).join('\n');
    
    await botInstance.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `Sources added by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
        `Added: ${added}\nSkipped: ${skipped}`
      );
    }
  }

  else if (text.startsWith('/add_destinations')) {
    const destIds = text.split(' ').slice(1).map(id => parseInt(id));
    if (destIds.length === 0) {
      await botInstance.sendMessage(chatId, 
        'Please provide at least one valid chat ID\n' +
        'Format: /add_destinations -100123456789 -100987654321 ...'
      );
      return;
    }

    let added = 0;
    let skipped = 0;
    
    for (const destId of destIds) {
      if (!destId) continue;
      
      if (!config.destinationChats.includes(destId)) {
        config.destinationChats.push(destId);
        added++;
      } else {
        skipped++;
      }
    }
    
    saveConfig();
    
    const message = [
      added > 0 ? `✅ Added ${added} new destination${added > 1 ? 's' : ''}` : '',
      skipped > 0 ? `⚠️ Skipped ${skipped} existing destination${skipped > 1 ? 's' : ''}` : ''
    ].filter(Boolean).join('\n');
    
    await botInstance.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `Destinations added by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
        `Added: ${added}\nSkipped: ${skipped}`
      );
    }
  }

  else if (text === '/list_sources') {
    const sources = config.sourceChats.length > 0 
      ? config.sourceChats.map(id => `• ${id}`).join('\n')
      : 'No source chats configured';
    await botInstance.sendMessage(chatId, `📋 *Source Chats:*\n${sources}`, { parse_mode: 'Markdown' });
  }

  else if (text === '/list_destinations') {
    const destinations = config.destinationChats.length > 0
      ? config.destinationChats.map(id => `• ${id}`).join('\n')
      : 'No destination chats configured';
    await botInstance.sendMessage(chatId, `📋 *Destination Chats:*\n${destinations}`, { parse_mode: 'Markdown' });
  }

  else if (text.startsWith('/remove_sources')) {
    const sourceIds = text.split(' ').slice(1).map(id => parseInt(id));
    if (sourceIds.length === 0) {
      await botInstance.sendMessage(chatId, 
        'Please provide source chat IDs to remove.\nFormat: /remove_sources chatId1 chatId2 ...'
      );
      return;
    }

    let removed = 0;
    let notFound = 0;
    let invalid = 0;
    
    for (const sourceId of sourceIds) {
      if (isNaN(sourceId)) {
        invalid++;
      } else if (config.sourceChats.includes(sourceId)) {
        config.sourceChats = config.sourceChats.filter(id => id !== sourceId);
        removed++;
      } else {
        notFound++;
      }
    }
    
    saveConfig();
    
    const message = [
      removed > 0 ? `✅ Removed ${removed} source${removed > 1 ? 's' : ''}` : '',
      notFound > 0 ? `⚠️ Not found: ${notFound}` : '',
      invalid > 0 ? `❌ Invalid IDs: ${invalid}` : ''
    ].filter(Boolean).join('\n');
    
    await botInstance.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `Sources removed by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
        `Removed: ${removed}\nNot found: ${notFound}\nInvalid: ${invalid}`
      );
    }
  }

  else if (text.startsWith('/remove_destinations')) {
    const destIds = text.split(' ').slice(1).map(id => parseInt(id));
    if (destIds.length === 0) {
      await botInstance.sendMessage(chatId, 
        'Please provide destination chat IDs to remove.\nFormat: /remove_destinations chatId1 chatId2 ...'
      );
      return;
    }

    let removed = 0;
    let notFound = 0;
    let invalid = 0;
    
    for (const destId of destIds) {
      if (isNaN(destId)) {
        invalid++;
      } else if (config.destinationChats.includes(destId)) {
        config.destinationChats = config.destinationChats.filter(id => id !== destId);
        removed++;
      } else {
        notFound++;
      }
    }
    
    saveConfig();
    
    const message = [
      removed > 0 ? `✅ Removed ${removed} destination${removed > 1 ? 's' : ''}` : '',
      notFound > 0 ? `⚠️ Not found: ${notFound}` : '',
      invalid > 0 ? `❌ Invalid IDs: ${invalid}` : ''
    ].filter(Boolean).join('\n');
    
    await botInstance.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `Destinations removed by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
        `Removed: ${removed}\nNot found: ${notFound}\nInvalid: ${invalid}`
      );
    }
  }

  else if (text === '/clear_sources') {
    const count = config.sourceChats.length;
    config.sourceChats = [];
    saveConfig();
    await botInstance.sendMessage(chatId, `✅ Cleared all ${count} source chat${count !== 1 ? 's' : ''}`);
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `All sources cleared by ${msg.from.id} (@${msg.from.username || 'N/A'})\n` +
        `Cleared: ${count} sources`
      );
    }
  }

  else if (text === '/clear_destinations') {
    const count = config.destinationChats.length;
    config.destinationChats = [];
    saveConfig();
    await botInstance.sendMessage(chatId, `✅ Cleared all ${count} destination chat${count !== 1 ? 's' : ''}`);
    
    if (config.logChannel) {
      await botInstance.sendMessage(config.logChannel,
        `All destinations cleared by ${msg.from.id} (@${msg.from.username || 'N/A'})\n` +
        `Cleared: ${count} destinations`
      );
    }
  }

  else if (text === '/help') {
    const adminCommands = isAdmin ? `*Admin Commands:*
• /clone [token] - Create your own bot
• /broadcast [message] - Send message to all users
• /add_sources [chat_id1] [chat_id2] - Add source chats
• /add_destinations [chat_id1] [chat_id2] - Add destination chats
• /remove_sources [chat_id1] [chat_id2] - Remove source chats
• /remove_destinations [chat_id1] [chat_id2] - Remove destination chats
• /clear_sources - Remove all source chats
• /clear_destinations - Remove all destination chats\n` : '';

    const helpText = `*Available Commands:*

${adminCommands}*General Commands:*
• /list_sources - Show source chats
• /list_destinations - Show destinations
• /status - Show bot status
• /help - Show this message

*Examples:*
• /add_sources -100123456789 -100987654321
• /add_destinations -100123456789 -100987654321
${!isAdmin ? '\n⚠️ Some commands require admin privileges' : ''}`;

    await botInstance.sendMessage(chatId, helpText, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    });
  }

  else if (text === '/status') {
    const status = `
*Bot Status:*
• Sources: ${config.sourceChats.length}
• Destinations: ${config.destinationChats.length}
• Keywords: ${config.filters.keywords.length}
• Message Types: ${config.filters.types.join(', ')}
• Rate Limit: ${config.rateLimit.maxMessages} msgs/${config.rateLimit.timeWindow}s
• Cloned Bots: ${botConfig.clonedBots.size}

*Active Chats:*
Sources:
${config.sourceChats.map(id => `• ${id}`).join('\n') || 'None'}

Destinations:
${config.destinationChats.map(id => `• ${id}`).join('\n') || 'None'}
    `.trim();
    await botInstance.sendMessage(chatId, status, { parse_mode: 'Markdown' });
  }
}

// Clean forward message function
async function cleanForwardMessage(msg, botInstance, destChat) {
  try {
    if (msg.text) {
      await botInstance.sendMessage(destChat, msg.text, {
        parse_mode: msg.parse_mode || 'HTML',
        disable_web_page_preview: msg.disable_web_page_preview
      });
    } 
    else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      await botInstance.sendPhoto(destChat, photo.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.video) {
      await botInstance.sendVideo(destChat, msg.video.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.document) {
      await botInstance.sendDocument(destChat, msg.document.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.audio) {
      await botInstance.sendAudio(destChat, msg.audio.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.voice) {
      await botInstance.sendVoice(destChat, msg.voice.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.video_note) {
      await botInstance.sendVideoNote(destChat, msg.video_note.file_id);
    }
    else if (msg.sticker) {
      await botInstance.sendSticker(destChat, msg.sticker.file_id);
    }
    else if (msg.location) {
      await botInstance.sendLocation(destChat, msg.location.latitude, msg.location.longitude);
    }
    else if (msg.poll) {
      await botInstance.sendPoll(destChat, msg.poll.question, msg.poll.options.map(opt => opt.text), {
        is_anonymous: msg.poll.is_anonymous,
        type: msg.poll.type,
        allows_multiple_answers: msg.poll.allows_multiple_answers,
        correct_option_id: msg.poll.correct_option_id
      });
    }
    else if (msg.animation) {
      await botInstance.sendAnimation(destChat, msg.animation.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }

    return true;
  } catch (error) {
    logger.error({
      event: 'clean_forward_error',
      error: error.message,
      messageId: msg.message_id,
      source: msg.chat.id,
      destination: destChat
    });
    return false;
  }
}

// Forward message function
async function forwardMessage(msg, botInstance = bot, config = botConfig) {
  try {
    if (!config.sourceChats.includes(msg.chat.id)) {
      return;
    }
    
    if (!matchesFilters(msg)) {
      return;
    }
    
    if (!checkRateLimit(msg.chat.id)) {
      logger.warn(`Rate limit exceeded for chat ${msg.chat.id}`);
      return;
    }
    
    for (const destChat of config.destinationChats) {
      const success = await cleanForwardMessage(msg, botInstance, destChat);
      
      if (success) {
        logger.info({
          event: 'message_forwarded',
          source: msg.chat.id,
          destination: destChat,
          messageId: msg.message_id,
          type: Object.keys(msg).find(key => 
            ['text', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'sticker', 'location', 'poll', 'animation'].includes(key)
          )
        });
        
        if (config.logChannel) {
          const messageType = Object.keys(msg).find(key => 
            ['text', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'sticker', 'location', 'poll', 'animation'].includes(key)
          );
          
          await botInstance.sendMessage(config.logChannel,
            `Message forwarded:\nFrom: ${msg.chat.id}\nTo: ${destChat}\nType: ${messageType}`
          );
        }
      }
    }
  } catch (error) {
    logger.error({
      event: 'forward_error',
      error: error.message,
      messageId: msg.message_id,
      source: msg.chat.id
    });
  }
}

// Set up event handlers for a bot instance
function setupBotEventHandlers(botInstance, config) {
  botInstance.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) {
      await handleAdminCommands(msg, botInstance, config);
    } else {
      await forwardMessage(msg, botInstance, config);
    }
  });

  botInstance.on('polling_error', (error) => {
    logger.error({
      event: 'polling_error',
      error: error.message,
      botToken: config.botToken
    });
  });

  botInstance.on('error', (error) => {
    logger.error({
      event: 'bot_error',
      error: error.message,
      botToken: config.botToken
    });
  });
}

// Save configuration
function saveConfig() {
  if (process.env.NODE_ENV !== 'production') {
    try {
      writeFileSync('./config.json', JSON.stringify(botConfig, null, 2));
      logger.info('Configuration saved successfully');
    } catch (error) {
      logger.error('Error saving configuration:', error.message);
    }
  }
}

// Set up event handlers for main bot
setupBotEventHandlers(bot, botConfig);

// Set up bot commands
async function setupBotCommands() {
  try {
    await bot.setMyCommands([
      { command: 'start', description: 'Start the bot and get help' },
      { command: 'clone', description: 'Clone this bot with your own token' },
      { command: 'add_sources', description: 'Add multiple source chats' },
      { command: 'add_destinations', description: 'Add multiple destination chats' },
      { command: 'list_sources', description: 'List all source chats' },
      { command: 'list_destinations', description: 'List all destination chats' },
      { command: 'remove_sources', description: 'Remove multiple source chats' },
      { command: 'remove_destinations', description: 'Remove multiple destination chats' },
      { command: 'clear_sources', description: 'Remove all source chats' },
      { command: 'clear_destinations', description: 'Remove all destination chats' },
      { command: 'broadcast', description: 'Send message to all users (Admin only)' },
      { command: 'status', description: 'Show bot status' },
      { command: 'help', description: 'Show help message' }
    ]);
    logger.info('Bot commands set up successfully');
  } catch (error) {
    logger.error('Failed to set up bot commands:', error);
  }
}

setupBotCommands().catch(error => {
  logger.error('Failed to set up bot commands:', error.message);
});

// Enhanced error handling for the main process
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
  logger.info('Received SIGINT. Graceful shutdown initiated...');
  try {
    await bot.stopPolling();
    logger.info('Bot polling stopped successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM. Graceful shutdown initiated...');
  try {
    await bot.stopPolling();
    logger.info('Bot polling stopped successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
});

logger.info('Bot started successfully with improved error handling');
