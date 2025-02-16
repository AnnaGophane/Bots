import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

// Configure logger with enhanced formatting
const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.printf(({ level, message, timestamp }) => {
      return `${timestamp} ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    }),
    new transports.File({ 
      filename: 'error.log',
      level: 'error'
    }),
    new transports.File({ 
      filename: 'combined.log'
    })
  ]
});

// Load environment variables with validation
config();

// Enhanced environment variable validation
const requiredEnvVars = ['BOT_TOKEN'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  logger.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Initialize default configuration with extended options
const defaultConfig = {
  botToken: process.env.BOT_TOKEN,
  sourceChats: [],
  destinationChats: [],
  filters: {
    keywords: [],
    types: [
      'text',
      'photo',
      'video',
      'document',
      'audio',
      'voice',
      'video_note',
      'sticker',
      'location',
      'poll',
      'animation',
      'contact',
      'venue',
      'game',
      'invoice',
      'successful_payment',
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post'
    ]
  },
  rateLimit: {
    maxMessages: parseInt(process.env.RATE_LIMIT_MAX || '10'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '10')
  },
  admins: process.env.ADMIN_USERS ? JSON.parse(process.env.ADMIN_USERS) : [],
  clonedBots: new Map(),
  logChannel: process.env.LOG_CHANNEL || '',
  forceSubscribe: process.env.FORCE_SUBSCRIBE ? JSON.parse(process.env.FORCE_SUBSCRIBE) : [],
  messageOptions: {
    parseMode: 'HTML',
    disableWebPagePreview: true,
    disableNotification: false
  },
  users: new Set(),
  statistics: {
    totalMessages: 0,
    forwardedMessages: 0,
    failedMessages: 0,
    lastReset: new Date()
  }
};

// Load or create configuration with error handling
let botConfig;
try {
  const configFile = readFileSync('./config.json', 'utf8');
  const parsedConfig = JSON.parse(configFile);
  botConfig = {
    ...defaultConfig,
    ...parsedConfig,
    users: new Set(parsedConfig.users || []),
    clonedBots: new Map(parsedConfig.clonedBots || []),
    statistics: {
      ...defaultConfig.statistics,
      ...parsedConfig.statistics
    }
  };
  logger.info('Configuration loaded successfully');
} catch (error) {
  logger.info('Creating new configuration from default settings');
  botConfig = defaultConfig;
  saveConfig();
}

// Helper function to validate bot token format
function isValidBotToken(token) {
  const tokenRegex = /^\d+:[A-Za-z0-9_-]{35,}$/;
  return tokenRegex.test(token.trim());
}

// Helper function to escape markdown v2 characters
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Initialize bot with improved error handling and retry logic
let bot;
try {
  const token = process.env.BOT_TOKEN.trim();
  
  if (!isValidBotToken(token)) {
    throw new Error('Invalid bot token format. Please check your token from @BotFather');
  }
  
  bot = new TelegramBot(token, {
    polling: {
      interval: 2000,
      autoStart: true,
      params: {
        timeout: 30,
        allowed_updates: [
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
          'callback_query'
        ],
        offset: -1
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

// Track processed messages to prevent duplicates
const processedMessages = new Map();

// Command handler wrapper to prevent duplicate processing
async function handleCommand(msg, handler) {
  const messageId = `${msg.chat.id}:${msg.message_id}`;
  const now = Date.now();
  
  // Check if message was processed in the last 5 seconds
  const lastProcessed = processedMessages.get(messageId);
  if (lastProcessed && now - lastProcessed < 5000) {
    return;
  }
  
  // Mark message as processed
  processedMessages.set(messageId, now);
  
  // Clean up old messages after 10 seconds
  setTimeout(() => {
    processedMessages.delete(messageId);
  }, 10000);
  
  try {
    // Check force subscribe first
    if (!(await checkForceSubscribe(msg, bot, botConfig))) {
      return;
    }
    
    // Execute the command handler
    await handler(msg);
  } catch (error) {
    logger.error(`Error handling command: ${error.message}`);
  }
}

// Add force subscribe check function with improved validation
async function checkForceSubscribe(msg, botInstance, config) {
  const userId = msg.from?.id;
  if (!userId) return true; // Skip for channel posts
  
  const requiredChannels = config.forceSubscribe || [];
  
  if (!requiredChannels.length) return true;
  
  let notSubscribed = [];
  
  for (const channelId of requiredChannels) {
    try {
      const member = await botInstance.getChatMember(channelId, userId);
      const chat = await botInstance.getChat(channelId);
      
      if (!['member', 'administrator', 'creator'].includes(member.status)) {
        notSubscribed.push({
          id: channelId,
          username: chat.username,
          title: chat.title
        });
      }
    } catch (error) {
      logger.error('Force subscribe check error:', error);
      continue;
    }
  }
  
  if (notSubscribed.length > 0) {
    const buttons = notSubscribed.map(channel => [{
      text: `📢 Join ${channel.title || channel.username || channel.id}`,
      url: `https://t.me/${channel.username}`
    }]);
    
    buttons.push([{ 
      text: '🔄 Check Subscription',
      callback_data: 'check_subscription'
    }]);
    
    await botInstance.sendMessage(msg.chat.id,
      `⚠️ *Please join our channel${notSubscribed.length > 1 ? 's' : ''} to use this bot\\!*\n\n` +
      `Click the button${notSubscribed.length > 1 ? 's' : ''} below to join:`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
    return false;
  }
  
  return true;
}

