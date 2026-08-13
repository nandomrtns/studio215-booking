import { z } from 'zod';

export const createPaymentSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('pix') }),
  z.object({
    method: z.literal('credit_card'),
    token: z.string().min(1),
    installments: z.number().int().min(1).max(12),
    paymentMethodId: z.string().min(1),
    issuerId: z.string().min(1),
  }),
]);

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
