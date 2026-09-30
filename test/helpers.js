// Ustawienia testowe muszą być gotowe przed importem modułów aplikacji.
process.env.ANTHROPIC_API_KEY = '';
process.env.META_PAGE_TOKEN = '';
process.env.META_VERIFY_TOKEN = 'sekret-weryfikacji';
process.env.META_APP_SECRET = '';
process.env.INBOUND_API_KEY = 'klucz-testowy';
process.env.APP_PASSWORD = '';
process.env.OWNER_PHONE = '';
process.env.SMS_PROVIDER = 'console';
process.env.PICKUP_REMINDER_HOURS = '12';

const { openDb } = await import('../src/db.js');
const { setSmsDriver } = await import('../src/sms.js');

export function setup() {
  const sent = [];
  setSmsDriver({
    async send(to, message) {
      sent.push({ to, message });
      return { status: 'wyslany', providerId: String(sent.length) };
    },
  });
  return { db: openDb(':memory:'), sent };
}
