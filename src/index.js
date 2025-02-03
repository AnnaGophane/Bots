import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

// Load environment variables
dotenv.config();

// Initialize configuration
let botConfig;
try {
  botConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
} catch (error) {
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
    clonedBots: new Map()
  };
}

// Configure logger
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

// Initialize bot with polling and error handling
const bot = new TelegramBot(botConfig.botToken, {
  polling: true
});

// Handle polling errors
bot.on('polling_error', (error) => {
  logger.error('Polling error:', error.message);
});

// Handle general errors
bot.on('error', (error) => {
  logger.error('Bot error:', error.message);
});

// Set up bot commands when starting
async function setupBotCommands() {
  try {
    await bot.setMyCommands([
      { command: 'start', description: 'Start the bot and get help' },
      { command: 'add_source', description: 'Add a source chat (Format: /add_source -100123456789)' },
      { command: 'add_destinations', description: 'Add multiple destination chats (Format: /add_destinations -100123456789 -100987654321)' },
      { command: 'list_sources', description: 'List all source chats' },
      { command: 'list_destinations', description: 'List all destination chats' },
      { command: 'remove_source', description: 'Remove a source chat (Format: /remove_source -100123456789)' },
      { command: 'remove_destination', description: 'Remove a destination chat (Format: /remove_destination -100123456789)' },
      { command: 'clone', description: 'Clone this bot with a new token (Admin only)' },
      { command: 'status', description: 'Show bot status' },
      { command: 'help', description: 'Show help message' }
    ]);
    logger.info('Bot commands set up successfully');
  } catch (error) {
    logger.error('Error setting up bot commands:', error.message);
  }
}