// Add callback query handler for subscription check button
bot.on('callback_query', async (query) => {
  if (query.data === 'check_subscription') {
    const subscribed = await checkForceSubscribe(query.message, bot, botConfig);
    
    if (subscribed) {
      await bot.answerCallbackQuery(query.id, {
        text: '✅ Thank you for subscribing! You can now use the bot.',
        show_alert: true
      });
      
      // Delete the subscription message
      await bot.deleteMessage(query.message.chat.id, query.message.message_id);
      
      // Send the welcome message again
      const startMessage = {
        text: '/start',
        from: query.from,
        chat: query.message.chat
      };
      
      // Trigger start command
      handleCommand(startMessage, handleStart);
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: '❌ Please join all required channels first!',
        show_alert: true
      });
    }
  }
});

// Command handlers
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = escapeMarkdown(msg.from.username || msg.from.first_name);
  
  // Add user to tracking
  botConfig.users.add(userId);
  saveConfig();
  
  const isAdmin = botConfig.admins.includes(userId);
  
  const welcomeMessage = 
    `Welcome ${username}\\! 🤖\n\n` +
    `I'm an Auto\\-Forward bot that can help you forward messages between multiple chats without the forwarded tag\\.\n\n` +
    `*Main Commands:*\n` +
    `• /add\\_sources \\- Add multiple source chats\n` +
    `• /add\\_destinations \\- Add multiple destination chats\n` +
    `• /list\\_sources \\- List all source chats\n` +
    `• /list\\_destinations \\- List all destination chats\n` +
    `• /remove\\_sources \\- Remove multiple source chats\n` +
    `• /remove\\_destinations \\- Remove multiple destination chats\n` +
    `• /clear\\_sources \\- Remove all source chats\n` +
    `• /clear\\_destinations \\- Remove all destination chats\n` +
    `• /help \\- Show all commands\n\n` +
    (isAdmin ? `*Admin Commands:*\n• /broadcast \\- Send message to all users\n• /status \\- Check bot status\n\n` : '') +
    `*Examples:*\n` +
    `• Add sources: /add\\_sources \\-100123456789 \\-100987654321\n` +
    `• Add destinations: /add\\_destinations \\-100123456789 \\-100987654321\n\n` +
    `Note: Some commands require admin privileges\\.`;
  
  await bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true
  });
  
  // Log new user
  if (botConfig.logChannel) {
    await bot.sendMessage(botConfig.logChannel,
      `New user started the bot:\n` +
      `ID: ${msg.from.id}\n` +
      `Username: @${msg.from.username || 'N/A'}\n` +
      `Name: ${msg.from.first_name} ${msg.from.last_name || ''}`
    );
  }
  
  logger.info(`New user started bot: ${userId} (@${msg.from.username || 'N/A'})`);
}

