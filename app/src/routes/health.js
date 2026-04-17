async function healthRoutes(fastify) {
  fastify.get('/health', { config: { noAuth: true } }, async (_req, reply) => {
    return reply.code(200).send({ status: 'ok', ts: Date.now() });
  });
}

module.exports = healthRoutes;