// Welcome message handler
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name;
  
  const welcomeMessage = `
Welcome ${username}! 🤖

I'm an Auto-Forward bot that can help you forward messages between chats without the forwarded tag.

*Main Commands:*
/add_source - Add a source chat
/add_destinations - Add multiple destination chats
/list_sources - List all source chats
/list_destinations - List all destination chats
/status - Check bot status
/help - Show all commands

*Examples:*
• Add source: /add_source -100123456789
• Add multiple destinations: /add_destinations -100123456789 -100987654321 -100555555555
• Remove destination: /remove_destination -100123456789

Note: Some commands require admin privileges.
`;

  try {
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error sending welcome message:', error.message);
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

// Clone bot functionality with proper error handling
async function cloneBot(msg, newBotToken) {
  try {
    if (!botConfig.admins.includes(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, 'You are not authorized to clone bots.');
      return;
    }

    if (!newBotToken || !/^\d+:[A-Za-z0-9_-]{35}$/.test(newBotToken)) {
      await bot.sendMessage(msg.chat.id, 'Please provide a valid bot token.');
      return;
    }

    const clonedBotConfig = {
      ...botConfig,
      botToken: newBotToken,
      sourceChats: [],
      destinationChats: [],
      filters: {
        keywords: [],
        types: ["text", "photo", "video", "document"]
      },
      admins: [msg.from.id]
    };

    const clonedBot = new TelegramBot(newBotToken, {
      polling: true
    });

    botConfig.clonedBots.set(newBotToken, {
      bot: clonedBot,
      config: clonedBotConfig
    });

    setupBotEventHandlers(clonedBot, clonedBotConfig);
    await setupBotCommands(); // Set up commands for cloned bot

    await bot.sendMessage(msg.chat.id, 
      'Bot cloned successfully! You are set as the admin. Use /help to see available commands.'
    );

    logger.info({
      event: 'bot_cloned',
      creator: msg.from.id,
      newBotToken: newBotToken
    });

  } catch (error) {
    logger.error({
      event: 'clone_error',
      error: error.message,
      userId: msg.from.id
    });
    await bot.sendMessage(msg.chat.id, 'Failed to clone bot. Please try again later.');
  }
}

// Set up event handlers for a bot instance
function setupBotEventHandlers(botInstance, config) {
  botInstance.on('message', async (msg) => {
    try {
      if (msg.text?.startsWith('/')) {
        await handleAdminCommands(msg, botInstance, config);
      } else {
        await forwardMessage(msg, botInstance, config);
      }
    } catch (error) {
      logger.error('Error handling message:', error.message);
    }
  });

  botInstance.on('polling_error', (error) => {
    logger.error({
      event: 'polling_error',
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
    } catch (error) {
      logger.error('Error saving config:', error.message);
    }
  }
}

// Admin commands
async function handleAdminCommands(msg, botInstance = bot, config = botConfig) {
  const text = msg.text;
  const chatId = msg.chat.id;

  // Check if user is admin for protected commands
  const isAdmin = config.admins.includes(msg.from.id);
  const requiresAdmin = ['/add_source', '/add_destinations', '/remove_source', '/remove_destination', '/clone'].some(cmd => text.startsWith(cmd));
  
  if (requiresAdmin && !isAdmin) {
    await botInstance.sendMessage(chatId, '⚠️ This command requires admin privileges.');
    return;
  }

  if (text.startsWith('/clone')) {
    const newBotToken = text.split(' ')[1];
    await cloneBot(msg, newBotToken);
    return;
  }

  if (text.startsWith('/add_source')) {
    const sourceId = parseInt(text.split(' ')[1]);
    if (!sourceId) {
      await botInstance.sendMessage(chatId, '⚠️ Please provide a valid chat ID\nFormat: /add_source -100123456789');
      return;
    }
    if (!config.sourceChats.includes(sourceId)) {
      config.sourceChats.push(sourceId);
      saveConfig();
      await botInstance.sendMessage(chatId, '✅ Source chat added successfully');
    } else {
      await botInstance.sendMessage(chatId, '⚠️ This chat is already a source');
    }
  }

  // New command to add multiple destinations at once
  else if (text.startsWith('/add_destinations')) {
    const destIds = text.split(' ').slice(1).map(id => parseInt(id));
    if (destIds.length === 0) {
      await botInstance.sendMessage(chatId, 
        '⚠️ Please provide at least one valid chat ID\n' +
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

  else if (text.startsWith('/remove_source')) {
    const sourceId = parseInt(text.split(' ')[1]);
    if (!sourceId) {
      await botInstance.sendMessage(chatId, '⚠️ Please provide a valid chat ID\nFormat: /remove_source -100123456789');
      return;
    }
    if (config.sourceChats.includes(sourceId)) {
      config.sourceChats = config.sourceChats.filter(id => id !== sourceId);
      saveConfig();
      await botInstance.sendMessage(chatId, '✅ Source chat removed successfully');
    } else {
      await botInstance.sendMessage(chatId, '⚠️ This chat is not in your source list');
    }
  }

  else if (text.startsWith('/remove_destination')) {
    const destId = parseInt(text.split(' ')[1]);
    if (!destId) {
      await botInstance.sendMessage(chatId, '⚠️ Please provide a valid chat ID\nFormat: /remove_destination -100123456789');
      return;
    }
    if (config.destinationChats.includes(destId)) {
      config.destinationChats = config.destinationChats.filter(id => id !== destId);
      saveConfig();
      await botInstance.sendMessage(chatId, '✅ Destination chat removed successfully');
    } else {
      await botInstance.sendMessage(chatId, '⚠️ This chat is not in your destination list');
    }
  }

  else if (text === '/help') {
    const helpText = `
*Available Commands:*

${isAdmin ? '*Admin Commands:*\n' : ''}${isAdmin ? `• /clone [bot_token] - Clone this bot
• /add_source [chat_id] - Add source chat
• /add_destinations [chat_id1] [chat_id2] ... - Add multiple destinations
• /remove_source [chat_id] - Remove source
• /remove_destination [chat_id] - Remove destination\n` : ''}
*General Commands:*
• /list_sources - Show source chats
• /list_destinations - Show destinations
• /status - Show bot status
• /help - Show this message

*Examples:*
• /add_source -100123456789
• /add_destinations -100123456789 -100987654321
• /remove_destination -100123456789

${!isAdmin ? '\n⚠️ Some commands require admin privileges' : ''}
    `.trim();
    await botInstance.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  }

  else if (text === '/status') {
    const status = `
*Bot Status:*
• Sources: ${config.sourceChats.length}
• Destinations: ${config.destinationChats.length}
• Keywords: ${config.filters.keywords.length}
• Message Types: ${config.filters.types.join(', ')}
• Rate Limit: ${config.rateLimit.maxMessages} msgs/${config.rateLimit.timeWindow}s

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

// Set up event handlers for main bot
setupBotEventHandlers(bot, botConfig);

// Set up bot commands when starting
setupBotCommands().catch(error => {
  logger.error('Failed to set up bot commands:', error.message);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error.message);
});

logger.info('Bot started successfully');
