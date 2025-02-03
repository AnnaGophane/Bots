import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import logger from './logger.js';

dotenv.config();

function loadConfig() {
  try {
    return JSON.parse(readFileSync('./config.json', 'utf8'));
  } catch (error) {
    logger.info('No config.json found, using environment variables');
    return {
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
}

export const config = loadConfig();
