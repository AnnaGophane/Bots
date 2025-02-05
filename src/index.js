// run `node index.js` in the terminal

import TelegramBot from 'node-telegram-bot-api';
import { createLogger, format, transports } from 'winston';
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';

const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'error.log', level: 'error' }),
    new transports.File({ filename: 'combined.log' }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

config();

const botConfig = {
  token: process.env.BOT_TOKEN,
  admins: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [],
  logChannel: process.env.LOG_CHANNEL ? parseInt(process.env.LOG_CHANNEL) : null,
  forceSubscribe: process.env.FORCE_SUBSCRIBE_CHANNEL || null,
  sourceChats: [],
  destinationChats: [],
  filters: {
    keywords: [],
    types: ['text', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'sticker', 'location', 'poll', 'animation']
  },
  rateLimit: {
    maxMessages: 10,
    timeWindow: 60
  },
  clonedBots: new Map()
};

const bot = new TelegramBot(botConfig.token, { polling: true });

// Welcome message handler with improved formatting and user-specific commands
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const username = escapeMarkdown(msg.from.username || msg.from.first_name);
  
  // Check force subscribe first
  if (!(await checkForceSubscribe(msg, bot, botConfig))) {
    return;
  }
  
  const isAdmin = botConfig.admins.includes(msg.from.id);
  
  // Show different welcome messages for admin and regular users
  const welcomeMessage = 
    `Welcome ${username}\\! 🤖\n\n` +
    `I'm an Auto\\-Forward bot that can help you forward messages between multiple chats without the forwarded tag\\.\n\n` +
    `*Available Commands:*\n` +
    `• /list\\_sources \\- List all source chats\n` +
    `• /list\\_destinations \\- List all destination chats\n` +
    `• /status \\- Check bot status\n` +
    `• /help \\- Show all commands\n\n` +
    (isAdmin ? 
      `*Admin Commands:*\n` +
      `• /clone \\- Create your own bot using your token\n` +
      `• /add\\_sources \\- Add multiple source chats\n` +
      `• /add\\_destinations \\- Add multiple destination chats\n` +
      `• /remove\\_sources \\- Remove multiple source chats\n` +
      `• /remove\\_destinations \\- Remove multiple destination chats\n` +
      `• /clear\\_sources \\- Remove all source chats\n` +
      `• /clear\\_destinations \\- Remove all destination chats\n\n` +
      `*Examples:*\n` +
      `• Add multiple sources:\n` +
      `/add\\_sources \\-100123456789 \\-100987654321\n\n` +
      `• Add multiple destinations:\n` +
      `/add\\_destinations \\-100123456789 \\-100987654321\n\n` : '');

  await bot.sendMessage(chatId, welcomeMessage, { 
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true 
  });
  
  if (botConfig.logChannel) {
    await bot.sendMessage(botConfig.logChannel, 
      `New user started the bot:\nID: ${msg.from.id}\nUsername: @${msg.from.username || 'N/A'}\nName: ${msg.from.first_name} ${msg.from.last_name || ''}`
    );
  }
});

// Modified help command to show user-specific commands
bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = botConfig.admins.includes(msg.from.id);
  
  // Check force subscribe first
  if (!(await checkForceSubscribe(msg, bot, botConfig))) {
    return;
  }
  
  const helpText = `*Available Commands:*\n\n` +
    `• /list\\_sources \\- Show source chats\n` +
    `• /list\\_destinations \\- Show destinations\n` +
    `• /status \\- Show bot status\n` +
    `• /help \\- Show this message\n\n` +
    (isAdmin ? 
      `*Admin Commands:*\n` +
      `• /clone [token] \\- Create your own bot\n` +
      `• /broadcast [message] \\- Send message to all users\n` +
      `• /add\\_sources [chat\\_id1] [chat\\_id2] \\- Add source chats\n` +
      `• /add\\_destinations [chat\\_id1] [chat\\_id2] \\- Add destination chats\n` +
      `• /remove\\_sources [chat\\_id1] [chat\\_id2] \\- Remove source chats\n` +
      `• /remove\\_destinations [chat\\_id1] [chat\\_id2] \\- Remove destination chats\n` +
      `• /clear\\_sources \\- Remove all source chats\n` +
      `• /clear\\_destinations \\- Remove all destination chats\n\n` +
      `*Examples:*\n` +
      `• /add\\_sources \\-100123456789 \\-100987654321\n` +
      `• /add\\_destinations \\-100123456789 \\-100987654321\n` : '');

  await bot.sendMessage(chatId, helpText, { 
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true 
  });
});

