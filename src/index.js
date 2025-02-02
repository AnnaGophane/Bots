import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

// Load environment variables
config();

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

// Initialize bot
const bot = new TelegramBot(botConfig.botToken, {
  webHook: process.env.NODE_ENV === 'production'
});

// Set webhook in production
if (process.env.NODE_ENV === 'production') {
  const url = process.env.APP_URL;
  bot.setWebHook(`${url}/bot${botConfig.botToken}`);
} else {
  bot.startPolling();
}

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

// Clone bot functionality
async function cloneBot(msg, newBotToken) {
  try {
    if (!botConfig.admins.includes(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, 'You are not authorized to clone bots.');
      return;
    }

    // Validate bot token
    if (!newBotToken || !/^\d+:[A-Za-z0-9_-]{35}$/.test(newBotToken)) {
      await bot.sendMessage(msg.chat.id, 'Please provide a valid bot token.');
      return;
    }

    // Create new bot instance with the same configuration
    const clonedBotConfig = {
      ...botConfig,
      botToken: newBotToken,
      sourceChats: [],
      destinationChats: [],
      filters: {
        keywords: [],
        types: ["text", "photo", "video", "document"]
      },
      admins: [msg.from.id] // Set the creator as the admin
    };

    // Create new bot instance
    const clonedBot = new TelegramBot(newBotToken, {
      webHook: process.env.NODE_ENV === 'production'
    });

    if (process.env.NODE_ENV === 'production') {
      const url = process.env.APP_URL;
      await clonedBot.setWebHook(`${url}/bot${newBotToken}`);
    } else {
      clonedBot.startPolling();
    }

    // Store the cloned bot instance
    botConfig.clonedBots.set(newBotToken, {
      bot: clonedBot,
      config: clonedBotConfig
    });

    // Set up event handlers for the cloned bot
    setupBotEventHandlers(clonedBot, clonedBotConfig);

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
}

// Save configuration
function saveConfig() {
  if (process.env.NODE_ENV !== 'production') {
    writeFileSync('./config.json', JSON.stringify(botConfig, null, 2));
  }
}

// Admin commands
async function handleAdminCommands(msg, botInstance = bot, config = botConfig) {
  if (!config.admins.includes(msg.from.id)) {
    return;
  }

  const text = msg.text;
  const chatId = msg.chat.id;

  if (text.startsWith('/clone')) {
    const newBotToken = text.split(' ')[1];
    await cloneBot(msg, newBotToken);
    return;
  }

  if (text.startsWith('/add_source')) {
    const sourceId = parseInt(text.split(' ')[1]);
    if (!sourceId) {
      await botInstance.sendMessage(chatId, 'Please provide a valid chat ID');
      return;
    }
    if (!config.sourceChats.includes(sourceId)) {
      config.sourceChats.push(sourceId);
      saveConfig();
      await botInstance.sendMessage(chatId, 'Source chat added successfully');
    } else {
      await botInstance.sendMessage(chatId, 'This chat is already a source');
    }
  }

  else if (text.startsWith('/add_destination')) {
    const destId = parseInt(text.split(' ')[1]);
    if (!destId) {
      await botInstance.sendMessage(chatId, 'Please provide a valid chat ID');
      return;
    }
    if (!config.destinationChats.includes(destId)) {
      config.destinationChats.push(destId);
      saveConfig();
      await botInstance.sendMessage(chatId, 'Destination chat added successfully');
    } else {
      await botInstance.sendMessage(chatId, 'This chat is already a destination');
    }
  }

  else if (text.startsWith('/add_keyword')) {
    const keyword = text.split(' ').slice(1).join(' ').toLowerCase();
    if (!keyword) {
      await botInstance.sendMessage(chatId, 'Please provide a keyword');
      return;
    }
    if (!config.filters.keywords.includes(keyword)) {
      config.filters.keywords.push(keyword);
      saveConfig();
      await botInstance.sendMessage(chatId, 'Keyword added successfully');
    } else {
      await botInstance.sendMessage(chatId, 'This keyword already exists');
    }
  }

  else if (text === '/list_sources') {
    const sources = config.sourceChats.join('\n');
    await botInstance.sendMessage(chatId, `Source chats:\n${sources || 'None'}`);
  }

  else if (text === '/list_destinations') {
    const destinations = config.destinationChats.join('\n');
    await botInstance.sendMessage(chatId, `Destination chats:\n${destinations || 'None'}`);
  }

  else if (text === '/list_keywords') {
    const keywords = config.filters.keywords.join('\n');
    await botInstance.sendMessage(chatId, `Keywords:\n${keywords || 'None'}`);
  }

  else if (text.startsWith('/remove_source')) {
    const sourceId = parseInt(text.split(' ')[1]);
    if (!sourceId) {
      await botInstance.sendMessage(chatId, 'Please provide a valid chat ID');
      return;
    }
    config.sourceChats = config.sourceChats.filter(id => id !== sourceId);
    saveConfig();
    await botInstance.sendMessage(chatId, 'Source chat removed successfully');
  }

  else if (text.startsWith('/remove_destination')) {
    const destId = parseInt(text.split(' ')[1]);
    if (!destId) {
      await botInstance.sendMessage(chatId, 'Please provide a valid chat ID');
      return;
    }
    config.destinationChats = config.destinationChats.filter(id => id !== destId);
    saveConfig();
    await botInstance.sendMessage(chatId, 'Destination chat removed successfully');
  }

  else if (text.startsWith('/remove_keyword')) {
    const keyword = text.split(' ').slice(1).join(' ').toLowerCase();
    if (!keyword) {
      await botInstance.sendMessage(chatId, 'Please provide a keyword');
      return;
    }
    config.filters.keywords = config.filters.keywords.filter(k => k !== keyword);
    saveConfig();
    await botInstance.sendMessage(chatId, 'Keyword removed successfully');
  }

  else if (text === '/help') {
    const helpText = `
Available commands:
/clone [bot_token] - Clone this bot with a new token
/add_source [chat_id] - Add a source chat
/add_destination [chat_id] - Add a destination chat
/add_keyword [keyword] - Add a keyword filter
/list_sources - List all source chats
/list_destinations - List all destination chats
/list_keywords - List all keyword filters
/remove_source [chat_id] - Remove a source chat
/remove_destination [chat_id] - Remove a destination chat
/remove_keyword [keyword] - Remove a keyword filter
/status - Show bot status
/help - Show this help message
    `.trim();
    await botInstance.sendMessage(chatId, helpText);
  }

  else if (text === '/status') {
    const status = `
Bot Status:
Sources: ${config.sourceChats.length}
Destinations: ${config.destinationChats.length}
Keywords: ${config.filters.keywords.length}
Message Types: ${config.filters.types.join(', ')}
Rate Limit: ${config.rateLimit.maxMessages} msgs/${config.rateLimit.timeWindow}s
    `.trim();
    await botInstance.sendMessage(chatId, status);
  }
}

// Clean forward message function
async function cleanForwardMessage(msg, botInstance, destChat) {
  try {
    // Handle different message types
    if (msg.text) {
      // Text messages
      await botInstance.sendMessage(destChat, msg.text, {
        parse_mode: msg.parse_mode || 'HTML',
        disable_web_page_preview: msg.disable_web_page_preview
      });
    } 
    else if (msg.photo) {
      // Photo messages
      const photo = msg.photo[msg.photo.length - 1]; // Get highest quality photo
      await botInstance.sendPhoto(destChat, photo.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.video) {
      // Video messages
      await botInstance.sendVideo(destChat, msg.video.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.document) {
      // Document messages
      await botInstance.sendDocument(destChat, msg.document.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.audio) {
      // Audio messages
      await botInstance.sendAudio(destChat, msg.audio.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.voice) {
      // Voice messages
      await botInstance.sendVoice(destChat, msg.voice.file_id, {
        caption: msg.caption,
        parse_mode: msg.caption_parse_mode || 'HTML'
      });
    }
    else if (msg.video_note) {
      // Video note messages
      await botInstance.sendVideoNote(destChat, msg.video_note.file_id);
    }
    else if (msg.sticker) {
      // Sticker messages
      await botInstance.sendSticker(destChat, msg.sticker.file_id);
    }
    else if (msg.location) {
      // Location messages
      await botInstance.sendLocation(destChat, msg.location.latitude, msg.location.longitude);
    }
    else if (msg.poll) {
      // Poll messages
      await botInstance.sendPoll(destChat, msg.poll.question, msg.poll.options.map(opt => opt.text), {
        is_anonymous: msg.poll.is_anonymous,
        type: msg.poll.type,
        allows_multiple_answers: msg.poll.allows_multiple_answers,
        correct_option_id: msg.poll.correct_option_id
      });
    }
    else if (msg.animation) {
      // Animation/GIF messages
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

// Update the forwardMessage function to use clean forwarding
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
      // Use clean forward instead of telegram's forward method
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

logger.info('Bot started successfully');
