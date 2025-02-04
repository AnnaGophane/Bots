import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

// Load environment variables
config();

// Validate bot token and log channel
const BOT_TOKEN = process.env.BOT_TOKEN;
const LOG_CHANNEL = process.env.LOG_CHANNEL;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

if (!LOG_CHANNEL) {
  throw new Error('LOG_CHANNEL environment variable is not set');
}

// Configure logger
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

// Initialize configuration with better error handling
let botConfig;
try {
  botConfig = {
    botToken: BOT_TOKEN,
    logChannel: LOG_CHANNEL,
    sourceChats: process.env.SOURCE_CHATS ? JSON.parse(process.env.SOURCE_CHATS) : [],
    destinationChats: process.env.DESTINATION_CHATS ? JSON.parse(process.env.DESTINATION_CHATS) : [],
    filters: {
      keywords: process.env.FILTER_KEYWORDS ? JSON.parse(process.env.FILTER_KEYWORDS) : [],
      types: process.env.FILTER_TYPES ? JSON.parse(process.env.FILTER_TYPES) : ["text","photo","video","document"]
    },
    rateLimit: {
      maxMessages: parseInt(process.env.RATE_LIMIT_MAX || '10'),
      timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60')
    },
    admins: process.env.ADMIN_USERS ? JSON.parse(process.env.ADMIN_USERS) : [],
    users: new Map(), // Store user data
    clonedBots: new Map() // Store cloned bot instances
  };
  logger.info('Configuration initialized from environment variables');
} catch (error) {
  logger.error('Error initializing configuration:', error);
  process.exit(1);
}

// Initialize bot with better error handling and timeouts
const bot = new TelegramBot(botConfig.botToken, {
  polling: true,
  request: {
    timeout: 30000,
    retry: 3
  }
});

// Log to channel function
async function logToChannel(message, type = 'info') {
  try {
    const emoji = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '🚫',
      success: '✅'
    };

    const formattedMessage = `${emoji[type]} *${type.toUpperCase()}*\n${message}`;
    await bot.sendMessage(botConfig.logChannel, formattedMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error logging to channel:', error);
  }
}

// Clone bot functionality
async function cloneBot(msg, newBotToken) {
  try {
    // Validate bot token
    if (!newBotToken || !/^\d+:[A-Za-z0-9_-]{35}$/.test(newBotToken)) {
      await bot.sendMessage(msg.chat.id, '⚠️ Please provide a valid bot token.');
      return;
    }

    // Create new bot instance
    const clonedBot = new TelegramBot(newBotToken, {
      polling: true
    });

    // Test if token is valid
    try {
      await clonedBot.getMe();
    } catch (error) {
      await bot.sendMessage(msg.chat.id, '⚠️ Invalid bot token. Please check and try again.');
      return;
    }

    // Store user data
    botConfig.users.set(msg.from.id, {
      username: msg.from.username,
      first_name: msg.from.first_name,
      clonedBot: newBotToken,
      created_at: new Date().toISOString()
    });

    // Store cloned bot instance
    botConfig.clonedBots.set(newBotToken, {
      userId: msg.from.id,
      username: msg.from.username,
      bot: clonedBot
    });

    // Log cloning event
    await logToChannel(
      `New bot cloned!\n` +
      `User: ${msg.from.username || msg.from.first_name} (${msg.from.id})\n` +
      `Bot Token: \`${newBotToken}\``,
      'success'
    );

    await bot.sendMessage(
      msg.chat.id,
      '✅ Bot cloned successfully! Start your bot and use /help to see available commands.'
    );

  } catch (error) {
    logger.error('Clone error:', error);
    await bot.sendMessage(msg.chat.id, '⚠️ Failed to clone bot. Please try again later.');
  }
}

// Broadcast command
async function broadcast(msg, message) {
  if (!botConfig.admins.includes(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, '⚠️ This command requires admin privileges.');
    return;
  }

  const users = Array.from(botConfig.users.values());
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.sendMessage(user.userId, message, { parse_mode: 'Markdown' });
      sent++;
    } catch (error) {
      failed++;
      logger.error(`Broadcast error for user ${user.username}:`, error);
    }
  }

  await logToChannel(
    `Broadcast sent by ${msg.from.username || msg.from.first_name}\n` +
    `Success: ${sent}\nFailed: ${failed}`,
    'info'
  );

  await bot.sendMessage(
    msg.chat.id,
    `✅ Broadcast completed\nSuccess: ${sent}\nFailed: ${failed}`
  );
}

