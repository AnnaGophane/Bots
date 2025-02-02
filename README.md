# Telegram Auto-Forward Bot

A Node.js bot that automatically forwards messages between Telegram chats/channels, similar to @AutoForwardBot.

## Features

- Forward messages between channels, groups, or private chats
- Support for text, images, videos, documents, and other message types
- Multiple source and destination chats
- Filter messages based on keywords
- Rate limiting to prevent spam
- Admin commands for configuration
- Logging of forwarded messages
- Bot cloning functionality
- Heroku deployment support

## Prerequisites

- Node.js 18 or higher
- A Telegram Bot Token (get it from [@BotFather](https://t.me/botfather))
- Chat IDs of source and destination chats
- Heroku account (for deployment)

## Local Development

1. Clone this repository:
```bash
git clone https://github.com/yourusername/telegram-auto-forward-bot.git
cd telegram-auto-forward-bot
```

2. Install dependencies:
```bash
npm install
```

3. Copy the example config:
```bash
cp config.example.json config.json
```

4. Edit `config.json` with your bot token and chat IDs

5. Start the bot:
```bash
npm start
```

## Admin Commands

- `/clone [bot_token]` - Clone the bot with a new token
- `/add_source [chat_id]` - Add a source chat
- `/add_destination [chat_id]` - Add a destination chat
- `/add_keyword [keyword]` - Add a keyword filter
- `/list_sources` - List all source chats
- `/list_destinations` - List all destination chats
- `/list_keywords` - List all keyword filters
- `/remove_source [chat_id]` - Remove a source chat
- `/remove_destination [chat_id]` - Remove a destination chat
- `/remove_keyword [keyword]` - Remove a keyword filter
- `/status` - Show bot status
- `/help` - Show help message

## Bot Cloning

To clone the bot:

1. Create a new bot with [@BotFather](https://t.me/botfather)
2. Get the new bot's token
3. Use the `/clone [new_bot_token]` command with your new bot token
4. The new bot will be created with the same functionality
5. You'll be set as the admin of the new bot
6. Configure the new bot's source and destination chats

## Heroku Deployment

1. Create a new Heroku app:
```bash
heroku create your-app-name
```

2. Set up environment variables in Heroku:
```bash
heroku config:set BOT_TOKEN=your_bot_token_here
heroku config:set SOURCE_CHATS='[-100123456789]'
heroku config:set DESTINATION_CHATS='[-100987654321]'
heroku config:set FILTER_KEYWORDS='["important","announcement"]'
heroku config:set FILTER_TYPES='["text","photo","video","document"]'
heroku config:set RATE_LIMIT_MAX=10
heroku config:set RATE_LIMIT_WINDOW=60
heroku config:set NODE_ENV=production
heroku config:set APP_URL=https://your-app-name.herokuapp.com
heroku config:set ADMIN_USERS='[123456789]'
```

3. Deploy to Heroku:
```bash
git push heroku main
```

4. Ensure the worker dyno is running:
```bash
heroku ps:scale worker=1
```

## Configuration

You can configure the bot using either:

1. Environment variables (recommended for Heroku)
2. config.json file (local development)

### Environment Variables

```env
BOT_TOKEN=your_bot_token_here
SOURCE_CHATS=[-100123456789]
DESTINATION_CHATS=[-100987654321]
FILTER_KEYWORDS=["important","announcement"]
FILTER_TYPES=["text","photo","video","document"]
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW=60
NODE_ENV=production
APP_URL=https://your-app-name.herokuapp.com
ADMIN_USERS=[123456789]
```

### JSON Configuration

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "sourceChats": [-100123456789],
  "destinationChats": [-100987654321],
  "filters": {
    "keywords": ["important", "announcement"],
    "types": ["text", "photo", "video", "document"]
  },
  "rateLimit": {
    "maxMessages": 10,
    "timeWindow": 60
  },
  "admins": [123456789]
}
```

## Usage

1. Add your bot to both source and destination chats
2. Grant admin rights to the bot in destination chats
3. Use admin commands to configure sources, destinations, and filters
4. Deploy to Heroku or start locally
5. Monitor the logs using `heroku logs --tail` or check the local bot.log file

## Bot Cloning Tips

1. Each cloned bot maintains its own configuration
2. Cloned bots start with empty source and destination lists
3. Only admins can clone bots
4. The person who clones a bot becomes its admin
5. Cloned bots have the same features as the original
6. Each cloned bot runs independently

## License

MIT
