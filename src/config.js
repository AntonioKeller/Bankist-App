import { readFileSync, existsSync } from 'node:fs';

// Minimalny loader pliku .env (bez dodatkowych zależności).
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'tak', 'yes'].includes(v.toLowerCase()));

export const config = {
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || 'data/cukiernia.db',
  appPassword: env.APP_PASSWORD || '',
  bakeryName: env.BAKERY_NAME || 'Cukiernia A.Keller',
  timeZone: env.TIME_ZONE || 'Europe/Warsaw',
  ownerPhone: env.OWNER_PHONE || '',

  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.AI_MODEL || 'claude-opus-5-5',
    autoReply: bool(env.AI_AUTO_REPLY, true),
    knowledgePath: env.KNOWLEDGE_PATH || 'data/wiedza.md',
  },

  sms: {
    provider: env.SMS_PROVIDER || 'console', // 'smsapi' | 'console'
    token: env.SMSAPI_TOKEN || '',
    sender: env.SMS_SENDER || '',
    normalize: bool(env.SMS_NORMALIZE, true), // usuwa polskie znaki => tańszy SMS
  },

  meta: {
    verifyToken: env.META_VERIFY_TOKEN || '',
    appSecret: env.META_APP_SECRET || '',
    pageToken: env.META_PAGE_TOKEN || '',
    graphVersion: env.META_GRAPH_VERSION || 'v21.0',
  },

  inboundApiKey: env.INBOUND_API_KEY || '',

  pickupReminderHours: Number(env.PICKUP_REMINDER_HOURS || 12),
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 60_000),
};
