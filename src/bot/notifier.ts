import { Bot } from "grammy";

export interface NotificationPublisher {
  notify(message: string): Promise<void>;
}

export function createTelegramNotifier(token: string, ownerId: number): NotificationPublisher {
  const bot = new Bot(token);

  return {
    notify: async (message: string) => {
      if (!message.trim()) {
        return;
      }

      await bot.api.sendMessage(ownerId, message);
    },
  };
}
