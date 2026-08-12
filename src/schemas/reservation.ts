import { z } from 'zod';
import { MAX_GUESTS } from '../constants.js';
import { isValidCpf } from '../lib/cpf.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data precisa estar no formato YYYY-MM-DD');

export const createReservationSchema = z
  .object({
    checkIn: isoDate,
    checkOut: isoDate,
    guestName: z.string().trim().min(2, 'nome muito curto'),
    guestEmail: z.string().trim().email('e-mail inválido'),
    guestPhone: z.string().trim().min(8, 'telefone inválido'),
    guestDocument: z.string().refine(isValidCpf, 'CPF inválido'),
    guestCount: z.number().int().min(1).max(MAX_GUESTS),
  })
  .refine((data) => data.checkOut > data.checkIn, {
    message: 'check-out precisa ser depois do check-in',
    path: ['checkOut'],
  });

export type CreateReservationInput = z.infer<typeof createReservationSchema>;