// Enhanced welcome message
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name;
  
  const welcomeMessage = `
Welcome ${username}! 🤖

I'm an Auto-Forward bot that can help you forward messages between chats without the forwarded tag.

*Main Commands:*
/clone <bot_token> - Create your own bot
/add_source - Add a source chat
/add_destinations - Add multiple destination chats
/list_sources - List all source chats
/list_destinations - List all destination chats
/status - Check bot status
/help - Show all commands

*Admin Commands:*
/broadcast - Send message to all users
/stats - View bot statistics

*Examples:*
• Clone bot: /clone 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
• Add source: /add_source -100123456789
• Add destinations: /add_destinations -100123456789 -100987654321

Note: Some commands require admin privileges.
`;

  try {
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    
    // Log new user
    if (!botConfig.users.has(msg.from.id)) {
      botConfig.users.set(msg.from.id, {
        username: msg.from.username,
        first_name: msg.from.first_name,
        started_at: new Date().toISOString()
      });

      await logToChannel(
        `New user started the bot!\n` +
        `User: ${msg.from.username || msg.from.first_name} (${msg.from.id})`,
        'info'
      );
    }
  } catch (error) {
    logger.error('Start command error:', error);
  }
});

// Clone command
bot.onText(/\/clone (.+)/, async (msg, match) => {
  const newBotToken = match[1];
  await cloneBot(msg, newBotToken);
});

// Broadcast command
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const message = match[1];
  await broadcast(msg, message);
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
  if (!botConfig.admins.includes(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, '⚠️ This command requires admin privileges.');
    return;
  }

  const stats = {
    users: botConfig.users.size,
    clonedBots: botConfig.clonedBots.size,
    sources: botConfig.sourceChats.length,
    destinations: botConfig.destinationChats.length
  };

  const statsMessage = `
*Bot Statistics* 📊

• Total Users: ${stats.users}
• Cloned Bots: ${stats.clonedBots}
• Source Chats: ${stats.sources}
• Destination Chats: ${stats.destinations}
`;

  await bot.sendMessage(msg.chat.id, statsMessage, { parse_mode: 'Markdown' });
});

// Enhanced polling error handler
bot.on('polling_error', (error) => {
  if (error.code === 'EFATAL') {
    logger.warn('Fatal polling error, attempting restart...', {
      error: error.message,
      code: error.code
    });
    setTimeout(() => bot.startPolling(), 5000);
    return;
  }
  
  if (error.code === 'ETELEGRAM') {
    logger.warn('Telegram API error', {
      error: error.message,
      code: error.code
    });
    return;
  }
  
  logger.error('Unhandled polling error', {
    error: error.message,
    code: error.code
  });
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

// Clean forward message function
async function cleanForwardMessage(msg, destChat) {
  try {
    if (msg.text) {
      await bot.sendMessage(destChat, msg.text, {
        parse_mode: msg.parse_mode || 'HTML',
        disable_web_page_preview: msg.disable_web_page_preview
      });
    } 
    else if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      await bot.sendPhoto(destChat, photo.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.video) {
      await bot.sendVideo(destChat, msg.video.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.document) {
      await bot.sendDocument(destChat, msg.document.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }

    return true;
  } catch (error) {
    logger.error('Forward error:', error);
    return false;
  }
}

// Forward message function
async function forwardMessage(msg) {
  try {
    if (!botConfig.sourceChats.includes(msg.chat.id)) {
      return;
    }
    
    if (!matchesFilters(msg)) {
      return;
    }
    
    if (!checkRateLimit(msg.chat.id)) {
      logger.warn(`Rate limit exceeded for chat ${msg.chat.id}`);
      return;
    }
    
    for (const destChat of botConfig.destinationChats) {
      await cleanForwardMessage(msg, destChat);
    }
  } catch (error) {
    logger.error('Forward error:', error);
  }
}

// Message handler
bot.on('message', async (msg) => {
  try {
    if (!msg.text?.startsWith('/')) {
      await forwardMessage(msg);
    }
  } catch (error) {
    logger.error('Message handling error:', error);
  }
});

// Admin commands
bot.onText(/\/add_source (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const sourceId = parseInt(match[1]);
  
  if (!botConfig.admins.includes(msg.from.id)) {
    await bot.sendMessage(chatId, '⚠️ This command requires admin privileges.');
    return;
  }

  if (!sourceId) {
    await bot.sendMessage(chatId, '⚠️ Please provide a valid chat ID');
    return;
  }

  if (!botConfig.sourceChats.includes(sourceId)) {
    botConfig.sourceChats.push(sourceId);
    await bot.sendMessage(chatId, '✅ Source chat added successfully');
  } else {
    await bot.sendMessage(chatId, '⚠️ This chat is already a source');
  }
});

bot.onText(/\/add_destinations (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const destIds = match[1].split(' ').map(id => parseInt(id));
  
  if (!botConfig.admins.includes(msg.from.id)) {
    await bot.sendMessage(chatId, '⚠️ This command requires admin privileges.');
    return;
  }

  let added = 0;
  for (const destId of destIds) {
    if (!destId) continue;
    if (!botConfig.destinationChats.includes(destId)) {
      botConfig.destinationChats.push(destId);
      added++;
    }
  }

  await bot.sendMessage(chatId, added > 0 ? 
    `✅ Added ${added} new destination${added > 1 ? 's' : ''}` : 
    '⚠️ No new destinations added'
  );
});

// Start message
logger.info('Bot started successfully');
await logToChannel('Bot started successfully', 'success');
