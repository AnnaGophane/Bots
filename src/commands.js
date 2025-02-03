import { logger } from './logger.js';

export async function setupCommands(bot) {
  try {
    await bot.setMyCommands([
      { command: 'start', description: 'Start the bot and get help' },
      { command: 'add_source', description: 'Add a source chat (Format: /add_source -100123456789)' },
      { command: 'add_destinations', description: 'Add multiple destination chats' },
      { command: 'list_sources', description: 'List all source chats' },
      { command: 'list_destinations', description: 'List all destination chats' },
      { command: 'remove_source', description: 'Remove a source chat' },
      { command: 'remove_destination', description: 'Remove a destination chat' },
      { command: 'status', description: 'Show bot status' },
      { command: 'help', description: 'Show help message' }
    ]);
    
    // Set up command handlers
    bot.onText(/\/start/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const username = msg.from?.username || msg.from?.first_name || 'User';
        
        const welcomeMessage = `Welcome ${username}! 🤖\n\nI'm an Auto-Forward bot that helps you forward messages between chats.\n\nType /help to see available commands.`;
        
        await bot.sendMessage(chatId, welcomeMessage, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
      } catch (error) {
        logger.error('Error in start command:', error);
        try {
          await bot.sendMessage(msg.chat.id, 'Welcome! Type /help to see available commands.');
        } catch (sendError) {
          logger.error('Failed to send welcome message:', sendError);
        }
      }
    });

    logger.info('Bot commands set up successfully');
  } catch (error) {
    logger.error('Error setting up commands:', error);
    throw error;
  }
}