// Modified admin commands handler to silently ignore unauthorized commands
async function handleAdminCommands(msg, botInstance = bot, config = botConfig) {
  const text = msg.text;
  const chatId = msg.chat.id;
  const isAdmin = config.admins.includes(msg.from.id);

  // Check force subscribe first
  if (!(await checkForceSubscribe(msg, botInstance, config))) {
    return;
  }

  // For non-admin users, only process non-admin commands
  const isAdminCommand = ['/add_sources', '/add_destinations', '/remove_sources', '/remove_destinations', '/clear_sources', '/clear_destinations', '/broadcast', '/clone'].some(cmd => text.startsWith(cmd));
  
  if (isAdminCommand && !isAdmin) {
    // Silently ignore admin commands for non-admin users
    return;
  }

  try {
    if (text.startsWith('/add_sources')) {
      const chatIds = text.split(' ').slice(1).map(id => parseInt(id));
      if (chatIds.length === 0) {
        await botInstance.sendMessage(chatId, 
          'Please provide at least one valid chat ID\n' +
          'Format: /add_sources -100123456789 -100987654321 ...'
        );
        return;
      }

      let added = 0;
      let skipped = 0;
      
      for (const sourceId of chatIds) {
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
      await botInstance.sendMessage(chatId, `📋 *Source Chats:*\n${sources}`, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }

    else if (text === '/list_destinations') {
      const destinations = config.destinationChats.length > 0
        ? config.destinationChats.map(id => `• ${id}`).join('\n')
        : 'No destination chats configured';
      await botInstance.sendMessage(chatId, `📋 *Destination Chats:*\n${destinations}`, { 
         parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
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

    else if (text === '/status') {
      const status = 
        `*Bot Status:*\n` +
        `• Sources: ${config.sourceChats.length}\n` +
        `• Destinations: ${config.destinationChats.length}\n` +
        `• Keywords: ${config.filters.keywords.length}\n` +
        `• Message Types: ${config.filters.types.join(', ')}\n` +
        `• Rate Limit: ${config.rateLimit.maxMessages} msgs/${config.rateLimit.timeWindow}s\n` +
        `• Cloned Bots: ${botConfig.clonedBots.size}\n\n` +
        `*Active Chats:*\n` +
        `Sources:\n${config.sourceChats.map(id => `• ${id}`).join('\n') || 'None'}\n\n` +
        `Destinations:\n${config.destinationChats.map(id => `• ${id}`).join('\n') || 'None'}`;

      await botInstance.sendMessage(chatId, status, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    }
  } catch (error) {
    logger.error('Admin command error:', error);
    await botInstance.sendMessage(chatId, '❌ An error occurred while processing your command. Please try again.');
  }
}

// Clone bot command with improved error handling and validation
bot.onText(/^\/clone(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const newToken = match[1]?.trim();
  
  // Check force subscribe first
  if (!(await checkForceSubscribe(msg, bot, botConfig))) {
    return;
  }
  
  if (!newToken) {
    await bot.sendMessage(chatId, 
      '❌ Please provide a bot token\\.\n' +
      'Format: `/clone YOUR_BOT_TOKEN`\n\n' +
      'Get a token from @BotFather', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }
  
  try {
    // Validate token format first
    if (!isValidBotToken(newToken)) {
      await bot.sendMessage(chatId, '❌ Invalid bot token format\\. Please check your token from @BotFather', {
        parse_mode: 'MarkdownV2'
      });
      return;
    }

    // Test the token with a temporary bot instance
    const testBot = new TelegramBot(newToken, { polling: false });
    const me = await testBot.getMe();
    
    // If the bot already exists in cloned bots, stop it first
    if (botConfig.clonedBots.has(newToken)) {
      const existingBot = botConfig.clonedBots.get(newToken);
      try {
        await existingBot.bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error('Error stopping existing bot:', error);
      }
      botConfig.clonedBots.delete(newToken);
    }
    
    // Create new bot instance with proper error handling
    const clonedBot = new TelegramBot(newToken, {
      polling: {
        interval: 2000,
        autoStart: true,
        params: {
          timeout: 30,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'],
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
    
    // Set up configuration for cloned bot
    const clonedConfig = {
      botToken: newToken,
      sourceChats: [],
      destinationChats: [],
      filters: { ...botConfig.filters },
      rateLimit: { ...botConfig.rateLimit },
      admins: [msg.from.id],
      owner: msg.from.id,
      logChannel: botConfig.logChannel,
      forceSubscribe: [...botConfig.forceSubscribe]
    };
    
    // Set up event handlers for the cloned bot
    setupBotEventHandlers(clonedBot, clonedConfig);
    
    // Add specific error handler for cloned bot
    let retryCount = 0;
    const maxRetries = 5;
    clonedBot.on('polling_error', async (error) => {
      if (error.message.includes('EFATAL')) return;
      
      if (error.message.includes('ETELEGRAM: 409')) {
        try {
          await clonedBot.stopPolling();
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          if (retryCount < maxRetries) {
            retryCount++;
            await clonedBot.startPolling();
            logger.info(`Restarted polling for bot @${me.username} (attempt ${retryCount})`);
          } else {
            const errorMsg = escapeMarkdown(`⚠️ Your cloned bot @${me.username} encountered too many conflicts. Please try cloning again later.`);
            await bot.sendMessage(msg.from.id, errorMsg, {
              parse_mode: 'MarkdownV2'
            });
            botConfig.clonedBots.delete(newToken);
          }
        } catch (restartError) {
          logger.error('Failed to restart cloned bot:', restartError);
        }
      } else {
        logger.error('Cloned bot error:', {
          error: error.message,
          botUsername: me.username
        });
      }
    });
    
    // Store the cloned bot
    botConfig.clonedBots.set(newToken, {
      bot: clonedBot,
      config: clonedConfig,
      owner: msg.from.id,
      username: me.username,
      createdAt: new Date()
    });
    
    // Send success message with properly escaped markdown
    const ownerName = msg.from.username 
      ? '@' + escapeMarkdown(msg.from.username)
      : escapeMarkdown(msg.from.first_name);
    
    const successMessage = 
      `✅ Bot cloned successfully\\!\n\n` +
      `*Bot Details:*\n` +
      `• Username: @${escapeMarkdown(me.username)}\n` +
      `• Owner: ${ownerName}\n\n` +
      `You can now use all commands with your bot\\!`;
    
    await bot.sendMessage(chatId, successMessage, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
    
    // Log cloning event
    if (botConfig.logChannel) {
      await bot.sendMessage(botConfig.logChannel, 
        `New bot cloned:\nOwner: ${msg.from.id} (@${msg.from.username || 'N/A'})\nBot: @${me.username}`
      );
    }
    
    // Save updated configuration
    saveConfig();
    
  } catch (error) {
    logger.error('Clone error:', error);
    
    let errorMessage = '❌ Failed to clone bot\\. ';
    
    if (error.message.includes('ETELEGRAM: 401')) {
      errorMessage += 'Invalid bot token\\. Please check your token and try again\\.';
    } else if (error.message.includes('ETELEGRAM: 409')) {
      errorMessage += 'Bot token is already in use by another bot\\.';
    } else {
      errorMessage += 'Please try again later or contact support\\.';
    }
    
    await bot.sendMessage(chatId, errorMessage, {
      parse_mode: 'MarkdownV2'
    });
  }
});

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

// Helper function to validate bot token format
function isValidBotToken(token) {
  const tokenRegex = /^\d+:[A-Za-z0-9_-]{35,}$/;
  return tokenRegex.test(token.trim());
}

// Helper function to escape markdown characters
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Helper function to check force subscribe
async function checkForceSubscribe(msg, botInstance, config) {
  if (!config.forceSubscribe) return true;
  
  try {
    const chatMember = await botInstance.getChatMember(config.forceSubscribe, msg.from.id);
    if (!['member', 'administrator', 'creator'].includes(chatMember.status)) {
      const channelInfo = await botInstance.getChat(config.forceSubscribe);
      await botInstance.sendMessage(msg.chat.id, 
        `Please join our channel @${channelInfo.username} to use this bot.`,
        { reply_markup: { inline_keyboard: [[{ text: 'Join Channel', url: `https://t.me/${channelInfo.username}` }]] } }
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Force subscribe check error:', error);
    return true;
  }
}

// Helper function to save config
function saveConfig() {
  try {
    writeFileSync('config.json', JSON.stringify(botConfig, null, 2));
  } catch (error) {
    logger.error('Failed to save config:', error);
  }
}

// Improved message filter function
function matchesFilters(msg) {
  const messageType = Object.keys(msg).find(key => 
    ['text', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'sticker', 'location', 'poll', 'animation'].includes(key)
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

// Clean forward message function with improved error handling
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

// Forward message function with improved error handling
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
  // Remove any existing handlers
  botInstance.removeAllListeners('message');
  botInstance.removeAllListeners('polling_error');
  botInstance.removeAllListeners('error');

  // Set up new handlers
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
      bot.emit('message', startMessage);
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: '❌ Please join all required channels first!',
        show_alert: true
      });
    }
  }
});

// Enhanced polling error handler with improved reconnection logic
let retryCount = 0;
const maxRetries = 10;
const baseDelay = 2000;
let isReconnecting = false;

bot.on('polling_error', async (error) => {
  if (error.message.includes('EFATAL')) return;
  
  if (isReconnecting) return;
  
  logger.error('Polling error:', error.message);
  
  if (retryCount < maxRetries) {
    const delay = Math.min(baseDelay * Math.pow(1.5, retryCount), 10000);
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
      
      if (retryCount >= maxRetries) {
        logger.error('Max retries reached, restarting bot...');
        process.exit(1);
      }
    }
  }
});

// Set up bot commands with improved error handling
async function setupBotCommands() {
  try {
    const baseCommands = [
      { command: 'start', description: 'Start the bot and get help' },
      { command: 'list_sources', description: 'List all source chats' },
      { command: 'list_destinations', description: 'List all destination chats' },
      { command: 'status', description: 'Show bot status' },
      { command: 'help', description: 'Show help message' }
    ];

    // Set up base commands for all users
    await bot.setMyCommands(baseCommands);
    logger.info('Bot commands set up successfully');
  } catch (error) {
    logger.error('Failed to set up bot commands:', error);
  }
}

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

// Initialize the bot
setupBotCommands();
logger.info('Bot started successfully');
