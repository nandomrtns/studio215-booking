import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  ALLOWED_ORIGIN: z.string().default('https://www.studio215poa.com.br'),
  // URL pública deste próprio serviço — usada pra montar notification_url dos
  // pagamentos MP. Mesmo padrão de default que ALLOWED_ORIGIN.
  PUBLIC_BASE_URL: z.string().default('https://studio215-booking-production.up.railway.app'),
  // Usados a partir da Fase 2+ — opcionais por enquanto pra não travar o boot da Fase 1.
  AIRBNB_ICS_URL: z.string().optional(),
  MP_ACCESS_TOKEN: z.string().optional(),
  // Trava temporária pros testes em produção: com ela definida, o backend
  // recusa qualquer cobrança acima desse valor antes de chamar o MP.
  // Remover depois do primeiro pagamento real supervisionado.
  MP_MAX_AMOUNT_CENTS: z.coerce.number().int().positive().optional(),
  MP_PUBLIC_KEY: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),
  CALENDAR_FEED_TOKEN: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_JWT_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
