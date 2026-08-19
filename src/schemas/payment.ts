import { z } from 'zod';

// `deviceId` vem do security.js do Mercado Pago rodando no navegador do
// hóspede. Opcional de propósito: se o script não carregar (bloqueador de
// anúncios, rede lenta), o pagamento tem que acontecer mesmo assim — só perde
// um sinal de antifraude.
export const createPaymentSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('pix'),
    deviceId: z.string().min(1).optional(),
  }),
  z.object({
    method: z.literal('credit_card'),
    token: z.string().min(1),
    installments: z.number().int().min(1).max(12),
    paymentMethodId: z.string().min(1),
    issuerId: z.string().min(1),
    deviceId: z.string().min(1).optional(),
  }),
]);

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
