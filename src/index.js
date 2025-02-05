// Import required modules
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
  // Improved regex for bot token validation
  const tokenRegex = /^\d+:[A-Za-z0-9_-]{35,}$/;
  return tokenRegex.test(token.trim());
}

// Helper function to escape markdown v2 characters
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Initialize configuration with improved error handling
let botConfig;
try {
  botConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
} catch (error) {
  logger.info('Creating new configuration from environment variables');
  botConfig = {
    botToken: process.env.BOT_TOKEN,
    sourceChats: JSON.parse(process.env.SOURCE_CHATS || '[]'),
    destinationChats: JSON.parse(process.env.DESTINATION_CHATS || '[]'),
    userDestinationChats: new Map(),
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
    logChannel: process.env.LOG_CHANNEL || '',
    forceSubscribe: JSON.parse(process.env.FORCE_SUBSCRIBE || '[]')
  };
}

// Add force subscribe check function
async function checkForceSubscribe(msg, botInstance, config) {
  const userId = msg.from.id;
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
    }
  }
  
  if (notSubscribed.length > 0) {
    const buttons = notSubscribed.map(channel => [{
      text: `📢 Join ${channel.title || channel.username || channel.id}`,
      url: `https://t.me/${channel.username}`
    }]);
    
    buttons.push([{ text: '🔄 Check Subscription', callback_data: 'check_subscription' }]);
    
    await botInstance.sendMessage(msg.chat.id,
      `⚠️ *Please join our channel${notSubscribed.length > 1 ? 's' : ''} to use this bot\\!*\n\n` +
      `Click the button${notSubscribed.length > 1 ? 's' : ''} below to join:`, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: buttons
      }
    });
    return false;
  }
  
  return true;
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

