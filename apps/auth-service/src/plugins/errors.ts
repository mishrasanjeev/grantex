import type { FastifyInstance, FastifyError } from 'fastify';

export async function errorsPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      app.log.error({ err: error, requestId }, 'Internal server error');
    }

    const code =
      statusCode === 401 ? 'UNAUTHORIZED' :
      statusCode === 403 ? 'FORBIDDEN' :
      statusCode === 404 ? 'NOT_FOUND' :
      statusCode === 422 ? 'VALIDATION_ERROR' :
      statusCode >= 400 && statusCode < 500 ? 'BAD_REQUEST' :
      'INTERNAL_ERROR';

    void reply.status(statusCode).send({
      message: error.message || 'An unexpected error occurred',
      code,
      requestId,
    });
  });
}