async function handleBroadcast(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const message = msg.text.split(/\s+(.+)/)[1]?.trim();
  
  // Check if user is admin
  if (!botConfig.admins.includes(userId)) {
    await bot.sendMessage(chatId, '⚠️ This command is only available for administrators\\.');
    logger.warn(`Non-admin user ${userId} attempted to use broadcast command`);
    return;
  }
  
  if (!message) {
    await bot.sendMessage(chatId,
      '❌ Please provide a message to broadcast\\.\n' +
      'Format: `/broadcast Your message here`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  try {
    let successCount = 0;
    let failCount = 0;
    const total = botConfig.users.size;
    
    // Send initial status message
    const statusMsg = await bot.sendMessage(chatId,
      '📢 Broadcasting message\\.\\.\\.\n' +
      `Total recipients: ${total}`
    );
    
    const startTime = Date.now();
    
    for (const recipientId of botConfig.users) {
      try {
        await bot.sendMessage(recipientId, message);
        successCount++;
        
        // Update status every 10 messages
        if (successCount % 10 === 0) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          await bot.editMessageText(
            `📢 Broadcasting\\.\\.\\.\n` +
            `Progress: ${successCount + failCount}/${total}\n` +
            `✅ Sent: ${successCount}\n` +
            `❌ Failed: ${failCount}\n` +
            `⏱ Elapsed: ${elapsed}s`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id
            }
          );
        }
      } catch (error) {
        failCount++;
        logger.error(`Broadcast failed for ${recipientId}:`, error.message);
      }
    }
    
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    
    // Send final status
    await bot.editMessageText(
      `📢 Broadcast completed\n` +
      `✅ Successful: ${successCount}\n` +
      `❌ Failed: ${failCount}\n` +
      `⏱ Total time: ${elapsed}s`,
      {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }
    );
    
    // Log broadcast results
    if (botConfig.logChannel) {
      await bot.sendMessage(botConfig.logChannel,
        `Broadcast completed:\n` +
        `Sent by: ${userId} (@${msg.from.username || 'N/A'})\n` +
        `Success: ${successCount}\n` +
        `Failed: ${failCount}\n` +
        `Time taken: ${elapsed}s\n` +
        `Message: ${message}`
      );
    }
    
    logger.info(`Broadcast completed - Success: ${successCount}, Failed: ${failCount}, Time: ${elapsed}s`);
  } catch (error) {
    logger.error('Broadcast error:', error);
    await bot.sendMessage(chatId, '❌ An error occurred while broadcasting the message\\.');
  }
}