// Updated command handler for both admin and user commands
async function handleCommands(msg, botInstance = bot, config = botConfig) {
  const text = msg.text;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const isAdmin = config.admins.includes(userId);

  // Check force subscribe first
  if (!(await checkForceSubscribe(msg, botInstance, config))) {
    return;
  }

  try {
    const command = text.split(' ')[0].toLowerCase();
    const args = text.split(' ').slice(1);

    switch (command) {
      case '/start':
        const username = escapeMarkdown(msg.from.username || msg.from.first_name);
        const welcomeMessage = 
          `Welcome ${username}\\! 🤖\n\n` +
          `I'm an Auto\\-Forward bot that can help you forward messages between multiple chats without the forwarded tag\\.\n\n` +
          `Use /help to see available commands\\.`;

        await botInstance.sendMessage(chatId, welcomeMessage, { 
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true 
        });
        break;

      case '/add_sources':
        if (!isAdmin) {
          await botInstance.sendMessage(chatId, '⚠️ This command requires admin privileges.');
          return;
        }
        const sourceIds = args.map(id => parseInt(id));
        if (sourceIds.length === 0) {
          await botInstance.sendMessage(chatId, 
            'Please provide at least one valid chat ID\n' +
            'Format: /add_sources -100123456789 -100987654321 ...'
          );
          return;
        }

        let addedSources = 0;
        let skippedSources = 0;
        
        for (const sourceId of sourceIds) {
          if (!sourceId) continue;
          
          if (!config.sourceChats.includes(sourceId)) {
            config.sourceChats.push(sourceId);
            addedSources++;
          } else {
            skippedSources++;
          }
        }
        
        saveConfig();
        
        const sourceMessage = [
          addedSources > 0 ? `✅ Added ${addedSources} new source${addedSources > 1 ? 's' : ''}` : '',
          skippedSources > 0 ? `⚠️ Skipped ${skippedSources} existing source${skippedSources > 1 ? 's' : ''}` : ''
        ].filter(Boolean).join('\n');
        
        await botInstance.sendMessage(chatId, sourceMessage || '⚠️ No valid chat IDs provided');
        break;

      case '/add_destinations':
        const destIds = args.map(id => parseInt(id));
        if (destIds.length === 0) {
          await botInstance.sendMessage(chatId, 
            'Please provide at least one valid chat ID\n' +
            'Format: /add_destinations -100123456789 -100987654321 ...'
          );
          return;
        }

        let userDests = config.userDestinationChats.get(userId) || [];
        let added = 0;
        let skipped = 0;
        
        for (const destId of destIds) {
          if (!destId) continue;
          
          if (!userDests.includes(destId)) {
            userDests.push(destId);
            added++;
          } else {
            skipped++;
          }
        }
        
        config.userDestinationChats.set(userId, userDests);
        saveConfig();
        
        const destMessage = [
          added > 0 ? `✅ Added ${added} new destination${added > 1 ? 's' : ''}` : '',
          skipped > 0 ? `⚠️ Skipped ${skipped} existing destination${skipped > 1 ? 's' : ''}` : ''
        ].filter(Boolean).join('\n');
        
        await botInstance.sendMessage(chatId, destMessage || '⚠️ No valid chat IDs provided');
        break;

      case '/remove_destinations':
        const removeIds = args.map(id => parseInt(id));
        if (removeIds.length === 0) {
          await botInstance.sendMessage(chatId, 
            'Please provide destination chat IDs to remove.\n' +
            'Format: /remove_destinations -100123456789 -100987654321 ...'
          );
          return;
        }

        let userDestList = config.userDestinationChats.get(userId) || [];
        let removed = 0;
        let notFound = 0;
        
        for (const removeId of removeIds) {
          if (!removeId) continue;
          
          if (userDestList.includes(removeId)) {
            userDestList = userDestList.filter(id => id !== removeId);
            removed++;
          } else {
            notFound++;
          }
        }
        
        config.userDestinationChats.set(userId, userDestList);
        saveConfig();
        
        const removeMessage = [
          removed > 0 ? `✅ Removed ${removed} destination${removed > 1 ? 's' : ''}` : '',
          notFound > 0 ? `⚠️ Not found: ${notFound}` : ''
        ].filter(Boolean).join('\n');
        
        await botInstance.sendMessage(chatId, removeMessage || '⚠️ No valid chat IDs provided');
        break;

      case '/list_destinations':
        const userDestinations = config.userDestinationChats.get(userId) || [];
        const destList = userDestinations.length > 0
          ? userDestinations.map(id => `• ${id}`).join('\n')
          : 'No destinations configured';
        
        await botInstance.sendMessage(chatId, `📋 *Your Destination Chats:*\n${destList}`, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
        break;

      case '/clear_destinations':
        config.userDestinationChats.set(userId, []);
        saveConfig();
        await botInstance.sendMessage(chatId, '✅ Cleared all your destinations');
        break;

      case '/broadcast':
        if (!isAdmin) {
          await botInstance.sendMessage(chatId, '⚠️ This command requires admin privileges.');
          return;
        }
        const broadcastText = args.join(' ');
        if (!broadcastText) {
          await botInstance.sendMessage(chatId, 
            'Please provide a message to broadcast.\n' +
            'Format: /broadcast Your message here'
          );
          return;
        }

        try {
          let successCount = 0;
          let failCount = 0;

          // Get unique users from both source and destination chats
          const uniqueUsers = new Set([...config.sourceChats, ...Array.from(config.userDestinationChats.values()).flat()]);
          
          // Send status message
          const statusMsg = await botInstance.sendMessage(chatId, 
            '📢 Broadcasting message...\n' +
            `Total recipients: ${uniqueUsers.size}`
          );
          
          for (const userId of uniqueUsers) {
            try {
              await botInstance.sendMessage(userId, broadcastText);
              successCount++;
              
              // Update status every 10 messages
              if (successCount % 10 === 0) {
                await botInstance.editMessageText(
                  `📢 Broadcasting message...\n` +
                  `Progress: ${successCount + failCount}/${uniqueUsers.size}\n` +
                  `✅ Success: ${successCount}\n` +
                  `❌ Failed: ${failCount}`,
                  {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                  }
                );
              }
            } catch (error) {
              logger.error(`Failed to broadcast to ${userId}:`, error.message);
              failCount++;
            }
          }

          // Send final status
          await botInstance.editMessageText(
            `📢 Broadcast completed\n` +
            `✅ Success: ${successCount}\n` +
            `❌ Failed: ${failCount}`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id
            }
          );

          if (config.logChannel) {
            await botInstance.sendMessage(config.logChannel,
              `Broadcast sent by ${msg.from.id} (@${msg.from.username || 'N/A'})\n` +
              `Success: ${successCount}\nFailed: ${failCount}\n` +
              `Message: ${broadcastText}`
            );
          }
        } catch (error) {
          logger.error('Broadcast error:', error);
          await botInstance.sendMessage(chatId, '❌ An error occurred while broadcasting the message.');
        }
        break;

      case '/help':
        const helpText = `*Available Commands:*\n\n` +
          `*User Commands:*\n` +
          `• /add\\_destinations [chat\\_id1] [chat\\_id2] \\- Add destination chats\n` +
          `• /remove\\_destinations [chat\\_id1] [chat\\_id2] \\- Remove destination chats\n` +
          `• /list\\_destinations \\- Show your destinations\n` +
          `• /clear\\_destinations \\- Remove all your destinations\n` +
          `• /status \\- Show bot status\n\n` +
          (isAdmin ? `*Admin Commands:*\n` +
          `• /broadcast [message] \\- Send message to all users\n` +
          `• /add\\_sources [chat\\_id1] [chat\\_id2] \\- Add source chats\n` +
          `• /remove\\_sources [chat\\_id1] [chat\\_id2] \\- Remove source chats\n` +
          `• /clear\\_sources \\- Remove all source chats\n\n` : '') +
          `*Examples:*\n` +
          `• /add\\_destinations \\-100123456789 \\-100987654321\n` +
          `• /remove\\_destinations \\-100123456789`;

        await botInstance.sendMessage(chatId, helpText, {
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        });
        break;

      case '/status':
        const userDests = config.userDestinationChats.get(userId) || [];
        const status = 
          `*Your Bot Status:*\n` +
          `• Your Destinations: ${userDests.length}\n` +
          (isAdmin ? `• Total Sources: ${config.sourceChats.length}\n` : '') +
          `• Message Types: ${config.filters.types.join(', ')}\n` +
          `• Rate Limit: ${config.rateLimit.maxMessages} msgs/${config.rateLimit.timeWindow}s\n\n` +
          `*Your Destinations:*\n${userDests.map(id => `• ${id}`).join('\n') || 'None'}`;

        await botInstance.sendMessage(chatId, status, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
        break;

      default:
        await botInstance.sendMessage(chatId, 'Unknown command. Use /help to see available commands.');
    }
  } catch (error) {
    logger.error('Command error:', error);
    await botInstance.sendMessage(chatId, '❌ An error occurred while processing your command. Please try again.');
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
    
    // Get all destinations for this message
    const allDestinations = new Set([
      ...config.destinationChats,
      ...(config.userDestinationChats.get(msg.from.id) || [])
    ]);
    
    for (const destChat of allDestinations) {
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
      await handleCommands(msg, botInstance, config);
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

// Save configuration with improved error handling
function saveConfig() {
  if (process.env.NODE_ENV !== 'production') {
    try {
      const configToSave = {
        ...botConfig,
        clonedBots: Array.from(botConfig.clonedBots.entries()),
        userDestinationChats: Array.from(botConfig.userDestinationChats.entries())
      };
      writeFileSync('./config.json', JSON.stringify(configToSave, null, 2));
      logger.info('Configuration saved successfully');
    } catch (error) {
      logger.error('Error saving configuration:', error.message);
    }
  }
}

// Set up event handlers for main bot
setupBotEventHandlers(bot, botConfig);

// Set up bot commands with improved error handling
async function setupBotCommands() {
  try {
    const commands = [
      { command: 'start', description: 'Start the bot and get help' },
      { command: 'clone', description: 'Clone this bot with your own token' },
      { command: 'add_destinations', description: 'Add multiple destination chats' },
      { command: 'remove_destinations', description: 'Remove multiple destination chats' },
      { command: 'list_destinations', description: 'List all destination chats' },
      { command: 'clear_destinations', description: 'Remove all destination chats' },
      { command: 'status', description: 'Show bot status' },
      { command: 'help', description: 'Show help message' }
    ];

    await bot.setMyCommands(commands);
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
Indent mode

Spaces
Indent size

2
Line wrap mode

No wrap
Editing index.js file contents
753
754
755
756
757
758
759
760
761
762
763
764
765
766
767
768
769
770
771
772
773
774
775
776
777
778
779
780
781
782
783
784
785
786
787
788
789
790
791
792
793
794
795
796
797
798
799
800
801

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
