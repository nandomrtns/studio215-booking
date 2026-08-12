import type { FastifyInstance } from 'fastify';
import { computeQuote, findApplicableRule, nightsBetween } from '../services/pricing.js';

export async function pricingRoutes(app: FastifyInstance) {
  app.get('/api/pricing', async (req, reply) => {
    const query = req.query as { checkIn?: string; checkOut?: string };

    // Sem datas: usa hoje como referência só pra achar a regra padrão e devolver
    // a diária "a partir de", sem calcular noites/total.
    const referenceDate = query.checkIn ?? new Date().toISOString().slice(0, 10);
    const rule = await findApplicableRule(referenceDate, query.checkOut ?? referenceDate);

    if (!rule) {
      return reply.status(404).send({ error: 'sem_regra_de_preco' });
    }

    if (!query.checkIn || !query.checkOut) {
      return reply.send(rule);
    }

    if (query.checkOut <= query.checkIn) {
      return reply.status(422).send({ error: 'datas_invalidas' });
    }

    const nights = nightsBetween(query.checkIn, query.checkOut);
    return reply.send(computeQuote(rule, nights));
  });
}