async function handleAddSources(msg) {
  const chatId = msg.chat.id;
  const sourceIds = msg.text.split(/\s+/).slice(1).map(id => parseInt(id));
  
  if (sourceIds.length === 0) {
    await bot.sendMessage(chatId,
      '❌ Please provide valid chat IDs\\.\n' +
      'Format: `/add\\_sources \\-100123456789 \\-100987654321`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  let added = 0;
  let invalid = 0;
  let existing = 0;
  
  for (const id of sourceIds) {
    if (isNaN(id)) {
      invalid++;
      continue;
    }
    
    try {
      // Verify chat exists and bot has access
      await bot.getChat(id);
      
      if (!botConfig.sourceChats.includes(id)) {
        botConfig.sourceChats.push(id);
        added++;
      } else {
        existing++;
      }
    } catch (error) {
      logger.error(`Failed to verify chat ${id}:`, error.message);
      invalid++;
    }
  }
  
  saveConfig();
  
  const message = [
    added > 0 ? `✅ Added ${added} source chat${added !== 1 ? 's' : ''}` : '',
    existing > 0 ? `\n⚠️ ${existing} chat${existing !== 1 ? 's' : ''} already added` : '',
    invalid > 0 ? `\n❌ ${invalid} invalid ID${invalid !== 1 ? 's' : ''} skipped` : ''
  ].filter(Boolean).join('');
  
  await bot.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
  
  // Log changes
  if (botConfig.logChannel && added > 0) {
    await bot.sendMessage(botConfig.logChannel,
      `Sources added by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
      `Added: ${added}\n` +
      `Existing: ${existing}\n` +
      `Invalid: ${invalid}`
    );
  }
  
  logger.info(`Sources added - Added: ${added}, Existing: ${existing}, Invalid: ${invalid}`);
}

async function handleAddDestinations(msg) {
  const chatId = msg.chat.id;
  const destIds = msg.text.split(/\s+/).slice(1).map(id => parseInt(id));
  
  if (destIds.length === 0) {
    await bot.sendMessage(chatId,
      '❌ Please provide valid chat IDs\\.\n' +
      'Format: `/add\\_destinations \\-100123456789 \\-100987654321`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  let added = 0;
  let invalid = 0;
  let existing = 0;
  
  for (const id of destIds) {
    if (isNaN(id)) {
      invalid++;
      continue;
    }
    
    try {
      // Verify chat exists and bot has access
      await bot.getChat(id);
      
      if (!botConfig.destinationChats.includes(id)) {
        botConfig.destinationChats.push(id);
        added++;
      } else {
        existing++;
      }
    } catch (error) {
      logger.error(`Failed to verify chat ${id}:`, error.message);
      invalid++;
    }
  }
  
  saveConfig();
  
  const message = [
    added > 0 ? `✅ Added ${added} destination chat${added !== 1 ? 's' : ''}` : '',
    existing > 0 ? `\n⚠️ ${existing} chat${existing !== 1 ? 's' : ''} already added` : '',
    invalid > 0 ? `\n❌ ${invalid} invalid ID${invalid !== 1 ? 's' : ''} skipped` : ''
  ].filter(Boolean).join('');
  
  await bot.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
  
  // Log changes
  if (botConfig.logChannel && added > 0) {
    await bot.sendMessage(botConfig.logChannel,
      `Destinations added by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
      `Added: ${added}\n` +
      `Existing: ${existing}\n` +
      `Invalid: ${invalid}`
    );
  }
  
  logger.info(`Destinations added - Added: ${added}, Existing: ${existing}, Invalid: ${invalid}`);
}

async function handleListSources(msg) {
  const chatId = msg.chat.id;
  
  const sources = botConfig.sourceChats.length > 0
    ? botConfig.sourceChats.map(id => `• ${id}`).join('\n')
    : 'No source chats configured';
  
  const message = 
    `📋 *Source Chats*\n\n` +
    `${sources}\n\n` +
    `Total: ${botConfig.sourceChats.length}`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}

async function handleListDestinations(msg) {
  const chatId = msg.chat.id;
  
  const destinations = botConfig.destinationChats.length > 0
    ? botConfig.destinationChats.map(id => `• ${id}`).join('\n')
    : 'No destination chats configured';
  
  const message = 
    `📋 *Destination Chats*\n\n` +
    `${destinations}\n\n` +
    `Total: ${botConfig.destinationChats.length}`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
}

async function handleRemoveSources(msg) {
  const chatId = msg.chat.id;
  const sourceIds = msg.text.split(/\s+/).slice(1).map(id => parseInt(id));
  
  if (sourceIds.length === 0) {
    await bot.sendMessage(chatId,
      '❌ Please provide source chat IDs to remove\\.\n' +
      'Format: `/remove\\_sources chatId1 chatId2 \\.\\.\\.`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  let removed = 0;
  let notFound = 0;
  let invalid = 0;
  
  for (const sourceId of sourceIds) {
    if (isNaN(sourceId)) {
      invalid++;
    } else if (botConfig.sourceChats.includes(sourceId)) {
      botConfig.sourceChats = botConfig.sourceChats.filter(id => id !== sourceId);
      removed++;
    } else {
      notFound++;
    }
  }
  
  saveConfig();
  
  const message = [
    removed > 0 ? `✅ Removed ${removed} source${removed > 1 ? 's' : ''}` : '',
    notFound > 0 ? `\n⚠️ Not found: ${notFound}` : '',
    invalid > 0 ? `\n❌ Invalid IDs: ${invalid}` : ''
  ].filter(Boolean).join('');
  
  await bot.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
  
  // Log changes
  if (botConfig.logChannel && removed > 0) {
    await bot.sendMessage(botConfig.logChannel,
      `Sources removed by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
      `Removed: ${removed}\n` +
      `Not found: ${notFound}\n` +
      `Invalid: ${invalid}`
    );
  }
  
  logger.info(`Sources removed - Removed: ${removed}, Not found: ${notFound}, Invalid: ${invalid}`);
}

async function handleRemoveDestinations(msg) {
  const chatId = msg.chat.id;
  const destIds = msg.text.split(/\s+/).slice(1).map(id => parseInt(id));
  
  if (destIds.length === 0) {
    await bot.sendMessage(chatId,
      '❌ Please provide destination chat IDs to remove\\.\n' +
      'Format: `/remove\\_destinations chatId1 chatId2 \\.\\.\\.`',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  let removed = 0;
  let notFound = 0;
  let invalid = 0;
  
  for (const destId of destIds) {
    if (isNaN(destId)) {
      invalid++;
    } else if (botConfig.destinationChats.includes(destId)) {
      botConfig.destinationChats = botConfig.destinationChats.filter(id => id !== destId);
      removed++;
    } else {
      notFound++;
    }
  }
  
  saveConfig();
  
  const message = [
    removed > 0 ? `✅ Removed ${removed} destination${removed > 1 ? 's' : ''}` : '',
    notFound > 0 ? `\n⚠️ Not found: ${notFound}` : '',
    invalid > 0 ? `\n❌ Invalid IDs: ${invalid}` : ''
  ].filter(Boolean).join('');
  
  await bot.sendMessage(chatId, message || '⚠️ No valid chat IDs provided');
  
  // Log changes
  if (botConfig.logChannel && removed > 0) {
    await bot.sendMessage(botConfig.logChannel,
      `Destinations removed by ${msg.from.id} (@${msg.from.username || 'N/A'}):\n` +
      `Removed: ${removed}\n` +
      `Not found: ${notFound}\n` +
      `Invalid: ${invalid}`
    );
  }
  
  logger.info(`Destinations removed - Removed: ${removed}, Not found: ${notFound}, Invalid: ${invalid}`);
}

async function handleClearSources(msg) {
  const chatId = msg.chat.id;
  
  const count = botConfig.sourceChats.length;
  
  if (count === 0) {
    await bot.sendMessage(chatId, '⚠️ No source chats to clear\\.');
    return;
  }
  
  botConfig.sourceChats = [];
  saveConfig();
  
  await bot.sendMessage(chatId, `✅ Cleared all ${count} source chat${count !== 1 ? 's' : ''}`);
  
  // Log changes
  if (botConfig.logChannel) {
    await bot.sendMessage(botConfig.logChannel,
      `All sources cleared by ${msg.from.id} (@${msg.from.username || 'N/A'})\n` +
      `Cleared: ${count} sources`
    );
  }
  
  logger.info(`Sources cleared - Count: ${count}`);
}

async function handleClearDestinations(msg) {
  const chatId = msg.chat.id;
  
  const count = botConfig.destinationChats.length;
  
  if (count === 0) {
    await bot.sendMessage(chatId, '⚠️ No destination chats to clear\\.');
    return;
  }
  
  botConfig.destinationChats = [];
  saveConfig();
  
  await bot.sendMessage(chatId, `✅ Cleared all ${count} destination chat${count !== 1 ? 's' : ''}`);
  
  // Log changes
  if (botConfig.logChannel) {
    await bot.sendMessage(botConfig.logChannel,
      `All destinations cleared by ${msg.from.id} (@${msg.from.username || 'N/A'})\n` +
      `Cleared: ${count} destinations`
    );
  }
  
  logger.info(`Destinations cleared - Count: ${count}`);
}

async function handleStatus(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user is admin
  if (!botConfig.admins.includes(userId)) {
    await bot.sendMessage(chatId, '⚠️ This command is only available for administrators.');
    logger.warn(`Non-admin user ${userId} attempted to use status command`);
    return;
  }
  
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  const status = 
    `🤖 *Bot Status*\n\n` +
    `*Configuration:*\n` +
    `• Sources: ${botConfig.sourceChats.length}\n` +
    `• Destinations: ${botConfig.destinationChats.length}\n` +
    `• Keywords: ${botConfig.filters.keywords.length}\n` +
    `• Message Types: ${botConfig.filters.types.length}\n` +
    `• Rate Limit: ${botConfig.rateLimit.maxMessages} msgs/${botConfig.rateLimit.timeWindow}s\n\n` +
    `*Statistics:*\n` +
    `• Total Messages: ${botConfig.statistics.totalMessages}\n` +
    `• Forwarded: ${botConfig.statistics.forwardedMessages}\n` +
    `• Failed: ${botConfig.statistics.failedMessages}\n\n` +
    `*System:*\n` +
    `• Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s\n` +
    `• Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n\n` +
    `*Active Chats:*\n` +
    `Sources:\n${botConfig.sourceChats.map(id => `• ${id}`).join('\n') || 'None'}\n\n` +
    `Destinations:\n${botConfig.destinationChats.map(id => `• ${id}`).join('\n') || 'None'}`;

  await bot.sendMessage(chatId, status, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });

  logger.info(`Admin ${userId} checked bot status`);
}

async function handleHelp(msg) {
  const chatId = msg.chat.id;
  const isAdmin = botConfig.admins.includes(msg.from.id);
  
  const adminCommands = isAdmin ? 
    `*Admin Commands:*\n` +
    `• /broadcast [message] \\- Send message to all users\n` +
    `• /status \\- Check detailed bot status\n\n` : '';
  
  const helpMessage = 
    `📚 *Available Commands*\n\n` +
    `${adminCommands}` +
    `*General Commands:*\n` +
    `• /add\\_sources [chat\\_ids] \\- Add source chats\n` +
    `• /add\\_destinations [chat\\_ids] \\- Add destination chats\n` +
    `• /list _ids] \\- View source chats\n` +
    `• /list\\_destinations \\- View destination chats\n` +
    `• /remove\\_sources [chat\\_ids] \\- Remove source chats\n` +
    `• /remove\\_destinations [chat\\_ids] \\- Remove destination chats\n` +
    `• /clear\\_sources \\- Remove all source chats\n` +
    `• /clear\\_destinations \\- Remove all destination chats\n` +
    `• /help \\- Show this message\n\n` +
    `*Examples:*\n` +
    `• Add sources:\n` +
    `/add\\_sources \\-100123456789 \\-100987654321\n\n` +
    `• Add destinations:\n` +
    `/add\\_destinations \\-100123456789 \\-100987654321\n\n` +
    `• Broadcast \\(admin only\\):\n` +
    `/broadcast Hello everyone\\!`;
  
  await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true
  });
}

// Register command handlers with duplicate prevention
bot.onText(/^\/start$/, msg => handleCommand(msg, handleStart));
bot.onText(/^\/broadcast(?:\s+(.+))?$/, msg => handleCommand(msg, handleBroadcast));
bot.onText(/^\/add_sources(?:\s+(.+))?$/, msg => handleCommand(msg, handleAddSources));
bot.onText(/^\/add_destinations(?:\s+(.+))?$/, msg => handleCommand(msg, handleAddDestinations));
bot.onText(/^\/list_sources$/, msg => handleCommand(msg, handleListSources));
bot.onText(/^\/list_destinations$/, msg => handleCommand(msg, handleListDestinations));
bot.onText(/^\/remove_sources(?:\s+(.+))?$/, msg => handleCommand(msg, handleRemoveSources));
bot.onText(/^\/remove_destinations(?:\s+(.+))?$/, msg => handleCommand(msg, handleRemoveDestinations));
bot.onText(/^\/clear_sources$/, msg => handleCommand(msg, handleClearSources));
bot.onText(/^\/clear_destinations$/, msg => handleCommand(msg, handleClearDestinations));
bot.onText(/^\/status$/, msg => handleCommand(msg, handleStatus));
bot.onText(/^\/help$/, msg => handleCommand(msg, handleHelp));

// Save configuration with improved error handling
function saveConfig() {
  try {
    const configToSave = {
      ...botConfig,
      users: Array.from(botConfig.users),
      clonedBots: Array.from(botConfig.clonedBots.entries())
    };
    writeFileSync('./config.json', JSON.stringify(configToSave, null, 2));
    logger.info('Configuration saved successfully');
  } catch (error) {
    logger.error('Error saving configuration:', error.message);
  }
}

// Rate limiting with improved cleanup
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
  
  // Cleanup old entries
  if (recentMessages.length > botConfig.rateLimit.maxMessages * 2) {
    messageCounter.set(chatId, recentMessages.slice(-botConfig.rateLimit.maxMessages));
  }
  
  return true;
}

// Message filter with improved type checking
function matchesFilters(msg) {
  // Check for channel posts
  const messageType = Object.keys(msg).find(key => 
    botConfig.filters.types.includes(key)
  );
  
  if (!messageType) {
    logger.debug(`Message type not in filters: ${Object.keys(msg).join(', ')}`);
    return false;
  }
  
  if (messageType === 'text' && botConfig.filters.keywords.length > 0) {
    const hasKeyword = botConfig.filters.keywords.some(keyword =>
      msg.text.toLowerCase().includes(keyword.toLowerCase())
    );
    if (!hasKeyword) {
      logger.debug(`Message does not contain any keywords`);
      return false;
    }
  }
  
  return true;
}

// Forward messages with improved error handling and logging
bot.on('channel_post', async (msg) => {
  try {
    // Check if post is from a source chat
    if (!botConfig.sourceChats.includes(msg.chat.id)) {
      logger.debug(`Channel post from non-source chat: ${msg.chat.id}`);
      return;
    }
    
    logger.info(`Processing channel post ${msg.message_id} from chat ${msg.chat.id}`);
    
    // Check rate limit
    if (!checkRateLimit(msg.chat.id)) {
      logger.warn(`Rate limit exceeded for chat ${msg.chat.id}`);
      return;
    }
    
    // Check message filters
    if (!matchesFilters(msg)) {
      logger.info(`Channel post filtered: ${msg.message_id}`);
      return;
    }
    
    // Forward to all destination chats
    for (const destId of botConfig.destinationChats) {
      try {
        logger.info(`Attempting to forward channel post ${msg.message_id} to ${destId}`);
        
        // Use copyMessage to avoid forwarded tag
        await bot.copyMessage(destId, msg.chat.id, msg.message_id, {
          disable_notification: false,
          protect_content: false
        });
        
        botConfig.statistics.forwardedMessages++;
        logger.info(`Successfully forwarded channel post ${msg.message_id} to ${destId}`);
      } catch (error) {
        botConfig.statistics.failedMessages++;
        logger.error(`Failed to forward channel post ${msg.message_id} to ${destId}: ${error.message}`);
        
        // Check specific error cases
        if (error.response?.body?.error_code === 403) {
          logger.error(`Bot lacks permission in chat ${destId}. Please ensure bot is admin with post permissions.`);
        } else if (error.response?.body?.error_code === 400) {
          logger.error(`Bad request when forwarding to ${destId}: ${error.response.body.description}`);
        }
      }
    }
    
    saveConfig();
  } catch (error) {
    logger.error('Channel post forward error:', error);
  }
});

// Error handling with improved logging
bot.on('polling_error', (error) => {
  if (!error.message.includes('EFATAL')) {
    logger.error('Polling error:', error.message);
  }
});

// Process error handling with improved logging
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

// Graceful shutdown with improved cleanup
process.on('SIGINT', async () => {
  logger.info('Received SIGINT. Graceful shutdown initiated...');
  try {
    await bot.stopPolling();
    saveConfig();
    logger.info('Bot stopped successfully');
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
    saveConfig();
    logger.info('Bot stopped successfully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Periodic statistics reset
setInterval(() => {
  const now = new Date();
  const lastReset = new Date(botConfig.statistics.lastReset);
  
  // Reset statistics every 24 hours
  if (now.getTime() - lastReset.getTime() > 24 * 60 * 60 * 1000) {
    botConfig.statistics = {
      totalMessages: 0,
      forwardedMessages: 0,
      failedMessages: 0,
      lastReset: now
    };
    saveConfig();
    logger.info('Statistics reset');
  }
}, 60 * 60 * 1000); // Check every hour

logger.info('Bot started successfully with enhanced features');
