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
      // Unexpected failures may contain SQL text, provider responses, hostnames,
      // or other operational details. Keep those in the structured server log
      // above and return a stable public message to the caller.
      message: statusCode >= 500
        ? 'An unexpected error occurred'
        : (error.message || 'Request failed'),
      code,
      requestId,
    });
  });
}
