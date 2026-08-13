import { MercadoPagoConfig } from 'mercadopago';
import { config } from '../config.js';

/**
 * MP_ACCESS_TOKEN é opcional em config.ts pra não travar o boot da Fase 1/2 —
 * por isso o guard aqui, não lá. Só as rotas de pagamento/webhook importam
 * este módulo, então o erro aparece no registro delas (falha de boot clara),
 * não silenciosamente na primeira chamada à API do MP.
 */
if (!config.MP_ACCESS_TOKEN) {
  throw new Error('MP_ACCESS_TOKEN é obrigatório pras rotas de pagamento');
}

export const mpClient = new MercadoPagoConfig({
  accessToken: config.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});
